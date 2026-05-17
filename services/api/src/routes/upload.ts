import { Router, Request, Response } from 'express';
import multer from 'multer';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { PublishCommand } from '@aws-sdk/client-sns';
import { v4 as uuidv4 } from 'uuid';
import { s3, sns } from '../lib/aws';
import { initFileStatus } from '../lib/statusStore';
import { FileUploadedEvent } from '../lib/types';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const BUCKET    = 'file-uploads';
const TOPIC_ARN = process.env.SNS_TOPIC_ARN || 'arn:aws:sns:us-east-1:000000000000:file-events';

export const uploadRouter = Router();

uploadRouter.post(
  '/upload',
  upload.single('file'),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const fileId  = uuidv4();
    const fileKey = `uploads/${fileId}/${req.file.originalname}`;

    try {
      // 1. Store raw file in S3
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: fileKey,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }));

      // 2. Initialise status rows in DynamoDB (meta + 4x pending processor rows)
      await initFileStatus(fileId, req.file.originalname, req.file.mimetype, req.file.size);

      // 3. Publish FileUploaded event to SNS → fans out to 4 SQS queues
      const event: FileUploadedEvent = {
        eventType: 'FileUploaded',
        fileId,
        fileName: req.file.originalname,
        fileKey,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        uploadedAt: new Date().toISOString(),
      };

      await sns.send(new PublishCommand({
        TopicArn: TOPIC_ARN,
        Message: JSON.stringify(event),
        Subject: 'FileUploaded',
      }));

      console.log(`[api] FileUploaded published — ${fileId} (${req.file.originalname})`);

      res.status(202).json({ fileId, fileName: req.file.originalname });
    } catch (err) {
      console.error('[api] Upload failed:', err);
      res.status(500).json({ error: 'Upload failed' });
    }
  },
);

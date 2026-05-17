import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

interface FileUploadedEvent {
  eventType: 'FileUploaded';
  fileId: string;
  fileName: string;
  fileKey: string;
  fileSize: number;
  mimeType: string;
  uploadedAt: string;
}

const awsConfig = {
  endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
  region: process.env.AWS_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  },
  forcePathStyle: true,
};

const sqs = new SQSClient(awsConfig);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(awsConfig));

const QUEUE_URL      = process.env.QUEUE_URL      ?? 'http://localhost:4566/000000000000/queue-thumbnail-generator';
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE ?? 'file-processing';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/ogg'];

async function generateThumbnail(event: FileUploadedEvent): Promise<Record<string, unknown>> {
  const processingTime = 1500 + Math.random() * 2500;
  await sleep(processingTime);

  if (IMAGE_TYPES.includes(event.mimeType)) {
    return {
      generated: true,
      type: 'image',
      thumbnailKey: `thumbnails/${event.fileId}/thumb_200x200.webp`,
      dimensions: { width: 200, height: 200 },
      format: 'webp',
      processingMs: Math.round(processingTime),
    };
  }

  if (VIDEO_TYPES.includes(event.mimeType)) {
    return {
      generated: true,
      type: 'video',
      thumbnailKey: `thumbnails/${event.fileId}/frame_00m01s.webp`,
      dimensions: { width: 320, height: 180 },
      capturedAt: '00:00:01',
      format: 'webp',
      processingMs: Math.round(processingTime),
    };
  }

  return {
    generated: false,
    type: 'placeholder',
    iconType: event.mimeType.split('/')[0] ?? 'generic',
    thumbnailKey: `thumbnails/${event.fileId}/icon_placeholder.svg`,
    processingMs: Math.round(processingTime),
  };
}

async function writeResult(
  fileId: string,
  status: 'success' | 'failed',
  result: Record<string, unknown>,
): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: DYNAMODB_TABLE,
    Item: {
      fileId,
      processor: 'thumbnailGenerator',
      status,
      result,
      processedAt: new Date().toISOString(),
    },
  }));
}

async function handleMessage(message: { Body?: string; ReceiptHandle?: string }): Promise<void> {
  const envelope = JSON.parse(message.Body ?? '{}');
  const event: FileUploadedEvent = JSON.parse(envelope.Message ?? '{}');

  console.log(`[thumbnail-generator] Processing ${event.fileId} (${event.mimeType})`);

  try {
    const result = await generateThumbnail(event);
    await writeResult(event.fileId, 'success', result);
    console.log(`[thumbnail-generator] ✓ Done: ${event.fileId}`);
  } catch (err) {
    await writeResult(event.fileId, 'failed', { error: (err as Error).message });
    console.log(`[thumbnail-generator] ✗ Failed: ${event.fileId}`);
  }

  await sqs.send(new DeleteMessageCommand({
    QueueUrl: QUEUE_URL,
    ReceiptHandle: message.ReceiptHandle!,
  }));
}

async function poll(): Promise<void> {
  console.log('[thumbnail-generator] Polling', QUEUE_URL);
  while (true) {
    try {
      const response = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 5,
        WaitTimeSeconds: 5,
      }));
      for (const message of response.Messages ?? []) {
        await handleMessage(message);
      }
    } catch (err) {
      console.error('[thumbnail-generator] Poll error:', err);
      await sleep(3000);
    }
  }
}

poll();

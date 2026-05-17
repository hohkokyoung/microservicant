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

const QUEUE_URL      = process.env.QUEUE_URL      ?? 'http://localhost:4566/000000000000/queue-storage-optimizer';
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE ?? 'file-processing';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const ALREADY_COMPRESSED = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg',
  'application/zip', 'application/gzip',
];

async function optimize(event: FileUploadedEvent): Promise<Record<string, unknown>> {
  const processingTime = 800 + Math.random() * 2000;
  await sleep(processingTime);

  if (ALREADY_COMPRESSED.includes(event.mimeType)) {
    return {
      optimized: false,
      reason: 'File type is already compressed',
      algorithm: 'none',
      originalSize: event.fileSize,
      optimizedSize: event.fileSize,
      savedBytes: 0,
      compressionRatio: '0%',
      processingMs: Math.round(processingTime),
    };
  }

  const savingsFraction = 0.15 + Math.random() * 0.25;
  const optimizedSize   = Math.round(event.fileSize * (1 - savingsFraction));

  return {
    optimized: true,
    algorithm: 'brotli',
    originalSize: event.fileSize,
    optimizedSize,
    savedBytes: event.fileSize - optimizedSize,
    compressionRatio: `${Math.round(savingsFraction * 100)}%`,
    storageKey: `optimized/${event.fileId}/${event.fileName}.br`,
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
      processor: 'storageOptimizer',
      status,
      result,
      processedAt: new Date().toISOString(),
    },
  }));
}

async function handleMessage(message: { Body?: string; ReceiptHandle?: string }): Promise<void> {
  const envelope = JSON.parse(message.Body ?? '{}');
  const event: FileUploadedEvent = JSON.parse(envelope.Message ?? '{}');

  console.log(`[storage-optimizer] Processing ${event.fileId} (${event.mimeType})`);

  try {
    const result = await optimize(event);
    await writeResult(event.fileId, 'success', result);
    console.log(`[storage-optimizer] ✓ Done: ${event.fileId}`);
  } catch (err) {
    await writeResult(event.fileId, 'failed', { error: (err as Error).message });
    console.log(`[storage-optimizer] ✗ Failed: ${event.fileId}`);
  }

  await sqs.send(new DeleteMessageCommand({
    QueueUrl: QUEUE_URL,
    ReceiptHandle: message.ReceiptHandle!,
  }));
}

async function poll(): Promise<void> {
  console.log('[storage-optimizer] Polling', QUEUE_URL);
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
      console.error('[storage-optimizer] Poll error:', err);
      await sleep(3000);
    }
  }
}

poll();

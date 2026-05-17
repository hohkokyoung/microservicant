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

const QUEUE_URL      = process.env.QUEUE_URL      ?? 'http://localhost:4566/000000000000/queue-metadata-indexer';
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE ?? 'file-processing';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const CATEGORY_MAP: Record<string, string> = {
  image: 'media', video: 'media', audio: 'media',
  application: 'document', text: 'document',
};

function deriveExtension(fileName: string): string {
  return fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : 'unknown';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

async function indexMetadata(event: FileUploadedEvent): Promise<Record<string, unknown>> {
  const processingTime = 500 + Math.random() * 1000;
  await sleep(processingTime);

  const [type]  = event.mimeType.split('/');
  const ext     = deriveExtension(event.fileName);
  const tags    = [...new Set([type, ext, event.fileSize > 10 * 1024 * 1024 ? 'large-file' : null].filter(Boolean))] as string[];

  return {
    indexed: true,
    fileName: event.fileName,
    extension: ext,
    mimeType: event.mimeType,
    category: CATEGORY_MAP[type] ?? 'other',
    tags,
    sizeBytes: event.fileSize,
    sizeHuman: formatBytes(event.fileSize),
    uploadedAt: event.uploadedAt,
    searchableText: event.fileName.replace(/[._-]/g, ' ').toLowerCase(),
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
      processor: 'metadataIndexer',
      status,
      result,
      processedAt: new Date().toISOString(),
    },
  }));
}

async function handleMessage(message: { Body?: string; ReceiptHandle?: string }): Promise<void> {
  const envelope = JSON.parse(message.Body ?? '{}');
  const event: FileUploadedEvent = JSON.parse(envelope.Message ?? '{}');

  console.log(`[metadata-indexer] Processing ${event.fileId} (${event.fileName})`);

  try {
    const result = await indexMetadata(event);
    await writeResult(event.fileId, 'success', result);
    console.log(`[metadata-indexer] ✓ Indexed: ${event.fileId}`);
  } catch (err) {
    await writeResult(event.fileId, 'failed', { error: (err as Error).message });
    console.log(`[metadata-indexer] ✗ Failed: ${event.fileId}`);
  }

  await sqs.send(new DeleteMessageCommand({
    QueueUrl: QUEUE_URL,
    ReceiptHandle: message.ReceiptHandle!,
  }));
}

async function poll(): Promise<void> {
  console.log('[metadata-indexer] Polling', QUEUE_URL);
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
      console.error('[metadata-indexer] Poll error:', err);
      await sleep(3000);
    }
  }
}

poll();

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

const QUEUE_URL      = process.env.QUEUE_URL      ?? 'http://localhost:4566/000000000000/queue-virus-scanner';
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE ?? 'file-processing';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function scan(event: FileUploadedEvent): Promise<Record<string, unknown>> {
  const scanDuration = 1000 + Math.random() * 2000;
  await sleep(scanDuration);

  if (Math.random() < 0.05) throw new Error('Threat detected: Trojan.Generic');

  return {
    clean: true,
    engine: 'MockAV v3.1',
    scanDurationMs: Math.round(scanDuration),
    signatureVersion: '2024.05.16',
    threatsFound: 0,
  };
}

async function writeResult(
  fileId: string,
  status: 'success' | 'failed',
  result: Record<string, unknown>,
): Promise<void> {
  // Write directly to DynamoDB — no results queue needed
  await ddb.send(new PutCommand({
    TableName: DYNAMODB_TABLE,
    Item: {
      fileId,
      processor: 'virusScanner',
      status,
      result,
      processedAt: new Date().toISOString(),
    },
  }));
}

async function handleMessage(message: { Body?: string; ReceiptHandle?: string }): Promise<void> {
  // Unwrap the SNS envelope that wraps the payload when delivered via SQS
  const envelope = JSON.parse(message.Body ?? '{}');
  const event: FileUploadedEvent = JSON.parse(envelope.Message ?? '{}');

  console.log(`[virus-scanner] Processing ${event.fileId} (${event.fileName})`);

  try {
    const scanResult = await scan(event);
    await writeResult(event.fileId, 'success', scanResult);
    console.log(`[virus-scanner] ✓ Clean: ${event.fileId}`);
  } catch (err) {
    await writeResult(event.fileId, 'failed', { error: (err as Error).message });
    console.log(`[virus-scanner] ✗ Threat: ${event.fileId}`);
  }

  await sqs.send(new DeleteMessageCommand({
    QueueUrl: QUEUE_URL,
    ReceiptHandle: message.ReceiptHandle!,
  }));
}

async function poll(): Promise<void> {
  console.log('[virus-scanner] Polling', QUEUE_URL);
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
      console.error('[virus-scanner] Poll error:', err);
      await sleep(3000);
    }
  }
}

poll();

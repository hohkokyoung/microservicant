import { QueryCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, DYNAMODB_TABLE } from './aws';
import { FileStatus, ProcessorName } from './types';

const PROCESSORS: ProcessorName[] = [
  'virusScanner',
  'thumbnailGenerator',
  'metadataIndexer',
  'storageOptimizer',
];

// Called on upload — writes the file metadata row + one pending row per processor
// SK '#meta' stores file-level info; SK 'virusScanner' etc. stores processor status
export async function initFileStatus(
  fileId: string,
  fileName: string,
  mimeType: string,
  fileSize: number,
): Promise<void> {
  const uploadedAt = new Date().toISOString();

  // File metadata row
  await ddb.send(new PutCommand({
    TableName: DYNAMODB_TABLE,
    Item: { fileId, processor: '#meta', fileName, mimeType, fileSize, uploadedAt },
  }));

  // One pending row per processor — written in parallel
  await Promise.all(
    PROCESSORS.map(processor =>
      ddb.send(new PutCommand({
        TableName: DYNAMODB_TABLE,
        Item: { fileId, processor, status: 'pending' },
      })),
    ),
  );
}

// Called by GET /api/status/:fileId — one DynamoDB query gets everything
export async function getFileStatus(fileId: string): Promise<FileStatus | null> {
  const result = await ddb.send(new QueryCommand({
    TableName: DYNAMODB_TABLE,
    KeyConditionExpression: 'fileId = :fileId',
    ExpressionAttributeValues: { ':fileId': fileId },
  }));

  const items = result.Items ?? [];
  if (items.length === 0) return null;

  const meta = items.find(i => i.processor === '#meta');
  if (!meta) return null;

  const processorItems = items.filter(i => i.processor !== '#meta');

  const processors = Object.fromEntries(
    processorItems.map(item => [
      item.processor,
      {
        status: item.status,
        result: item.result,
        processedAt: item.processedAt,
      },
    ]),
  ) as FileStatus['processors'];

  // Fill in any processors not yet written by workers
  for (const p of PROCESSORS) {
    if (!processors[p]) processors[p] = { status: 'pending' };
  }

  const statuses = Object.values(processors).map(p => p.status);
  const allDone  = statuses.every(s => s === 'success' || s === 'failed');
  const anyFailed = statuses.some(s => s === 'failed');

  return {
    fileId,
    fileName: meta.fileName,
    mimeType: meta.mimeType,
    fileSize: meta.fileSize,
    uploadedAt: meta.uploadedAt,
    overallStatus: allDone ? (anyFailed ? 'partial_failure' : 'complete') : 'processing',
    processors,
  };
}

// GET /api/files — lists all files (scans meta rows)
export async function getAllFiles(): Promise<FileStatus[]> {
  // We query each known file — for a real system you'd maintain a separate index
  // For now, return empty and let users query by fileId directly
  // (full table scan would require a GSI in production)
  return [];
}

export interface FileUploadedEvent {
  eventType: 'FileUploaded';
  fileId: string;
  fileName: string;
  fileKey: string;
  fileSize: number;
  mimeType: string;
  uploadedAt: string;
}

export interface ProcessingResultEvent {
  eventType: 'ProcessingResult';
  fileId: string;
  processor: ProcessorName;
  status: 'success' | 'failed';
  result: Record<string, unknown>;
  processedAt: string;
}

export type ProcessorName =
  | 'virusScanner'
  | 'thumbnailGenerator'
  | 'metadataIndexer'
  | 'storageOptimizer';

export interface ProcessorStatus {
  status: 'pending' | 'processing' | 'success' | 'failed';
  result?: Record<string, unknown>;
  processedAt?: string;
}

export interface FileStatus {
  fileId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  uploadedAt: string;
  overallStatus: 'processing' | 'complete' | 'partial_failure';
  processors: Record<ProcessorName, ProcessorStatus>;
}

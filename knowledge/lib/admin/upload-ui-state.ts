import type {
  UiUploadQueueStatus,
  UploadApiResponse,
} from '@/lib/admin/upload-contract';

export function queueStatusAfterResponse(
  response: UploadApiResponse,
): UiUploadQueueStatus {
  if (response.ok) return 'uploaded';
  return response.code === 'UNSUPPORTED_MEDIA_TYPE' || response.code === 'MIME_MISMATCH'
    ? 'unsupported'
    : 'failed';
}

export function canRetryUpload(status: UiUploadQueueStatus): boolean {
  return status === 'failed';
}

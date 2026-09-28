import { UPLOAD_BUCKETS, type UploadBucket, type UploadObjectLocation } from '@/lib/admin/upload-contract';
import { UploadContractError } from '@/lib/admin/upload-errors';

/**
 * The single builder for Qdrant payload.source_key: `{bucket}/{key}`.
 * Upload responses, status lookup and delete must all use this function.
 */
export function toQdrantSourceKey(
  location: Pick<UploadObjectLocation, 'bucket' | 'key'>,
): string {
  return `${location.bucket}/${location.key}`;
}

export function parseQdrantSourceKey(sourceKey: string): { bucket: UploadBucket; key: string } {
  const separator = sourceKey.indexOf('/');
  const bucket = sourceKey.slice(0, separator);
  const key = sourceKey.slice(separator + 1);
  if (separator < 1 || !key || !UPLOAD_BUCKETS.includes(bucket as UploadBucket)) {
    throw new UploadContractError(400, 'MALFORMED_REQUEST', 'Invalid source key');
  }
  return { bucket: bucket as UploadBucket, key };
}

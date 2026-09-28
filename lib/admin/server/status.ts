import { createHash } from 'node:crypto';
import {
  uploadMediaForExtension,
  type RecentUpload,
  type UploadMediaRoute,
  type UploadStatus,
} from '@/lib/admin/upload-contract';
import { parseUploadObjectKey } from '@/lib/admin/object-key';
import { toQdrantSourceKey } from '@/lib/admin/source-key';
import type { QdrantEvidenceAdapter } from '@/lib/admin/server/qdrant';
import type { StoredObject } from '@/lib/admin/server/storage';
import { UPLOAD_METADATA } from '@/lib/admin/server/object-metadata';

export function deriveUploadStatus(input: {
  stored: boolean;
  /** False when the key is outside the confirmed ingest taxonomy. */
  routable?: boolean;
  ingestionCapability?: UploadMediaRoute['ingestionCapability'];
  processedEvidence: boolean;
  explicitFailure?: boolean;
}): UploadStatus {
  if (input.explicitFailure) return 'failed';
  if (!input.stored) return 'unsupported';
  if (input.routable === false) return 'unsupported';
  if (input.ingestionCapability === 'deferred') return 'pending';
  if (input.ingestionCapability !== 'supported') return 'unsupported';
  return input.processedEvidence ? 'processed' : 'pending';
}

function fallbackUploadId(object: StoredObject): string {
  return createHash('sha256')
    .update(`${object.bucket}/${object.key}`)
    .digest('hex')
    .slice(0, 24);
}

function isRoutableObjectKey(key: string): boolean {
  try {
    parseUploadObjectKey(key);
    return true;
  } catch {
    return false;
  }
}

export async function buildRecentUpload(
  object: StoredObject,
  qdrant: QdrantEvidenceAdapter | null,
): Promise<RecentUpload> {
  const filename = object.key.split('/').pop() ?? object.key;
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  const media = uploadMediaForExtension(extension);
  const sourceKey = toQdrantSourceKey(object);
  // Legacy/unknown prefixes are reported explicitly instead of being routed
  // to a guessed collection.
  const routable = isRoutableObjectKey(object.key);
  const processedEvidence = routable && qdrant && media?.ingestionCapability === 'supported'
    ? await qdrant.hasProcessedEvidence(sourceKey)
    : false;

  return {
    uploadId: object.metadata[UPLOAD_METADATA.uploadId] || fallbackUploadId(object),
    bucket: object.bucket,
    key: object.key,
    sourceKey,
    filename,
    size: object.size,
    uploadedAt: object.lastModified?.toISOString() ?? null,
    ingestionCapability: media?.ingestionCapability ?? 'deferred',
    status: deriveUploadStatus({
      stored: true,
      routable,
      ingestionCapability: media?.ingestionCapability,
      processedEvidence,
    }),
  };
}

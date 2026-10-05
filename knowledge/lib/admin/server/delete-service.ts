import { NextResponse } from 'next/server';
import { UPLOAD_BUCKETS, uploadMediaForExtension, type DeleteUploadResponse, type UploadBucket, type UploadObjectLocation } from '@/lib/admin/upload-contract';
import { UploadContractError, normalizeUploadError } from '@/lib/admin/upload-errors';
import { sanitizeUploadFilename } from '@/lib/admin/upload-validation';
import { parseUploadObjectKey } from '@/lib/admin/object-key';
import { toQdrantSourceKey } from '@/lib/admin/source-key';
import { currentRequestIdentity, requireAdminPermission, type AdminIdentity } from '@/lib/admin/server/authorization';
import { jsonAuditLogger, requestIp, type AuditLogger } from '@/lib/admin/server/audit';
import { doubleSubmitCsrfValidator, type CsrfValidator } from '@/lib/admin/server/csrf';
import { createStorageAdapter, type StorageAdapter } from '@/lib/admin/server/storage';
import { createQdrantAdapter, type QdrantEvidenceAdapter } from '@/lib/admin/server/qdrant';

const MAX_DELETE_BODY_BYTES = 2_048;
const DELETE_BODY_TIMEOUT_MS = 3_000;

export interface DeleteDependencies {
  /** Resolves the session identity (null when absent or expired). */
  authenticate: () => Promise<AdminIdentity | null>;
  csrf: CsrfValidator;
  storage: () => StorageAdapter;
  qdrant: () => QdrantEvidenceAdapter;
  audit: AuditLogger;
}

const defaults: DeleteDependencies = {
  authenticate: currentRequestIdentity,
  csrf: doubleSubmitCsrfValidator,
  storage: createStorageAdapter,
  qdrant: createQdrantAdapter,
  audit: jsonAuditLogger,
};

/**
 * Validates a stored object location against the ingest taxonomy
 * (`machines|software|consulting/{slug}/{file}`). It deliberately does not
 * consult today's website catalogue: an already-stored valid object remains
 * deletable after its product is removed from the catalogue.
 */
export function validateDeleteTarget(input: unknown): UploadObjectLocation {
  if (!input || typeof input !== 'object') {
    throw new UploadContractError(400, 'MALFORMED_REQUEST', 'Invalid delete target');
  }
  const { bucket, key } = input as { bucket?: unknown; key?: unknown };
  if (typeof bucket !== 'string' || !UPLOAD_BUCKETS.includes(bucket as UploadBucket) || typeof key !== 'string') {
    throw new UploadContractError(400, 'MALFORMED_REQUEST', 'Invalid delete target');
  }
  const { safeFilename } = parseUploadObjectKey(key);
  if (sanitizeUploadFilename(safeFilename) !== safeFilename) {
    throw new UploadContractError(400, 'INVALID_FILENAME', 'Invalid object filename');
  }
  const extension = safeFilename.split('.').pop() ?? '';
  const media = uploadMediaForExtension(extension);
  if (!media || media.bucket !== bucket) {
    throw new UploadContractError(400, 'MALFORMED_REQUEST', 'Object type does not match bucket');
  }
  const location = { bucket: bucket as UploadBucket, key };
  return { ...location, sourceKey: toQdrantSourceKey(location) };
}

export async function readDeleteBody(request: Request, timeoutMs = DELETE_BODY_TIMEOUT_MS): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !request.body) {
    throw new UploadContractError(400, 'MALFORMED_REQUEST', 'A JSON delete target is required');
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let received = 0;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new UploadContractError(408, 'REQUEST_TIMEOUT', 'Delete request body timed out'));
      void reader.cancel().catch(() => {});
    }, timeoutMs);
    onAbort = () => {
      reject(new UploadContractError(408, 'REQUEST_TIMEOUT', 'Delete request was cancelled'));
      void reader.cancel().catch(() => {});
    };
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) onAbort();
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      received += value.byteLength;
      if (received > MAX_DELETE_BODY_BYTES) {
        throw new UploadContractError(400, 'MALFORMED_REQUEST', 'Delete target is too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof UploadContractError) throw error;
    throw new UploadContractError(400, 'MALFORMED_REQUEST', 'Invalid JSON delete target');
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (onAbort) request.signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

export async function deleteUpload(
  request: Request,
  overrides: Partial<DeleteDependencies> = {},
): Promise<Response> {
  const dependencies: DeleteDependencies = { ...defaults, ...overrides };
  let identity: AdminIdentity | null = null;
  let key = 'unresolved';
  let qdrantDeleted = false;
  try {
    identity = requireAdminPermission(await dependencies.authenticate());
    await dependencies.csrf.verify(request);
    const target = validateDeleteTarget(await readDeleteBody(request));
    key = target.key;
    const qdrant = dependencies.qdrant(); // Mandatory for a consistent delete.
    const storage = dependencies.storage();
    // Delete vectors first so an S3 failure cannot leave indexed FAQ answers.
    await qdrant.deleteBySourceKey(target.sourceKey);
    qdrantDeleted = true;
    await storage.deleteObject(target.bucket, target.key);
    try {
      dependencies.audit.write({ user: identity.userId, action: 'delete.accepted', key, size: 0, ip: requestIp(request.headers), timestamp: new Date().toISOString() });
    } catch {
      // A logging outage must not claim that an already completed delete was partial.
    }
    const body: DeleteUploadResponse = { ok: true, ...target };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (identity) {
      try {
        dependencies.audit.write({ user: identity.userId, action: qdrantDeleted ? 'delete.partial' : 'delete.failed', key, size: 0, ip: requestIp(request.headers), timestamp: new Date().toISOString() });
      } catch {
        // Logging must not turn a failed delete into success or expose secrets.
      }
    }
    const normalized = qdrantDeleted
      ? normalizeUploadError(new UploadContractError(500, 'PARTIAL_DELETE', 'Delete incomplete; contact an administrator'))
      : normalizeUploadError(error);
    return NextResponse.json(normalized.body, { status: normalized.status, headers: { 'Cache-Control': 'no-store' } });
  }
}

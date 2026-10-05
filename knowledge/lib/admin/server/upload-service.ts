import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { NextResponse } from 'next/server';
import {
  UPLOAD_BUCKETS,
  type RecentUploadsResponse,
  type UploadSuccessResponse,
} from '@/lib/admin/upload-contract';
import { UploadContractError, normalizeUploadError } from '@/lib/admin/upload-errors';
import {
  createUploadByteCounter,
  prepareUploadRequest,
  UPLOAD_IDLE_TIMEOUT_MS,
  type UploadByteCounter,
} from '@/lib/admin/upload-validation';
import { getServerUploadMaxBytes } from '@/lib/admin/server/upload-limit';
import {
  canViewAllUploads,
  currentRequestIdentity,
  requireUploadPermission,
  type AdminIdentity,
} from '@/lib/admin/server/authorization';
import {
  jsonAuditLogger,
  requestIp,
  type AuditLogger,
} from '@/lib/admin/server/audit';
import {
  doubleSubmitCsrfValidator,
  type CsrfValidator,
} from '@/lib/admin/server/csrf';
import { tryGetQdrantConfig } from '@/lib/admin/server/config';
import {
  createQdrantAdapter,
  type QdrantEvidenceAdapter,
} from '@/lib/admin/server/qdrant';
import {
  uploadRateLimiter,
  type UploadRateLimiter,
  type UploadVolumeReservation,
} from '@/lib/admin/server/rate-limit';
import {
  createStorageAdapter,
  type StorageAdapter,
  type StoredObject,
} from '@/lib/admin/server/storage';
import { buildRecentUpload } from '@/lib/admin/server/status';
import { sniffUploadStream } from '@/lib/admin/server/mime-sniff';
import { UPLOAD_METADATA } from '@/lib/admin/server/object-metadata';
import {
  uploadConcurrencyGuard,
  type UploadConcurrencyGuard,
  type UploadSlot,
} from '@/lib/admin/server/upload-concurrency';

const RECENT_UPLOAD_LIMIT = 50;

export interface UploadServiceDependencies {
  /** Resolves the session identity (null when absent or expired). */
  authenticate: () => Promise<AdminIdentity | null>;
  csrf: CsrfValidator;
  rateLimiter: UploadRateLimiter;
  /** Per-process cap on simultaneously streaming uploads. */
  concurrency: UploadConcurrencyGuard;
  /** No-progress limit for the request body (408). */
  idleTimeoutMs: number;
  audit: AuditLogger;
  storage: () => StorageAdapter;
  qdrant: () => QdrantEvidenceAdapter | null;
  createUploadId: () => string;
}

const defaultDependencies: UploadServiceDependencies = {
  authenticate: currentRequestIdentity,
  csrf: doubleSubmitCsrfValidator,
  rateLimiter: uploadRateLimiter,
  concurrency: uploadConcurrencyGuard,
  idleTimeoutMs: UPLOAD_IDLE_TIMEOUT_MS,
  audit: jsonAuditLogger,
  storage: createStorageAdapter,
  qdrant: () => {
    const config = tryGetQdrantConfig();
    return config ? createQdrantAdapter(config) : null;
  },
  createUploadId: randomUUID,
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function errorResponse(error: unknown) {
  const normalized = normalizeUploadError(error);
  return json(normalized.body, normalized.status);
}

function writeAuditSafely(audit: AuditLogger, event: Parameters<AuditLogger['write']>[0]) {
  try {
    audit.write(event);
  } catch {
    // Upload outcome must not be changed by a stdout logging failure.
  }
}

function capacityExhausted(): UploadContractError {
  return new UploadContractError(
    503,
    'UPLOAD_CAPACITY_EXHAUSTED',
    'The server is already handling its maximum number of uploads; retry shortly',
  );
}

export async function putUpload(
  request: Request,
  overrides: Partial<UploadServiceDependencies> = {},
): Promise<Response> {
  const dependencies: UploadServiceDependencies = { ...defaultDependencies, ...overrides };
  let identity: AdminIdentity | null = null;
  let auditKey = 'unresolved';
  let counter: UploadByteCounter | null = null;
  let reservation: UploadVolumeReservation | null = null;
  let nodeStream: Readable | null = null;
  let slot: UploadSlot | null = null;

  try {
    identity = requireUploadPermission(await dependencies.authenticate());
    if (!request.body) {
      throw new UploadContractError(400, 'EMPTY_FILE', 'Empty files are not accepted');
    }

    const prepared = prepareUploadRequest(request.headers);
    await dependencies.csrf.verify(request);
    // Taken after the cheap header/auth/CSRF checks and before the body is
    // read or storage is contacted; a full process is not charged to the
    // user's rate limit. Released in `finally` on every outcome.
    slot = dependencies.concurrency.tryAcquire();
    if (!slot) throw capacityExhausted();
    const maxUploadBytes = getServerUploadMaxBytes();
    const declaredSize = prepared.metadata.declaredSize;
    reservation = dependencies.rateLimiter.admit(identity.userId, {
      declaredBytes: declaredSize,
      maxUploadBytes,
    });

    const uploadId = dependencies.createUploadId();
    auditKey = prepared.location.key;
    counter = createUploadByteCounter({
      maxBytes: maxUploadBytes,
      expectedBytes: declaredSize,
      volumeAllowanceBytes: reservation.allowanceBytes,
      idleTimeoutMs: dependencies.idleTimeoutMs,
    });
    const countedWebStream = request.body.pipeThrough(counter.stream, { signal: request.signal });
    const sniffed = await sniffUploadStream(countedWebStream, prepared.media);
    nodeStream = Readable.fromWeb(
      sniffed.stream as unknown as NodeReadableStream<Uint8Array>,
      { signal: request.signal },
    );

    await dependencies.storage().putObject({
      bucket: prepared.location.bucket,
      key: prepared.location.key,
      body: nodeStream,
      contentLength: declaredSize,
      contentType: prepared.media.canonicalMimeType,
      signal: request.signal,
      metadata: {
        [UPLOAD_METADATA.uploadId]: uploadId,
        [UPLOAD_METADATA.productLine]: prepared.metadata.businessLine,
        [UPLOAD_METADATA.productId]: prepared.metadata.productId,
        [UPLOAD_METADATA.originalFilename]: encodeURIComponent(prepared.metadata.originalFilename),
        [UPLOAD_METADATA.safeFilename]: prepared.safeFilename,
        [UPLOAD_METADATA.mimeType]: prepared.media.canonicalMimeType,
        [UPLOAD_METADATA.ingestionCapability]: prepared.media.ingestionCapability,
        [UPLOAD_METADATA.uploadedBy]: encodeURIComponent(identity.userId),
      },
    });

    const receivedBytes = counter.receivedBytes;
    reservation.settle(receivedBytes);
    writeAuditSafely(dependencies.audit, {
      user: identity.userId,
      action: 'upload.accepted',
      key: auditKey,
      size: receivedBytes,
      ip: requestIp(request.headers),
      timestamp: new Date().toISOString(),
    });

    const response: UploadSuccessResponse = {
      ok: true,
      uploadId,
      bucket: prepared.location.bucket,
      key: prepared.location.key,
      sourceKey: prepared.location.sourceKey,
      size: receivedBytes,
      status: 'pending',
    };
    return json(response);
  } catch (error) {
    // Release streams this handler created so a failed upload (validation,
    // MIME, size, disconnect or storage error) does not keep reading the body.
    nodeStream?.destroy();
    // Bytes that actually arrived still count toward the hourly volume.
    const receivedBytes = counter?.receivedBytes ?? 0;
    reservation?.settle(receivedBytes);
    if (identity) {
      writeAuditSafely(dependencies.audit, {
        user: identity.userId,
        action: 'upload.failed',
        key: auditKey,
        size: receivedBytes,
        ip: requestIp(request.headers),
        timestamp: new Date().toISOString(),
      });
    }
    return errorResponse(error);
  } finally {
    counter?.stop();
    slot?.release();
  }
}

function metadataUploader(metadata: Record<string, string>): string | null {
  const stored = metadata[UPLOAD_METADATA.uploadedBy];
  if (!stored) return null;
  try {
    return decodeURIComponent(stored);
  } catch {
    return null;
  }
}

export async function getUploads(
  _request: Request,
  overrides: Partial<UploadServiceDependencies> = {},
): Promise<Response> {
  const dependencies: UploadServiceDependencies = { ...defaultDependencies, ...overrides };
  try {
    const identity = requireUploadPermission(await dependencies.authenticate());
    const storage = dependencies.storage();
    const qdrant = dependencies.qdrant();
    const visible = (object: StoredObject) =>
      canViewAllUploads(identity) ||
      metadataUploader(object.metadata) === identity.userId;
    // Ownership is filtered inside the listing, before its limit, so another
    // user's newer uploads cannot push an uploader's own objects out of view.
    const stored = (
      await Promise.all(
        UPLOAD_BUCKETS.map((bucket) =>
          storage.listObjects(bucket, { limit: RECENT_UPLOAD_LIMIT, filter: visible }),
        ),
      )
    )
      .flat()
      .filter(visible)
      .sort(
        (left, right) =>
          (right.lastModified?.getTime() ?? 0) -
          (left.lastModified?.getTime() ?? 0),
      )
      .slice(0, RECENT_UPLOAD_LIMIT);
    const uploads = await Promise.all(
      stored.map((object) => buildRecentUpload(object, qdrant)),
    );
    const response: RecentUploadsResponse = {
      ok: true,
      uploads,
      qdrantAvailable: qdrant !== null,
    };
    return json(response);
  } catch (error) {
    return errorResponse(error);
  }
}

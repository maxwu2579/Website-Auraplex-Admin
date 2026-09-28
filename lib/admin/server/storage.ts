import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { PassThrough, type Readable } from 'node:stream';
import type { UploadBucket } from '@/lib/admin/upload-contract';
import { getMinioConfig, type MinioConfig } from '@/lib/admin/server/config';
import { UPLOAD_IDLE_TIMEOUT_MS } from '@/lib/admin/upload-validation';

const S3_CONNECTION_TIMEOUT_MS = 10_000;
/** Total cap, including SDK retries, on the best-effort abort after a failed completion. */
const MULTIPART_CLEANUP_TIMEOUT_MS = 30_000;

export interface PutStoredObjectInput {
  bucket: UploadBucket;
  key: string;
  body: Readable;
  /** Declared length. Omitted for chunked requests without Content-Length. */
  contentLength?: number;
  contentType: string;
  metadata: Record<string, string>;
  signal?: AbortSignal;
}

export interface StoredObject {
  bucket: UploadBucket;
  key: string;
  size: number;
  lastModified: Date | null;
  metadata: Record<string, string>;
}

export interface ListStoredObjectsOptions {
  limit?: number;
  /** Applied before the limit so matching objects are not cut off. */
  filter?: (object: StoredObject) => boolean;
}

export interface StorageAdapter {
  putObject(input: PutStoredObjectInput): Promise<{ etag?: string }>;
  listObjects(bucket: UploadBucket, options?: ListStoredObjectsOptions): Promise<StoredObject[]>;
  deleteObject(bucket: UploadBucket, key: string): Promise<void>;
}

/**
 * Unknown-length bodies use lib-storage multipart upload because single-part
 * PutObject needs a length up front (the SDK's aws-chunked checksum framing
 * fails without one, and S3/MinIO reject unsized PutObject). Memory is bounded
 * to roughly (queueSize + 1) * partSize per upload; bodies smaller than one
 * part are sent as a single sized PutObject by lib-storage.
 */
export const UNKNOWN_LENGTH_UPLOAD = {
  partSize: 8 * 1024 * 1024,
  queueSize: 2,
} as const;

const HEAD_BATCH_SIZE = 25;

function normalizeMetadata(metadata?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/**
 * Links request cancellation and body-stream failure to one abort signal and
 * rethrows the original body error (SIZE_MISMATCH, FILE_TOO_LARGE, ...) so the
 * caller can return its HTTP status.
 *
 * With `shieldBody`, the SDK receives a PassThrough that ends silently when the
 * real body fails. The SDK's aws-chunked wrapper forwards a source error via
 * `destroy(err)` on a stream it only `pipe()`s into the HTTP request, so that
 * error has no listener: previously the S3 request stalled, the HTTP client
 * never got a response and the error surfaced as an uncaughtException.
 * Aborting through the signal instead makes the SDK reject promptly.
 */
async function runWithBodyAbort<T>(
  body: Readable,
  signal: AbortSignal | undefined,
  run: (abort: AbortController, sdkBody: Readable) => Promise<T>,
  { shieldBody }: { shieldBody: boolean },
): Promise<T> {
  const abort = new AbortController();
  let bodyError: unknown;
  const shield = shieldBody ? new PassThrough() : null;
  const sdkBody = shield ?? body;
  // Kept attached for the stream's lifetime so a late error is never uncaught.
  // Every body failure also aborts the storage call, so the caller's promise
  // settles now rather than after a slow or hung storage cleanup request.
  body.on('error', (error) => {
    bodyError ??= error;
    abort.abort();
    shield?.destroy();
  });
  if (shield) body.pipe(shield);
  const onRequestAbort = () => abort.abort(signal?.reason);
  signal?.addEventListener('abort', onRequestAbort, { once: true });
  if (signal?.aborted) onRequestAbort();
  try {
    return await run(abort, sdkBody);
  } catch (error) {
    body.destroy();
    throw bodyError ?? error;
  } finally {
    signal?.removeEventListener('abort', onRequestAbort);
  }
}

export class S3StorageAdapter implements StorageAdapter {
  constructor(private readonly client: S3Client) {}

  async putObject(input: PutStoredObjectInput): Promise<{ etag?: string }> {
    return input.contentLength === undefined
      ? this.putUnknownLength(input)
      : this.putKnownLength(input, input.contentLength);
  }

  private putKnownLength(input: PutStoredObjectInput, contentLength: number) {
    return runWithBodyAbort(input.body, input.signal, async (abort, sdkBody) => {
      const output = await this.client.send(
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          Body: sdkBody,
          ContentLength: contentLength,
          ContentType: input.contentType,
          Metadata: input.metadata,
        }),
        { abortSignal: abort.signal },
      );
      return { etag: output.ETag };
    }, { shieldBody: true });
  }

  private putUnknownLength(input: PutStoredObjectInput) {
    return runWithBodyAbort(input.body, input.signal, async (abort) => {
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: input.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          Metadata: input.metadata,
        },
        partSize: UNKNOWN_LENGTH_UPLOAD.partSize,
        queueSize: UNKNOWN_LENGTH_UPLOAD.queueSize,
        // Failed or cancelled uploads send AbortMultipartUpload.
        leavePartsOnError: false,
      });
      // Request cancellation and body failure both end up here. upload.abort()
      // makes done() reject immediately; Upload's own reader still sees the
      // failure and sends AbortMultipartUpload in the background. Without this,
      // done() would wait for that cleanup call, so a slow or hung MinIO abort
      // would leave the HTTP client (and the upload slot) waiting. If cleanup
      // never completes, the MinIO incomplete-multipart lifecycle rule applies.
      const onAbort = () => void upload.abort();
      abort.signal.addEventListener('abort', onAbort, { once: true });
      if (abort.signal.aborted) onAbort();
      try {
        const output = await upload.done();
        return { etag: output.ETag };
      } catch (error) {
        // lib-storage aborts after a failed part but not after a failed
        // CompleteMultipartUpload, which would leave the parts behind. Abort
        // here unless the abort signal path above already handles it; after a
        // part failure this repeat is a no-op. Not awaited, so the original
        // error is returned at once and a failing or hung abort cannot replace
        // or delay it. The final key is never deleted: it may hold an existing
        // object. The MinIO incomplete-multipart lifecycle rule stays the net.
        if (!abort.signal.aborted && upload.uploadId) {
          this.client
            .send(
              new AbortMultipartUploadCommand({
                Bucket: input.bucket,
                Key: input.key,
                UploadId: upload.uploadId,
              }),
              { abortSignal: AbortSignal.timeout(MULTIPART_CLEANUP_TIMEOUT_MS) },
            )
            .catch(() => {});
        }
        throw error;
      } finally {
        abort.signal.removeEventListener('abort', onAbort);
      }
      // No shield: Upload reads the body itself (async iteration handles
      // errors) and must see the failure to send AbortMultipartUpload.
    }, { shieldBody: false });
  }

  async deleteObject(bucket: UploadBucket, key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  async listObjects(
    bucket: UploadBucket,
    { limit = 50, filter }: ListStoredObjectsOptions = {},
  ): Promise<StoredObject[]> {
    const objects: Array<{
      Key: string;
      Size?: number;
      LastModified?: Date;
    }> = [];
    let continuationToken: string | undefined;

    do {
      const output = await this.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          MaxKeys: 1_000,
          ContinuationToken: continuationToken,
        }),
      );
      objects.push(
        ...(output.Contents ?? []).filter(
          (item): item is typeof item & { Key: string } => Boolean(item.Key),
        ),
      );
      continuationToken = output.IsTruncated
        ? output.NextContinuationToken
        : undefined;
    } while (continuationToken);

    objects.sort(
      (left, right) =>
        (right.LastModified?.getTime() ?? 0) -
        (left.LastModified?.getTime() ?? 0),
    );

    // Ownership lives in object metadata, which listing does not return. HEAD
    // newest-first in bounded batches and stop once enough objects match, so
    // an uploader's own objects are not lost behind other users' newer ones.
    const matched: StoredObject[] = [];
    const max = Math.max(0, limit);
    for (let offset = 0; offset < objects.length && matched.length < max; offset += HEAD_BATCH_SIZE) {
      const batch = await Promise.all(
        objects.slice(offset, offset + HEAD_BATCH_SIZE).map(async (item) => {
          const head = await this.client.send(
            new HeadObjectCommand({ Bucket: bucket, Key: item.Key }),
          );
          return {
            bucket,
            key: item.Key,
            size: item.Size ?? head.ContentLength ?? 0,
            lastModified: item.LastModified ?? head.LastModified ?? null,
            metadata: normalizeMetadata(head.Metadata),
          };
        }),
      );
      matched.push(...(filter ? batch.filter(filter) : batch));
    }
    return matched.slice(0, max);
  }
}

export function createStorageAdapter(
  config: MinioConfig = getMinioConfig(),
): StorageAdapter {
  return new S3StorageAdapter(
    new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      // socketTimeout is an inactivity limit on each MinIO request (not a
      // total duration), so a hung MinIO response, e.g. to
      // CompleteMultipartUpload, cannot hold an upload forever.
      requestHandler: {
        connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
        socketTimeout: UPLOAD_IDLE_TIMEOUT_MS,
      },
    }),
  );
}

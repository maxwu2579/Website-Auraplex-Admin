import {
  UPLOAD_HEADERS,
  UPLOAD_MEDIA_ROUTES,
  type UploadMediaRoute,
  type UploadObjectLocation,
  type UploadRequestMetadata,
} from '@/lib/admin/upload-contract';
import {
  ingestLineForBusinessLine,
  isBusinessLine,
  type BusinessLine,
  type IngestLine,
} from '@/lib/admin/upload-domain';
import { UploadContractError } from '@/lib/admin/upload-errors';
import { buildUploadObjectKey } from '@/lib/admin/object-key';
import { toQdrantSourceKey } from '@/lib/admin/source-key';
import { findUploadProduct, hasUploadProducts, type UploadProduct } from '@/lib/admin/upload-products';
import { getServerUploadMaxBytes } from '@/lib/admin/server/upload-limit';

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name)?.trim();
  if (!value) {
    throw new UploadContractError(
      400,
      'MALFORMED_REQUEST',
      `Missing required header: ${name}`,
    );
  }
  return value;
}

function decodeFilenameHeader(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new UploadContractError(
      400,
      'INVALID_FILENAME',
      'Filename header is not valid UTF-8 percent-encoding',
    );
  }
}

function sanitizeSegment(value: string, fallback?: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/[-_]{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');

  if (normalized) return normalized;
  if (fallback) return fallback;
  throw new UploadContractError(400, 'INVALID_FILENAME', 'Filename is empty after sanitization');
}

export function parseBusinessLine(value: string): BusinessLine {
  if (!isBusinessLine(value)) {
    throw new UploadContractError(
      400,
      'MALFORMED_REQUEST',
      'Business line is not valid',
    );
  }
  return value;
}

export function resolveUploadProduct(productId: string, businessLine: BusinessLine): UploadProduct {
  if (!hasUploadProducts(businessLine)) {
    throw new UploadContractError(
      400,
      'INVALID_PRODUCT',
      'No products are configured for this business line yet',
    );
  }
  const product = findUploadProduct(productId);
  if (!product) {
    throw new UploadContractError(400, 'INVALID_PRODUCT', 'Product ID does not exist');
  }
  if (product.businessLine !== businessLine) {
    throw new UploadContractError(
      400,
      'PRODUCT_LINE_MISMATCH',
      'Product does not belong to the selected business line',
    );
  }
  return product;
}

export function sanitizeUploadFilename(originalFilename: string): string {
  const trimmed = originalFilename.trim();
  if (!trimmed || /[\\/\0-\x1f\x7f]/.test(trimmed)) {
    throw new UploadContractError(
      400,
      'INVALID_FILENAME',
      'Filename contains a path separator or control character',
    );
  }

  const lastDot = trimmed.lastIndexOf('.');
  const hasExtension = lastDot > 0 && lastDot < trimmed.length - 1;
  const rawStem = hasExtension ? trimmed.slice(0, lastDot) : trimmed;
  const rawExtension = hasExtension ? trimmed.slice(lastDot + 1) : '';
  const stem = sanitizeSegment(rawStem, 'file');
  const extension = rawExtension ? sanitizeSegment(rawExtension) : '';
  const reserved = new Set(['.', '..']);
  const candidate = extension ? `${stem}.${extension}` : stem;

  if (
    reserved.has(candidate) ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(candidate)
  ) {
    throw new UploadContractError(400, 'INVALID_FILENAME', 'Filename is not safe');
  }

  // 255 ASCII bytes keeps this single path segment interoperable with common
  // filesystem-backed tooling while leaving the extension intact.
  const maxLength = 255;
  if (candidate.length <= maxLength) return candidate;

  if (!extension) return candidate.slice(0, maxLength).replace(/[._-]+$/g, '');
  const stemBudget = maxLength - extension.length - 1;
  if (stemBudget < 1) {
    throw new UploadContractError(400, 'INVALID_FILENAME', 'Filename extension is too long');
  }
  const shortenedStem = stem.slice(0, Math.max(stemBudget, 1)).replace(/[._-]+$/g, '');
  return `${shortenedStem || 'file'}.${extension}`;
}

function fileTooLarge(maxBytes: number, prefix = 'File'): UploadContractError {
  return new UploadContractError(
    413,
    'FILE_TOO_LARGE',
    `${prefix} exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`,
  );
}

/**
 * Content-Length is optional (chunked uploads through proxies omit it). When
 * present it must be a positive integer within the runtime limit; when absent
 * the byte counter's actual total is authoritative.
 */
export function validateDeclaredSize(
  rawContentLength: string | null,
  maxBytes = getServerUploadMaxBytes(),
): number | undefined {
  if (rawContentLength === null || rawContentLength.trim() === '') return undefined;

  if (!/^\d+$/.test(rawContentLength.trim())) {
    throw new UploadContractError(
      400,
      'INVALID_CONTENT_LENGTH',
      'Content-Length must be a positive integer',
    );
  }

  const size = Number(rawContentLength);
  if (!Number.isSafeInteger(size)) {
    throw new UploadContractError(
      400,
      'INVALID_CONTENT_LENGTH',
      'Content-Length is outside the supported range',
    );
  }
  if (size === 0) {
    throw new UploadContractError(400, 'EMPTY_FILE', 'Empty files are not accepted');
  }
  if (size > maxBytes) throw fileTooLarge(maxBytes);
  return size;
}

/**
 * An upload fails with 408 when no bytes move through it for this long. It is
 * a no-progress limit, not a total duration limit: a slow but steadily
 * progressing 500 MB upload is never cut off. Node's HTTP server does not time
 * out a stalled request body once Next.js has dispatched the handler, so this
 * is what stops an abandoned-but-open connection from holding an upload slot.
 */
export const UPLOAD_IDLE_TIMEOUT_MS = 120_000;

export interface UploadByteCounterOptions {
  /** Runtime per-file limit (413 when exceeded). */
  maxBytes?: number;
  /** Declared Content-Length, when present (400 SIZE_MISMATCH on mismatch). */
  expectedBytes?: number;
  /** Remaining hourly byte volume for this user (429 when exceeded). */
  volumeAllowanceBytes?: number;
  /** No-progress limit (408); defaults to UPLOAD_IDLE_TIMEOUT_MS, 0 disables. */
  idleTimeoutMs?: number;
}

export interface UploadByteCounter {
  readonly stream: TransformStream<Uint8Array, Uint8Array>;
  /** Bytes that actually passed through the stream so far. */
  readonly receivedBytes: number;
  /** Clears the idle timer; call once the upload has settled either way. */
  stop(): void;
}

/**
 * Counts the bytes that actually pass through an upload stream without
 * buffering them. The final count is authoritative for storage, rate-limit
 * volume and audit, whether or not Content-Length was sent.
 *
 * The idle timer restarts whenever a chunk passes. Chunks pass only when the
 * storage side pulls, so a stall on either side (silent client, or MinIO no
 * longer accepting parts) counts as no progress and errors the stream, which
 * aborts the storage request through the existing body-failure path.
 */
export function createUploadByteCounter(
  options: UploadByteCounterOptions = {},
): UploadByteCounter {
  const maxBytes = options.maxBytes ?? getServerUploadMaxBytes();
  const { expectedBytes, volumeAllowanceBytes } = options;
  const idleTimeoutMs = options.idleTimeoutMs ?? UPLOAD_IDLE_TIMEOUT_MS;
  let receivedBytes = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const stopIdleTimer = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const armIdleTimer = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (!idleTimeoutMs) return;
    stopIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      controller.error(new UploadContractError(
        408,
        'REQUEST_TIMEOUT',
        `Upload stalled: no data received for ${Math.round(idleTimeoutMs / 1000)} seconds`,
      ));
    }, idleTimeoutMs);
    // Never keep the process alive just for this timer.
    idleTimer.unref?.();
  };
  const limitError = (): UploadContractError | null => {
    if (receivedBytes > maxBytes) return fileTooLarge(maxBytes, 'Received file data');
    if (expectedBytes !== undefined && receivedBytes > expectedBytes) {
      return new UploadContractError(
        400,
        'SIZE_MISMATCH',
        'Received file size does not match Content-Length',
      );
    }
    if (volumeAllowanceBytes !== undefined && receivedBytes > volumeAllowanceBytes) {
      return new UploadContractError(429, 'RATE_LIMITED', 'Upload rate limit exceeded');
    }
    return null;
  };

  const stream = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      armIdleTimer(controller);
    },
    transform(chunk, controller) {
      receivedBytes += chunk.byteLength;
      const error = limitError();
      if (error) {
        stopIdleTimer();
        throw error;
      }
      armIdleTimer(controller);
      controller.enqueue(chunk);
    },
    flush() {
      stopIdleTimer();
      if (expectedBytes !== undefined && receivedBytes !== expectedBytes) {
        throw new UploadContractError(
          400,
          'SIZE_MISMATCH',
          'Received file size does not match Content-Length',
        );
      }
      if (receivedBytes === 0) {
        throw new UploadContractError(400, 'EMPTY_FILE', 'Empty files are not accepted');
      }
    },
  });

  return {
    stream,
    get receivedBytes() {
      return receivedBytes;
    },
    stop: stopIdleTimer,
  };
}

export function resolveUploadMedia(
  declaredMimeType: string,
  safeFilename: string,
): UploadMediaRoute {
  const mime = declaredMimeType.split(';', 1)[0].trim().toLowerCase();
  const route = UPLOAD_MEDIA_ROUTES[mime];
  const extension = safeFilename.split('.').pop()?.toLowerCase() ?? '';

  if (!route || !route.acceptedExtensions.includes(extension)) {
    throw new UploadContractError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Declared media type and filename extension are not supported',
    );
  }
  return route;
}

export function buildUploadObjectLocation(input: {
  ingestLine: IngestLine;
  productSlug: string;
  safeFilename: string;
  media: UploadMediaRoute;
}): UploadObjectLocation {
  const location = {
    bucket: input.media.bucket,
    key: buildUploadObjectKey(input),
  };
  return { ...location, sourceKey: toQdrantSourceKey(location) };
}

export function parseUploadRequestMetadata(headers: Headers): UploadRequestMetadata {
  const businessLine = parseBusinessLine(
    requiredHeader(headers, UPLOAD_HEADERS.productLine),
  );
  const productId = requiredHeader(headers, UPLOAD_HEADERS.productId);
  const originalFilename = decodeFilenameHeader(
    requiredHeader(headers, UPLOAD_HEADERS.filename),
  );
  const declaredMimeType = requiredHeader(headers, 'content-type')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  const declaredSize = validateDeclaredSize(headers.get('content-length'));
  const csrfToken = headers.get(UPLOAD_HEADERS.csrfToken)?.trim();
  if (!csrfToken) {
    throw new UploadContractError(
      400,
      'MISSING_CSRF_TOKEN',
      'CSRF token is required by the upload contract',
    );
  }

  return {
    businessLine,
    productId,
    originalFilename,
    declaredMimeType,
    declaredSize,
    csrfToken,
  };
}

export function prepareUploadRequest(headers: Headers) {
  const metadata = parseUploadRequestMetadata(headers);
  const product = resolveUploadProduct(metadata.productId, metadata.businessLine);
  const ingestLine = ingestLineForBusinessLine(product.businessLine);
  const safeFilename = sanitizeUploadFilename(metadata.originalFilename);
  const media = resolveUploadMedia(metadata.declaredMimeType, safeFilename);
  const location = buildUploadObjectLocation({
    ingestLine,
    productSlug: product.slug,
    safeFilename,
    media,
  });

  return { metadata, product, ingestLine, safeFilename, media, location };
}

export const uploadMediaRoutes = UPLOAD_MEDIA_ROUTES;

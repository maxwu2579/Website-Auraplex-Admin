import type { BusinessLine } from '@/lib/admin/upload-domain';

export type UploadStatus =
  | 'pending'
  | 'processed'
  | 'failed'
  | 'unsupported';

export type UiUploadQueueStatus = 'ready' | 'uploading' | 'uploaded' | 'failed' | 'unsupported';

// Optional build-time UI ceiling only. The server-enforced cap comes from
// ADMIN_UPLOAD_MAX_MB at request time and is passed to the admin page.
const configuredClientUploadMb = Number(process.env.NEXT_PUBLIC_ADMIN_UPLOAD_MAX_MB);
export const CLIENT_UPLOAD_MAX_MB = Number.isSafeInteger(configuredClientUploadMb) && configuredClientUploadMb > 0
  ? configuredClientUploadMb
  : null;

export function effectiveClientUploadMaxMb(serverMaxMb: number): number {
  return CLIENT_UPLOAD_MAX_MB === null ? serverMaxMb : Math.min(CLIENT_UPLOAD_MAX_MB, serverMaxMb);
}

export const UPLOAD_HEADERS = {
  filename: 'x-upload-filename',
  productLine: 'x-product-line',
  productId: 'x-product-id',
  csrfToken: 'x-csrf-token',
} as const;

export interface UploadRequestMetadata {
  businessLine: BusinessLine;
  productId: string;
  originalFilename: string;
  declaredMimeType: string;
  /** Present only when the request carried Content-Length. */
  declaredSize?: number;
  csrfToken: string;
}

export interface UploadSuccessResponse {
  ok: true;
  uploadId: string;
  bucket: UploadBucket;
  key: string;
  sourceKey: string;
  /** Bytes actually received and stored. */
  size: number;
  status: UploadStatus;
}

export interface RecentUpload {
  uploadId: string;
  bucket: UploadBucket;
  key: string;
  sourceKey: string;
  filename: string;
  size: number;
  uploadedAt: string | null;
  ingestionCapability: UploadMediaRoute['ingestionCapability'];
  status: UploadStatus;
}

export interface DeleteUploadResponse {
  ok: true;
  bucket: UploadBucket;
  key: string;
  sourceKey: string;
}

export interface RecentUploadsResponse {
  ok: true;
  uploads: RecentUpload[];
  qdrantAvailable: boolean;
}

export type UploadApiErrorCode =
  | 'MALFORMED_REQUEST'
  | 'REQUEST_TIMEOUT'
  | 'INVALID_CONTENT_LENGTH'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'SIZE_MISMATCH'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'MIME_MISMATCH'
  | 'INVALID_FILENAME'
  | 'INVALID_PRODUCT'
  | 'PRODUCT_LINE_MISMATCH'
  | 'MISSING_CSRF_TOKEN'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'UPLOAD_CAPACITY_EXHAUSTED'
  | 'BACKEND_NOT_CONFIGURED'
  | 'PARTIAL_DELETE'
  | 'INTERNAL_ERROR';

export type UploadApiErrorStatus =
  | 400
  | 408
  | 401
  | 403
  | 413
  | 415
  | 429
  | 500
  | 503;

export const UPLOAD_ERROR_STATUS = {
  MALFORMED_REQUEST: 400,
  REQUEST_TIMEOUT: 408,
  INVALID_CONTENT_LENGTH: 400,
  EMPTY_FILE: 400,
  FILE_TOO_LARGE: 413,
  SIZE_MISMATCH: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  MIME_MISMATCH: 415,
  INVALID_FILENAME: 400,
  INVALID_PRODUCT: 400,
  PRODUCT_LINE_MISMATCH: 400,
  MISSING_CSRF_TOKEN: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  UPLOAD_CAPACITY_EXHAUSTED: 503,
  BACKEND_NOT_CONFIGURED: 503,
  PARTIAL_DELETE: 500,
  INTERNAL_ERROR: 500,
} as const satisfies Record<UploadApiErrorCode, UploadApiErrorStatus>;

export interface UploadApiErrorResponse {
  ok: false;
  code: UploadApiErrorCode;
  error: string;
}

export type UploadApiResponse = UploadSuccessResponse | UploadApiErrorResponse;

export interface UploadObjectLocation {
  bucket: UploadBucket;
  key: string;
  sourceKey: string;
}

export type UploadBucket =
  | 'auraplex-raw-pdf'
  | 'auraplex-raw-image'
  | 'auraplex-raw-video';

export const UPLOAD_BUCKETS: readonly UploadBucket[] = [
  'auraplex-raw-pdf',
  'auraplex-raw-image',
  'auraplex-raw-video',
];

export interface UploadMediaRoute {
  bucket: UploadBucket;
  canonicalMimeType: string;
  acceptedExtensions: readonly string[];
  ingestionCapability: 'supported' | 'deferred';
}

export const UPLOAD_MEDIA_ROUTES: Readonly<Record<string, UploadMediaRoute>> = {
  'application/pdf': {
    bucket: 'auraplex-raw-pdf',
    canonicalMimeType: 'application/pdf',
    acceptedExtensions: ['pdf'],
    ingestionCapability: 'supported',
  },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    bucket: 'auraplex-raw-pdf',
    canonicalMimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    acceptedExtensions: ['docx'],
    ingestionCapability: 'deferred',
  },
  'image/png': {
    bucket: 'auraplex-raw-image',
    canonicalMimeType: 'image/png',
    acceptedExtensions: ['png'],
    ingestionCapability: 'deferred',
  },
  'image/jpeg': {
    bucket: 'auraplex-raw-image',
    canonicalMimeType: 'image/jpeg',
    acceptedExtensions: ['jpg', 'jpeg'],
    ingestionCapability: 'deferred',
  },
  'video/mp4': {
    bucket: 'auraplex-raw-video',
    canonicalMimeType: 'video/mp4',
    acceptedExtensions: ['mp4'],
    ingestionCapability: 'deferred',
  },
};

export const ACCEPTED_UPLOAD_EXTENSIONS = Object.freeze(
  Array.from(
    new Set(
      Object.values(UPLOAD_MEDIA_ROUTES).flatMap(
        (route) => route.acceptedExtensions,
      ),
    ),
  ),
);

/**
 * react-dropzone `accept` map, derived from the same routes the server
 * enforces. It filters the file picker only; the server remains authoritative.
 */
export const UPLOAD_DROPZONE_ACCEPT: Readonly<Record<string, string[]>> = Object.freeze(
  Object.fromEntries(
    Object.values(UPLOAD_MEDIA_ROUTES).map((route) => [
      route.canonicalMimeType,
      route.acceptedExtensions.map((extension) => `.${extension}`),
    ]),
  ),
);

export function uploadMediaForExtension(
  extension: string,
): UploadMediaRoute | undefined {
  const normalized = extension.toLowerCase();
  return Object.values(UPLOAD_MEDIA_ROUTES).find((route) =>
    route.acceptedExtensions.includes(normalized),
  );
}

import type {
  UploadApiErrorCode,
  UploadApiErrorResponse,
  UploadApiErrorStatus,
} from '@/lib/admin/upload-contract';
import { UPLOAD_ERROR_STATUS } from '@/lib/admin/upload-contract';

export class UploadContractError extends Error {
  constructor(
    public readonly status: UploadApiErrorStatus,
    public readonly code: UploadApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UploadContractError';
    if (status !== UPLOAD_ERROR_STATUS[code]) {
      throw new Error(`Upload error ${code} must use HTTP ${UPLOAD_ERROR_STATUS[code]}`);
    }
  }
}

export function createUploadErrorBody(
  code: UploadApiErrorCode,
  error: string,
): UploadApiErrorResponse {
  return { ok: false, code, error };
}

export function normalizeUploadError(error: unknown): {
  status: UploadApiErrorStatus;
  body: UploadApiErrorResponse;
} {
  if (error instanceof UploadContractError) {
    return {
      status: error.status,
      body: createUploadErrorBody(error.code, error.message),
    };
  }

  return {
    status: 500,
    body: createUploadErrorBody(
      'INTERNAL_ERROR',
      'The upload request could not be processed',
    ),
  };
}

import { isIngestLine, type IngestLine } from '@/lib/admin/upload-domain';
import { UploadContractError } from '@/lib/admin/upload-errors';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FILENAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_FILENAME_LENGTH = 255;

export interface UploadObjectKeyParts {
  ingestLine: IngestLine;
  productSlug: string;
  safeFilename: string;
}

function assertSafeParts(parts: { productSlug: string; safeFilename: string }): void {
  if (!SLUG_PATTERN.test(parts.productSlug)) {
    throw new UploadContractError(400, 'INVALID_PRODUCT', 'Product slug is not safe');
  }
  if (
    parts.safeFilename.length > MAX_FILENAME_LENGTH ||
    !FILENAME_PATTERN.test(parts.safeFilename) ||
    parts.safeFilename === '.' ||
    parts.safeFilename === '..'
  ) {
    throw new UploadContractError(400, 'INVALID_FILENAME', 'Filename is not safe');
  }
}

/**
 * Confirmed ingest contract: `{ingest_line}/{product.slug}/{safe_filename}`.
 * Exactly three segments; the same product and filename map to the same key,
 * so S3/MinIO overwrites that object.
 */
export function buildUploadObjectKey(parts: UploadObjectKeyParts): string {
  if (!isIngestLine(parts.ingestLine)) {
    throw new UploadContractError(400, 'MALFORMED_REQUEST', 'Ingest line is not valid');
  }
  assertSafeParts(parts);
  return `${parts.ingestLine}/${parts.productSlug}/${parts.safeFilename}`;
}

/**
 * Parses a stored object key. Unknown or legacy first segments (for example a
 * website category such as `labelling/`) fail explicitly; they are never
 * defaulted to an ingest line.
 */
export function parseUploadObjectKey(key: string): UploadObjectKeyParts {
  const segments = key.split('/');
  if (segments.length !== 3) {
    throw new UploadContractError(400, 'MALFORMED_REQUEST', 'Invalid object key');
  }
  const [ingestLine, productSlug, safeFilename] = segments;
  if (!isIngestLine(ingestLine)) {
    throw new UploadContractError(
      400,
      'MALFORMED_REQUEST',
      'Object key is not in a supported ingest location',
    );
  }
  try {
    assertSafeParts({ productSlug, safeFilename });
  } catch {
    throw new UploadContractError(400, 'MALFORMED_REQUEST', 'Invalid object key');
  }
  return { ingestLine, productSlug, safeFilename };
}

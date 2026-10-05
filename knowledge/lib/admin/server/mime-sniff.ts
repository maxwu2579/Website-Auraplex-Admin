import type { FileTypeResult } from 'file-type';
import type { UploadMediaRoute } from '@/lib/admin/upload-contract';
import { UploadContractError } from '@/lib/admin/upload-errors';

// file-type recommends 4,100 bytes for broad detection. Only this prefix is
// copied for inspection; the original chunks are replayed into the upload.
export const UPLOAD_SNIFF_BYTES = 4_100;

// ASF is not an accepted upload format. Reject its fixed header before the
// locked file-type v19 parser because affected v19 releases can loop forever
// on a malformed zero-size ASF sub-header (GHSA-5v7r-6r5c-r473).
const ASF_HEADER = new Uint8Array([
  0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11,
  0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c,
]);

function startsWith(bytes: Uint8Array, signature: Uint8Array): boolean {
  if (bytes.byteLength < signature.byteLength) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

export interface SniffedUploadStream {
  stream: ReadableStream<Uint8Array>;
  detected: FileTypeResult;
}

function assertDetectedMedia(
  detected: FileTypeResult | undefined,
  expected: UploadMediaRoute,
): asserts detected is FileTypeResult {
  if (!detected) {
    throw new UploadContractError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'File content type could not be identified',
    );
  }

  if (detected.mime !== expected.canonicalMimeType) {
    throw new UploadContractError(
      415,
      'MIME_MISMATCH',
      'File content does not match the declared media type and extension',
    );
  }
}

/**
 * Reads and validates only the leading detection window, then returns a stream
 * that replays every byte (including the sniffed prefix) exactly once.
 */
export async function sniffUploadStream(
  source: ReadableStream<Uint8Array>,
  expected: UploadMediaRoute,
  sniffBytes = UPLOAD_SNIFF_BYTES,
): Promise<SniffedUploadStream> {
  const reader = source.getReader();
  const prefix = new Uint8Array(sniffBytes);
  const replayChunks: Uint8Array[] = [];
  let prefixLength = 0;

  try {
    while (prefixLength < sniffBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      replayChunks.push(value);
      const copyLength = Math.min(value.byteLength, sniffBytes - prefixLength);
      prefix.set(value.subarray(0, copyLength), prefixLength);
      prefixLength += copyLength;
    }

    // file-type v19 is ESM-only; dynamic import keeps the repository's current
    // CommonJS-compatible test runner working without changing app module mode.
    if (startsWith(prefix.subarray(0, prefixLength), ASF_HEADER)) {
      throw new UploadContractError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'ASF content is not an accepted upload type',
      );
    }
    const { fileTypeFromBuffer } = await import('file-type');
    let detected: FileTypeResult | undefined;
    try {
      detected = await fileTypeFromBuffer(prefix.subarray(0, prefixLength));
    } catch {
      throw new UploadContractError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'File content type could not be identified from the inspection window',
      );
    }
    assertDetectedMedia(detected, expected);

    let replayIndex = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (replayIndex < replayChunks.length) {
          controller.enqueue(replayChunks[replayIndex]);
          replayIndex += 1;
          return;
        }
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });

    return { stream, detected };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
}

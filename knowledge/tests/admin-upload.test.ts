import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { PUT } from '../app/api/admin/uploads/route';
import {
  CLIENT_UPLOAD_MAX_MB,
  effectiveClientUploadMaxMb,
  UPLOAD_ERROR_STATUS,
} from '../lib/admin/upload-contract';
import {
  BUSINESS_LINES,
  BUSINESS_TO_INGEST_LINE,
  INGEST_LINES,
  ingestLineForBusinessLine,
  type IngestLine,
} from '../lib/admin/upload-domain';
import { buildUploadObjectKey, parseUploadObjectKey } from '../lib/admin/object-key';
import { parseQdrantSourceKey, toQdrantSourceKey } from '../lib/admin/source-key';
import { UPLOAD_PRODUCTS } from '../lib/admin/upload-products';
import {
  buildUploadObjectLocation,
  createUploadByteCounter,
  parseBusinessLine,
  prepareUploadRequest,
  resolveUploadMedia,
  resolveUploadProduct,
  sanitizeUploadFilename,
  validateDeclaredSize,
} from '../lib/admin/upload-validation';
import {
  createUploadErrorBody,
  UploadContractError,
} from '../lib/admin/upload-errors';
import { sniffUploadStream } from '../lib/admin/server/mime-sniff';
import { getServerUploadMaxBytes, getServerUploadMaxMb } from '../lib/admin/server/upload-limit';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\ncomplete-pdf-body');
const PNG_BYTES = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
const MP4_BYTES = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
const DOCX_BYTES = (() => {
  const filename = new TextEncoder().encode('word/document.xml');
  const bytes = new Uint8Array(30 + filename.byteLength);
  bytes.set([0x50, 0x4b, 0x03, 0x04], 0);
  bytes[26] = filename.byteLength;
  bytes.set(filename, 30);
  return bytes;
})();

function expectContractError(
  callback: () => unknown,
  code: string,
  status?: number,
) {
  assert.throws(callback, (error: unknown) => {
    assert.ok(error instanceof UploadContractError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

test('exposes exactly five business lines and three ingest lines', () => {
  assert.deepEqual([...BUSINESS_LINES], ['labelling', 'packaging', 'automation', 'software', 'consulting']);
  assert.deepEqual([...INGEST_LINES], ['machines', 'software', 'consulting']);
  for (const line of BUSINESS_LINES) assert.equal(parseBusinessLine(line), line);
  expectContractError(() => parseBusinessLine('machines'), 'MALFORMED_REQUEST', 400);
});

test('maps business lines to the confirmed ingest lines', () => {
  assert.deepEqual({ ...BUSINESS_TO_INGEST_LINE }, {
    labelling: 'machines',
    packaging: 'machines',
    automation: 'machines',
    software: 'software',
    consulting: 'consulting',
  });
  assert.equal(ingestLineForBusinessLine('labelling'), 'machines');
  assert.equal(ingestLineForBusinessLine('packaging'), 'machines');
  assert.equal(ingestLineForBusinessLine('automation'), 'machines');
  assert.equal(ingestLineForBusinessLine('software'), 'software');
  assert.equal(ingestLineForBusinessLine('consulting'), 'consulting');
});

test('resolves a real catalogue product by ID and business line', () => {
  const product = resolveUploadProduct('6470625', 'labelling');
  assert.equal(product.slug, 'flexy-applicator');
  assert.equal(product.businessLine, 'labelling');
});

test('software and consulting have no invented products and reject uploads', () => {
  for (const line of ['software', 'consulting'] as const) {
    assert.equal(UPLOAD_PRODUCTS.some((product) => product.businessLine === line), false);
    expectContractError(() => resolveUploadProduct('6470625', line), 'INVALID_PRODUCT', 400);
  }
  for (const line of ['labelling', 'packaging', 'automation'] as const) {
    assert.equal(UPLOAD_PRODUCTS.some((product) => product.businessLine === line), true);
  }
});

test('every catalogue product slug is a valid object-key segment', () => {
  for (const product of UPLOAD_PRODUCTS) {
    assert.doesNotThrow(() => buildUploadObjectKey({
      ingestLine: ingestLineForBusinessLine(product.businessLine),
      productSlug: product.slug,
      safeFilename: 'manual.pdf',
    }), product.slug);
  }
});

test('rejects an unknown product ID', () => {
  expectContractError(
    () => resolveUploadProduct('not-a-product', 'labelling'),
    'INVALID_PRODUCT',
    400,
  );
});

test('rejects a product line and product ID mismatch', () => {
  expectContractError(
    () => resolveUploadProduct('6470625', 'packaging'),
    'PRODUCT_LINE_MISMATCH',
    400,
  );
});

test('sanitizes ordinary and Unicode filenames deterministically', () => {
  assert.equal(sanitizeUploadFilename(' Product Manual V2.PDF '), 'product-manual-v2.pdf');
  assert.equal(sanitizeUploadFilename('AR 600 中文手册.pdf'), 'ar-600.pdf');
  assert.equal(sanitizeUploadFilename('Résumé final.pdf'), 'resume-final.pdf');
});

test('allows longer filenames but preserves the extension within 255 ASCII bytes', () => {
  const filename = sanitizeUploadFilename(`${'a'.repeat(300)}.pdf`);
  assert.equal(filename.length, 255);
  assert.equal(filename.endsWith('.pdf'), true);
  assert.equal(sanitizeUploadFilename(`${'a'.repeat(190)}.pdf`).length, 194);
});

test('rejects path traversal and control characters', () => {
  for (const filename of ['../secret.pdf', '..\\secret.pdf', '/tmp/file.pdf', 'a\0b.pdf']) {
    expectContractError(
      () => sanitizeUploadFilename(filename),
      'INVALID_FILENAME',
      400,
    );
  }
});

test('routes supported MIME types to the specified buckets', () => {
  assert.equal(resolveUploadMedia('application/pdf', 'manual.pdf').bucket, 'auraplex-raw-pdf');
  assert.equal(
    resolveUploadMedia(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'manual.docx',
    ).bucket,
    'auraplex-raw-pdf',
  );
  assert.equal(resolveUploadMedia('image/jpeg', 'photo.jpg').bucket, 'auraplex-raw-image');
  assert.equal(resolveUploadMedia('image/png', 'photo.png').bucket, 'auraplex-raw-image');
  assert.equal(resolveUploadMedia('video/mp4', 'demo.mp4').bucket, 'auraplex-raw-video');
});

test('keeps storage acceptance separate from ingestion capability', () => {
  assert.equal(resolveUploadMedia('application/pdf', 'manual.pdf').ingestionCapability, 'supported');
  assert.equal(resolveUploadMedia('image/png', 'diagram.png').ingestionCapability, 'deferred');
});

test('rejects unsupported MIME types and extension mismatches', () => {
  expectContractError(
    () => resolveUploadMedia('application/octet-stream', 'manual.pdf'),
    'UNSUPPORTED_MEDIA_TYPE',
    415,
  );
  expectContractError(
    () => resolveUploadMedia('image/jpeg', 'manual.pdf'),
    'UNSUPPORTED_MEDIA_TYPE',
    415,
  );
  for (const [mime, filename] of [
    ['image/webp', 'photo.webp'],
    ['video/webm', 'demo.webm'],
    ['video/quicktime', 'demo.mov'],
  ]) {
    expectContractError(() => resolveUploadMedia(mime, filename), 'UNSUPPORTED_MEDIA_TYPE', 415);
  }
});

test('builds {ingest_line}/{product.slug}/{file} and a bucket/key source_key', () => {
  const media = resolveUploadMedia('application/pdf', 'manual.pdf');
  const location = buildUploadObjectLocation({
    ingestLine: 'machines',
    productSlug: 'flexy-applicator',
    safeFilename: 'bottom-labelling-machine-brochure.pdf',
    media,
  });

  assert.deepEqual(location, {
    bucket: 'auraplex-raw-pdf',
    key: 'machines/flexy-applicator/bottom-labelling-machine-brochure.pdf',
    sourceKey: 'auraplex-raw-pdf/machines/flexy-applicator/bottom-labelling-machine-brochure.pdf',
  });
  assert.equal(location.key.split('/').length, 3);
});

test('prepared uploads use the mapped ingest line and keep product.slug', () => {
  const prepared = prepareUploadRequest(new Headers({
    'content-type': 'application/pdf',
    'x-product-line': 'labelling',
    'x-product-id': '6470625',
    'x-upload-filename': encodeURIComponent('Bottom Labelling Machine Brochure.pdf'),
    'x-csrf-token': 'token',
  }));
  assert.equal(prepared.ingestLine, 'machines');
  assert.equal(prepared.location.key, 'machines/flexy-applicator/bottom-labelling-machine-brochure.pdf');
  assert.equal(prepared.metadata.declaredSize, undefined);
});

test('source_key is built once from bucket and key and round-trips', () => {
  const location = { bucket: 'auraplex-raw-video', key: 'software/some-product/demo.mp4' } as const;
  const sourceKey = toQdrantSourceKey(location);
  assert.equal(sourceKey, 'auraplex-raw-video/software/some-product/demo.mp4');
  assert.deepEqual(parseQdrantSourceKey(sourceKey), location);
  expectContractError(() => parseQdrantSourceKey('machines/p/manual.pdf'), 'MALFORMED_REQUEST', 400);
  expectContractError(() => parseQdrantSourceKey('unknown-bucket/machines/p/manual.pdf'), 'MALFORMED_REQUEST', 400);
});

test('object keys accept only ingest prefixes and reject legacy or extra paths', () => {
  for (const ingestLine of ['machines', 'software', 'consulting'] as const) {
    assert.deepEqual(parseUploadObjectKey(`${ingestLine}/product-a/manual.pdf`), {
      ingestLine,
      productSlug: 'product-a',
      safeFilename: 'manual.pdf',
    });
  }
  for (const key of [
    'labelling/flexy-applicator/manual.pdf',
    'packaging/p/manual.pdf',
    'unknown/p/manual.pdf',
    'machines/p/extra/manual.pdf',
    'machines/manual.pdf',
    'machines/../manual.pdf',
    'machines/p/../manual.pdf',
  ]) {
    expectContractError(() => parseUploadObjectKey(key), 'MALFORMED_REQUEST', 400);
  }
  expectContractError(
    () => buildUploadObjectKey({ ingestLine: 'labelling' as IngestLine, productSlug: 'p', safeFilename: 'manual.pdf' }),
    'MALFORMED_REQUEST',
    400,
  );
});

test('rejects unsafe object key components', () => {
  const media = resolveUploadMedia('application/pdf', 'manual.pdf');
  expectContractError(
    () => buildUploadObjectLocation({
      ingestLine: 'machines',
      productSlug: '../escape',
      safeFilename: 'manual.pdf',
      media,
    }),
    'INVALID_PRODUCT',
    400,
  );
});

test('validates zero, exact-limit, and over-limit file sizes', () => {
  assert.equal(getServerUploadMaxMb({}), 100);
  const maxBytes = getServerUploadMaxBytes({});
  expectContractError(() => validateDeclaredSize('0'), 'EMPTY_FILE', 400);
  assert.equal(validateDeclaredSize(String(maxBytes), maxBytes), maxBytes);
  expectContractError(
    () => validateDeclaredSize(String(maxBytes + 1), maxBytes),
    'FILE_TOO_LARGE',
    413,
  );
});

test('server upload limit is runtime-only and UI ceiling is independently bounded', () => {
  assert.equal(getServerUploadMaxMb({ ADMIN_UPLOAD_MAX_MB: '500' }), 500);
  assert.equal(getServerUploadMaxMb({ ADMIN_UPLOAD_MAX_MB: '25' }), 25);
  assert.throws(() => getServerUploadMaxMb({ ADMIN_UPLOAD_MAX_MB: '501' }));
  assert.throws(() => getServerUploadMaxMb({ ADMIN_UPLOAD_MAX_MB: '-1' }));
  assert.equal(CLIENT_UPLOAD_MAX_MB, null);
  assert.equal(effectiveClientUploadMaxMb(500), 500);
});

function chunkStream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return bytes;
    bytes += value.byteLength;
  }
}

async function assertStreamRejects(stream: ReadableStream<Uint8Array>, code: string, status: number) {
  await assert.rejects(drain(stream), (error: unknown) => {
    assert.ok(error instanceof UploadContractError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

test('counts streamed bytes without buffering and exposes the actual total', async () => {
  const counter = createUploadByteCounter({ maxBytes: 5 });
  assert.equal(await drain(chunkStream([new Uint8Array(3), new Uint8Array(2)]).pipeThrough(counter.stream)), 5);
  assert.equal(counter.receivedBytes, 5);

  const oversized = createUploadByteCounter({ maxBytes: 5 });
  await assertStreamRejects(chunkStream([new Uint8Array(6)]).pipeThrough(oversized.stream), 'FILE_TOO_LARGE', 413);
});

test('rejects declared and actual byte count mismatches with a stable 400', async () => {
  for (const chunks of [[new Uint8Array(4)], [new Uint8Array(2)]]) {
    const counter = createUploadByteCounter({ maxBytes: 10, expectedBytes: 3 });
    await assertStreamRejects(chunkStream(chunks).pipeThrough(counter.stream), 'SIZE_MISMATCH', 400);
  }
});

test('without Content-Length the actual stream is authoritative', async () => {
  const valid = createUploadByteCounter({ maxBytes: 10 });
  assert.equal(await drain(chunkStream([new Uint8Array(4), new Uint8Array(3)]).pipeThrough(valid.stream)), 7);
  assert.equal(valid.receivedBytes, 7);

  const empty = createUploadByteCounter({ maxBytes: 10 });
  await assertStreamRejects(chunkStream([]).pipeThrough(empty.stream), 'EMPTY_FILE', 400);

  const oversized = createUploadByteCounter({ maxBytes: 10 });
  await assertStreamRejects(chunkStream([new Uint8Array(6), new Uint8Array(6)]).pipeThrough(oversized.stream), 'FILE_TOO_LARGE', 413);
  assert.equal(oversized.receivedBytes, 12);
});

test('byte counter enforces the reserved hourly volume as a rate limit', async () => {
  const counter = createUploadByteCounter({ maxBytes: 100, volumeAllowanceBytes: 5 });
  await assertStreamRejects(chunkStream([new Uint8Array(4), new Uint8Array(4)]).pipeThrough(counter.stream), 'RATE_LIMITED', 429);
});

test('sniffs every accepted signature and preserves every stream byte', async () => {
  const cases = [
    { bytes: PDF_BYTES, mime: 'application/pdf', filename: 'manual.pdf' },
    { bytes: DOCX_BYTES, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: 'manual.docx' },
    { bytes: PNG_BYTES, mime: 'image/png', filename: 'diagram.png' },
    { bytes: JPEG_BYTES, mime: 'image/jpeg', filename: 'photo.jpg' },
    { bytes: MP4_BYTES, mime: 'video/mp4', filename: 'demo.mp4' },
  ];

  for (const item of cases) {
    const midpoint = Math.floor(item.bytes.byteLength / 2);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(item.bytes.slice(0, midpoint));
        controller.enqueue(item.bytes.slice(midpoint));
        controller.close();
      },
    });
    const sniffed = await sniffUploadStream(
      source,
      resolveUploadMedia(item.mime, item.filename),
    );
    const received: number[] = [];
    const reader = sniffed.stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received.push(...value);
    }
    assert.equal(sniffed.detected.mime, item.mime);
    assert.deepEqual(received, Array.from(item.bytes));
  }
});

test('replays the sniffed 4 KB plus the remaining streamed bytes', async () => {
  const bytes = new Uint8Array(8_500);
  bytes.set(PDF_BYTES, 0);
  for (let index = PDF_BYTES.length; index < bytes.length; index += 1) bytes[index] = index % 251;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += 517) {
        controller.enqueue(bytes.slice(index, index + 517));
      }
      controller.close();
    },
  });
  const { stream } = await sniffUploadStream(source, resolveUploadMedia('application/pdf', 'manual.pdf'));
  const received = new Uint8Array(bytes.length);
  let offset = 0;
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received.set(value, offset);
    offset += value.length;
  }
  assert.equal(offset, bytes.length);
  assert.deepEqual(received, bytes);
});

test('rejects MIME spoofing and unsupported binary content', async () => {
  await assert.rejects(
    sniffUploadStream(
      new Blob([PNG_BYTES]).stream(),
      resolveUploadMedia('application/pdf', 'manual.pdf'),
    ),
    (error: unknown) => {
      assert.ok(error instanceof UploadContractError);
      assert.equal(error.code, 'MIME_MISMATCH');
      return true;
    },
  );

  await assert.rejects(
    sniffUploadStream(
      new Blob([new Uint8Array([1, 2, 3, 4, 5])]).stream(),
      resolveUploadMedia('application/pdf', 'manual.pdf'),
    ),
    (error: unknown) => {
      assert.ok(error instanceof UploadContractError);
      assert.equal(error.code, 'UNSUPPORTED_MEDIA_TYPE');
      return true;
    },
  );

  const asfHeader = new Uint8Array([
    0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11,
    0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c,
  ]);
  await assert.rejects(
    sniffUploadStream(
      new Blob([asfHeader]).stream(),
      resolveUploadMedia('video/mp4', 'demo.mp4'),
    ),
    (error: unknown) => {
      assert.ok(error instanceof UploadContractError);
      assert.equal(error.code, 'UNSUPPORTED_MEDIA_TYPE');
      return true;
    },
  );
});

test('Content-Length is optional but validated when present', () => {
  assert.equal(validateDeclaredSize(null), undefined);
  assert.equal(validateDeclaredSize(''), undefined);
  assert.equal(validateDeclaredSize('1234'), 1234);
  for (const invalid of ['-1', 'abc', '1.5', '1e3', '12 34']) {
    expectContractError(() => validateDeclaredSize(invalid), 'INVALID_CONTENT_LENGTH', 400);
  }
  expectContractError(() => validateDeclaredSize('99999999999999999999'), 'INVALID_CONTENT_LENGTH', 400);
});

test('serializes stable API errors', () => {
  assert.deepEqual(
    createUploadErrorBody('FILE_TOO_LARGE', 'File exceeds the 100 MB limit'),
    {
      ok: false,
      code: 'FILE_TOO_LARGE',
      error: 'File exceeds the 100 MB limit',
    },
  );
  assert.equal(UPLOAD_ERROR_STATUS.UNAUTHENTICATED, 401);
  assert.equal(UPLOAD_ERROR_STATUS.FORBIDDEN, 403);
  assert.equal(UPLOAD_ERROR_STATUS.RATE_LIMITED, 429);
  assert.equal(UPLOAD_ERROR_STATUS.INTERNAL_ERROR, 500);
});

function makeUploadRequest(contentLength: number) {
  return new NextRequest('http://localhost/api/admin/uploads', {
    method: 'PUT',
    body: new Uint8Array([1]),
    headers: {
      'content-length': String(contentLength),
      'content-type': 'application/pdf',
      'x-csrf-token': 'contract-placeholder',
      'x-product-id': '6470625',
      'x-product-line': 'labelling',
      'x-upload-filename': encodeURIComponent('Product Manual.pdf'),
    },
  });
}

test('upload route fails honestly while backend integration is unavailable', async () => {
  const response = await PUT(makeUploadRequest(1));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'BACKEND_NOT_CONFIGURED');
});

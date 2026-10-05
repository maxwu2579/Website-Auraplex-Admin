import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { NextRequest } from 'next/server';
import {
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import {
  type UploadApiResponse,
} from '../lib/admin/upload-contract';
import { getServerUploadMaxBytes } from '../lib/admin/server/upload-limit';
import { UploadContractError } from '../lib/admin/upload-errors';
import { toQdrantSourceKey } from '../lib/admin/source-key';
import {
  createQdrantAdapter,
  qdrantCollectionForSourceKey,
  QDRANT_COLLECTIONS,
  QdrantRestEvidenceAdapter,
  type QdrantEvidenceAdapter,
} from '../lib/admin/server/qdrant';
import { getQdrantConfig, tryGetQdrantConfig } from '../lib/admin/server/config';
import { InMemoryUploadRateLimiter } from '../lib/admin/server/rate-limit';
import { createStorageAdapter, S3StorageAdapter, type StorageAdapter } from '../lib/admin/server/storage';
import {
  getUploads,
  putUpload,
  type UploadServiceDependencies,
} from '../lib/admin/server/upload-service';
import { buildRecentUpload, deriveUploadStatus } from '../lib/admin/server/status';
import { deleteUpload, readDeleteBody, validateDeleteTarget, type DeleteDependencies } from '../lib/admin/server/delete-service';
import { UPLOAD_METADATA } from '../lib/admin/server/object-metadata';
import { canRetryUpload, queueStatusAfterResponse } from '../lib/admin/upload-ui-state';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\ncomplete-pdf-body');

function uploadRequest(
  contentLength: number | null = PDF_BYTES.byteLength,
  body: Uint8Array = PDF_BYTES,
) {
  const headers: Record<string, string> = {
    'content-type': 'application/pdf',
    cookie: 'auraplex-admin-csrf=test-csrf',
    'x-csrf-token': 'test-csrf',
    'x-product-id': '6470625',
    'x-product-line': 'labelling',
    'x-upload-filename': encodeURIComponent('Product Manual.pdf'),
  };
  // null models a chunked request that carries no Content-Length.
  if (contentLength !== null) headers['content-length'] = String(contentLength);
  return new NextRequest('http://localhost/api/admin/uploads', {
    method: 'PUT',
    body: body.slice().buffer as ArrayBuffer,
    headers,
  });
}

function drainingStorage(onPut?: (input: Parameters<StorageAdapter['putObject']>[0], bytes: number) => void): StorageAdapter {
  return {
    async putObject(input) {
      let bytes = 0;
      for await (const chunk of input.body) bytes += Buffer.byteLength(chunk as Uint8Array);
      onPut?.(input, bytes);
      return {};
    },
    async listObjects() { return []; },
    async deleteObject() {},
  };
}

const unlimitedRateLimiter = {
  admit: () => ({ allowanceBytes: Number.MAX_SAFE_INTEGER, settle() {} }),
};

function dependencies(
  storage: StorageAdapter,
  overrides: Partial<UploadServiceDependencies> = {},
): Partial<UploadServiceDependencies> {
  return {
    authenticate: async () => ({
      userId: 'user-1',
      email: 'user@example.test',
      groups: ['auraplex-uploader'],
    }),
    csrf: { verify() {} },
    rateLimiter: unlimitedRateLimiter,
    audit: { write() {} },
    storage: () => storage,
    qdrant: () => null,
    createUploadId: () => 'upload-123',
    ...overrides,
  };
}

test('streams request bytes through the limiter and maps MinIO input', async () => {
  let receivedBytes = 0;
  let captured: Parameters<StorageAdapter['putObject']>[0] | undefined;
  const storage: StorageAdapter = {
    async putObject(input) {
      captured = input;
      for await (const chunk of input.body) {
        receivedBytes += Buffer.byteLength(chunk as Uint8Array);
      }
      return { etag: 'etag' };
    },
    async listObjects() {
      return [];
    },
    async deleteObject() {},
  };

  const response = await putUpload(uploadRequest(), dependencies(storage));
  const body = (await response.json()) as UploadApiResponse;
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(receivedBytes, PDF_BYTES.byteLength);
  assert.equal(captured?.bucket, 'auraplex-raw-pdf');
  assert.equal(captured?.key, 'machines/flexy-applicator/product-manual.pdf');
  assert.equal(captured?.contentLength, PDF_BYTES.byteLength);
  assert.equal(captured?.metadata['product-line'], 'labelling');
  assert.equal(captured?.metadata['product-id'], '6470625');
  assert.equal(captured?.metadata['safe-filename'], 'product-manual.pdf');
  assert.equal(captured?.metadata['upload-id'], 'upload-123');
  assert.equal(captured?.metadata['uploaded-by'], 'user-1');
  if (body.ok) {
    assert.equal(body.status, 'pending');
    assert.equal(body.key, 'machines/flexy-applicator/product-manual.pdf');
    assert.equal(body.sourceKey, 'auraplex-raw-pdf/machines/flexy-applicator/product-manual.pdf');
    assert.equal(body.size, PDF_BYTES.byteLength);
  }
});

test('missing Content-Length is accepted and actual bytes are authoritative', async () => {
  const audits: Array<{ action: string; size: number }> = [];
  const admissions: Array<number | undefined> = [];
  const settled: number[] = [];
  let stored: { contentLength?: number; bytes: number } | undefined;
  const body = new Uint8Array(9_000);
  body.set(PDF_BYTES, 0);
  const response = await putUpload(uploadRequest(null, body), dependencies(
    drainingStorage((input, bytes) => { stored = { contentLength: input.contentLength, bytes }; }),
    {
      audit: { write(event) { audits.push(event); } },
      rateLimiter: {
        admit(_user, request) {
          admissions.push(request.declaredBytes);
          return { allowanceBytes: request.maxUploadBytes, settle(bytes) { settled.push(bytes); } };
        },
      },
    },
  ));
  const json = await response.json();
  assert.equal(response.status, 200);
  assert.equal(json.size, 9_000);
  assert.deepEqual(stored, { contentLength: undefined, bytes: 9_000 });
  assert.deepEqual(admissions, [undefined]);
  assert.deepEqual(settled, [9_000]);
  assert.deepEqual(audits.map(({ action, size }) => ({ action, size })), [{ action: 'upload.accepted', size: 9_000 }]);
});

test('missing Content-Length with a zero-byte body fails as EMPTY_FILE', async () => {
  let stored = false;
  const response = await putUpload(uploadRequest(null, new Uint8Array(0)), dependencies(
    drainingStorage(() => { stored = true; }),
  ));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'EMPTY_FILE');
  assert.equal(stored, false);
});

test('missing Content-Length with a stream above the runtime limit returns 413', async () => {
  const previous = process.env.ADMIN_UPLOAD_MAX_MB;
  process.env.ADMIN_UPLOAD_MAX_MB = '1';
  try {
    const body = new Uint8Array(1024 * 1024 + 1);
    body.set(PDF_BYTES, 0);
    const audits: number[] = [];
    const response = await putUpload(uploadRequest(null, body), dependencies(drainingStorage(), {
      audit: { write(event) { audits.push(event.size); } },
    }));
    assert.equal(response.status, 413);
    assert.equal((await response.json()).code, 'FILE_TOO_LARGE');
    assert.ok(audits[0] > 1024 * 1024, 'audit records the bytes actually received');
  } finally {
    if (previous === undefined) delete process.env.ADMIN_UPLOAD_MAX_MB;
    else process.env.ADMIN_UPLOAD_MAX_MB = previous;
  }
});

test('invalid Content-Length is rejected before storage', async () => {
  let stored = false;
  const request = new NextRequest('http://localhost/api/admin/uploads', {
    method: 'PUT',
    body: PDF_BYTES.slice().buffer as ArrayBuffer,
    headers: {
      'content-length': 'not-a-number', 'content-type': 'application/pdf',
      'x-csrf-token': 'test', 'x-product-id': '6470625', 'x-product-line': 'labelling',
      'x-upload-filename': 'manual.pdf',
    },
  });
  const response = await putUpload(request, dependencies(drainingStorage(() => { stored = true; })));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INVALID_CONTENT_LENGTH');
  assert.equal(stored, false);
});

test('unknown-length uploads settle real bytes against the hourly volume', async () => {
  const limiter = new InMemoryUploadRateLimiter();
  const body = new Uint8Array(5_000);
  body.set(PDF_BYTES, 0);
  const response = await putUpload(uploadRequest(null, body), dependencies(drainingStorage(), { rateLimiter: limiter }));
  assert.equal(response.status, 200);
  const events = (limiter as unknown as { events: Map<string, Array<{ bytes: number }>> }).events.get('user-1');
  assert.deepEqual(events?.map((event) => event.bytes), [5_000]);
});

test('software and consulting uploads are refused until real products exist', async () => {
  for (const line of ['software', 'consulting']) {
    let stored = false;
    const request = new NextRequest('http://localhost/api/admin/uploads', {
      method: 'PUT',
      body: PDF_BYTES.slice().buffer as ArrayBuffer,
      headers: {
        'content-type': 'application/pdf', 'x-csrf-token': 'test', 'x-product-id': '6470625',
        'x-product-line': line, 'x-upload-filename': 'manual.pdf',
      },
    });
    const response = await putUpload(request, dependencies(drainingStorage(() => { stored = true; })));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_PRODUCT');
    assert.equal(stored, false);
  }
});

test('upload service rejects a body shorter than the declared Content-Length', async () => {
  const storage: StorageAdapter = {
    async putObject(input) {
      for await (const _chunk of input.body) {
        // Drain to trigger the counting stream flush check.
      }
      return {};
    },
    async listObjects() { return []; },
    async deleteObject() {},
  };
  const response = await putUpload(
    uploadRequest(PDF_BYTES.byteLength + 1),
    dependencies(storage),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'SIZE_MISMATCH');
});

test('does not return success before storage confirms acceptance', async () => {
  let release!: () => void;
  const accepted = new Promise<void>((resolve) => { release = resolve; });
  const storage: StorageAdapter = {
    async putObject() {
      await accepted;
      return {};
    },
    async listObjects() { return []; },
    async deleteObject() {},
  };
  let settled = false;
  const pending = putUpload(uploadRequest(), dependencies(storage)).then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false);
  release();
  const response = await pending;
  assert.equal(response.status, 200);
});

test('maps storage failure to a stable 500 response', async () => {
  const storage: StorageAdapter = {
    async putObject() { throw new Error('internal endpoint detail'); },
    async listObjects() { return []; },
    async deleteObject() {},
  };
  const response = await putUpload(uploadRequest(), dependencies(storage));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: 'INTERNAL_ERROR',
    error: 'The upload request could not be processed',
  });
});

test('upload service returns 401 and 403 from the authentication boundary', async () => {
  const storage: StorageAdapter = {
    async putObject() { return {}; },
    async listObjects() { return []; },
    async deleteObject() {},
  };
  for (const expected of [
    new UploadContractError(401, 'UNAUTHENTICATED', 'Authentication is required'),
    new UploadContractError(403, 'FORBIDDEN', 'Permission is required'),
  ]) {
    const response = await putUpload(
      uploadRequest(),
      dependencies(storage, {
        authenticate: async () => { throw expected; },
      }),
    );
    assert.equal(response.status, expected.status);
    assert.equal((await response.json()).code, expected.code);
  }
});

test('GET and DELETE independently reject missing sessions', async () => {
  const anonymous = async (): Promise<never> => { throw new UploadContractError(401, 'UNAUTHENTICATED', 'Authentication is required'); };
  const storage: StorageAdapter = {
    async putObject() { throw new Error('storage must not be reached'); },
    async listObjects() { throw new Error('storage must not be reached'); },
    async deleteObject() { throw new Error('storage must not be reached'); },
  };
  assert.equal((await getUploads(new Request('http://localhost/api/admin/uploads'), dependencies(storage, { authenticate: anonymous }))).status, 401);
  assert.equal((await deleteUpload(deleteRequest(), deleteDependencies({ authenticate: anonymous, storage: () => storage }))).status, 401);
});

test('accepted non-PDF files are stored and remain pending', async () => {
  const docx = new Uint8Array(30 + 17);
  docx.set([0x50, 0x4b, 0x03, 0x04], 0);
  docx[26] = 17;
  docx.set(new TextEncoder().encode('word/document.xml'), 30);
  const cases = [
    { name: 'manual.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: docx, bucket: 'auraplex-raw-pdf' },
    { name: 'diagram.png', mime: 'image/png', bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]), bucket: 'auraplex-raw-image' },
    { name: 'photo.jpg', mime: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]), bucket: 'auraplex-raw-image' },
    { name: 'demo.mp4', mime: 'video/mp4', bytes: new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]), bucket: 'auraplex-raw-video' },
  ];
  for (const item of cases) {
    let saved: Parameters<StorageAdapter['putObject']>[0] | undefined;
    const storage: StorageAdapter = {
      async putObject(input) { saved = input; for await (const _chunk of input.body) { /* drain */ } return {}; },
      async listObjects() { return []; },
      async deleteObject() {},
    };
    const request = new Request('http://localhost/api/admin/uploads', {
      method: 'PUT', body: item.bytes.slice().buffer,
      headers: {
        'content-length': String(item.bytes.length), 'content-type': item.mime,
        'x-csrf-token': 'test', 'x-product-id': '6470625', 'x-product-line': 'labelling',
        'x-upload-filename': encodeURIComponent(item.name),
      },
    });
    const response = await putUpload(request, dependencies(storage));
    assert.equal(response.status, 200, item.name);
    assert.equal((await response.json()).status, 'pending');
    assert.equal(saved?.bucket, item.bucket);
    assert.equal(saved?.metadata[UPLOAD_METADATA.ingestionCapability], 'deferred');
  }
});

test('browser cancellation is propagated to the storage adapter', async () => {
  const controller = new AbortController();
  let sawStorage = false;
  const storage: StorageAdapter = {
    async putObject(input) {
      sawStorage = true;
      assert.equal(input.signal, controller.signal);
      await new Promise<void>((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(new Error('upstream aborted')), { once: true });
        controller.abort();
      });
      return {};
    },
    async listObjects() { return []; },
    async deleteObject() {},
  };
  const request = new Request('http://localhost/api/admin/uploads', {
    method: 'PUT', body: PDF_BYTES.slice().buffer,
    signal: controller.signal,
    headers: {
      'content-length': String(PDF_BYTES.length), 'content-type': 'application/pdf',
      'x-csrf-token': 'test', 'x-product-id': '6470625', 'x-product-line': 'labelling',
      'x-upload-filename': encodeURIComponent('manual.pdf'),
    },
  });
  const response = await putUpload(request, dependencies(storage));
  assert.equal(sawStorage, true);
  assert.notEqual(response.status, 200);
});

test('rejects oversized declarations before opening storage', async () => {
  let storageUsed = false;
  const storage: StorageAdapter = {
    async putObject() { storageUsed = true; return {}; },
    async listObjects() { return []; },
    async deleteObject() {},
  };
  const response = await putUpload(
    uploadRequest(getServerUploadMaxBytes() + 1),
    dependencies(storage),
  );
  assert.equal(response.status, 413);
  assert.equal(storageUsed, false);
});

test('S3 adapter sends a PutObjectCommand with the supplied stream metadata', async () => {
  let command: unknown;
  let sent!: () => void;
  const sending = new Promise<void>((resolve) => { sent = resolve; });
  const adapter = new S3StorageAdapter({
    send: (value: unknown, options?: { abortSignal?: AbortSignal }) => {
      command = value;
      sent();
      // Stays in flight until cancelled, like a slow upstream.
      return new Promise((_resolve, reject) => {
        options?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  } as never);
  const controller = new AbortController();
  const pending = adapter.putObject({
    bucket: 'auraplex-raw-pdf',
    key: 'machines/product/manual.pdf',
    body: Readable.from([Buffer.from('pdf')]),
    contentLength: 3,
    contentType: 'application/pdf',
    metadata: { 'product-id': '123' },
    signal: controller.signal,
  });
  await sending;
  assert.ok(command instanceof PutObjectCommand);
  assert.equal(command.input.Bucket, 'auraplex-raw-pdf');
  assert.equal(command.input.Key, 'machines/product/manual.pdf');
  assert.equal(command.input.ContentLength, 3);
  assert.equal(command.input.Metadata?.['product-id'], '123');
  // Request cancellation reaches the in-flight SDK call.
  controller.abort();
  await assert.rejects(pending, /aborted/);
});

test('S3 adapter sends a DeleteObjectCommand for the exact bucket and key', async () => {
  let command: unknown;
  const adapter = new S3StorageAdapter({ send: async (value: unknown) => { command = value; return {}; } } as never);
  await adapter.deleteObject('auraplex-raw-pdf', 'machines/flexy-applicator/manual.pdf');
  assert.ok(command instanceof DeleteObjectCommand);
  assert.equal(command.input.Key, 'machines/flexy-applicator/manual.pdf');
});

test('MinIO client keeps path-style addressing enabled', () => {
  const adapter = createStorageAdapter({
    endpoint: 'http://minio.example.test:9000',
    region: 'us-east-1', accessKey: 'test-only', secretKey: 'test-only',
  });
  const client = (adapter as unknown as { client: { config: { forcePathStyle: boolean } } }).client;
  assert.equal(client.config.forcePathStyle, true);
});

test('S3 listing follows continuation tokens and returns newest objects first', async () => {
  const listTokens: Array<string | undefined> = [];
  const adapter = new S3StorageAdapter({
    send: async (command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        listTokens.push(command.input.ContinuationToken);
        if (!command.input.ContinuationToken) {
          return {
            IsTruncated: true,
            NextContinuationToken: 'next-page',
            Contents: [{
              Key: 'older.pdf',
              Size: 1,
              LastModified: new Date('2026-09-20T10:00:00Z'),
            }],
          };
        }
        return {
          IsTruncated: false,
          Contents: [{
            Key: 'newer.pdf',
            Size: 2,
            LastModified: new Date('2026-09-21T10:00:00Z'),
          }],
        };
      }
      assert.ok(command instanceof HeadObjectCommand);
      return { Metadata: { 'uploaded-by': 'user-1' } };
    },
  } as never);
  const objects = await adapter.listObjects('auraplex-raw-pdf', { limit: 2 });
  assert.deepEqual(listTokens, [undefined, 'next-page']);
  assert.deepEqual(objects.map((object) => object.key), ['newer.pdf', 'older.pdf']);
});

test('uploader items are not lost behind a global latest-50 slice of other users', async () => {
  const base = Date.parse('2026-09-01T00:00:00Z');
  const contents = [
    { Key: 'machines/p/own-old.pdf', Size: 1, LastModified: new Date(base) },
    ...Array.from({ length: 120 }, (_, index) => ({
      Key: `machines/p/other-${index}.pdf`, Size: 1, LastModified: new Date(base + (index + 1) * 1000),
    })),
  ];
  let heads = 0;
  const adapter = new S3StorageAdapter({
    send: async (command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        return { IsTruncated: false, Contents: command.input.Bucket === 'auraplex-raw-pdf' ? contents : [] };
      }
      assert.ok(command instanceof HeadObjectCommand);
      heads += 1;
      const own = command.input.Key === 'machines/p/own-old.pdf';
      return { Metadata: { 'uploaded-by': own ? 'user-1' : 'user-2' } };
    },
  } as never);
  const response = await getUploads(
    new Request('http://localhost/api/admin/uploads'),
    dependencies(adapter),
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.uploads.map((item: { key: string }) => item.key), ['machines/p/own-old.pdf']);
  assert.ok(heads <= contents.length, 'HEAD requests stay bounded by the listing');
});

test('status mapping never treats missing Qdrant evidence as failed', () => {
  assert.equal(deriveUploadStatus({ stored: true, ingestionCapability: 'deferred', processedEvidence: false }), 'pending');
  assert.equal(deriveUploadStatus({ stored: true, ingestionCapability: 'supported', processedEvidence: false }), 'pending');
  assert.equal(deriveUploadStatus({ stored: true, ingestionCapability: 'supported', processedEvidence: true }), 'processed');
  assert.equal(deriveUploadStatus({ stored: false, ingestionCapability: 'supported', processedEvidence: false }), 'unsupported');
  assert.equal(deriveUploadStatus({ stored: true, processedEvidence: false }), 'unsupported');
});

test('Qdrant adapter filters by the bucket/key source key', async () => {
  let filterValue: unknown;
  let collection = '';
  const qdrant = new QdrantRestEvidenceAdapter({
    async scroll(name: string, options: { filter?: { must?: Array<{ match?: { value?: unknown } }> } }) {
      collection = name;
      filterValue = options.filter?.must?.[0]?.match?.value;
      return { points: [{ id: 1 }], next_page_offset: null };
    },
  } as never);
  const sourceKey = toQdrantSourceKey({
    bucket: 'auraplex-raw-pdf',
    key: 'machines/flexy-applicator/manual.pdf',
  });
  assert.equal(await qdrant.hasProcessedEvidence(sourceKey), true);
  assert.equal(filterValue, 'auraplex-raw-pdf/machines/flexy-applicator/manual.pdf');
  assert.equal(collection, 'auraplex_machines');
});

test('Qdrant deletion waits for exact source-key filter completion', async () => {
  let collection = '';
  let options: unknown;
  const qdrant = new QdrantRestEvidenceAdapter({
    async delete(name: string, input: unknown) {
      collection = name;
      options = input;
      return { status: 'completed' };
    },
  } as never);
  await qdrant.deleteBySourceKey('auraplex-raw-pdf/software/some-product/manual.pdf');
  assert.equal(collection, 'auraplex_software');
  assert.deepEqual(options, {
    filter: { must: [{ key: 'source_key', match: { value: 'auraplex-raw-pdf/software/some-product/manual.pdf' } }] },
    wait: true,
  });
});

test('Qdrant routes each ingest line to its confirmed collection', () => {
  assert.deepEqual({ ...QDRANT_COLLECTIONS }, {
    machines: 'auraplex_machines',
    software: 'auraplex_software',
    consulting: 'auraplex_consulting',
  });
  assert.equal(qdrantCollectionForSourceKey('auraplex-raw-pdf/machines/p/manual.pdf'), 'auraplex_machines');
  assert.equal(qdrantCollectionForSourceKey('auraplex-raw-image/software/p/diagram.png'), 'auraplex_software');
  assert.equal(qdrantCollectionForSourceKey('auraplex-raw-video/consulting/p/demo.mp4'), 'auraplex_consulting');
});

test('Qdrant routing fails explicitly for unknown and legacy prefixes', async () => {
  let called = false;
  const qdrant = new QdrantRestEvidenceAdapter({
    async scroll() { called = true; return { points: [] }; },
    async delete() { called = true; return { status: 'completed' }; },
  } as never);
  for (const sourceKey of [
    'auraplex-raw-pdf/labelling/flexy-applicator/manual.pdf',
    'auraplex-raw-pdf/unknown/p/manual.pdf',
    'machines/p/manual.pdf',
  ]) {
    assert.throws(() => qdrantCollectionForSourceKey(sourceKey), UploadContractError);
    await assert.rejects(qdrant.hasProcessedEvidence(sourceKey), UploadContractError);
    await assert.rejects(qdrant.deleteBySourceKey(sourceKey), UploadContractError);
  }
  assert.equal(called, false, 'no collection is queried or scanned as a fallback');
});

test('status and delete share one collection resolver', async () => {
  const seen: string[] = [];
  const qdrant = new QdrantRestEvidenceAdapter({
    async scroll(name: string) { seen.push(`status:${name}`); return { points: [] }; },
    async delete(name: string) { seen.push(`delete:${name}`); return { status: 'completed' }; },
  } as never);
  for (const line of ['machines', 'software', 'consulting']) {
    const sourceKey = `auraplex-raw-pdf/${line}/p/manual.pdf`;
    await qdrant.hasProcessedEvidence(sourceKey);
    await qdrant.deleteBySourceKey(sourceKey);
  }
  assert.deepEqual(seen, [
    'status:auraplex_machines', 'delete:auraplex_machines',
    'status:auraplex_software', 'delete:auraplex_software',
    'status:auraplex_consulting', 'delete:auraplex_consulting',
  ]);
  const factoryAdapter = createQdrantAdapter({ url: 'http://qdrant.example.test:6333' });
  assert.equal(
    (factoryAdapter as unknown as { collectionForSourceKey: unknown }).collectionForSourceKey,
    qdrantCollectionForSourceKey,
  );
});

test('Qdrant configuration no longer uses QDRANT_COLLECTION', () => {
  assert.deepEqual(getQdrantConfig({ QDRANT_URL: 'http://qdrant.example.test:6333' } as unknown as NodeJS.ProcessEnv), {
    url: 'http://qdrant.example.test:6333',
    apiKey: undefined,
  });
  assert.equal(tryGetQdrantConfig({ QDRANT_COLLECTION: 'legacy' } as unknown as NodeJS.ProcessEnv), null);
});

test('status reports legacy-prefix objects as unsupported without querying Qdrant', async () => {
  let queried = false;
  const upload = await buildRecentUpload({
    bucket: 'auraplex-raw-pdf',
    key: 'labelling/flexy-applicator/manual.pdf',
    size: 1,
    lastModified: null,
    metadata: {},
  }, { async hasProcessedEvidence() { queried = true; return true; }, async deleteBySourceKey() {} });
  assert.equal(upload.status, 'unsupported');
  assert.equal(upload.sourceKey, 'auraplex-raw-pdf/labelling/flexy-applicator/manual.pdf');
  assert.equal(queried, false);
});

test('GET status gives uploaders own objects only and admins all objects', async () => {
  const storage: StorageAdapter = {
    async putObject() { return {}; },
    async deleteObject() {},
    async listObjects(bucket) {
      return bucket === 'auraplex-raw-pdf'
        ? [
            {
              bucket,
              key: 'machines/flexy-applicator/own.pdf',
              size: 10,
              lastModified: new Date('2026-09-21T10:00:00Z'),
              metadata: { 'upload-id': 'own-id', 'uploaded-by': 'user-1' },
            },
            {
              bucket,
              key: 'machines/flexy-applicator/other.pdf',
              size: 10,
              lastModified: new Date('2026-09-21T11:00:00Z'),
              metadata: { 'upload-id': 'other-id', 'uploaded-by': 'user-2' },
            },
            {
              bucket,
              key: 'machines/flexy-applicator/legacy.pdf',
              size: 10,
              lastModified: new Date('2026-09-21T12:00:00Z'),
              metadata: { 'upload-id': 'legacy-id' } as Record<string, string>,
            },
          ]
        : [];
    },
  };
  const qdrant: QdrantEvidenceAdapter = {
    async hasProcessedEvidence() { return true; },
    async deleteBySourceKey() {},
  };
  const uploaderResponse = await getUploads(
    new Request('http://localhost/api/admin/uploads'),
    dependencies(storage, { qdrant: () => qdrant }),
  );
  const uploaderBody = await uploaderResponse.json();
  assert.equal(uploaderResponse.status, 200);
  assert.deepEqual(uploaderBody.uploads.map((item: { uploadId: string }) => item.uploadId), ['own-id']);
  assert.equal(uploaderBody.uploads[0].status, 'processed');
  assert.equal(uploaderBody.qdrantAvailable, true);

  const adminResponse = await getUploads(
    new Request('http://localhost/api/admin/uploads'),
    dependencies(storage, {
      authenticate: async () => ({ userId: 'admin-1', groups: ['auraplex-admin'] }),
      qdrant: () => qdrant,
    }),
  );
  const adminBody = await adminResponse.json();
  assert.deepEqual(
    adminBody.uploads.map((item: { uploadId: string }) => item.uploadId),
    ['legacy-id', 'other-id', 'own-id'],
  );
});

test('frontend response mapping never treats a 503 error body as uploaded', () => {
  assert.equal(queueStatusAfterResponse({
    ok: false,
    code: 'BACKEND_NOT_CONFIGURED',
    error: 'MinIO is not configured',
  }), 'failed');
  assert.equal(queueStatusAfterResponse({
    ok: true,
    uploadId: '1',
    bucket: 'auraplex-raw-pdf',
    key: 'machines/b/c.pdf',
    sourceKey: 'auraplex-raw-pdf/machines/b/c.pdf',
    size: 1,
    status: 'pending',
  }), 'uploaded');
  assert.equal(canRetryUpload('failed'), true);
  assert.equal(canRetryUpload('uploaded'), false);
});

function deleteRequest(key = 'machines/flexy-applicator/manual.pdf') {
  return new Request('http://localhost/api/admin/uploads', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bucket: 'auraplex-raw-pdf', key }),
  });
}

function deleteDependencies(overrides: Partial<DeleteDependencies> = {}): DeleteDependencies {
  return {
    authenticate: async () => ({ userId: 'admin-1', groups: ['auraplex-admin'] }),
    csrf: { verify() {} },
    storage: () => ({
      async putObject() { return {}; },
      async listObjects() { return []; },
      async deleteObject() {},
    }),
    qdrant: () => ({ async hasProcessedEvidence() { return false; }, async deleteBySourceKey() {} }),
    audit: { write() {} },
    ...overrides,
  };
}

test('Admin delete removes exact Qdrant source before the MinIO object', async () => {
  const calls: string[] = [];
  const target = 'machines/flexy-applicator/manual.pdf';
  const response = await deleteUpload(deleteRequest(target), deleteDependencies({
    qdrant: () => ({ async hasProcessedEvidence() { return false; }, async deleteBySourceKey(key) { calls.push(`qdrant:${key}`); } }),
    storage: () => ({ async putObject() { return {}; }, async listObjects() { return []; }, async deleteObject(bucket, key) { calls.push(`minio:${bucket}/${key}`); } }),
  }));
  assert.equal(response.status, 200);
  // source_key includes the bucket; MinIO receives the bare key.
  assert.deepEqual(calls, [`qdrant:auraplex-raw-pdf/${target}`, `minio:auraplex-raw-pdf/${target}`]);
  assert.equal((await response.json()).sourceKey, `auraplex-raw-pdf/${target}`);
});

test('delete validation accepts every ingest prefix without consulting the catalogue', () => {
  for (const [bucket, key] of [
    ['auraplex-raw-pdf', 'machines/flexy-applicator/manual.pdf'],
    ['auraplex-raw-image', 'software/future-product/diagram.png'],
    ['auraplex-raw-video', 'consulting/future-service/demo.mp4'],
    // Product removed from today's catalogue: the stored object stays deletable.
    ['auraplex-raw-pdf', 'machines/discontinued-machine/manual.pdf'],
  ] as const) {
    assert.deepEqual(validateDeleteTarget({ bucket, key }), { bucket, key, sourceKey: `${bucket}/${key}` });
  }
});

test('delete rejects legacy and unknown prefixes before external operations', async () => {
  for (const key of [
    'labelling/flexy-applicator/manual.pdf',
    'unknown/flexy-applicator/manual.pdf',
    'machines/flexy-applicator/nested/manual.pdf',
  ]) {
    let used = false;
    const response = await deleteUpload(deleteRequest(key), deleteDependencies({
      qdrant: () => { used = true; throw new Error('must not open Qdrant'); },
      storage: () => { used = true; throw new Error('must not open storage'); },
    }));
    assert.equal(response.status, 400, key);
    assert.equal(used, false);
  }
});

test('delete body parsing times out a stalled stream', async () => {
  const stalled = new ReadableStream<Uint8Array>({ start() {} });
  const request = new Request('http://localhost/api/admin/uploads', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: stalled,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  await assert.rejects(readDeleteBody(request, 10), (error: unknown) => {
    assert.ok(error instanceof UploadContractError);
    assert.equal(error.status, 408);
    assert.equal(error.code, 'REQUEST_TIMEOUT');
    return true;
  });
});

test('Admin delete denies Uploader and rejects traversal before external operations', async () => {
  let used = false;
  const deps = deleteDependencies({
    authenticate: async () => ({ userId: 'uploader', groups: ['auraplex-uploader'] }),
    storage: () => { used = true; throw new Error('must not open storage'); },
  });
  assert.equal((await deleteUpload(deleteRequest(), deps)).status, 403);
  assert.equal(used, false);
  const invalid = await deleteUpload(deleteRequest('../manual.pdf'), deleteDependencies({
    storage: () => { used = true; throw new Error('must not open storage'); },
  }));
  assert.equal(invalid.status, 400);
  assert.equal(used, false);
});

test('Admin delete reports partial failure without leaking upstream details', async () => {
  const response = await deleteUpload(deleteRequest(), deleteDependencies({
    storage: () => ({ async putObject() { return {}; }, async listObjects() { return []; }, async deleteObject() { throw new Error('secret minio.internal bucket'); } }),
  }));
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.code, 'PARTIAL_DELETE');
  assert.doesNotMatch(JSON.stringify(body), /secret|minio\.internal/i);
});

test('Admin delete does not remove MinIO when Qdrant cleanup fails', async () => {
  let minioCalled = false;
  const response = await deleteUpload(deleteRequest(), deleteDependencies({
    qdrant: () => ({ async hasProcessedEvidence() { return false; }, async deleteBySourceKey() { throw new Error('secret qdrant.internal'); } }),
    storage: () => ({ async putObject() { return {}; }, async listObjects() { return []; }, async deleteObject() { minioCalled = true; } }),
  }));
  assert.equal(response.status, 500);
  assert.equal((await response.json()).code, 'INTERNAL_ERROR');
  assert.equal(minioCalled, false);
});

test('stored object metadata uses the shared dash-case schema', () => {
  for (const value of Object.values(UPLOAD_METADATA)) assert.match(value, /^[a-z]+(?:-[a-z]+)*$/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { S3Client } from '@aws-sdk/client-s3';
import { S3StorageAdapter, UNKNOWN_LENGTH_UPLOAD } from '../lib/admin/server/storage';
import { createUploadByteCounter } from '../lib/admin/upload-validation';
import { UploadContractError } from '../lib/admin/upload-errors';
import { putUpload } from '../lib/admin/server/upload-service';
import { UploadConcurrencyGuard } from '../lib/admin/server/upload-concurrency';

// Real AWS SDK wire behaviour against a minimal in-process S3 endpoint. This
// covers what mocked `send()` tests cannot: aws-chunked framing, multipart
// sequencing and whether a failing body stream aborts the HTTP request.

type S3Event =
  | { type: 'put'; key: string; contentLength: string | null; decodedLength: string | null; bytes: number }
  | { type: 'create'; key: string }
  | { type: 'part'; partNumber: number; bytes: number }
  | { type: 'complete'; key: string }
  | { type: 'abort'; key: string }
  | { type: 'incomplete'; key: string };

function payloadBytes(body: Buffer, encoding: string | undefined): number {
  if (!encoding?.includes('aws-chunked')) return body.length;
  let offset = 0;
  let total = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset);
    if (lineEnd < 0) break;
    const size = parseInt(body.subarray(offset, lineEnd).toString().split(';')[0], 16);
    if (!size) break;
    total += size;
    offset = lineEnd + 2 + size + 2;
  }
  return total;
}

interface FakeS3Options {
  /** AbortMultipartUpload behaviour: answer, fail with 500, or never answer. */
  abort?: 'ok' | 'fail' | 'hang';
  /** CompleteMultipartUpload behaviour: answer, or fail with 500. */
  complete?: 'ok' | 'fail';
  /** Never answer UploadPart requests (a stalled MinIO). */
  hangParts?: boolean;
  /** Client socket-inactivity timeout, as createStorageAdapter configures. */
  socketTimeoutMs?: number;
}

async function withFakeS3(
  run: (client: S3Client, events: S3Event[]) => Promise<void>,
  options: FakeS3Options = {},
) {
  const events: S3Event[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    let size = 0;
    const chunks: Buffer[] = [];
    let completed = false;
    req.on('data', (chunk: Buffer) => { size += chunk.length; chunks.push(chunk); });
    req.on('close', () => { if (!completed) events.push({ type: 'incomplete', key }); });
    req.on('end', () => {
      completed = true;
      const body = Buffer.concat(chunks);
      const bytes = payloadBytes(body, req.headers['content-encoding'] as string | undefined);
      void size;
      const xml = (value: string) => {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>${value}`);
      };
      if (req.method === 'POST' && url.searchParams.has('uploads')) {
        events.push({ type: 'create', key });
        xml(`<InitiateMultipartUploadResult><Bucket>b</Bucket><Key>${key}</Key><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>`);
      } else if (req.method === 'PUT' && url.searchParams.has('partNumber')) {
        const partNumber = Number(url.searchParams.get('partNumber'));
        events.push({ type: 'part', partNumber, bytes });
        if (options.hangParts) return;
        res.writeHead(200, { ETag: `"part-${partNumber}"` });
        res.end();
      } else if (req.method === 'POST' && url.searchParams.has('uploadId')) {
        events.push({ type: 'complete', key });
        if (options.complete === 'fail') {
          res.writeHead(500, { 'content-type': 'application/xml' });
          res.end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code><Message>complete failed</Message></Error>');
          return;
        }
        xml(`<CompleteMultipartUploadResult><Bucket>b</Bucket><Key>${key}</Key><ETag>"multipart"</ETag></CompleteMultipartUploadResult>`);
      } else if (req.method === 'DELETE' && url.searchParams.has('uploadId')) {
        events.push({ type: 'abort', key });
        if (options.abort === 'hang') return;
        if (options.abort === 'fail') {
          res.writeHead(500, { 'content-type': 'application/xml' });
          res.end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code><Message>abort failed</Message></Error>');
          return;
        }
        res.writeHead(204);
        res.end();
      } else if (req.method === 'PUT') {
        events.push({
          type: 'put',
          key,
          contentLength: (req.headers['content-length'] as string | undefined) ?? null,
          decodedLength: (req.headers['x-amz-decoded-content-length'] as string | undefined) ?? null,
          bytes,
        });
        res.writeHead(200, { ETag: '"single"' });
        res.end();
      } else {
        res.writeHead(400);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${port}`,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test-only', secretAccessKey: 'test-only' },
    maxAttempts: 1,
    ...(options.socketTimeoutMs ? { requestHandler: { socketTimeout: options.socketTimeoutMs } } : {}),
  });
  try {
    await run(client, events);
  } finally {
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Web stream of `total` bytes in 64 KiB chunks, optionally failing midway. */
function sourceStream(total: number, failAfter?: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAfter !== undefined && sent >= failAfter) {
        controller.error(new Error('client disconnected'));
        return;
      }
      if (sent >= total) { controller.close(); return; }
      const size = Math.min(64 * 1024, total - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(7));
    },
  });
}

/** Mirrors upload-service: request body -> byte counter -> Node Readable. */
function countedBody(source: ReadableStream<Uint8Array>, options: Parameters<typeof createUploadByteCounter>[0]) {
  const counter = createUploadByteCounter(options);
  const web = source.pipeThrough(counter.stream);
  return { counter, body: Readable.fromWeb(web as unknown as NodeReadableStream<Uint8Array>) };
}

const MiB = 1024 * 1024;
const input = (body: Readable, contentLength?: number, signal?: AbortSignal) => ({
  bucket: 'auraplex-raw-pdf' as const,
  key: 'machines/flexy-applicator/manual.pdf',
  body,
  contentLength,
  contentType: 'application/pdf',
  metadata: { 'upload-id': 'u1' },
  signal,
});

function uncaughtGuard() {
  const seen: unknown[] = [];
  const listener = (error: unknown) => { seen.push(error); };
  process.on('uncaughtException', listener);
  process.on('unhandledRejection', listener);
  return {
    seen,
    dispose: () => {
      process.off('uncaughtException', listener);
      process.off('unhandledRejection', listener);
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 3_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('known Content-Length keeps the single-part PutObject path', async () => {
  await withFakeS3(async (client, events) => {
    const { body } = countedBody(sourceStream(3 * MiB), { maxBytes: 10 * MiB, expectedBytes: 3 * MiB });
    await new S3StorageAdapter(client).putObject(input(body, 3 * MiB));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'put');
    assert.equal(events[0].type === 'put' && events[0].bytes, 3 * MiB);
    assert.equal(events[0].type === 'put' && events[0].decodedLength, String(3 * MiB));
  });
});

test('a body failure during known-length PutObject rejects promptly instead of hanging', async () => {
  // Regression: a SIZE_MISMATCH from the byte counter previously surfaced as an
  // uncaughtException while the S3 request (and the HTTP client) hung.
  const guard = uncaughtGuard();
  try {
    await withFakeS3(async (client, events) => {
      const { body } = countedBody(sourceStream(2 * MiB), { maxBytes: 10 * MiB, expectedBytes: 3 * MiB });
      const started = Date.now();
      await assert.rejects(
        new S3StorageAdapter(client).putObject(input(body, 3 * MiB)),
        (error: unknown) => error instanceof UploadContractError && error.code === 'SIZE_MISMATCH',
      );
      assert.ok(Date.now() - started < 5_000);
      await waitFor(() => events.some((event) => event.type === 'incomplete'));
      assert.equal(events.some((event) => event.type === 'put'), false, 'no object was stored');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(guard.seen, []);
  } finally {
    guard.dispose();
  }
});

test('unknown length below one part is stored with a single sized PutObject', async () => {
  await withFakeS3(async (client, events) => {
    const { body, counter } = countedBody(sourceStream(3 * MiB + 17), { maxBytes: 100 * MiB });
    await new S3StorageAdapter(client).putObject(input(body));
    assert.equal(counter.receivedBytes, 3 * MiB + 17);
    assert.deepEqual(events.map((event) => event.type), ['put']);
    assert.equal(events[0].type === 'put' && events[0].bytes, 3 * MiB + 17);
  });
});

test('unknown length above one part uses bounded multipart upload', async () => {
  await withFakeS3(async (client, events) => {
    const total = 2 * UNKNOWN_LENGTH_UPLOAD.partSize + 12_345;
    const { body } = countedBody(sourceStream(total), { maxBytes: 100 * MiB });
    const result = await new S3StorageAdapter(client).putObject(input(body));
    assert.equal(result.etag, '"multipart"');
    const parts = events.filter((event): event is Extract<S3Event, { type: 'part' }> => event.type === 'part');
    assert.deepEqual(parts.map((part) => part.partNumber).sort(), [1, 2, 3]);
    assert.equal(parts.reduce((sum, part) => sum + part.bytes, 0), total);
    assert.ok(parts.every((part) => part.bytes <= UNKNOWN_LENGTH_UPLOAD.partSize));
    assert.equal(events[0].type, 'create');
    assert.equal(events.at(-1)?.type, 'complete');
    assert.equal(events.some((event) => event.type === 'abort'), false);
  });
});

test('unknown-length body failure aborts the multipart upload and keeps the error', async () => {
  const guard = uncaughtGuard();
  try {
    await withFakeS3(async (client, events) => {
      const limit = UNKNOWN_LENGTH_UPLOAD.partSize + 2 * MiB;
      const { body } = countedBody(sourceStream(3 * UNKNOWN_LENGTH_UPLOAD.partSize), { maxBytes: limit });
      await assert.rejects(
        new S3StorageAdapter(client).putObject(input(body)),
        (error: unknown) => error instanceof UploadContractError && error.code === 'FILE_TOO_LARGE',
      );
      // done() rejects at once; AbortMultipartUpload follows in the background.
      await waitFor(() => events.some((event) => event.type === 'create'));
      await waitFor(() => events.some((event) => event.type === 'abort'));
      assert.equal(events.some((event) => event.type === 'complete'), false);
    });
    assert.deepEqual(guard.seen, []);
  } finally {
    guard.dispose();
  }
});

test('request cancellation aborts an unknown-length multipart upload', async () => {
  await withFakeS3(async (client, events) => {
    const controller = new AbortController();
    const { body } = countedBody(sourceStream(4 * UNKNOWN_LENGTH_UPLOAD.partSize), { maxBytes: 100 * MiB });
    const pending = new S3StorageAdapter(client).putObject(input(body, undefined, controller.signal));
    await waitFor(() => events.some((event) => event.type === 'part'));
    controller.abort();
    await assert.rejects(pending);
    await waitFor(() => events.some((event) => event.type === 'abort'));
    assert.equal(events.some((event) => event.type === 'complete'), false);
  });
});

test('client disconnect during an unknown-length upload aborts the multipart upload', async () => {
  await withFakeS3(async (client, events) => {
    const failAfter = UNKNOWN_LENGTH_UPLOAD.partSize + MiB;
    const { body } = countedBody(sourceStream(4 * UNKNOWN_LENGTH_UPLOAD.partSize, failAfter), { maxBytes: 100 * MiB });
    await assert.rejects(new S3StorageAdapter(client).putObject(input(body)), /client disconnected/);
    await waitFor(() => events.some((event) => event.type === 'abort'));
    assert.equal(events.some((event) => event.type === 'complete'), false);
  });
});

/** Web stream that sends `bytes` and then stays open without sending more. */
function stallingStream(bytes: number): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return new Promise<void>(() => {});
      sent = true;
      controller.enqueue(new Uint8Array(bytes).fill(7));
    },
  });
}

async function rejectsWithin<T>(promise: Promise<T>, ms: number, check: (error: unknown) => boolean) {
  const started = Date.now();
  await assert.rejects(promise, check);
  assert.ok(Date.now() - started < ms, `settled after ${Date.now() - started} ms`);
}

test('a delayed AbortMultipartUpload does not delay the failed upload', async () => {
  const guard = uncaughtGuard();
  try {
    await withFakeS3(async (client, events) => {
      const limit = UNKNOWN_LENGTH_UPLOAD.partSize + 2 * MiB;
      const { body } = countedBody(sourceStream(3 * UNKNOWN_LENGTH_UPLOAD.partSize), { maxBytes: limit });
      // The fake MinIO never answers the abort; the upload must still settle.
      await rejectsWithin(new S3StorageAdapter(client).putObject(input(body)), 2_000,
        (error) => error instanceof UploadContractError && error.code === 'FILE_TOO_LARGE');
      await waitFor(() => events.some((event) => event.type === 'abort'));
      assert.equal(events.some((event) => event.type === 'complete'), false);
    }, { abort: 'hang' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(guard.seen, []);
  } finally {
    guard.dispose();
  }
});

test('a failing AbortMultipartUpload keeps the original error and raises nothing uncaught', async () => {
  const guard = uncaughtGuard();
  try {
    await withFakeS3(async (client, events) => {
      const failAfter = UNKNOWN_LENGTH_UPLOAD.partSize + MiB;
      const { body } = countedBody(sourceStream(4 * UNKNOWN_LENGTH_UPLOAD.partSize, failAfter), { maxBytes: 100 * MiB });
      await rejectsWithin(new S3StorageAdapter(client).putObject(input(body)), 2_000,
        (error) => error instanceof Error && /client disconnected/.test(error.message));
      await waitFor(() => events.some((event) => event.type === 'abort'));
      assert.equal(events.some((event) => event.type === 'complete'), false);
    }, { abort: 'fail' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(guard.seen, []);
  } finally {
    guard.dispose();
  }
});

test('a stalled client times out as 408 and aborts the multipart upload', async () => {
  await withFakeS3(async (client, events) => {
    // More than one part arrives, then the connection stays open but silent.
    const { body, counter } = countedBody(stallingStream(UNKNOWN_LENGTH_UPLOAD.partSize + MiB), {
      maxBytes: 100 * MiB,
      idleTimeoutMs: 100,
    });
    await rejectsWithin(new S3StorageAdapter(client).putObject(input(body)), 2_000,
      (error) => error instanceof UploadContractError && error.code === 'REQUEST_TIMEOUT');
    counter.stop();
    await waitFor(() => events.some((event) => event.type === 'abort'));
    assert.equal(events.some((event) => event.type === 'complete'), false);
  });
});

test('a stalled known-length client times out as 408 without storing an object', async () => {
  await withFakeS3(async (client, events) => {
    const { body } = countedBody(stallingStream(MiB), { maxBytes: 10 * MiB, expectedBytes: 3 * MiB, idleTimeoutMs: 100 });
    await rejectsWithin(new S3StorageAdapter(client).putObject(input(body, 3 * MiB)), 2_000,
      (error) => error instanceof UploadContractError && error.code === 'REQUEST_TIMEOUT');
    await waitFor(() => events.some((event) => event.type === 'incomplete'));
    assert.equal(events.some((event) => event.type === 'put'), false);
  });
});

test('a stalled MinIO part upload stops progress and is aborted', async () => {
  await withFakeS3(async (client, events) => {
    // MinIO accepts the part requests but never answers them; once the
    // bounded queue is full no bytes move, which the idle timer detects. The
    // HTTP result is immediate; lib-storage does not cancel in-flight parts, so
    // AbortMultipartUpload follows once the socket-inactivity timeout fails them.
    const { body } = countedBody(sourceStream(6 * UNKNOWN_LENGTH_UPLOAD.partSize), {
      maxBytes: 100 * MiB,
      idleTimeoutMs: 200,
    });
    await rejectsWithin(new S3StorageAdapter(client).putObject(input(body)), 3_000,
      (error) => error instanceof UploadContractError && error.code === 'REQUEST_TIMEOUT');
    await waitFor(() => events.some((event) => event.type === 'abort'));
    // Bounded memory: only queueSize parts were ever in flight.
    assert.ok(events.filter((event) => event.type === 'part').length <= UNKNOWN_LENGTH_UPLOAD.queueSize);
    assert.equal(events.some((event) => event.type === 'complete'), false);
  }, { hangParts: true, socketTimeoutMs: 400 });
});

test('the MinIO client sets connection and socket-inactivity timeouts', async () => {
  const { createStorageAdapter } = await import('../lib/admin/server/storage');
  const { UPLOAD_IDLE_TIMEOUT_MS } = await import('../lib/admin/upload-validation');
  const adapter = createStorageAdapter({ endpoint: 'http://127.0.0.1:9', accessKey: 'a', secretKey: 'b', region: 'us-east-1' });
  const client = (adapter as unknown as { client: S3Client }).client;
  const handler = client.config.requestHandler as unknown as { configProvider: Promise<{ socketTimeout?: number; connectionTimeout?: number; requestTimeout?: number }> };
  const config = await handler.configProvider;
  assert.equal(config.socketTimeout, UPLOAD_IDLE_TIMEOUT_MS);
  assert.equal(config.connectionTimeout, 10_000);
  // No total-duration request timeout that could cut off a long upload.
  assert.equal(config.requestTimeout, undefined);
  client.destroy();
});

// --- CompleteMultipartUpload failure ------------------------------------------
// lib-storage does not abort after a failed completion; the adapter sends a
// best-effort AbortMultipartUpload itself without waiting for it.

const isCompletionError = (error: unknown) => error instanceof Error && error.message === 'complete failed';
const count = (events: S3Event[], type: S3Event['type']) => events.filter((event) => event.type === type).length;
const MULTIPART_TOTAL = 2 * UNKNOWN_LENGTH_UPLOAD.partSize + 12_345;

test('a failed CompleteMultipartUpload is rejected and the multipart upload is aborted', async () => {
  const guard = uncaughtGuard();
  try {
    await withFakeS3(async (client, events) => {
      const { body } = countedBody(sourceStream(MULTIPART_TOTAL), { maxBytes: 100 * MiB });
      await assert.rejects(new S3StorageAdapter(client).putObject(input(body)), isCompletionError);
      await waitFor(() => events.some((event) => event.type === 'abort'));
      assert.equal(count(events, 'complete'), 1);
      assert.equal(count(events, 'abort'), 1);
      // Cleanup targets only the multipart upload, never the final object key.
      assert.equal(count(events, 'put'), 0);
    }, { complete: 'fail' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(guard.seen, []);
  } finally {
    guard.dispose();
  }
});

test('a failing abort after a failed completion keeps the completion error', async () => {
  const guard = uncaughtGuard();
  try {
    await withFakeS3(async (client, events) => {
      const { body } = countedBody(sourceStream(MULTIPART_TOTAL), { maxBytes: 100 * MiB });
      await rejectsWithin(new S3StorageAdapter(client).putObject(input(body)), 2_000, isCompletionError);
      await waitFor(() => events.some((event) => event.type === 'abort'));
      // Let the failed abort response arrive before checking for stray errors.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }, { complete: 'fail', abort: 'fail' });
    assert.deepEqual(guard.seen, []);
  } finally {
    guard.dispose();
  }
});

test('a hung abort after a failed completion does not delay the failure', async () => {
  const guard = uncaughtGuard();
  try {
    await withFakeS3(async (client, events) => {
      const { body } = countedBody(sourceStream(MULTIPART_TOTAL), { maxBytes: 100 * MiB });
      await rejectsWithin(new S3StorageAdapter(client).putObject(input(body)), 2_000, isCompletionError);
      await waitFor(() => events.some((event) => event.type === 'abort'));
    }, { complete: 'fail', abort: 'hang' });
    // The hung abort ends when the fake server closes; nothing escapes.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(guard.seen, []);
  } finally {
    guard.dispose();
  }
});

/** sourceStream() with a PDF signature, as the upload route sniffs it. */
function pdfSourceStream(total: number): ReadableStream<Uint8Array> {
  const signature = new TextEncoder().encode('%PDF-1.7\n');
  let first = true;
  return sourceStream(total).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (first) { chunk.set(signature); first = false; }
      controller.enqueue(chunk);
    },
  }));
}

test('a failed completion yields an error response, never success, and frees the upload slot', async () => {
  const guard = uncaughtGuard();
  try {
    await withFakeS3(async (client, events) => {
      const concurrency = new UploadConcurrencyGuard(() => 1);
      const audits: string[] = [];
      // No Content-Length, so the route takes the multipart path.
      const request = new Request('http://localhost/api/admin/uploads', {
        method: 'PUT',
        body: pdfSourceStream(MULTIPART_TOTAL),
        headers: {
          'content-type': 'application/pdf',
          'x-product-id': '6470625',
          'x-product-line': 'labelling',
          'x-upload-filename': 'manual.pdf',
          'x-csrf-token': 'csrf',
        },
        duplex: 'half',
      } as RequestInit);
      const started = Date.now();
      const response = await putUpload(request, {
        authenticate: async () => ({ userId: 'user-1', groups: ['auraplex-uploader'] }),
        csrf: { verify() {} },
        rateLimiter: { admit: () => ({ allowanceBytes: Number.MAX_SAFE_INTEGER, settle() {} }) },
        audit: { write: (event) => { audits.push(event.action); } },
        qdrant: () => null,
        createUploadId: () => 'upload-1',
        concurrency,
        idleTimeoutMs: 5_000,
        storage: () => new S3StorageAdapter(client),
      });
      // The fake MinIO never answers the abort; the response must not wait for it.
      assert.ok(Date.now() - started < 5_000, `settled after ${Date.now() - started} ms`);
      assert.equal(response.status, 500);
      const payload = (await response.json()) as { ok?: boolean; code?: string };
      assert.notEqual(payload.ok, true);
      assert.equal(payload.code, 'INTERNAL_ERROR');
      assert.deepEqual(audits, ['upload.failed']);
      assert.equal(concurrency.inUse, 0, 'upload slot released');
      assert.equal(count(events, 'complete'), 1);
      await waitFor(() => events.some((event) => event.type === 'abort'));
    }, { complete: 'fail', abort: 'hang' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(guard.seen, []);
  } finally {
    guard.dispose();
  }
});

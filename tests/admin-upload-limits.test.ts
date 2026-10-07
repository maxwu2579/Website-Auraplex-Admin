import assert from 'node:assert/strict';
import test from 'node:test';
import type { AdminIdentity } from '../lib/admin/server/authorization';
import {
  DEFAULT_MAX_CONCURRENT_UPLOADS,
  getMaxConcurrentUploads,
  UploadConcurrencyGuard,
} from '../lib/admin/server/upload-concurrency';
import {
  InMemoryUploadRateLimiter,
  UPLOAD_RATE_LIMITS,
  type UploadRateLimiter,
} from '../lib/admin/server/rate-limit';
import type { StorageAdapter } from '../lib/admin/server/storage';
import { putUpload, type UploadServiceDependencies } from '../lib/admin/server/upload-service';

// A 1 MB server limit keeps oversize cases small. Each test file runs in its
// own node:test process, so this does not leak into other suites.
process.env.ADMIN_UPLOAD_MAX_MB = '1';
const MAX_UPLOAD = 1024 * 1024;
const PDF_HEADER = new TextEncoder().encode('%PDF-1.7\n');

interface BodyOptions {
  /** Error the body after this many bytes (client disconnect). */
  failAfter?: number;
  /** Stop sending, but keep the stream open, after this many bytes. */
  stallAfter?: number;
  /** Size of each chunk; 16 KiB unless a test needs the bytes to arrive differently. */
  chunkBytes?: number;
}

/** PDF-signed body of `total` bytes in 16 KiB chunks, or `chunkBytes` when given. */
function pdfBody(total: number, { failAfter, stallAfter, chunkBytes = 16 * 1024 }: BodyOptions = {}): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAfter !== undefined && sent >= failAfter) {
        controller.error(new Error('client disconnected'));
        return;
      }
      if (stallAfter !== undefined && sent >= stallAfter) return new Promise<void>(() => {});
      if (sent >= total) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(Math.min(chunkBytes, total - sent)).fill(0x20);
      if (sent === 0) chunk.set(PDF_HEADER.subarray(0, chunk.byteLength));
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
}

function uploadRequest(total: number, options: BodyOptions & { declare?: boolean; signal?: AbortSignal } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/pdf',
    'x-product-id': '6470625',
    'x-product-line': 'labelling',
    'x-upload-filename': 'manual.pdf',
    'x-csrf-token': 'csrf',
  };
  if (options.declare) headers['content-length'] = String(total);
  return new Request('http://localhost/api/admin/uploads', {
    method: 'PUT',
    body: pdfBody(total, options),
    headers,
    signal: options.signal,
    duplex: 'half',
  } as RequestInit);
}

async function drain(body: AsyncIterable<unknown>): Promise<number> {
  let bytes = 0;
  for await (const chunk of body) bytes += (chunk as Uint8Array).byteLength;
  return bytes;
}

const drainingStorage: StorageAdapter = {
  async putObject(input) { await drain(input.body); return {}; },
  async listObjects() { return []; },
  async deleteObject() {},
};

/** Storage whose first write waits until `open()` is called. */
function gatedStorage() {
  let open!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const adapter: StorageAdapter = {
    async putObject(input) { markStarted(); await gate; await drain(input.body); return {}; },
    async listObjects() { return []; },
    async deleteObject() {},
  };
  return { adapter, started, open };
}

const failingStorage: StorageAdapter = {
  async putObject(input) {
    for await (const _chunk of input.body) throw new Error('MinIO connection reset');
    return {};
  },
  async listObjects() { return []; },
  async deleteObject() {},
};

const uploader = async (): Promise<AdminIdentity> => ({ userId: 'user-1', groups: ['auraplex-uploader'] });
const unlimited: UploadRateLimiter = {
  admit: () => ({ allowanceBytes: Number.MAX_SAFE_INTEGER, settle() {} }),
};

function deps(overrides: Partial<UploadServiceDependencies> = {}): Partial<UploadServiceDependencies> {
  return {
    authenticate: uploader,
    csrf: { verify() {} },
    rateLimiter: unlimited,
    audit: { write() {} },
    qdrant: () => null,
    createUploadId: () => 'upload-1',
    concurrency: new UploadConcurrencyGuard(() => 1),
    idleTimeoutMs: 5_000,
    storage: () => drainingStorage,
    ...overrides,
  };
}

async function code(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { code?: string }).code;
}

/** Far longer than any idle timeout used here, so it only ends an upload that is stuck. */
const UPLOAD_DEADLINE_MS = 2_000;
/** How long an upload gets to unwind once its request has been aborted. */
const ABORT_GRACE_MS = 500;

/**
 * Awaits an upload that must end by itself, and fails if it has not ended by
 * a deadline. `start` receives the signal to put on its request.
 *
 * The application's idle timer is unref'd, so it does not keep the process
 * alive. In a test with no server and no socket, an upload that waits on that
 * timer would let the event loop drain: the process would exit, cancelling
 * this test and every test after it. The deadline is an ordinary, ref'd timer
 * that keeps the process alive while the upload runs, and it turns an upload
 * that never ends into a failure of this test alone. It does not stand in for
 * the idle timeout: whatever response the upload produces is returned as it
 * is, for the caller to assert on.
 */
async function withinDeadline(
  name: string,
  start: (signal: AbortSignal) => Promise<Response>,
  deadlineMs = UPLOAD_DEADLINE_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const after = (ms: number) => new Promise<'expired'>((resolve) => { timers.push(setTimeout(() => resolve('expired'), ms)); });

  const upload = start(controller.signal);
  // Observed here so that a late rejection, after the deadline, is never unhandled.
  const settled = upload.then(() => 'settled' as const, () => 'settled' as const);
  try {
    if (await Promise.race([settled, after(deadlineMs)]) === 'settled') return await upload;

    // Stuck. Abort the request so its streams, idle timer and upload slot are
    // released, and give that a bounded time rather than waiting on it.
    controller.abort();
    const unwound = await Promise.race([settled, after(ABORT_GRACE_MS)]) === 'settled';
    throw new Error(
      `${name}: the upload did not end within ${deadlineMs} ms` +
      (unwound ? '' : `, and was still running ${ABORT_GRACE_MS} ms after its request was aborted`),
    );
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
}

// --- Concurrency guard -----------------------------------------------------

test('guard grants slots up to the limit and releases idempotently', () => {
  const guard = new UploadConcurrencyGuard(() => 2);
  const first = guard.tryAcquire();
  const second = guard.tryAcquire();
  assert.ok(first && second);
  assert.equal(guard.tryAcquire(), null, 'capacity exhausted');
  first.release();
  first.release(); // A second release must not free another slot.
  assert.equal(guard.inUse, 1);
  const third = guard.tryAcquire();
  assert.ok(third);
  assert.equal(guard.tryAcquire(), null);
  second.release();
  third.release();
  assert.equal(guard.inUse, 0);
});

test('concurrency limit defaults to 4 and accepts only 1-16 from the environment', () => {
  assert.equal(getMaxConcurrentUploads({}), DEFAULT_MAX_CONCURRENT_UPLOADS);
  assert.equal(DEFAULT_MAX_CONCURRENT_UPLOADS, 4);
  assert.equal(getMaxConcurrentUploads({ ADMIN_UPLOAD_MAX_CONCURRENT: '2' }), 2);
  for (const value of ['0', '17', '2.5', 'many', '-1']) {
    assert.throws(() => getMaxConcurrentUploads({ ADMIN_UPLOAD_MAX_CONCURRENT: value }), /ADMIN_UPLOAD_MAX_CONCURRENT/);
  }
});

test('a full process answers 503 before reading the body or charging the rate limit', async () => {
  const concurrency = new UploadConcurrencyGuard(() => 1);
  const held = concurrency.tryAcquire();
  let admitted = 0;
  let stored = 0;
  const response = await putUpload(uploadRequest(64 * 1024, { declare: true }), deps({
    concurrency,
    rateLimiter: { admit: () => { admitted += 1; return { allowanceBytes: Number.MAX_SAFE_INTEGER, settle() {} }; } },
    storage: () => ({ ...drainingStorage, async putObject() { stored += 1; return {}; } }),
  }));
  assert.equal(response.status, 503);
  assert.equal(await code(response), 'UPLOAD_CAPACITY_EXHAUSTED');
  assert.equal(admitted, 0);
  assert.equal(stored, 0);
  held?.release();
  assert.equal(concurrency.inUse, 0);
});

test('a concurrent upload is refused while the slot is busy and admitted after', async () => {
  const concurrency = new UploadConcurrencyGuard(() => 1);
  const gated = gatedStorage();
  const first = putUpload(uploadRequest(64 * 1024), deps({ concurrency, storage: () => gated.adapter }));
  await gated.started;
  assert.equal(concurrency.inUse, 1);
  const refused = await putUpload(uploadRequest(64 * 1024), deps({ concurrency }));
  assert.equal(refused.status, 503);
  gated.open();
  assert.equal((await first).status, 200);
  assert.equal(concurrency.inUse, 0, 'released after success');
  assert.equal((await putUpload(uploadRequest(64 * 1024), deps({ concurrency }))).status, 200);
  assert.equal(concurrency.inUse, 0);
});

test('the slot is released after every failure mode, with no permanent leak', async () => {
  const concurrency = new UploadConcurrencyGuard(() => 1);
  const cases: Array<{ name: string; run: () => Promise<Response>; status: number; code: string }> = [
    {
      name: 'storage failure',
      run: () => putUpload(uploadRequest(64 * 1024), deps({ concurrency, storage: () => failingStorage })),
      status: 500,
      code: 'INTERNAL_ERROR',
    },
    {
      name: 'oversize stream without Content-Length',
      run: () => putUpload(uploadRequest(2 * MAX_UPLOAD), deps({ concurrency })),
      status: 413,
      code: 'FILE_TOO_LARGE',
    },
    {
      name: 'body shorter than Content-Length',
      run: () => putUpload(
        new Request('http://localhost/api/admin/uploads', {
          method: 'PUT',
          body: pdfBody(32 * 1024),
          headers: { ...Object.fromEntries(uploadRequest(1).headers), 'content-length': String(64 * 1024) },
          duplex: 'half',
        } as RequestInit),
        deps({ concurrency }),
      ),
      status: 400,
      code: 'SIZE_MISMATCH',
    },
    {
      name: 'client disconnect mid-body',
      run: () => putUpload(uploadRequest(512 * 1024, { failAfter: 128 * 1024 }), deps({ concurrency })),
      status: 500,
      code: 'INTERNAL_ERROR',
    },
    {
      name: 'stalled client (idle timeout)',
      run: () => withinDeadline('stalled client', (signal) => putUpload(
        uploadRequest(512 * 1024, { stallAfter: 64 * 1024, signal }),
        deps({ concurrency, idleTimeoutMs: 50 }),
      )),
      status: 408,
      code: 'REQUEST_TIMEOUT',
    },
    {
      name: 'MIME rejection',
      run: () => putUpload(
        new Request('http://localhost/api/admin/uploads', {
          method: 'PUT',
          body: new TextEncoder().encode('not a pdf at all'),
          headers: Object.fromEntries(uploadRequest(1).headers),
        }),
        deps({ concurrency }),
      ),
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
    },
  ];
  for (const { name, run, status, code: expected } of cases) {
    const response = await run();
    assert.equal(response.status, status, name);
    assert.equal(await code(response), expected, name);
    assert.equal(concurrency.inUse, 0, `slot released after ${name}`);
  }
  // Still usable after all failures.
  assert.equal((await putUpload(uploadRequest(64 * 1024), deps({ concurrency }))).status, 200);
});

test('a request aborted by the client releases the slot', async () => {
  const concurrency = new UploadConcurrencyGuard(() => 1);
  const controller = new AbortController();
  const gated = gatedStorage();
  const pending = putUpload(
    uploadRequest(512 * 1024, { signal: controller.signal }),
    deps({ concurrency, storage: () => gated.adapter }),
  );
  await gated.started;
  controller.abort();
  gated.open();
  const response = await pending;
  assert.ok(response.status >= 400);
  assert.equal(concurrency.inUse, 0);
});

// --- Rate limit: reserve at admission, settle to actual bytes ---------------

type LimiterEvents = Map<string, Array<{ at: number; bytes: number }>>;
const eventsOf = (limiter: InMemoryUploadRateLimiter) => (limiter as unknown as { events: LimiterEvents }).events;
const hourBytes = (limiter: InMemoryUploadRateLimiter, user = 'user-1') =>
  (eventsOf(limiter).get(user) ?? []).reduce((sum, event) => sum + event.bytes, 0);
const GiB = 1024 * 1024 * 1024;

test('known-length uploads reserve the declared size; unknown length reserves the per-file max', () => {
  const limiter = new InMemoryUploadRateLimiter();
  const now = Date.UTC(2026, 8, 28, 9);
  const known = limiter.admit('user-1', { declaredBytes: 300, maxUploadBytes: MAX_UPLOAD }, now);
  assert.equal(known.allowanceBytes, 300);
  assert.equal(hourBytes(limiter), 300);
  const unknown = limiter.admit('user-1', { maxUploadBytes: MAX_UPLOAD }, now);
  assert.equal(unknown.allowanceBytes, MAX_UPLOAD);
  assert.equal(hourBytes(limiter), 300 + MAX_UPLOAD);
});

test('a successful upload settles its reservation to the bytes actually received', async () => {
  const limiter = new InMemoryUploadRateLimiter();
  const unknown = await putUpload(uploadRequest(200 * 1024), deps({ rateLimiter: limiter }));
  assert.equal(unknown.status, 200);
  assert.equal(((await unknown.json()) as { size: number }).size, 200 * 1024);
  assert.equal(hourBytes(limiter), 200 * 1024, 'unknown-length reservation shrinks to actual');
  const known = await putUpload(uploadRequest(100 * 1024, { declare: true }), deps({ rateLimiter: limiter }));
  assert.equal(known.status, 200);
  assert.equal(hourBytes(limiter), 300 * 1024);
});

test('a failed upload settles to the bytes that actually arrived', async () => {
  const limiter = new InMemoryUploadRateLimiter();
  const response = await putUpload(
    uploadRequest(512 * 1024, { failAfter: 128 * 1024 }),
    deps({ rateLimiter: limiter }),
  );
  assert.equal(response.status, 500);
  const charged = hourBytes(limiter);
  assert.ok(charged >= 64 * 1024 && charged <= 128 * 1024, `charged ${charged}`);
  // The full per-file reservation was released back to the hourly budget.
  assert.ok(charged < MAX_UPLOAD);
});

test('a stalled upload settles its 1 MiB reservation to the 64 KiB that arrived', async () => {
  const limiter = new InMemoryUploadRateLimiter();
  const concurrency = new UploadConcurrencyGuard(() => 1);
  let reservedWhileUploading = -1;
  // All 64 KiB arrive as the first chunk, PDF header included, and the client
  // stalls straight after. The idle timer is already running while the type
  // is detected, so bytes split over several chunks could be cut short by a
  // slow detection; one chunk is counted in full whenever the timeout fires.
  const response = await withinDeadline('stalled client with a real limiter', (signal) => putUpload(
    uploadRequest(512 * 1024, { stallAfter: 64 * 1024, chunkBytes: 64 * 1024, signal }),
    deps({
      rateLimiter: limiter,
      concurrency,
      idleTimeoutMs: 50,
      storage: () => ({
        ...drainingStorage,
        async putObject(input) {
          reservedWhileUploading = hourBytes(limiter);
          await drain(input.body);
          return {};
        },
      }),
    }),
  ));
  assert.equal(response.status, 408);
  assert.equal(await code(response), 'REQUEST_TIMEOUT');
  // No Content-Length, so the whole per-file maximum was reserved up front.
  assert.equal(reservedWhileUploading, MAX_UPLOAD);
  // The slot is free again, but the bytes that arrived stay charged: the
  // reservation is replaced by them, neither kept at 1 MiB nor dropped to 0.
  assert.equal(concurrency.inUse, 0);
  assert.equal(hourBytes(limiter), 64 * 1024);
  assert.equal(eventsOf(limiter).get('user-1')?.length, 1, 'one upload recorded, nothing left reserved');

  // The same user can upload again, and is charged for exactly both uploads.
  const next = await putUpload(uploadRequest(16 * 1024, { declare: true }), deps({ rateLimiter: limiter, concurrency }));
  assert.equal(next.status, 200);
  assert.equal(hourBytes(limiter), 64 * 1024 + 16 * 1024);
  assert.equal(concurrency.inUse, 0);
});

test('near the 5 GiB hourly quota, declarations must fit and unknown lengths shrink', () => {
  const now = Date.UTC(2026, 8, 28, 9);
  const limiter = new InMemoryUploadRateLimiter();
  limiter.admit('user-1', { declaredBytes: 5 * GiB - 1000, maxUploadBytes: 5 * GiB }, now).settle(5 * GiB - 1000);
  assert.throws(() => limiter.admit('user-1', { declaredBytes: 1001, maxUploadBytes: MAX_UPLOAD }, now), /rate limit/);
  assert.equal(limiter.admit('user-1', { maxUploadBytes: MAX_UPLOAD }, now).allowanceBytes, 1000);
  // That reservation now holds the remaining volume.
  assert.throws(() => limiter.admit('user-1', { maxUploadBytes: MAX_UPLOAD }, now), /rate limit/);
  assert.equal(hourBytes(limiter), UPLOAD_RATE_LIMITS.bytesPerHour);
});

test('concurrent reservations from one user cannot jointly exceed the hourly volume', () => {
  const now = Date.UTC(2026, 8, 28, 9);
  const limiter = new InMemoryUploadRateLimiter();
  const perFile = 500 * 1024 * 1024;
  limiter.admit('user-1', { declaredBytes: 5 * GiB - 700 * 1024 * 1024, maxUploadBytes: 5 * GiB }, now)
    .settle(5 * GiB - 700 * 1024 * 1024);
  // 700 MiB left: in-flight uploads reserve 500 MiB, then 200 MiB, then none.
  const first = limiter.admit('user-1', { maxUploadBytes: perFile }, now);
  const second = limiter.admit('user-1', { maxUploadBytes: perFile }, now);
  assert.deepEqual([first.allowanceBytes, second.allowanceBytes], [perFile, 200 * 1024 * 1024]);
  assert.throws(() => limiter.admit('user-1', { maxUploadBytes: perFile }, now), /rate limit/);
  // Settling the first to its real size frees the unused part of its reservation.
  first.settle(100 * 1024 * 1024);
  assert.equal(limiter.admit('user-1', { maxUploadBytes: perFile }, now).allowanceBytes, 400 * 1024 * 1024);
});

test('parallel uploads over the stream cannot bypass the reserved volume', async () => {
  const limiter = new InMemoryUploadRateLimiter();
  // Leave 100 KiB of hourly volume.
  limiter.admit('user-1', { declaredBytes: 5 * GiB - 100 * 1024, maxUploadBytes: 5 * GiB }).settle(5 * GiB - 100 * 1024);
  const concurrency = new UploadConcurrencyGuard(() => 4);
  const gated = gatedStorage();
  const first = putUpload(uploadRequest(160 * 1024), deps({ rateLimiter: limiter, concurrency, storage: () => gated.adapter }));
  await gated.started;
  const second = await putUpload(uploadRequest(16 * 1024), deps({ rateLimiter: limiter, concurrency }));
  assert.equal(second.status, 429, 'the first upload holds all remaining volume');
  gated.open();
  // The first upload may use only its 100 KiB reservation.
  const firstResponse = await first;
  assert.equal(firstResponse.status, 429);
  assert.ok(hourBytes(limiter) <= UPLOAD_RATE_LIMITS.bytesPerHour + 16 * 1024, 'overrun bounded by one chunk');
  assert.equal(concurrency.inUse, 0);
});

test('documented limitation: bytes count toward the hour in which the upload was admitted', () => {
  const limiter = new InMemoryUploadRateLimiter();
  const admittedAt = Date.UTC(2026, 8, 28, 9);
  // A long upload admitted at 09:00 and settled at 09:50 is still recorded at 09:00 ...
  limiter.admit('user-1', { maxUploadBytes: 5 * GiB }, admittedAt).settle(5 * GiB);
  assert.throws(() => limiter.admit('user-1', { declaredBytes: 1, maxUploadBytes: 1 }, admittedAt + 50 * 60_000));
  // ... so its volume stops counting at 10:00, one hour after admission.
  assert.equal(limiter.admit('user-1', { declaredBytes: 1, maxUploadBytes: 1 }, admittedAt + 60 * 60_000 + 1).allowanceBytes, 1);
});

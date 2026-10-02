import assert from 'node:assert/strict';
import test from 'node:test';
import NextAuth from 'next-auth';
import { decode, encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

import { createAdminAuthConfig } from '../lib/admin/server/auth-config';
import {
  ADMIN_SESSION_POLICY,
  KEYCLOAK_REVALIDATION_WINDOW_SECONDS,
  REVALIDATION_UNAVAILABLE_FLAG,
  isKeycloakRevalidationDue,
} from '../lib/admin/server/session-policy';
import {
  ID_TOKEN_CLOCK_TOLERANCE_SECONDS,
  REFRESH_RESULT_REUSE_MS,
  RefreshSingleFlight,
  createKeycloakRevalidator,
  type KeycloakRevalidationResult,
} from '../lib/admin/server/keycloak-revalidation';
import {
  PROXY_IDENTITY_HEADER,
  createAdminSessionLoader,
  proxiedRequestIdentity,
  sealProxyIdentity,
  withAdminRequestSession,
  type AdminSessionLoader,
} from '../lib/admin/server/session';
import { requireUploadPermission } from '../lib/admin/server/authorization';
import { getAdminCsrfResponse } from '../lib/admin/server/csrf-service';
import type { StorageAdapter, StoredObject } from '../lib/admin/server/storage';
import { authSessionCookieName } from '../lib/admin/server/auth-cookies';
import { getUploads, putUpload } from '../lib/admin/server/upload-service';
import { deleteUpload } from '../lib/admin/server/delete-service';
import { UploadConcurrencyGuard } from '../lib/admin/server/upload-concurrency';
import { createAdminProxy } from '../proxy';
import { createFakeKeycloak, type FakeKeycloakMode } from './helpers/fake-keycloak';

// Test-only configuration. No request in this file leaves the process: Keycloak
// is an in-process fake reached through an injected fetch.
const TEST_ENV = {
  AUTH_SECRET: 'test-only-auth-secret-0123456789abcdef',
  KEYCLOAK_ISSUER: 'https://sso.example.test/realms/auraplex',
  KEYCLOAK_CLIENT_ID: 'website-test',
  KEYCLOAK_CLIENT_SECRET: 'test-only',
};
Object.assign(process.env, TEST_ENV);
const KEYCLOAK = {
  issuer: TEST_ENV.KEYCLOAK_ISSUER,
  clientId: TEST_ENV.KEYCLOAK_CLIENT_ID,
  clientSecret: TEST_ENV.KEYCLOAK_CLIENT_SECRET,
};

const COOKIE = authSessionCookieName(false);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const WINDOW = KEYCLOAK_REVALIDATION_WINDOW_SECONDS * SECOND;
const IDLE = ADMIN_SESSION_POLICY.idleTimeoutSeconds * SECOND;
const ABSOLUTE = ADMIN_SESSION_POLICY.absoluteLifetimeSeconds * SECOND;
const T0 = Date.UTC(2026, 9, 2, 8, 0, 0);
const sec = (ms: number) => Math.floor(ms / 1000);

// The application's own user id and the Keycloak subject are different values.
const APP_SUB = 'app-user-1';
const KC_SUB = 'keycloak-sub-1';

// Revalidation failures are logged; capture them to check nothing secret leaks.
const warnings: string[] = [];
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };

async function setup(startMs = T0 + 2 * HOUR) {
  const clock = { now: startMs };
  const now = () => clock.now;
  const kc = await createFakeKeycloak(KEYCLOAK);
  const singleFlight = new RefreshSingleFlight();
  const revalidator = createKeycloakRevalidator({
    config: KEYCLOAK,
    fetcher: kc.fetcher(now),
    now,
    production: false,
    singleFlight,
  });
  const { auth, handlers } = NextAuth(
    createAdminAuthConfig({ env: { ...TEST_ENV, NODE_ENV: 'test' }, now, revalidator }),
  );
  const load = createAdminSessionLoader(auth);

  /** A session cookie whose Keycloak validation is `validatedAgo` old (default: just due). */
  async function cookie(
    { groups = ['auraplex-uploader'], validatedAgo = WINDOW, ...claims }:
      { groups?: string[]; validatedAgo?: number } & Record<string, unknown> = {},
  ) {
    const refreshToken = kc.grant(KC_SUB, groups);
    const token = await encode({
      secret: TEST_ENV.AUTH_SECRET,
      salt: COOKIE,
      // Long JWT expiry so only the session policy (not real time) decides.
      maxAge: 30 * 24 * 3600,
      token: {
        sub: APP_SUB,
        email: 'user@example.test',
        groups,
        loginAt: sec(clock.now - HOUR),
        activeAt: sec(clock.now - MINUTE),
        keycloakSub: KC_SUB,
        refreshToken,
        idToken: 'previous-id-token',
        lastValidatedAt: sec(clock.now - validatedAgo),
        ...claims,
      },
    });
    return { header: `${COOKIE}=${token}`, refreshToken };
  }

  return { clock, kc, singleFlight, load, handlers, cookie };
}

const headersFor = (cookie?: string) =>
  new Headers({ host: 'admin.example.test', ...(cookie ? { cookie } : {}) });

/** The re-issued session cookie as a request Cookie header, if one was set. */
function nextCookie(setCookies: string[]): string | null {
  const value = setCookies.find((cookie) => cookie.startsWith(`${COOKIE}=`) && !/Max-Age=0/i.test(cookie));
  return value ? value.split(';', 1)[0] : null;
}

async function reissued(setCookies: string[]) {
  const header = nextCookie(setCookies);
  if (!header) return null;
  return decode({ secret: TEST_ENV.AUTH_SECRET, salt: COOKIE, token: header.slice(COOKIE.length + 1) });
}

const clearsSession = (setCookies: string[]) =>
  setCookies.some((cookie) => cookie.startsWith(`${COOKIE}=;`) && /Max-Age=0/i.test(cookie));

const groupsOf = (session: unknown) => (session as { user?: { groups?: string[] } } | null)?.user?.groups;

function spyStorage() {
  let puts = 0;
  return {
    puts: () => puts,
    adapter: {
      async putObject(input: { body: AsyncIterable<unknown> }) { puts += 1; for await (const _chunk of input.body) { /* drain */ } return {}; },
      async listObjects() { return []; },
      async deleteObject() {},
    },
  };
}

const serviceDeps = (storage: ReturnType<typeof spyStorage>) => ({
  storage: () => storage.adapter,
  qdrant: () => null,
  audit: { write() {} },
  rateLimiter: { admit: () => ({ allowanceBytes: Number.MAX_SAFE_INTEGER, settle() {} }) },
  concurrency: new UploadConcurrencyGuard(() => 4),
  createUploadId: () => 'upload-1',
});

/** PUT through the Proxy-bypassed upload endpoint's own session wrapper. */
async function upload(load: AdminSessionLoader, cookie: string) {
  const request = new NextRequest('http://admin.example.test/api/admin/uploads', {
    method: 'PUT',
    body: new TextEncoder().encode('%PDF-1.7\nbody'),
    headers: {
      host: 'admin.example.test',
      'content-type': 'application/pdf',
      'x-product-id': '6470625',
      'x-product-line': 'labelling',
      'x-upload-filename': 'manual.pdf',
      'x-csrf-token': 'csrf',
      cookie: `${cookie}; auraplex-admin-csrf=csrf`,
    },
  });
  const storage = spyStorage();
  const response = await withAdminRequestSession(
    request,
    (authenticate) => putUpload(request, { ...serviceDeps(storage), authenticate }),
    load,
  );
  return { response, puts: storage.puts() };
}

/** Admin-only DELETE through the same wrapper; storage and Qdrant are spies. */
async function remove(load: AdminSessionLoader, cookie: string) {
  const request = new NextRequest('http://admin.example.test/api/admin/uploads', {
    method: 'DELETE',
    body: JSON.stringify({ bucket: 'auraplex-raw-pdf', key: 'machines/flexy-applicator/manual.pdf' }),
    headers: { host: 'admin.example.test', 'content-type': 'application/json', cookie },
  });
  const calls: string[] = [];
  const response = await withAdminRequestSession(
    request,
    (authenticate) => deleteUpload(request, {
      authenticate,
      csrf: { verify() {} },
      audit: { write() {} },
      qdrant: () => ({ async hasProcessedEvidence() { return false; }, async deleteBySourceKey() { calls.push('qdrant'); } }),
      storage: () => ({ async putObject() { return {}; }, async listObjects() { return []; }, async deleteObject() { calls.push('minio'); } }),
    }),
    load,
  );
  return { response, calls };
}

const code = async (response: Response) => ((await response.json()) as { code?: string }).code;

// --- Freshness window -------------------------------------------------------

test('the freshness window is 60 seconds and independent of the session lifetimes', () => {
  assert.equal(KEYCLOAK_REVALIDATION_WINDOW_SECONDS, 60);
  assert.equal(ADMIN_SESSION_POLICY.idleTimeoutSeconds, 30 * 60);
  assert.equal(ADMIN_SESSION_POLICY.absoluteLifetimeSeconds, 12 * 60 * 60);
  const validated = sec(T0);
  assert.equal(isKeycloakRevalidationDue(validated, T0), false);
  assert.equal(isKeycloakRevalidationDue(validated, T0 + 59 * SECOND), false);
  assert.equal(isKeycloakRevalidationDue(validated, T0 + 60 * SECOND), true);
  // A validation time in the future is not trusted.
  assert.equal(isKeycloakRevalidationDue(validated + 10, T0), true);
});

test('validated less than 60 seconds ago: no Keycloak call, lastValidatedAt unchanged', async () => {
  const { clock, kc, load, cookie } = await setup();
  const validatedAt = sec(clock.now - 59 * SECOND);
  const { header, refreshToken } = await cookie({ validatedAgo: 59 * SECOND });
  const { session, setCookies } = await load(headersFor(header));
  assert.deepEqual(groupsOf(session), ['auraplex-uploader']);
  assert.deepEqual(kc.calls, { discovery: 0, jwks: 0, token: 0 });
  const token = await reissued(setCookies);
  // Local activity is recorded, but it is not an authoritative validation.
  assert.equal(token?.activeAt, sec(clock.now));
  assert.equal(token?.lastValidatedAt, validatedAt);
  assert.equal(token?.refreshToken, refreshToken);
});

test('validated 60 seconds ago: exactly one Keycloak refresh, unchanged groups stay allowed', async () => {
  const { clock, kc, load, cookie } = await setup();
  const { header } = await cookie();
  const { session, setCookies } = await load(headersFor(header));
  assert.deepEqual(groupsOf(session), ['auraplex-uploader']);
  assert.equal(kc.calls.token, 1);
  const token = await reissued(setCookies);
  assert.equal(token?.lastValidatedAt, sec(clock.now));
  assert.equal(token?.activeAt, sec(clock.now));
  assert.notEqual(token?.idToken, 'previous-id-token', 'the fresh ID token replaces the old one');

  const ok = await upload(load, nextCookie(setCookies)!);
  assert.equal(ok.response.status, 200);
  assert.equal(ok.puts, 1);
  assert.equal(kc.calls.token, 1, 'the re-issued cookie is fresh again');
});

// --- Group changes ----------------------------------------------------------

test('removed groups are replaced, not merged: a removed uploader is denied', async () => {
  const { kc, load, cookie } = await setup();
  const { header } = await cookie({ groups: ['auraplex-uploader', 'auraplex-admin'] });
  kc.setGroups(KC_SUB, ['staff']);

  const denied = await upload(load, header);
  assert.equal(denied.response.status, 403);
  assert.equal(await code(denied.response), 'FORBIDDEN');
  assert.equal(denied.puts, 0, 'nothing reaches storage');
  // The session itself stays valid; its groups are exactly Keycloak's.
  const token = await reissued(denied.response.headers.getSetCookie());
  assert.deepEqual(token?.groups, ['staff']);
});

test('admin removed, uploader retained: upload allowed, admin-only delete denied', async () => {
  const { kc, load, cookie } = await setup();
  const { header } = await cookie({ groups: ['auraplex-uploader', 'auraplex-admin'] });
  kc.setGroups(KC_SUB, ['auraplex-uploader']);

  const uploaded = await upload(load, header);
  assert.equal(uploaded.response.status, 200);
  assert.equal(uploaded.puts, 1);
  const fresh = nextCookie(uploaded.response.headers.getSetCookie())!;
  assert.deepEqual((await reissued(uploaded.response.headers.getSetCookie()))?.groups, ['auraplex-uploader']);

  const deleted = await remove(load, fresh);
  assert.equal(deleted.response.status, 403);
  assert.deepEqual(deleted.calls, []);

  // The same delete straight from the stale admin cookie is denied as well.
  const stale = await setup();
  const staleCookie = await stale.cookie({ groups: ['auraplex-uploader', 'auraplex-admin'] });
  stale.kc.setGroups(KC_SUB, ['auraplex-uploader']);
  const staleDelete = await remove(stale.load, staleCookie.header);
  assert.equal(staleDelete.response.status, 403);
  assert.deepEqual(staleDelete.calls, []);
});

test('a newly added group takes effect at the next revalidation', async () => {
  const { kc, load, cookie } = await setup();
  const { header } = await cookie({ groups: ['auraplex-uploader'] });
  kc.setGroups(KC_SUB, ['auraplex-uploader', 'auraplex-admin']);
  const deleted = await remove(load, header);
  assert.equal(deleted.response.status, 200);
  assert.deepEqual(deleted.calls, ['qdrant', 'minio']);
});

// --- Fail closed ------------------------------------------------------------

test('invalid_grant (revoked, disabled, ended SSO session): 401 and the session is cleared', async () => {
  const disabled = await setup();
  const first = await disabled.cookie();
  disabled.kc.disable(KC_SUB);
  const loaded = await disabled.load(headersFor(first.header));
  assert.equal(loaded.session, null);
  assert.ok(clearsSession(loaded.setCookies));
  assert.notEqual(loaded.revalidationUnavailable, true);

  // A refresh token Keycloak no longer recognises (revoked or already rotated).
  const revoked = await setup();
  const second = await revoked.cookie({ refreshToken: 'refresh-unknown-to-keycloak' });
  const denied = await upload(revoked.load, second.header);
  assert.equal(denied.response.status, 401);
  assert.equal(await code(denied.response), 'UNAUTHENTICATED');
  assert.equal(denied.puts, 0);
  assert.ok(clearsSession(denied.response.headers.getSetCookie()));
});

test('a refresh token past its recorded Keycloak expiry ends the session without a call', async () => {
  const { clock, kc, load, cookie } = await setup();
  const { header } = await cookie({ refreshExpiresAt: sec(clock.now) });
  const loaded = await load(headersFor(header));
  assert.equal(loaded.session, null);
  assert.ok(clearsSession(loaded.setCookies));
  assert.equal(kc.calls.token, 0);
});

for (const mode of ['timeout', 'network', 'http-5xx'] as const) {
  test(`Keycloak ${mode}: controlled 503, no privileged operation, stale groups not used`, async () => {
    const { clock, kc, load, cookie } = await setup();
    const { header, refreshToken } = await cookie({ groups: ['auraplex-uploader', 'auraplex-admin'] });
    kc.mode = mode;

    const loaded = await load(headersFor(header));
    assert.equal(loaded.session, null);
    assert.equal(loaded.revalidationUnavailable, true);
    // The cookie is neither cleared nor re-issued: activeAt and
    // lastValidatedAt are not advanced by a denied request.
    assert.deepEqual(loaded.setCookies, []);

    const put = await upload(load, header);
    assert.equal(put.response.status, 503);
    assert.equal(await code(put.response), 'IDENTITY_PROVIDER_UNAVAILABLE');
    assert.equal(put.puts, 0);
    assert.deepEqual(put.response.headers.getSetCookie(), []);

    const del = await remove(load, header);
    assert.equal(del.response.status, 503);
    assert.deepEqual(del.calls, []);

    const proxy = createAdminProxy(load);
    const api = await proxy(new NextRequest('http://admin.example.test/api/admin/csrf', { headers: headersFor(header) }));
    assert.equal(api.status, 503);
    assert.equal(await code(api), 'IDENTITY_PROVIDER_UNAVAILABLE');
    assert.equal(api.headers.get('x-middleware-next'), null);
    const page = await proxy(new NextRequest('http://admin.example.test/admin/upload', { headers: headersFor(header) }));
    assert.equal(page.status, 503);
    assert.equal(page.headers.get('x-middleware-next'), null);
    assert.deepEqual(page.headers.getSetCookie(), []);

    // Once Keycloak answers again, the preserved cookie works without re-login.
    kc.mode = 'ok';
    clock.now += 5 * SECOND;
    const recovered = await upload(load, header);
    assert.equal(recovered.response.status, 200);
    assert.equal(recovered.puts, 1);
    const token = await reissued(recovered.response.headers.getSetCookie());
    assert.equal(token?.lastValidatedAt, sec(clock.now));
    assert.notEqual(token?.refreshToken, refreshToken);
  });
}

test('malformed or untrusted token responses are denied and never restore stale groups', async () => {
  const cases: Array<{ name: string; arrange: (kc: Awaited<ReturnType<typeof setup>>['kc']) => void }> = [
    { name: 'not JSON', arrange: (kc) => { kc.mode = 'not-json' satisfies FakeKeycloakMode; } },
    { name: 'no ID token', arrange: (kc) => { kc.mode = 'no-id-token'; } },
    { name: 'forged signature', arrange: (kc) => { kc.forgeSignature = true; } },
    { name: 'wrong issuer', arrange: (kc) => { kc.tamper = (claims) => ({ ...claims, iss: 'https://evil.example.test/realms/auraplex' }); } },
    { name: 'wrong audience', arrange: (kc) => { kc.tamper = (claims) => ({ ...claims, aud: 'another-client', azp: 'another-client' }); } },
    { name: 'wrong authorized party', arrange: (kc) => { kc.tamper = (claims) => ({ ...claims, aud: [KEYCLOAK.clientId, 'another-client'], azp: 'another-client' }); } },
    { name: 'different subject', arrange: (kc) => { kc.tamper = (claims) => ({ ...claims, sub: 'keycloak-sub-2' }); } },
    { name: 'expired', arrange: (kc) => { kc.tamper = (claims) => ({ ...claims, iat: claims.iat! - 600, exp: claims.iat! - 300 }); } },
    { name: 'no expiry', arrange: (kc) => { kc.tamper = ({ exp: _exp, ...claims }) => claims; } },
  ];
  for (const { name, arrange } of cases) {
    const { kc, load, cookie } = await setup();
    const { header } = await cookie({ groups: ['auraplex-uploader', 'auraplex-admin'] });
    // Even a response that claims admin must not be believed.
    arrange(kc);

    const put = await upload(load, header);
    assert.equal(put.response.status, 503, name);
    assert.equal(await code(put.response), 'IDENTITY_PROVIDER_UNAVAILABLE', name);
    assert.equal(put.puts, 0, name);
    assert.deepEqual(put.response.headers.getSetCookie(), [], name);
    const loaded = await load(headersFor(header));
    assert.equal(loaded.session, null, name);
  }
});

test('the unavailable marker is never trusted from, or kept in, a stored session', async () => {
  const { load, cookie } = await setup();
  const { header } = await cookie({ validatedAgo: 10 * SECOND, [REVALIDATION_UNAVAILABLE_FLAG]: true });
  const { session, setCookies } = await load(headersFor(header));
  assert.deepEqual(groupsOf(session), ['auraplex-uploader']);
  assert.equal((await reissued(setCookies))?.[REVALIDATION_UNAVAILABLE_FLAG], undefined);
});

// --- Refresh-token rotation and concurrency ---------------------------------

test('a rotated refresh token is stored and used for the next revalidation', async () => {
  const { clock, kc, load, cookie } = await setup();
  const { header, refreshToken } = await cookie();

  const first = await load(headersFor(header));
  const rotated = (await reissued(first.setCookies))?.refreshToken as string;
  assert.ok(rotated && rotated !== refreshToken);

  clock.now += WINDOW;
  const second = await load(headersFor(nextCookie(first.setCookies)!));
  assert.notEqual(second.session, null);
  assert.deepEqual(kc.presented, [refreshToken, rotated], 'the replaced token is never presented again');
  const rotatedAgain = (await reissued(second.setCookies))?.refreshToken;
  assert.ok(rotatedAgain && rotatedAgain !== rotated);
  // Discovery and signing keys are cached between revalidations.
  assert.deepEqual(kc.calls, { discovery: 1, jwks: 1, token: 2 });
});

test('a Keycloak signing-key rotation is picked up by refetching the JWKS once', async () => {
  const { clock, kc, load, cookie } = await setup();
  const { header } = await cookie();
  const first = await load(headersFor(header));
  await kc.rotateSigningKey();
  clock.now += WINDOW;
  const second = await load(headersFor(nextCookie(first.setCookies)!));
  assert.notEqual(second.session, null);
  assert.equal(kc.calls.jwks, 2);
});

test('concurrent requests with the same stale refresh state share one Keycloak refresh', async () => {
  const { clock, kc, load, cookie, singleFlight } = await setup();
  const { header, refreshToken } = await cookie();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  kc.duringTokenRequest = () => gate;

  const pending = Array.from({ length: 6 }, () => load(headersFor(header)));
  // Hold Keycloak's answer until the token request is on the wire and the
  // other requests have had time to reach the session callback.
  while (kc.calls.token === 0) await new Promise((resolve) => setImmediate(resolve));
  for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(singleFlight.size.inFlight, 1);
  release();
  const results = await Promise.all(pending);

  assert.equal(kc.calls.token, 1);
  assert.deepEqual(kc.presented, [refreshToken]);
  const refreshTokens = new Set<unknown>();
  for (const { session, setCookies } of results) {
    assert.deepEqual(groupsOf(session), ['auraplex-uploader']);
    refreshTokens.add((await reissued(setCookies))?.refreshToken);
  }
  assert.equal(refreshTokens.size, 1, 'every request received the same rotated token');
  assert.equal(refreshTokens.has(refreshToken), false);
  assert.deepEqual(singleFlight.size, { inFlight: 0, settled: 1 });

  // A request that still carries the old cookie just after the refresh
  // completed reuses the result instead of redeeming a rotated token.
  kc.duringTokenRequest = null;
  clock.now += REFRESH_RESULT_REUSE_MS - 1;
  assert.notEqual((await load(headersFor(header))).session, null);
  assert.equal(kc.calls.token, 1);

  // After the short reuse window the old cookie is on its own: Keycloak
  // refuses the rotated token and that session ends.
  clock.now += 1;
  const late = await load(headersFor(header));
  assert.equal(late.session, null);
  assert.ok(clearsSession(late.setCookies));
  assert.equal(kc.calls.token, 2);
});

test('the single-flight state is bounded, expires, and never reuses a failure', async () => {
  let nowMs = 0;
  const now = () => nowMs;
  const flight = new RefreshSingleFlight(1_000, 2);
  const ok = (id: string): KeycloakRevalidationResult =>
    ({ status: 'ok', refreshToken: id, idToken: id, groups: [], validatedAt: 1 });
  let calls = 0;
  const run = (key: string, result: KeycloakRevalidationResult) =>
    flight.run(key, now, async () => { calls += 1; return result; });

  await run('a', ok('a'));
  await run('b', ok('b'));
  await run('c', ok('c'));
  assert.deepEqual(flight.size, { inFlight: 0, settled: 2 }, 'the oldest entry is evicted at capacity');
  assert.equal(calls, 3);
  await run('c', ok('c'));
  assert.equal(calls, 3, 'reused inside the window');
  nowMs = 1_000;
  await run('c', ok('c'));
  assert.equal(calls, 4, 'expired entries are not reused');

  for (const failure of [{ status: 'revoked' }, { status: 'unavailable', reason: 'network' }] as const) {
    await run('failing', failure);
    await run('failing', failure);
  }
  assert.equal(calls, 8, 'failures are retried every time');

  // In-flight entries are capped too; excess refreshes are refused, not queued.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const held = ['x', 'y'].map((key) => flight.run(key, now, async () => { await gate; return ok(key); }));
  assert.deepEqual(await flight.run('z', now, async () => ok('z')), { status: 'unavailable', reason: 'busy' });
  release();
  await Promise.all(held);
  assert.equal(flight.size.inFlight, 0);
});

// --- Interaction with the local 30-minute / 12-hour limits ------------------

test('idle- or absolute-expired sessions are rejected before Keycloak is contacted', async () => {
  const { clock, kc, load, cookie } = await setup(T0 + 20 * HOUR);
  for (const claims of [
    { loginAt: sec(clock.now - HOUR), activeAt: sec(clock.now - IDLE) },
    { loginAt: sec(clock.now - ABSOLUTE), activeAt: sec(clock.now - MINUTE) },
  ]) {
    const { header } = await cookie({ ...claims, validatedAgo: 5 * MINUTE });
    const loaded = await load(headersFor(header));
    assert.equal(loaded.session, null);
    assert.ok(clearsSession(loaded.setCookies));
  }
  assert.equal(kc.calls.token, 0);

  // Just inside both limits the session is revalidated and accepted.
  const { header } = await cookie({
    loginAt: sec(clock.now - ABSOLUTE + MINUTE),
    activeAt: sec(clock.now - IDLE + MINUTE),
    validatedAgo: 5 * MINUTE,
  });
  assert.notEqual((await load(headersFor(header))).session, null);
  assert.equal(kc.calls.token, 1);
});

test('a successful Keycloak refresh never moves loginAt or extends the 12-hour limit', async () => {
  const { clock, kc, load, cookie } = await setup();
  const loginAt = sec(clock.now);
  let header = (await cookie({ loginAt, activeAt: loginAt, validatedAgo: 0 })).header;
  const loginMs = clock.now;

  // Active every 20 minutes: each request revalidates and rotates the token.
  for (clock.now = loginMs + 20 * MINUTE; clock.now < loginMs + ABSOLUTE; clock.now += 20 * MINUTE) {
    const { session, setCookies } = await load(headersFor(header));
    assert.notEqual(session, null, `valid at +${(clock.now - loginMs) / MINUTE} min`);
    const token = await reissued(setCookies);
    assert.equal(token?.loginAt, loginAt);
    assert.equal(token?.lastValidatedAt, sec(clock.now));
    header = nextCookie(setCookies)!;
  }
  const refreshes = kc.calls.token;
  assert.equal(refreshes, 35);

  clock.now = loginMs + ABSOLUTE;
  const expired = await load(headersFor(header));
  assert.equal(expired.session, null);
  assert.ok(clearsSession(expired.setCookies));
  assert.equal(kc.calls.token, refreshes, 'no refresh is attempted past the limit');
});

test('a Keycloak round trip that crosses the 12-hour boundary is denied', async () => {
  const { clock, kc, load, cookie } = await setup(T0 + 20 * HOUR);
  const { header } = await cookie({ loginAt: sec(clock.now - ABSOLUTE + 2 * SECOND) });
  kc.duringTokenRequest = () => { clock.now += 3 * SECOND; };

  const denied = await upload(load, header);
  assert.equal(kc.calls.token, 1, 'the session was still valid when the refresh started');
  assert.equal(denied.response.status, 401);
  assert.equal(denied.puts, 0);
  assert.ok(clearsSession(denied.response.headers.getSetCookie()));
});

// --- Proxy / Route Handler consistency --------------------------------------

test('Proxy and the Proxy-bypassed upload handler revalidate identically', async () => {
  type Fake = Awaited<ReturnType<typeof setup>>['kc'];
  const cases: Array<{ name: string; arrange: (kc: Fake) => void; expected: 200 | 401 | 403 | 503 }> = [
    { name: 'groups unchanged', arrange: () => {}, expected: 200 },
    { name: 'groups removed', arrange: (kc) => kc.setGroups(KC_SUB, []), expected: 403 },
    { name: 'user disabled', arrange: (kc) => kc.disable(KC_SUB), expected: 401 },
    { name: 'Keycloak down', arrange: (kc) => { kc.mode = 'network'; }, expected: 503 },
    { name: 'Keycloak 5xx', arrange: (kc) => { kc.mode = 'http-5xx'; }, expected: 503 },
  ];
  for (const { name, arrange, expected } of cases) {
    const { kc, load, cookie } = await setup();
    const { header } = await cookie();
    arrange(kc);
    const proxy = createAdminProxy(load);

    // Proxy first, then a handler seeing the same request cookie: this is the
    // order of a real request to a Proxy-covered route.
    const api = await proxy(new NextRequest('http://admin.example.test/api/admin/csrf', { headers: headersFor(header) }));
    assert.equal(api.headers.get('x-middleware-next') ? 200 : api.status, expected, `proxy: ${name}`);

    const request = new NextRequest('http://admin.example.test/api/admin/uploads', { headers: headersFor(header) });
    const handler = await withAdminRequestSession(
      request,
      (authenticate) => getUploads(request, { ...serviceDeps(spyStorage()), authenticate }),
      load,
    );
    assert.equal(handler.status, expected, `route handler: ${name}`);
    if (expected === 200 || expected === 403) {
      assert.equal(kc.calls.token, 1, `${name}: the handler reused Proxy's refresh`);
    }
  }
});

test('an untrusted answer is 503 on both paths; the consumed refresh token then ends the session', async () => {
  // Keycloak rotated the refresh token before its answer was rejected, so each
  // path gets its own session here, and a retry cannot succeed.
  const viaProxy = await setup();
  viaProxy.kc.forgeSignature = true;
  const proxied = await createAdminProxy(viaProxy.load)(new NextRequest(
    'http://admin.example.test/api/admin/csrf',
    { headers: headersFor((await viaProxy.cookie()).header) },
  ));
  assert.equal(proxied.status, 503);

  const direct = await setup();
  direct.kc.forgeSignature = true;
  const { header } = await direct.cookie();
  assert.equal((await upload(direct.load, header)).response.status, 503);

  direct.kc.forgeSignature = false;
  const retry = await upload(direct.load, header);
  assert.equal(retry.response.status, 401);
  assert.equal(retry.puts, 0);
});

test('the upload endpoint revalidates on its own, without Proxy', async () => {
  const { kc, load, cookie } = await setup();
  const { header } = await cookie();
  const ok = await upload(load, header);
  assert.equal(ok.response.status, 200);
  assert.equal(kc.calls.token, 1);
  assert.equal((await reissued(ok.response.headers.getSetCookie()))?.keycloakSub, KC_SUB);
});

// --- Token state ------------------------------------------------------------

test('sign-in stores revalidation state and keeps keycloakSub separate from token.sub', async () => {
  const config = createAdminAuthConfig({ env: { ...TEST_ENV, NODE_ENV: 'test' }, now: () => T0 });
  const signIn = (account: Record<string, unknown>) => config.callbacks!.jwt!({
    token: { sub: APP_SUB },
    user: { id: APP_SUB },
    account: { provider: 'keycloak', type: 'oidc', providerAccountId: KC_SUB, ...account },
    profile: { sub: KC_SUB, groups: ['auraplex-uploader'] },
  } as never);

  const token = await signIn({
    id_token: 'id-token', access_token: 'access-token', refresh_token: 'refresh-token', refresh_expires_in: 1800,
  });
  assert.ok(token);
  assert.equal(token.sub, APP_SUB, "the application's own identity is untouched");
  assert.equal(token.keycloakSub, KC_SUB);
  assert.equal(token.refreshToken, 'refresh-token');
  assert.equal(token.refreshExpiresAt, sec(T0) + 1800);
  assert.equal(token.lastValidatedAt, sec(T0));
  assert.deepEqual([token.loginAt, token.activeAt], [sec(T0), sec(T0)]);
  assert.deepEqual(token.groups, ['auraplex-uploader']);
  assert.equal(JSON.stringify(token).includes('access-token'), false, 'the access token is not kept');

  // A sign-in that cannot be revalidated later is not accepted at all.
  assert.equal(await signIn({ id_token: 'id-token' }), null);
});

test('revalidation keeps token.sub and keycloakSub separate', async () => {
  const { load, cookie } = await setup();
  const { header } = await cookie();
  const { session, setCookies } = await load(headersFor(header));
  const token = await reissued(setCookies);
  assert.equal(token?.sub, APP_SUB);
  assert.equal(token?.keycloakSub, KC_SUB);
  assert.equal((session?.user as { id?: string } | undefined)?.id, APP_SUB);
});

test('provider tokens never appear in the browser session JSON or in logs', async () => {
  const { clock, kc, load, handlers, cookie } = await setup();
  const { header, refreshToken } = await cookie();

  // The session endpoint the browser can call, on a revalidating read.
  const response = await handlers.GET(
    new NextRequest('http://admin.example.test/api/auth/session', { headers: headersFor(header) }),
  );
  assert.equal(response.status, 200);
  const body = await response.text();
  const token = await reissued(response.headers.getSetCookie());
  const secrets = [refreshToken, token?.refreshToken, token?.idToken, KC_SUB] as string[];
  assert.equal(kc.calls.token, 1);
  assert.ok(secrets.every((secret) => typeof secret === 'string' && secret.length > 0));
  for (const secret of secrets) assert.equal(body.includes(secret), false);
  const session = JSON.parse(body) as { user: Record<string, unknown> };
  assert.deepEqual(Object.keys(session).sort(), ['expires', 'user']);
  assert.deepEqual(Object.keys(session.user).sort(), ['email', 'groups', 'id']);

  // The loader's session object, and the failure path's log line.
  const loaded = await load(headersFor(header));
  for (const secret of secrets) assert.equal(JSON.stringify(loaded.session).includes(secret), false);

  kc.mode = 'network';
  clock.now += WINDOW;
  warnings.length = 0;
  const fresh = nextCookie(response.headers.getSetCookie())!;
  const unavailable = await handlers.GET(
    new NextRequest('http://admin.example.test/api/auth/session', { headers: headersFor(fresh) }),
  );
  const unavailableBody = await unavailable.text();
  assert.deepEqual(Object.keys(JSON.parse(unavailableBody) as object).sort(), ['expires', REVALIDATION_UNAVAILABLE_FLAG]);
  assert.equal(warnings.length, 1);
  assert.deepEqual(JSON.parse(warnings[0]), { type: 'admin_session_revalidation', outcome: 'unavailable', reason: 'network' });
  for (const secret of secrets) {
    assert.equal(unavailableBody.includes(secret), false);
    assert.equal(warnings[0].includes(secret), false);
  }
});

test('sessions from before revalidation must sign in again', async () => {
  const { kc, load, cookie } = await setup();
  for (const missing of ['refreshToken', 'keycloakSub', 'lastValidatedAt']) {
    // Otherwise valid and recently active, with an allowed cached group.
    const { header } = await cookie({ validatedAgo: 0, [missing]: undefined });
    const loaded = await load(headersFor(header));
    assert.equal(loaded.session, null, missing);
    assert.ok(clearsSession(loaded.setCookies), missing);

    const denied = await upload(load, header);
    assert.equal(denied.response.status, 401, missing);
    assert.equal(denied.puts, 0, missing);
  }
  assert.equal(kc.calls.token, 0);
});

// --- Refresh-token rotation is mandatory -------------------------------------

for (const mode of ['no-refresh-token', 'same-refresh-token'] as const) {
  test(`a refresh answer with ${mode} is a protocol failure, not a validation`, async () => {
    const { kc, load, cookie } = await setup();
    const { header, refreshToken } = await cookie({ groups: ['auraplex-uploader', 'auraplex-admin'] });
    kc.mode = mode;

    const put = await upload(load, header);
    assert.equal(put.response.status, 503);
    assert.equal(await code(put.response), 'IDENTITY_PROVIDER_UNAVAILABLE');
    assert.equal(put.puts, 0);
    // No cookie: lastValidatedAt is not moved and no token is stored.
    assert.deepEqual(put.response.headers.getSetCookie(), []);

    // The presented token is spent. It is not treated as still usable: the
    // next attempt is refused by Keycloak and the session ends.
    kc.mode = 'ok';
    const retry = await load(headersFor(header));
    assert.equal(retry.session, null);
    assert.ok(clearsSession(retry.setCookies));
    assert.deepEqual(kc.presented, [refreshToken, refreshToken]);
  });
}

test('every successful refresh stores a new token and no redeemed token is presented again', async () => {
  const { clock, kc, load, cookie } = await setup();
  let { header } = await cookie();
  const stored: unknown[] = [];
  for (let round = 0; round < 4; round += 1) {
    const { session, setCookies } = await load(headersFor(header));
    assert.notEqual(session, null);
    stored.push((await reissued(setCookies))?.refreshToken);
    header = nextCookie(setCookies)!;
    clock.now += WINDOW;
  }
  assert.equal(kc.presented.length, 4);
  assert.equal(new Set(kc.presented).size, 4, 'each presented token is used exactly once');
  // What was stored after each success is what Keycloak issued, never what was sent.
  assert.deepEqual(stored.slice(0, 3), kc.presented.slice(1));
  assert.equal(kc.presented.includes(stored[3] as string), false);
});

// --- ID-token iat and audience / azp -----------------------------------------

test('ID-token iat and multiple-audience azp rules', async () => {
  const client = KEYCLOAK.clientId;
  type Claims = Parameters<NonNullable<Awaited<ReturnType<typeof setup>>['kc']['tamper']>>[0];
  const cases: Array<{ name: string; tamper: (claims: Claims) => Claims; expected: 200 | 503 }> = [
    { name: 'iat now', tamper: (claims) => claims, expected: 200 },
    { name: 'iat slightly in the past', tamper: (claims) => ({ ...claims, iat: claims.iat! - 20 }), expected: 200 },
    { name: 'iat within clock tolerance', tamper: (claims) => ({ ...claims, iat: claims.iat! + ID_TOKEN_CLOCK_TOLERANCE_SECONDS }), expected: 200 },
    { name: 'iat in the future', tamper: (claims) => ({ ...claims, iat: claims.iat! + ID_TOKEN_CLOCK_TOLERANCE_SECONDS + 1, exp: claims.exp! + 600 }), expected: 503 },
    { name: 'iat far in the future', tamper: (claims) => ({ ...claims, iat: claims.iat! + 3600, exp: claims.exp! + 7200 }), expected: 503 },
    { name: 'iat not a number', tamper: (claims) => ({ ...claims, iat: 'now' as unknown as number }), expected: 503 },
    { name: 'single audience, no azp', tamper: ({ azp: _azp, ...claims }) => ({ ...claims, aud: client }), expected: 200 },
    { name: 'single audience, correct azp', tamper: (claims) => ({ ...claims, aud: client, azp: client }), expected: 200 },
    { name: 'single audience, wrong azp', tamper: (claims) => ({ ...claims, aud: client, azp: 'another-client' }), expected: 503 },
    { name: 'multiple audiences, correct azp', tamper: (claims) => ({ ...claims, aud: [client, 'account'], azp: client }), expected: 200 },
    { name: 'multiple audiences, missing azp', tamper: ({ azp: _azp, ...claims }) => ({ ...claims, aud: [client, 'account'] }), expected: 503 },
    { name: 'multiple audiences, wrong azp', tamper: (claims) => ({ ...claims, aud: [client, 'account'], azp: 'account' }), expected: 503 },
    { name: 'multiple audiences without this client', tamper: (claims) => ({ ...claims, aud: ['account', 'another-client'], azp: client }), expected: 503 },
  ];
  for (const { name, tamper, expected } of cases) {
    const { kc, load, cookie } = await setup();
    const { header } = await cookie();
    kc.tamper = tamper;
    const put = await upload(load, header);
    assert.equal(put.response.status, expected, name);
    assert.equal(put.puts, expected === 200 ? 1 : 0, name);
    assert.equal(kc.calls.token, 1, name);
  }
});

// --- Proxy → downstream pipeline ---------------------------------------------

/**
 * A request as Next.js runs it for Proxy-covered routes: Proxy first; if it
 * lets the request continue, the code behind it sees exactly the request
 * headers Proxy forwarded, and Proxy's Set-Cookie headers are merged into the
 * final response.
 */
async function throughProxy(
  load: AdminSessionLoader,
  request: NextRequest,
  downstream: (headers: Headers) => Promise<Response>,
  betweenProxyAndDownstream: () => void = () => {},
) {
  const proxied = await createAdminProxy(load)(request);
  if (!proxied.headers.get('x-middleware-next')) return { response: proxied as Response, reachedDownstream: false };
  const headers = new Headers();
  for (const name of (proxied.headers.get('x-middleware-override-headers') ?? '').split(',').filter(Boolean)) {
    headers.set(name, proxied.headers.get(`x-middleware-request-${name}`) ?? '');
  }
  betweenProxyAndDownstream();
  const handled = await downstream(headers);
  const response = new Response(handled.body, handled);
  for (const setCookie of proxied.headers.getSetCookie()) response.headers.append('set-cookie', setCookie);
  return { response, reachedDownstream: true };
}

const csrfRequest = (cookie: string, extra: Record<string, string> = {}) =>
  new NextRequest('http://admin.example.test/api/admin/csrf', { headers: { host: 'admin.example.test', cookie, ...extra } });
const pageRequest = (cookie: string) =>
  new NextRequest('http://admin.example.test/admin/upload', { headers: headersFor(cookie) });

/** The CSRF Route Handler and the admin page's gate, as they run behind Proxy. */
function downstreamOf(load: AdminSessionLoader) {
  const counts = { csrfIssued: 0, pageRendered: 0 };
  return {
    counts,
    csrf: async (headers: Headers) => {
      const response = await getAdminCsrfResponse(() => proxiedRequestIdentity(headers, load));
      if (response.ok) counts.csrfIssued += 1;
      return response;
    },
    // Mirrors AuthorizedUploadPage: a throw here is an error page whose HTTP
    // status has already been sent as 200.
    page: async (headers: Headers) => {
      requireUploadPermission(await proxiedRequestIdentity(headers, load));
      counts.pageRendered += 1;
      return new Response('upload workspace');
    },
  };
}

test('a request Proxy accepted at 59 s is not re-judged behind Proxy at 61 s', async () => {
  const { clock, kc, load, cookie } = await setup();
  const validatedAt = sec(clock.now - 59 * SECOND);
  const { header } = await cookie({ validatedAgo: 59 * SECOND });
  const proxyTime = clock.now;
  // Keycloak goes down and the window is crossed between the two stages.
  const crossWindow = () => { clock.now = proxyTime + 2 * SECOND; kc.mode = 'timeout'; };

  for (const stage of ['csrf', 'page'] as const) {
    clock.now = proxyTime;
    kc.mode = 'ok';
    const behind = downstreamOf(load);
    const { response, reachedDownstream } = await throughProxy(
      load,
      stage === 'csrf' ? csrfRequest(header) : pageRequest(header),
      behind[stage],
      crossWindow,
    );
    // One session decision per request, taken by Proxy while still fresh.
    assert.equal(reachedDownstream, true, stage);
    assert.equal(response.status, 200, stage);
    assert.deepEqual(behind.counts, stage === 'csrf' ? { csrfIssued: 1, pageRendered: 0 } : { csrfIssued: 0, pageRendered: 1 });
    assert.equal(kc.calls.token, 0, `${stage}: nothing behind Proxy contacted Keycloak`);
    const token = await reissued(response.headers.getSetCookie());
    assert.equal(token?.activeAt, sec(proxyTime), 'activity of the accepted request');
    assert.equal(token?.lastValidatedAt, validatedAt, 'not an authoritative validation');
  }

  // Before the handoff, the second read is what failed here: taken on its own
  // at 61 s it is (correctly) unavailable.
  assert.equal((await load(headersFor(header))).revalidationUnavailable, true);
});

test('once revalidation is due and Keycloak is unavailable, the whole pipeline is a controlled 503', async () => {
  const { clock, kc, load, cookie } = await setup();
  const { header } = await cookie({ validatedAgo: 59 * SECOND, groups: ['auraplex-uploader', 'auraplex-admin'] });

  // First request: accepted by Proxy at 59 s; the browser stores its cookie.
  const behind = downstreamOf(load);
  const accepted = await throughProxy(load, csrfRequest(header), behind.csrf);
  assert.equal(accepted.response.status, 200);
  const stored = nextCookie(accepted.response.headers.getSetCookie())!;
  const before = await reissued(accepted.response.headers.getSetCookie());

  // Next requests: 61 s after the last validation, Keycloak timing out.
  clock.now += 2 * SECOND;
  kc.mode = 'timeout';

  const api = await throughProxy(load, csrfRequest(stored), behind.csrf);
  assert.equal(api.reachedDownstream, false);
  assert.equal(api.response.status, 503);
  assert.equal(await code(api.response), 'IDENTITY_PROVIDER_UNAVAILABLE');
  assert.deepEqual(api.response.headers.getSetCookie(), [], 'no activity is persisted for a denied request');

  const page = await throughProxy(load, pageRequest(stored), behind.page);
  assert.equal(page.reachedDownstream, false);
  assert.equal(page.response.status, 503, 'a controlled 503, not a 200 error page');
  assert.equal(page.response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(page.response.headers.getSetCookie(), []);

  assert.deepEqual(behind.counts, { csrfIssued: 1, pageRendered: 0 }, 'nothing ran behind Proxy after the window');

  // The Proxy-bypassed upload endpoint, on its own read: same outcome.
  const put = await upload(load, stored);
  assert.equal(put.response.status, 503);
  assert.equal(put.puts, 0);
  assert.deepEqual(put.response.headers.getSetCookie(), []);
  const del = await remove(load, stored);
  assert.equal(del.response.status, 503);
  assert.deepEqual(del.calls, []);

  // The browser still holds the cookie from before: neither activeAt nor
  // lastValidatedAt moved, and it works again once Keycloak is back.
  kc.mode = 'ok';
  const recovered = await throughProxy(load, csrfRequest(stored), behind.csrf);
  assert.equal(recovered.response.status, 200);
  const after = await reissued(recovered.response.headers.getSetCookie());
  assert.equal(after?.lastValidatedAt, sec(clock.now));
  assert.equal(before?.lastValidatedAt, sec(clock.now - 61 * SECOND));
});

test('the Proxy handoff cannot be supplied or forged by a client', async () => {
  const { load, cookie } = await setup();
  const admin = { userId: 'keycloak-sub-attacker', groups: ['auraplex-admin'] };
  const forgedValues = [
    'not-a-token',
    JSON.stringify(admin),
    // Encrypted, but not with this deployment's secret.
    await sealProxyIdentity(admin, 'some-other-secret-0123456789abcdef'),
  ];
  const uploader = await cookie({ validatedAgo: 0 });

  for (const forged of forgedValues) {
    // Without a session, a handoff header from the client gets nowhere,
    // whether or not Proxy runs.
    const anonymous = await throughProxy(
      load,
      new NextRequest('http://admin.example.test/api/admin/csrf', { headers: { host: 'admin.example.test', [PROXY_IDENTITY_HEADER]: forged } }),
      downstreamOf(load).csrf,
    );
    assert.equal(anonymous.response.status, 401);
    const direct = new Headers({ host: 'admin.example.test', [PROXY_IDENTITY_HEADER]: forged });
    assert.equal(await proxiedRequestIdentity(direct, load), null);

    // With a session, Proxy replaces the client's value with its own decision.
    let identity: unknown;
    await throughProxy(load, csrfRequest(uploader.header, { [PROXY_IDENTITY_HEADER]: forged }), async (headers) => {
      assert.notEqual(headers.get(PROXY_IDENTITY_HEADER), forged);
      identity = await proxiedRequestIdentity(headers, load);
      return new Response('ok');
    });
    assert.deepEqual(identity, { userId: KC_SUB, email: 'user@example.test', groups: ['auraplex-uploader'] });
  }

  // The upload endpoint has no Proxy in front of it and ignores the header.
  const put = await upload(load, 'unrelated=1');
  assert.equal(put.response.status, 401);
});

// --- Stable upload ownership --------------------------------------------------

function memoryStorage() {
  const objects: StoredObject[] = [];
  const adapter: StorageAdapter = {
    async putObject(input) {
      for await (const _chunk of input.body) { /* drain */ }
      objects.push({
        bucket: input.bucket,
        key: input.key,
        size: 1,
        lastModified: new Date(T0 + objects.length * SECOND),
        metadata: input.metadata,
      });
      return {};
    },
    async listObjects(bucket, options) {
      return objects.filter((object) => object.bucket === bucket && (options?.filter?.(object) ?? true));
    },
    async deleteObject() {},
  };
  return { objects, adapter };
}

type Memory = ReturnType<typeof memoryStorage>;

const ownershipDeps = (memory: Memory) => ({ ...serviceDeps(spyStorage()), storage: () => memory.adapter });

async function putInto(memory: Memory, load: AdminSessionLoader, cookie: string, filename: string) {
  const request = new NextRequest('http://admin.example.test/api/admin/uploads', {
    method: 'PUT',
    body: new TextEncoder().encode('%PDF-1.7\nbody'),
    headers: {
      host: 'admin.example.test',
      'content-type': 'application/pdf',
      'x-product-id': '6470625',
      'x-product-line': 'labelling',
      'x-upload-filename': filename,
      'x-csrf-token': 'csrf',
      cookie: `${cookie}; auraplex-admin-csrf=csrf`,
    },
  });
  return withAdminRequestSession(
    request,
    (authenticate) => putUpload(request, { ...ownershipDeps(memory), authenticate }),
    load,
  );
}

async function visibleKeys(memory: Memory, load: AdminSessionLoader, cookie: string) {
  const request = new NextRequest('http://admin.example.test/api/admin/uploads', { headers: headersFor(cookie) });
  const response = await withAdminRequestSession(
    request,
    (authenticate) => getUploads(request, { ...ownershipDeps(memory), authenticate }),
    load,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { uploads: Array<{ key: string }> };
  return body.uploads.map((upload) => upload.key.split('/').at(-1)).sort();
}

test('upload ownership follows the Keycloak subject across logins, not the Auth.js session id', async () => {
  const { load, cookie } = await setup();
  const memory = memoryStorage();

  // Login #1: Auth.js generated one random token.sub for this session.
  const firstLogin = await cookie({ sub: 'authjs-login-uuid-A', validatedAgo: 0 });
  assert.equal((await putInto(memory, load, firstLogin.header, 'first-login.pdf')).status, 200);
  assert.equal(memory.objects[0].metadata['uploaded-by'], KC_SUB, 'uploaded-by is the Keycloak subject');
  assert.deepEqual(await visibleKeys(memory, load, firstLogin.header), ['first-login.pdf']);

  // Logout, login #2: a different token.sub, the same Keycloak user. This
  // session is also due for revalidation, so the identity survives a refresh.
  const secondLogin = await cookie({ sub: 'authjs-login-uuid-B' });
  assert.deepEqual(await visibleKeys(memory, load, secondLogin.header), ['first-login.pdf']);
  assert.equal((await putInto(memory, load, secondLogin.header, 'second-login.pdf')).status, 200);
  assert.deepEqual(await visibleKeys(memory, load, secondLogin.header), ['first-login.pdf', 'second-login.pdf']);
  assert.deepEqual(await visibleKeys(memory, load, firstLogin.header), ['first-login.pdf', 'second-login.pdf']);

  // A different Keycloak user sees none of it, even with the same token.sub
  // and the same email.
  const otherUser = await cookie({ sub: 'authjs-login-uuid-A', keycloakSub: 'test-kc-sub-b', validatedAgo: 0 });
  assert.deepEqual(await visibleKeys(memory, load, otherUser.header), []);
  assert.equal((await putInto(memory, load, otherUser.header, 'other-user.pdf')).status, 200);
  assert.equal(memory.objects[2].metadata['uploaded-by'], 'test-kc-sub-b');
  assert.deepEqual(await visibleKeys(memory, load, otherUser.header), ['other-user.pdf']);
  assert.deepEqual(await visibleKeys(memory, load, secondLogin.header), ['first-login.pdf', 'second-login.pdf']);

  // Legacy object: uploaded-by holds an old per-login UUID. It is not matched
  // to anyone, not even to a session whose token.sub happens to equal it.
  memory.objects.push({
    bucket: 'auraplex-raw-pdf',
    key: 'machines/flexy-applicator/legacy.pdf',
    size: 1,
    lastModified: new Date(T0 + 10 * SECOND),
    metadata: { 'uploaded-by': 'authjs-login-uuid-B' },
  });
  assert.deepEqual(await visibleKeys(memory, load, secondLogin.header), ['first-login.pdf', 'second-login.pdf']);

  // Admins still see every object, including legacy ones.
  const admin = await cookie({ groups: ['auraplex-admin'], sub: 'authjs-login-uuid-C', keycloakSub: 'keycloak-sub-admin', validatedAgo: 0 });
  assert.deepEqual(
    await visibleKeys(memory, load, admin.header),
    ['first-login.pdf', 'legacy.pdf', 'other-user.pdf', 'second-login.pdf'],
  );
});

test('the Keycloak subject reaches Proxy-covered handlers without entering the session JSON', async () => {
  const { load, handlers, cookie } = await setup();
  const { header } = await cookie({ sub: 'authjs-login-uuid-A', validatedAgo: 0 });

  let identity: unknown;
  await throughProxy(load, csrfRequest(header), async (headers) => {
    identity = await proxiedRequestIdentity(headers, load);
    return new Response('ok');
  });
  assert.deepEqual(identity, { userId: KC_SUB, email: 'user@example.test', groups: ['auraplex-uploader'] });

  const loaded = await load(headersFor(header));
  assert.equal(loaded.keycloakSub, KC_SUB);
  // Browser-visible session: Auth.js's own id, and no Keycloak subject.
  const response = await handlers.GET(
    new NextRequest('http://admin.example.test/api/auth/session', { headers: headersFor(header) }),
  );
  const body = await response.text();
  assert.equal((JSON.parse(body) as { user: { id: string } }).user.id, 'authjs-login-uuid-A');
  assert.equal(body.includes(KC_SUB), false);
  assert.equal(JSON.stringify(loaded.session).includes(KC_SUB), false);
});

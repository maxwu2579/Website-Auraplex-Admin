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
  sessionCookiesToCommit,
  withAdminRequestSession,
  type AdminSessionLoader,
} from '../lib/admin/server/session';
import { currentAdminAuthScope, runInAdminAuthScope, type AdminAuthScope, type SessionLineage } from '../lib/admin/server/session-context';
import { browserInstanceCookieName, withBrowserInstance } from '../lib/admin/server/browser-instance';
import { requireUploadPermission } from '../lib/admin/server/authorization';
import { getAdminCsrfResponse } from '../lib/admin/server/csrf-service';
import type { StorageAdapter, StoredObject } from '../lib/admin/server/storage';
import { authSessionCookieName } from '../lib/admin/server/auth-cookies';
import { getUploads, putUpload } from '../lib/admin/server/upload-service';
import { deleteUpload } from '../lib/admin/server/delete-service';
import { UploadConcurrencyGuard } from '../lib/admin/server/upload-concurrency';
import { createAdminProxy } from '../proxy';
import { createFakeKeycloak, type FakeKeycloakMode } from './helpers/fake-keycloak';
import { createBrowserJar } from './helpers/browser-jar';

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

let loginSerial = 0;

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
  // As in production, the callbacks, the loader and the revalidator share one
  // coordinator.
  const config = createAdminAuthConfig({ env: { ...TEST_ENV, NODE_ENV: 'test' }, now, revalidator, coordinator: singleFlight });
  const { auth, handlers } = NextAuth(config);
  const load = createAdminSessionLoader(auth, undefined, singleFlight);
  /** The same reads with every session cookie applied, as before response ordering existed. */
  const loadUnordered: AdminSessionLoader = async (headers) => ({ ...(await load(headers)), withholdSessionCookies: undefined });

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
        // Each cookie is its own login, from a browser the process has not seen.
        browserInstanceId: 'browser-unregistered',
        loginId: `login-${++loginSerial}`,
        refreshGeneration: 0,
        ...claims,
      },
    });
    return { header: `${COOKIE}=${token}`, refreshToken };
  }

  /** A completed Keycloak sign-in from the given browser, through the app's own `jwt` callback. */
  async function signIn(browserInstanceId: string, groups = ['auraplex-uploader']) {
    const refreshToken = kc.grant(KC_SUB, groups);
    const token = await runInAdminAuthScope({ browserInstanceId }, async () => config.callbacks!.jwt!({
      token: { sub: APP_SUB, email: 'user@example.test' },
      user: { id: APP_SUB },
      account: { provider: 'keycloak', type: 'oidc', providerAccountId: KC_SUB, id_token: 'sign-in-id-token', refresh_token: refreshToken },
      profile: { sub: KC_SUB, groups },
    } as never));
    assert.ok(token);
    const jwt = await encode({ secret: TEST_ENV.AUTH_SECRET, salt: COOKIE, maxAge: 30 * 24 * 3600, token });
    return { header: `${COOKIE}=${jwt}`, refreshToken, loginId: token.loginId as string };
  }

  /** Sign-out as Auth.js reports it to the app (server action or its own route). */
  async function signOut(cookieHeader: string) {
    const token = await decode({ secret: TEST_ENV.AUTH_SECRET, salt: COOKIE, token: cookieHeader.slice(COOKIE.length + 1) });
    await config.events!.signOut!({ token } as never);
  }

  return { clock, kc, singleFlight, config, load, loadUnordered, handlers, cookie, signIn, signOut };
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

// --- Response ordering ------------------------------------------------------

/** The browser cookie jar (tests/helpers/browser-jar.ts): applies every response in arrival order. */
const { browserWith } = createBrowserJar(COOKIE, TEST_ENV.AUTH_SECRET);

const uploadsRequest = (cookie: string) =>
  new NextRequest('http://admin.example.test/api/admin/uploads', { headers: headersFor(cookie) });

/** An authenticated request through the upload endpoint's session wrapper. */
function visit(load: AdminSessionLoader, cookie: string): Promise<Response> {
  return withAdminRequestSession(uploadsRequest(cookie), async (authenticate) => {
    try {
      const identity = await authenticate();
      return Response.json({ groups: identity?.groups ?? null }, { status: identity ? 200 : 401 });
    } catch {
      return Response.json({ groups: null }, { status: 503 });
    }
  }, load);
}

/**
 * The same, but the handler keeps working after it authenticated (a long
 * upload) until `finish()` is called. `authenticated` settles once the session
 * was read, i.e. after any refresh this request performed.
 */
function slowVisit(load: AdminSessionLoader, cookie: string) {
  let finishHandler!: () => void;
  const working = new Promise<void>((resolve) => { finishHandler = resolve; });
  let markAuthenticated!: () => void;
  const authenticated = new Promise<void>((resolve) => { markAuthenticated = resolve; });
  const response = withAdminRequestSession(uploadsRequest(cookie), async (authenticate) => {
    const identity = await authenticate();
    markAuthenticated();
    await working;
    return Response.json({ groups: identity?.groups ?? null }, { status: identity ? 200 : 401 });
  }, load);
  return { authenticated, finish: () => { finishHandler(); return response; } };
}

const lineageOf = (token: Record<string, unknown> | null): SessionLineage => ({
  browserInstanceId: token?.browserInstanceId as string,
  loginId: token?.loginId as string,
  refreshGeneration: token?.refreshGeneration as number,
});

/**
 * Slow request refreshes RT0 → RT1 and keeps running; the browser gets RT1
 * from a parallel request, later refreshes RT1 → RT2 and receives it; only
 * then does the slow response arrive.
 */
async function staleResponseRace(env: Awaited<ReturnType<typeof setup>>, load: AdminSessionLoader) {
  const { clock, kc, cookie } = env;
  const login = await cookie();
  const browser = browserWith(login.header);

  const slow = slowVisit(load, browser.cookie);
  await slow.authenticated;
  assert.deepEqual(kc.presented, [login.refreshToken], 'the slow request redeemed RT0');

  // A parallel request sent with the RT0 cookie shares that refresh.
  browser.receive(await visit(load, browser.cookie));
  const rt1Cookie = browser.cookie;
  const rt1 = (await browser.token())?.refreshToken as string;
  assert.ok(rt1 && rt1 !== login.refreshToken);
  assert.equal(kc.calls.token, 1);

  // One window later the browser, holding RT1, refreshes again and gets RT2.
  clock.now += WINDOW;
  const newer = browser.receive(await visit(load, browser.cookie));
  assert.equal(newer.status, 200);
  const rt2 = (await browser.token())?.refreshToken as string;
  assert.deepEqual(kc.presented, [login.refreshToken, rt1]);
  assert.ok(rt2 && rt2 !== rt1);
  const current = lineageOf(await browser.token());
  assert.deepEqual(
    [0, 1, 2].map((refreshGeneration) => env.singleFlight.isSuperseded({ ...current, refreshGeneration })),
    [true, true, false],
  );

  // The slow request finishes last. It was prepared from generation 1.
  const late = await slow.finish();
  assert.equal(late.status, 200, 'the slow request itself still succeeds');
  browser.receive(late);
  return { browser, late, rt0: login.refreshToken, rt1, rt1Cookie, rt2 };
}

test('stale-cookie race: without response ordering the late response rolls the browser back to consumed RT1', async () => {
  const env = await setup();
  const { clock, kc, loadUnordered } = env;
  const { browser, late, rt0, rt1 } = await staleResponseRace(env, loadUnordered);

  assert.equal((await reissued(late.headers.getSetCookie()))?.refreshToken, rt1);
  assert.equal((await browser.token())?.refreshToken, rt1, 'rolled back to a consumed generation');

  // Once the reuse window and the freshness window have passed, RT1 is
  // presented again, Keycloak refuses it and the user is signed out.
  clock.now += WINDOW;
  const next = browser.receive(await visit(loadUnordered, browser.cookie));
  assert.equal(next.status, 401);
  assert.equal(browser.signedIn, false);
  assert.deepEqual(kc.presented, [rt0, rt1, rt1]);
});

test('stale-cookie race: a late response from an older refresh generation does not overwrite the newer cookie', async () => {
  const env = await setup();
  const { clock, kc, load } = env;
  const { browser, late, rt0, rt1, rt2 } = await staleResponseRace(env, load);

  assert.deepEqual(late.headers.getSetCookie(), [], 'the stale response sets no session cookie');
  assert.equal((await browser.token())?.refreshToken, rt2, 'the browser keeps the newest generation');
  assert.equal((await browser.token())?.refreshGeneration, 2);

  // The session carries on: the next refresh presents RT2, never RT1 again.
  clock.now += WINDOW;
  const next = browser.receive(await visit(load, browser.cookie));
  assert.equal(next.status, 200);
  assert.equal(browser.signedIn, true);
  assert.deepEqual(kc.presented, [rt0, rt1, rt2]);
});

test('a late invalid_grant for consumed RT1 is denied but does not clear the browser\'s RT2 session', async () => {
  const env = await setup();
  const { clock, kc, load } = env;
  const { browser, rt0, rt1, rt1Cookie, rt2 } = await staleResponseRace(env, load);

  // An older request still carrying RT1 is processed after the reuse window.
  clock.now += REFRESH_RESULT_REUSE_MS;
  const late = await upload(load, rt1Cookie);
  assert.equal(late.response.status, 401, 'the stale token is not treated as valid');
  assert.equal(await code(late.response), 'UNAUTHENTICATED');
  assert.equal(late.puts, 0, 'nothing protected ran');
  assert.deepEqual(kc.presented, [rt0, rt1, rt1], 'Keycloak was asked and refused RT1');
  assert.deepEqual(late.response.headers.getSetCookie(), [], 'no removal of the session cookie');

  // The same request through Proxy.
  const proxied = await createAdminProxy(load)(csrfRequest(rt1Cookie));
  assert.equal(proxied.status, 401);
  assert.deepEqual(proxied.headers.getSetCookie(), []);

  // Both responses reach the browser after it already holds RT2.
  browser.receive(late.response);
  browser.receive(proxied);
  assert.equal(browser.signedIn, true);
  assert.equal((await browser.token())?.refreshToken, rt2);

  // Internally the reason is explicit, and Auth.js did produce a removal.
  const loaded = await load(headersFor(rt1Cookie));
  assert.equal(loaded.session, null);
  assert.equal(loaded.endReason, 'provider-superseded-refresh-rejected');
  assert.ok(clearsSession(loaded.setCookies));
  assert.deepEqual(sessionCookiesToCommit(loaded), []);

  // The RT2 session is intact and still inside its freshness window.
  const calls = kc.calls.token;
  assert.equal(browser.receive(await visit(load, browser.cookie)).status, 200);
  assert.equal(kc.calls.token, calls);
  clock.now += WINDOW;
  assert.equal(browser.receive(await visit(load, browser.cookie)).status, 200);
  assert.equal(kc.presented.at(-1), rt2);
});

test('without that rule the late invalid_grant response deletes the valid RT2 session', async () => {
  const env = await setup();
  const { clock, load, loadUnordered } = env;
  const { browser, rt1Cookie } = await staleResponseRace(env, load);
  clock.now += REFRESH_RESULT_REUSE_MS;
  const late = browser.receive(await visit(loadUnordered, rt1Cookie));
  assert.equal(late.status, 401);
  assert.equal(browser.signedIn, false);
});

test('Keycloak refusing the current generation ends the session and clears the cookie', async () => {
  const env = await setup();
  const { clock, kc, load } = env;
  const { browser, rt2 } = await staleResponseRace(env, load);

  // The user is disabled (or the SSO session ended): RT2, the newest refresh
  // token of this login, is refused at the next revalidation.
  kc.disable(KC_SUB);
  clock.now += WINDOW;
  const loaded = await load(headersFor(browser.cookie));
  assert.equal(loaded.session, null);
  assert.equal(loaded.endReason, 'provider-current-session-rejected');
  assert.ok(clearsSession(sessionCookiesToCommit(loaded)));

  const denied = browser.receive(await visit(load, browser.cookie));
  assert.equal(denied.status, 401);
  assert.equal(kc.presented.at(-1), rt2);
  assert.equal(browser.signedIn, false, 'the cookie was removed');
});

test('idle expiry of the current session clears the cookie', async () => {
  const env = await setup();
  const { clock, kc, load } = env;
  const { browser } = await staleResponseRace(env, load);
  const calls = kc.calls.token;

  clock.now += IDLE;
  const loaded = await load(headersFor(browser.cookie));
  assert.equal(loaded.endReason, 'local-idle-expired');
  assert.ok(clearsSession(sessionCookiesToCommit(loaded)));

  const denied = browser.receive(await visit(load, browser.cookie));
  assert.equal(denied.status, 401);
  assert.equal(browser.signedIn, false);
  assert.equal(kc.calls.token, calls, 'Keycloak is not contacted for an idle session');
});

test('three refresh generations completing out of order leave the browser on the newest', async () => {
  const { clock, kc, load, cookie } = await setup();
  const login = await cookie();
  const browser = browserWith(login.header);

  // Generation 1: slow request A refreshes RT0; the browser gets RT1 in parallel.
  const slowA = slowVisit(load, browser.cookie);
  await slowA.authenticated;
  browser.receive(await visit(load, browser.cookie));
  const rt1 = (await browser.token())?.refreshToken;

  // Generation 2: slow request B refreshes RT1; the browser gets RT2 in parallel.
  clock.now += WINDOW;
  const slowB = slowVisit(load, browser.cookie);
  await slowB.authenticated;
  browser.receive(await visit(load, browser.cookie));
  const rt2 = (await browser.token())?.refreshToken;

  // Generation 3: slow request C refreshes RT2. Nothing else delivers RT3.
  clock.now += WINDOW;
  const slowC = slowVisit(load, browser.cookie);
  await slowC.authenticated;
  assert.deepEqual(kc.presented, [login.refreshToken, rt1, rt2]);

  // Completion order: newest, oldest, middle.
  const newest = browser.receive(await slowC.finish());
  const committed = await reissued(newest.headers.getSetCookie());
  const rt3 = committed?.refreshToken;
  assert.ok(rt3 && rt3 !== rt2, 'the current generation is still committed');
  assert.equal(committed?.refreshGeneration, 3);
  const oldest = browser.receive(await slowA.finish());
  const middle = browser.receive(await slowB.finish());
  assert.deepEqual(oldest.headers.getSetCookie(), []);
  assert.deepEqual(middle.headers.getSetCookie(), []);
  assert.equal((await browser.token())?.refreshToken, rt3);

  clock.now += WINDOW;
  assert.equal(browser.receive(await visit(load, browser.cookie)).status, 200);
  assert.deepEqual(kc.presented, [login.refreshToken, rt1, rt2, rt3]);
  assert.equal((await browser.token())?.refreshGeneration, 4);
});

test('a stale response cannot restore removed groups', async () => {
  const { clock, kc, load, cookie } = await setup();
  const login = await cookie({ groups: ['auraplex-uploader', 'auraplex-admin'] });
  const browser = browserWith(login.header);

  const slow = slowVisit(load, browser.cookie);
  await slow.authenticated;
  browser.receive(await visit(load, browser.cookie));
  assert.deepEqual((await browser.token())?.groups, ['auraplex-uploader', 'auraplex-admin']);

  // Both groups are removed in Keycloak; the next refresh picks that up.
  kc.setGroups(KC_SUB, ['staff']);
  clock.now += WINDOW;
  browser.receive(await visit(load, browser.cookie));
  assert.deepEqual((await browser.token())?.groups, ['staff']);

  // The slow request was authorised with the old groups and finishes now.
  const late = browser.receive(await slow.finish());
  assert.deepEqual(late.headers.getSetCookie(), []);
  assert.deepEqual((await browser.token())?.groups, ['staff'], 'the old groups are not written back');

  const denied = await upload(load, browser.cookie);
  assert.equal(denied.response.status, 403);
  assert.equal(denied.puts, 0);
  const deleted = await remove(load, browser.cookie);
  assert.equal(deleted.response.status, 403);
  assert.deepEqual(deleted.calls, []);
});

test('a stale response cannot extend loginAt, and the 12-hour limit clears the cookie', async () => {
  const env = await setup();
  const { clock, kc, load } = env;
  const loginMs = clock.now - HOUR;
  const { browser, late } = await staleResponseRace(env, load);
  assert.deepEqual(late.headers.getSetCookie(), []);
  const token = await browser.token();
  assert.equal(token?.loginAt, sec(loginMs), 'loginAt is the original sign-in time');
  assert.equal(token?.activeAt, sec(clock.now), 'activity is that of the newest response');

  // Kept active, the session still ends exactly 12 hours after sign-in.
  const refreshes = kc.calls.token;
  for (clock.now += 20 * MINUTE; clock.now < loginMs + ABSOLUTE; clock.now += 20 * MINUTE) {
    assert.equal(browser.receive(await visit(load, browser.cookie)).status, 200);
    assert.equal((await browser.token())?.loginAt, sec(loginMs));
  }
  assert.ok(kc.calls.token > refreshes);
  clock.now = loginMs + ABSOLUTE;
  const calls = kc.calls.token;
  const loaded = await load(headersFor(browser.cookie));
  assert.equal(loaded.endReason, 'local-absolute-expired');
  assert.ok(clearsSession(sessionCookiesToCommit(loaded)));
  assert.equal(browser.receive(await visit(load, browser.cookie)).status, 401);
  assert.equal(browser.signedIn, false);
  assert.equal(kc.calls.token, calls);
});

test('a refresh that succeeds while the 12-hour limit passes still ends the session and clears the cookie', async () => {
  // During the Keycloak round trip: the refresh itself made the cookie this
  // request carried a superseded generation, which must not hide the removal.
  const { clock, kc, load, cookie, singleFlight } = await setup(T0 + 20 * HOUR);
  const login = await cookie({ loginAt: sec(clock.now - ABSOLUTE + 2 * SECOND) });
  const browser = browserWith(login.header);
  const carried = lineageOf(await browser.token());
  kc.duringTokenRequest = () => { clock.now += 3 * SECOND; };

  let endReason: string | undefined;
  const observed: AdminSessionLoader = async (headers) => {
    const loaded = await load(headers);
    endReason = loaded.endReason;
    return loaded;
  };
  const denied = await visit(observed, browser.cookie);
  assert.equal(kc.calls.token, 1, 'the session was still valid when the refresh started');
  assert.equal(denied.status, 401);
  assert.equal(endReason, 'refresh-succeeded-but-local-session-expired');
  assert.equal(singleFlight.isSuperseded(carried), true, 'the refresh did rotate the token');
  assert.ok(clearsSession(denied.headers.getSetCookie()), 'the removal is not withheld');
  browser.receive(denied);
  assert.equal(browser.signedIn, false);

  // While the handler is still working: the refresh and the request succeed,
  // the limit passes before the response is sent, and the next request ends it.
  const other = await setup(T0 + 20 * HOUR);
  const loginAt = sec(other.clock.now - ABSOLUTE + MINUTE);
  const second = await other.cookie({ loginAt });
  const jar = browserWith(second.header);
  const slow = slowVisit(other.load, jar.cookie);
  await slow.authenticated;
  assert.equal(other.kc.calls.token, 1);
  other.clock.now += 2 * MINUTE;
  assert.equal(jar.receive(await slow.finish()).status, 200);
  assert.equal((await jar.token())?.loginAt, loginAt, 'loginAt did not move');
  const ended = await other.load(headersFor(jar.cookie));
  assert.equal(ended.endReason, 'local-absolute-expired');
  assert.equal(jar.receive(await visit(other.load, jar.cookie)).status, 401);
  assert.equal(jar.signedIn, false);
  assert.equal(other.kc.calls.token, 1, 'no refresh is attempted past the limit');
});

test('a stale response or cookie cannot bypass the 60-second freshness window', async () => {
  const env = await setup();
  const { clock, kc, load, singleFlight } = env;
  const { browser, rt2 } = await staleResponseRace(env, load);
  const validatedAt = (await browser.token())?.lastValidatedAt;
  assert.equal(validatedAt, sec(clock.now), 'freshness is that of the newest refresh');

  // 59 s after the newest validation: served from the cookie, no Keycloak call.
  clock.now += WINDOW - SECOND;
  assert.equal(browser.receive(await visit(load, browser.cookie)).status, 200);
  assert.equal(kc.calls.token, 2);
  assert.equal((await browser.token())?.lastValidatedAt, validatedAt);

  // At 60 s the session revalidates, with RT2, exactly once.
  clock.now += SECOND;
  assert.equal(browser.receive(await visit(load, browser.cookie)).status, 200);
  assert.equal(kc.calls.token, 3);
  assert.equal(kc.presented.at(-1), rt2);
  assert.equal((await browser.token())?.lastValidatedAt, sec(clock.now));
  assert.equal(singleFlight.size.inFlight, 0);
});

// --- Old login versus new login in the same browser ---------------------------

test('a response of the old login that finishes after a new sign-in does not replace the new session', async () => {
  for (const ordered of [true, false]) {
    const { clock, load, loadUnordered, signIn } = await setup();
    const loader = ordered ? load : loadUnordered;
    const oldLogin = await signIn('browser-a');
    const browser = browserWith(oldLogin.header);

    // A request of the old login is in flight; it refreshed and keeps working.
    clock.now += WINDOW;
    const slow = slowVisit(loader, browser.cookie);
    await slow.authenticated;

    // The same browser signs in again and holds the new login's cookie.
    const newLogin = await signIn('browser-a');
    browser.set(newLogin.header);
    assert.notEqual(newLogin.loginId, oldLogin.loginId);

    const late = browser.receive(await slow.finish());
    assert.equal(late.status, 200, 'the old request\'s own result is unchanged');
    if (!ordered) {
      // What used to happen: the old login's cookie replaced the new one.
      assert.equal((await browser.token())?.loginId, oldLogin.loginId);
      continue;
    }
    assert.deepEqual(late.headers.getSetCookie(), []);
    assert.equal((await browser.token())?.loginId, newLogin.loginId);
    assert.equal((await browser.token())?.refreshToken, newLogin.refreshToken);
    assert.equal(browser.receive(await visit(loader, browser.cookie)).status, 200);
    assert.equal((await browser.token())?.loginId, newLogin.loginId);
  }
});

test('a late removal from the old login does not delete the new login', async () => {
  for (const ordered of [true, false]) {
    const { clock, kc, load, loadUnordered, signIn } = await setup();
    const loader = ordered ? load : loadUnordered;
    const oldLogin = await signIn('browser-a');
    clock.now += WINDOW;

    // The old Keycloak session ended; the browser signed in again.
    kc.revoke(oldLogin.refreshToken);
    const newLogin = await signIn('browser-a');
    const browser = browserWith(newLogin.header);

    // A request sent with the old cookie is answered only now.
    const late = browser.receive(await visit(loader, oldLogin.header));
    assert.equal(late.status, 401, 'the old request stays denied');
    if (!ordered) {
      assert.equal(browser.signedIn, false, 'what used to happen: the new login was deleted');
      continue;
    }
    assert.deepEqual(late.headers.getSetCookie(), []);
    assert.equal(browser.signedIn, true);
    assert.equal((await browser.token())?.loginId, newLogin.loginId);
    // It was the old login's newest token, so this is not the superseded-refresh
    // rule: the removal is withheld because the browser has a newer login.
    const loaded = await load(headersFor(oldLogin.header));
    assert.equal(loaded.endReason, 'provider-current-session-rejected');
    assert.deepEqual(sessionCookiesToCommit(loaded), []);

    // An old cookie that idles out is no different.
    const idle = await setup();
    const stale = await idle.signIn('browser-a');
    idle.clock.now += IDLE - MINUTE;
    const fresh = await idle.signIn('browser-a');
    const jar = browserWith(fresh.header);
    idle.clock.now += MINUTE;
    const expired = jar.receive(await visit(idle.load, stale.header));
    assert.equal(expired.status, 401);
    assert.deepEqual(expired.headers.getSetCookie(), []);
    assert.equal((await jar.token())?.loginId, fresh.loginId);
    assert.equal(jar.receive(await visit(idle.load, jar.cookie)).status, 200);
  }
});

test('after sign-out a late response of that login does not sign the browser back in', async () => {
  const { clock, load, signIn, signOut } = await setup();
  const oldLogin = await signIn('browser-a');
  const browser = browserWith(oldLogin.header);
  clock.now += WINDOW;
  const first = slowVisit(load, browser.cookie);
  await first.authenticated;
  const second = slowVisit(load, browser.cookie);
  await second.authenticated;

  // Sign-out retires the login for this browser and removes the cookie.
  await signOut(browser.cookie);
  browser.set(null);
  const late = browser.receive(await first.finish());
  assert.equal(late.status, 200);
  assert.deepEqual(late.headers.getSetCookie(), []);
  assert.equal(browser.signedIn, false, 'the sign-out is not undone');

  // After the next sign-in the remaining old response is still ignored.
  const newLogin = await signIn('browser-a');
  browser.set(newLogin.header);
  browser.receive(await second.finish());
  assert.equal((await browser.token())?.loginId, newLogin.loginId);
  assert.equal(browser.receive(await visit(load, browser.cookie)).status, 200);
});

test("Auth.js's own sign-out route retires the login, and its callbacks run inside the request scope", async () => {
  const { clock, load, handlers, singleFlight, signIn } = await setup();
  const login = await signIn('browser-a');
  const browser = browserWith(login.header);
  clock.now += WINDOW;
  const slow = slowVisit(load, browser.cookie);
  await slow.authenticated;
  const lineage = lineageOf(await browser.token());
  assert.equal(singleFlight.isCurrentLogin(lineage), true);

  // The scope opened around the real Auth.js handler reaches the jwt callback.
  const scope: AdminAuthScope = {};
  const read = await runInAdminAuthScope(scope, () => handlers.GET(
    new NextRequest('http://admin.example.test/api/auth/session', { headers: headersFor(browser.cookie) }),
  ));
  assert.equal(read.status, 200);
  assert.equal(scope.outcome?.status, 'active');
  browser.receive(read);

  // POST /api/auth/signout with Auth.js's CSRF token, as its sign-out form does.
  const csrf = await handlers.GET(new NextRequest('http://admin.example.test/api/auth/csrf', { headers: headersFor() }));
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const csrfCookie = csrf.headers.getSetCookie().find((value) => value.includes('csrf-token'))!.split(';', 1)[0];
  const signedOut = await handlers.POST(new NextRequest('http://admin.example.test/api/auth/signout', {
    method: 'POST',
    headers: {
      host: 'admin.example.test',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `${browser.cookie}; ${csrfCookie}`,
    },
    body: new URLSearchParams({ csrfToken }).toString(),
  }));
  assert.ok(clearsSession(signedOut.headers.getSetCookie()));
  browser.receive(signedOut);
  assert.equal(browser.signedIn, false);
  assert.equal(singleFlight.isCurrentLogin(lineage), false, 'the login is no longer current for this browser');

  const late = browser.receive(await slow.finish());
  assert.deepEqual(late.headers.getSetCookie(), []);
  assert.equal(browser.signedIn, false);
});

test('two browsers of the same Keycloak user are independent: a new login in one does not retire the other', async () => {
  const { clock, kc, load, signIn } = await setup();
  const a1 = await signIn('browser-a');
  const b1 = await signIn('browser-b');
  const browserB = browserWith(b1.header);

  clock.now += WINDOW;
  const slowA = slowVisit(load, a1.header);
  await slowA.authenticated;
  // Browser A signs in again; browser B does nothing.
  const a2 = await signIn('browser-a');
  const browserA = browserWith(a2.header);

  // B's session keeps refreshing and committing its cookies.
  const refreshedB = browserB.receive(await visit(load, browserB.cookie));
  assert.equal(refreshedB.status, 200);
  assert.ok(nextCookie(refreshedB.headers.getSetCookie()), 'browser B still receives its cookie');
  assert.equal((await browserB.token())?.loginId, b1.loginId);
  assert.equal((await browserB.token())?.refreshGeneration, 1);
  assert.equal((await browserB.token())?.keycloakSub, (await browserA.token())?.keycloakSub);

  // Only A's old login is ignored.
  const lateA = browserA.receive(await slowA.finish());
  assert.deepEqual(lateA.headers.getSetCookie(), []);
  assert.equal((await browserA.token())?.loginId, a2.loginId);

  // B's own session ending is still B's: its cookie is removed, A is untouched.
  kc.revoke((await browserB.token())?.refreshToken as string);
  clock.now += WINDOW;
  assert.equal(browserB.receive(await visit(load, browserB.cookie)).status, 401);
  assert.equal(browserB.signedIn, false);
  assert.equal(browserA.receive(await visit(load, browserA.cookie)).status, 200);
  assert.equal((await browserA.token())?.loginId, a2.loginId);
});

test('the browser-instance cookie is opaque, HttpOnly and bound to a login only at sign-in', async () => {
  const { config, load, cookie, singleFlight } = await setup();
  const name = browserInstanceCookieName(false);
  const signInHandler = async () => {
    const token = await config.callbacks!.jwt!({
      token: { sub: APP_SUB },
      user: { id: APP_SUB },
      account: { provider: 'keycloak', type: 'oidc', providerAccountId: KC_SUB, id_token: 'id-token', refresh_token: 'refresh-token' },
      profile: { sub: KC_SUB, groups: [] },
    } as never);
    // As Auth.js answers the OIDC callback: a redirect carrying its own cookies.
    const response = new Response(null, { status: 302, headers: { location: 'http://admin.example.test/admin/upload' } });
    response.headers.append('set-cookie', `${COOKIE}=session; Path=/; HttpOnly`);
    response.headers.append('set-cookie', 'authjs.callback-url=x; Path=/');
    return { response, token };
  };
  const callback = (cookieHeader?: string) =>
    new Request('http://admin.example.test/api/auth/callback/keycloak', { headers: headersFor(cookieHeader) });
  const run = async (request: Request, production = false) => {
    let token: Record<string, unknown> | null = null;
    const response = await withBrowserInstance(request, async () => {
      const result = await signInHandler();
      token = result.token;
      return result.response;
    }, { production, ordering: singleFlight });
    return { response, token: token as Record<string, unknown> | null };
  };

  // First sign-in from a browser: a new random id, in its own cookie.
  const first = await run(callback());
  const issued = first.response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`))!;
  const id = issued.split(';', 1)[0].slice(name.length + 1);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(first.token?.browserInstanceId, id, 'the login is bound to it');
  assert.match(issued, /; HttpOnly/);
  assert.match(issued, /; SameSite=Lax/);
  assert.match(issued, /; Path=\//);
  assert.match(issued, /; Max-Age=\d+/);
  assert.doesNotMatch(issued, /Secure/, 'plain HTTP in local development');
  assert.equal(first.response.status, 302);
  assert.equal(first.response.headers.getSetCookie().length, 3, "Auth.js's own cookies are kept");
  for (const secret of [KC_SUB, APP_SUB, 'user@example.test']) assert.equal(id.includes(secret), false);

  // The next sign-in from the same browser reuses it, with a new login id.
  const second = await run(callback(`${name}=${id}`));
  assert.equal(second.token?.browserInstanceId, id);
  assert.notEqual(second.token?.loginId, first.token?.loginId);
  assert.ok(second.response.headers.getSetCookie().some((value) => value.startsWith(`${name}=${id};`)));

  // A value this app did not issue is replaced, not trusted.
  const forged = await run(callback(`${name}=${KC_SUB}`));
  assert.notEqual(forged.token?.browserInstanceId, KC_SUB);
  assert.match(String(forged.token?.browserInstanceId), /^[0-9a-f-]{36}$/);

  // Production: __Host- prefix and Secure.
  const production = await run(callback(), true);
  const secure = production.response.headers.getSetCookie().find((value) => value.startsWith('__Host-auraplex.browser-instance='))!;
  assert.match(secure, /; Secure/);
  assert.match(secure, /; HttpOnly/);

  // Other Auth.js requests (here a session read) do not set it, and it is not
  // part of the browser-visible session.
  const { header } = await cookie({ validatedAgo: 0 });
  const sessionRead = await withBrowserInstance(
    new Request('http://admin.example.test/api/auth/session', { headers: headersFor(header) }),
    async (request) => Response.json((await load(request.headers)).session),
  );
  assert.equal(sessionRead.headers.getSetCookie().length, 0);
  const body = await sessionRead.text();
  for (const hidden of ['browserInstanceId', 'loginId', 'refreshGeneration', 'browser-unregistered']) {
    assert.equal(body.includes(hidden), false);
  }
});

// --- Native Auth.js routes behind the route wrapper ---------------------------

type Env = Awaited<ReturnType<typeof setup>>;

/** The app's /api/auth route: the real Auth.js handlers behind the real wrapper. */
function authRouteOf(env: Env) {
  return (request: NextRequest) => withBrowserInstance(
    request,
    request.method === 'POST' ? env.handlers.POST : env.handlers.GET,
    { production: false, ordering: env.singleFlight },
  );
}

const sessionRequest = (cookie?: string) =>
  new NextRequest('http://admin.example.test/api/auth/session', { headers: headersFor(cookie) });

/** POST /api/auth/signout as Auth.js's sign-out form sends it, CSRF token included. */
async function signOutRequest(route: (request: NextRequest) => Promise<Response>, cookie: string) {
  const csrf = await route(new NextRequest('http://admin.example.test/api/auth/csrf', { headers: headersFor() }));
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const csrfCookie = csrf.headers.getSetCookie().find((value) => value.includes('csrf-token'))!.split(';', 1)[0];
  return new NextRequest('http://admin.example.test/api/auth/signout', {
    method: 'POST',
    headers: {
      host: 'admin.example.test',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `${cookie}; ${csrfCookie}`,
    },
    body: new URLSearchParams({ csrfToken }).toString(),
  });
}

const sessionCookiesIn = (response: Response) =>
  response.headers.getSetCookie().filter((value) => value.startsWith(COOKIE));
const otherCookieNamesIn = (response: Response) =>
  response.headers.getSetCookie().filter((value) => !value.startsWith(COOKIE)).map((value) => value.split('=', 1)[0]).sort();
const sessionBody = async (response: Response) => JSON.parse(await response.text()) as { user?: { groups?: string[] } } | null;

test('native /api/auth/session: a stale RT1 read is answered null but does not delete the RT2 session', async () => {
  const env = await setup();
  const { clock, kc, load, handlers } = env;
  const route = authRouteOf(env);
  const { browser, rt1, rt1Cookie, rt2 } = await staleResponseRace(env, load);
  clock.now += REFRESH_RESULT_REUSE_MS;

  // What Auth.js answers on its own: no session, and a removal of the cookie.
  const unwrapped = await handlers.GET(sessionRequest(rt1Cookie));
  assert.equal(await sessionBody(unwrapped), null);
  assert.ok(clearsSession(unwrapped.headers.getSetCookie()), 'the unfiltered response would delete the session');

  // The same request through the app's route.
  const stale = await route(sessionRequest(rt1Cookie));
  assert.equal(stale.status, 200);
  assert.equal(await sessionBody(stale), null, 'the stale request is not turned into a session');
  assert.equal(kc.presented.at(-1), rt1, 'Keycloak was asked and refused RT1');
  assert.deepEqual(sessionCookiesIn(stale), []);
  assert.deepEqual(otherCookieNamesIn(stale), otherCookieNamesIn(unwrapped), 'other cookies pass through');
  assert.equal(stale.headers.get('content-type'), unwrapped.headers.get('content-type'));
  browser.receive(stale);
  assert.equal(browser.signedIn, true);
  assert.equal((await browser.token())?.refreshToken, rt2);

  // The admin wrapper and Proxy deny the same old request, consistently.
  const admin = await upload(load, rt1Cookie);
  assert.equal(admin.response.status, 401);
  assert.equal(admin.puts, 0);
  assert.deepEqual(admin.response.headers.getSetCookie(), []);
  const proxied = await createAdminProxy(load)(csrfRequest(rt1Cookie));
  assert.equal(proxied.status, 401);
  assert.deepEqual(proxied.headers.getSetCookie(), []);
  browser.receive(admin.response);
  browser.receive(proxied);

  // The RT2 session itself is served and re-issued by the native route.
  const current = browser.receive(await route(sessionRequest(browser.cookie)));
  assert.deepEqual((await sessionBody(current))?.user?.groups, ['auraplex-uploader']);
  assert.equal((await reissued(current.headers.getSetCookie()))?.refreshToken, rt2);
  assert.equal((await browser.token())?.refreshToken, rt2);
});

test('native /api/auth/session: when the current login ends, its cookie is cleared', async () => {
  const cases: Array<{ name: string; arrange: (env: Env) => Promise<string> | string }> = [
    { name: 'idle expiry', arrange: async (env) => { const login = await env.signIn('browser-a'); env.clock.now += IDLE; return login.header; } },
    { name: '12-hour expiry', arrange: async (env) => { const login = await env.signIn('browser-a'); env.clock.now += ABSOLUTE; return login.header; } },
    {
      name: 'Keycloak revocation',
      arrange: async (env) => { const login = await env.signIn('browser-a'); env.clock.now += WINDOW; env.kc.disable(KC_SUB); return login.header; },
    },
    {
      name: 'refresh succeeded but the 12-hour limit passed',
      arrange: async (env) => {
        const login = await env.cookie({ loginAt: sec(env.clock.now - ABSOLUTE + 2 * SECOND) });
        env.kc.duringTokenRequest = () => { env.clock.now += 3 * SECOND; };
        return login.header;
      },
    },
  ];
  for (const { name, arrange } of cases) {
    const env = await setup(T0 + 20 * HOUR);
    const browser = browserWith(await arrange(env));
    const ended = await authRouteOf(env)(sessionRequest(browser.cookie));
    assert.equal(await sessionBody(ended), null, name);
    assert.ok(clearsSession(ended.headers.getSetCookie()), `${name}: the removal is sent`);
    browser.receive(ended);
    assert.equal(browser.signedIn, false, name);
  }
});

test('native /api/auth/signout: a delayed sign-out of an old login does not delete the newer login', async () => {
  // Unfiltered, Auth.js removes the session cookie for any sign-out.
  const control = await setup();
  const controlOld = await control.signIn('browser-a');
  await control.signIn('browser-a');
  const unwrapped = await control.handlers.POST(await signOutRequest(authRouteOf(control), controlOld.header));
  assert.ok(clearsSession(unwrapped.headers.getSetCookie()));

  const env = await setup();
  const route = authRouteOf(env);
  const oldLogin = await env.signIn('browser-a');
  const newLogin = await env.signIn('browser-a');
  const browser = browserWith(newLogin.header);
  const newLineage = lineageOf(await browser.token());

  // The old login's sign-out is handled only now.
  const late = await route(await signOutRequest(route, oldLogin.header));
  assert.equal(late.status, unwrapped.status, 'the request completes as it would have');
  assert.equal(late.headers.get('location'), unwrapped.headers.get('location'));
  assert.deepEqual(sessionCookiesIn(late), []);
  assert.deepEqual(otherCookieNamesIn(late), otherCookieNamesIn(unwrapped), 'other Auth.js cookies are kept');
  browser.receive(late);
  assert.equal(browser.signedIn, true);
  assert.equal((await browser.token())?.loginId, newLogin.loginId);
  assert.equal(env.singleFlight.isCurrentLogin(newLineage), true, 'the new login was not retired');
  assert.ok((await sessionBody(await route(sessionRequest(browser.cookie))))?.user);
});

test('native /api/auth/signout: signing out of the current login clears it and keeps the browser instance', async () => {
  const env = await setup();
  const route = authRouteOf(env);
  const login = await env.signIn('browser-a');
  const browser = browserWith(login.header);
  const lineage = lineageOf(await browser.token());

  const signedOut = await route(await signOutRequest(route, browser.cookie));
  assert.ok(signedOut.status < 400);
  assert.ok(clearsSession(signedOut.headers.getSetCookie()));
  assert.equal(
    signedOut.headers.getSetCookie().some((value) => value.startsWith(browserInstanceCookieName(false))),
    false,
    'the browser-instance cookie is not touched by sign-out',
  );
  browser.receive(signedOut);
  assert.equal(browser.signedIn, false);
  assert.equal(env.singleFlight.isCurrentLogin(lineage), false);

  // A repeated, late sign-out of that login after the next sign-in is ignored.
  const next = await env.signIn('browser-a');
  browser.set(next.header);
  browser.receive(await route(await signOutRequest(route, login.header)));
  assert.equal((await browser.token())?.loginId, next.loginId);
});

test('native /api/auth/session: a late success of the old login does not replace the new login', async () => {
  const env = await setup();
  const route = authRouteOf(env);
  const oldLogin = await env.signIn('browser-a');
  env.clock.now += WINDOW;
  const newLogin = await env.signIn('browser-a');
  const browser = browserWith(newLogin.header);

  const unwrapped = await env.handlers.GET(sessionRequest(oldLogin.header));
  assert.equal((await reissued(unwrapped.headers.getSetCookie()))?.loginId, oldLogin.loginId, 'unfiltered, it re-issues the old login');

  const late = await route(sessionRequest(oldLogin.header));
  assert.ok((await sessionBody(late))?.user, "the old request's own answer is unchanged");
  assert.deepEqual(sessionCookiesIn(late), []);
  browser.receive(late);
  assert.equal((await browser.token())?.loginId, newLogin.loginId);
  assert.equal((await browser.token())?.refreshToken, newLogin.refreshToken);
});

test('native routes: two browsers of the same Keycloak user stay independent', async () => {
  const env = await setup();
  const route = authRouteOf(env);
  const a1 = await env.signIn('browser-a');
  const b1 = await env.signIn('browser-b');
  const browserB = browserWith(b1.header);
  env.clock.now += WINDOW;
  const a2 = await env.signIn('browser-a');
  const browserA = browserWith(a2.header);

  // B keeps being served and re-issued although A signed in again.
  const servedB = browserB.receive(await route(sessionRequest(browserB.cookie)));
  assert.ok((await sessionBody(servedB))?.user);
  assert.equal((await reissued(servedB.headers.getSetCookie()))?.loginId, b1.loginId);
  assert.equal((await browserB.token())?.refreshGeneration, 1);

  // A's old login: neither its session read nor its sign-out touches A's new cookie.
  browserA.receive(await route(sessionRequest(a1.header)));
  browserA.receive(await route(await signOutRequest(route, a1.header)));
  assert.equal((await browserA.token())?.loginId, a2.loginId);
  assert.ok((await sessionBody(await route(sessionRequest(browserB.cookie))))?.user, 'B is unaffected');

  // B signs out: only B is cleared.
  browserB.receive(await route(await signOutRequest(route, browserB.cookie)));
  assert.equal(browserB.signedIn, false);
  assert.ok((await sessionBody(browserA.receive(await route(sessionRequest(browserA.cookie)))))?.user);
  assert.equal((await browserA.token())?.loginId, a2.loginId);
});

test('the route wrapper removes only the session cookie and passes everything else through', async () => {
  const env = await setup();
  const lineage: SessionLineage = { browserInstanceId: 'browser-x', loginId: 'login-x', refreshGeneration: 1 };
  const cookies = [
    `${COOKIE}=; Path=/; Max-Age=0; HttpOnly`,
    `${COOKIE}.0=; Path=/; Max-Age=0; HttpOnly`,
    `${COOKIE}.1=chunk; Path=/; HttpOnly`,
    'authjs.csrf-token=csrf; Path=/; HttpOnly',
    'authjs.callback-url=url; Path=/',
    'authjs.pkce.code_verifier=pkce; Path=/; Max-Age=900',
    'authjs.state=state; Path=/; Max-Age=900',
    'authjs.nonce=nonce; Path=/; Max-Age=900',
    `${COOKIE}-lookalike=kept; Path=/`,
    `${browserInstanceCookieName(false)}=11111111-2222-3333-4444-555555555555; Path=/; HttpOnly`,
  ];
  const handlerReporting = (outcome: AdminAuthScope['outcome']) => async () => {
    const scope = currentAdminAuthScope();
    if (scope && outcome) scope.outcome = outcome;
    const response = new Response('{"body":"kept"}', { status: 418, statusText: 'kept', headers: { 'content-type': 'application/json', 'x-kept': 'yes' } });
    for (const cookie of cookies) response.headers.append('set-cookie', cookie);
    return response;
  };
  const request = () => new Request('http://admin.example.test/api/auth/session', { headers: headersFor() });
  const options = { production: false, ordering: env.singleFlight };

  const filtered = await withBrowserInstance(
    request(),
    handlerReporting({ status: 'ended', reason: 'provider-superseded-refresh-rejected', lineage }),
    options,
  );
  assert.deepEqual(filtered.headers.getSetCookie(), cookies.slice(3), 'session cookie and its chunks only');
  assert.equal(filtered.status, 418);
  assert.equal(filtered.statusText, 'kept');
  assert.equal(filtered.headers.get('x-kept'), 'yes');
  assert.equal(filtered.headers.get('content-type'), 'application/json');
  assert.equal(await filtered.text(), '{"body":"kept"}');

  // Nothing reported, or a current session: the response is passed through as is.
  for (const outcome of [undefined, { status: 'active', lineage } as const, { status: 'ended', reason: 'local-idle-expired', lineage } as const]) {
    const untouched = await withBrowserInstance(request(), handlerReporting(outcome), options);
    assert.deepEqual(untouched.headers.getSetCookie(), cookies);
  }
  // A sign-out is filtered only when the browser had already left that login.
  for (const wasCurrentLogin of [true, false]) {
    const signedOut = await withBrowserInstance(request(), handlerReporting({ status: 'signed-out', lineage, wasCurrentLogin }), options);
    assert.deepEqual(signedOut.headers.getSetCookie(), wasCurrentLogin ? cookies : cookies.slice(3));
  }

  // Real handlers: the CSRF cookie of /api/auth/csrf comes through, and a read
  // that could not be revalidated leaves the session cookie exactly as it is.
  const route = authRouteOf(env);
  const csrf = await route(new NextRequest('http://admin.example.test/api/auth/csrf', { headers: headersFor() }));
  assert.ok(csrf.headers.getSetCookie().some((value) => value.startsWith('authjs.csrf-token=')));
  const { header } = await env.cookie();
  env.kc.mode = 'network';
  const unavailable = await route(sessionRequest(header));
  assert.deepEqual(sessionCookiesIn(unavailable), []);
  assert.deepEqual(Object.keys((await sessionBody(unavailable)) ?? {}).sort(), ['expires', REVALIDATION_UNAVAILABLE_FLAG]);
});

// --- Documented limitation: network arrival order ----------------------------

test('limitation: the server orders what it commits, not the order in which responses reach the browser', async () => {
  const { clock, kc, load, cookie, singleFlight } = await setup();
  const login = await cookie({ validatedAgo: 0 });
  const browser = browserWith(login.header);

  // Two requests, handled and committed strictly one after the other. Each
  // cookie is current at the moment the server commits it.
  const first = await visit(load, browser.cookie);
  assert.equal((await reissued(first.headers.getSetCookie()))?.refreshGeneration, 0);
  clock.now += WINDOW;
  const second = await visit(load, browser.cookie);
  assert.equal((await reissued(second.headers.getSetCookie()))?.refreshGeneration, 1);

  // The network delivers them the other way round. Nothing on the server can
  // see or prevent this: the browser applies the older cookie last.
  browser.receive(second);
  browser.receive(first);
  assert.equal((await browser.token())?.refreshGeneration, 0, 'the browser is back on the consumed generation');
  assert.equal(singleFlight.isSuperseded(lineageOf(await browser.token())), true);

  // Consequence: once that cookie is due for revalidation, Keycloak refuses
  // the consumed token and the user has to sign in again.
  clock.now += WINDOW;
  const denied = browser.receive(await visit(load, browser.cookie));
  assert.equal(denied.status, 401);
  assert.equal(kc.presented.at(-1), login.refreshToken);
});

// --- Coordinator ------------------------------------------------------------

test('concurrent requests of the same generation still share one refresh and all commit it', async () => {
  const { clock, kc, load, cookie, singleFlight } = await setup();
  const login = await cookie();
  const browser = browserWith(login.header);
  browser.receive(await visit(load, browser.cookie));
  const rt1 = (await browser.token())?.refreshToken;
  assert.deepEqual(singleFlight.ordering, { logins: 1, browsers: 0 });

  clock.now += WINDOW;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  kc.duringTokenRequest = () => gate;
  const pending = Array.from({ length: 6 }, () => visit(load, browser.cookie));
  while (kc.calls.token === 1) await new Promise((resolve) => setImmediate(resolve));
  for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(singleFlight.size.inFlight, 1);
  release();
  const responses = await Promise.all(pending);

  assert.deepEqual(kc.presented, [login.refreshToken, rt1], 'one refresh for six requests');
  const committed = new Set<unknown>();
  for (const response of responses) {
    assert.equal(response.status, 200);
    const token = await reissued(response.headers.getSetCookie());
    assert.equal(token?.refreshGeneration, 2);
    committed.add(token?.refreshToken);
  }
  assert.equal(committed.size, 1, 'every response commits the same new generation');
  assert.equal(committed.has(rt1), false);
  assert.equal(committed.has(undefined), false, 'none of them is treated as stale');
  assert.equal(singleFlight.size.inFlight, 0);
  assert.deepEqual(singleFlight.ordering, { logins: 1, browsers: 0 }, 'one entry per login, not per rotation');
});

test('a failed refresh leaves no coordinator entry and does not block the next one', async () => {
  const { kc, load, cookie, singleFlight } = await setup();
  const login = await cookie();

  for (const mode of ['network', 'timeout', 'http-5xx'] as const) {
    kc.mode = mode;
    const failed = await visit(load, login.header);
    assert.equal(failed.status, 503, mode);
    assert.deepEqual(failed.headers.getSetCookie(), []);
    assert.deepEqual(singleFlight.size, { inFlight: 0, settled: 0 }, mode);
    assert.deepEqual(singleFlight.ordering, { logins: 0, browsers: 0 }, mode);
  }

  // Keycloak is back: the same cookie refreshes normally and is committed.
  kc.mode = 'ok';
  const ok = await visit(load, login.header);
  assert.equal(ok.status, 200);
  assert.ok(nextCookie(ok.headers.getSetCookie()));
  assert.deepEqual(singleFlight.ordering, { logins: 1, browsers: 0 });

  // A revoked grant records nothing either, and still clears the session.
  const other = await setup();
  const revoked = await other.cookie();
  other.kc.disable(KC_SUB);
  const ended = await visit(other.load, revoked.header);
  assert.equal(ended.status, 401);
  assert.ok(clearsSession(ended.headers.getSetCookie()));
  assert.deepEqual(other.singleFlight.size, { inFlight: 0, settled: 0 });
  assert.deepEqual(other.singleFlight.ordering, { logins: 0, browsers: 0 });

  // A refresh that throws is cleaned up as well and can be retried.
  const flight = new RefreshSingleFlight();
  await assert.rejects(flight.run('k', () => 0, async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(flight.size, { inFlight: 0, settled: 0 });
  assert.deepEqual(flight.ordering, { logins: 0, browsers: 0 });
  const retried = await flight.run('k', () => 0, async () => ({ status: 'revoked' }));
  assert.deepEqual(retried, { status: 'revoked' });
});

test('ordering state is capacity bounded, ages out, and does not depend on the reuse window', () => {
  const retention = 12 * HOUR;
  const flight = new RefreshSingleFlight(1_000, 2, 3, retention);
  const at = (loginId: string, refreshGeneration: number, browserInstanceId = 'browser'): SessionLineage =>
    ({ browserInstanceId, loginId, refreshGeneration });

  // Refresh generations: one entry per login however often it rotates.
  for (let generation = 0; generation < 10; generation += 1) flight.recordRotation(at('a', generation), 0);
  assert.deepEqual(flight.ordering, { logins: 1, browsers: 0 });
  assert.equal(flight.isSuperseded(at('a', 10)), false, 'the current generation');
  for (const generation of [0, 5, 9]) assert.equal(flight.isSuperseded(at('a', generation)), true);
  // A rotation reported late does not lower the newest known generation.
  flight.recordRotation(at('a', 3), 0);
  assert.equal(flight.isSuperseded(at('a', 9)), true);
  assert.equal(flight.isSuperseded(at('a', 10)), false);
  // Another login is its own lineage, and an unknown one is never stale.
  flight.recordRotation(at('b', 0), 0);
  assert.equal(flight.isSuperseded(at('b', 0)), true);
  assert.equal(flight.isSuperseded(at('b', 1)), false);
  assert.equal(flight.isSuperseded(at('never-seen', 0)), false);

  // The answer does not expire with the 1-second reuse window.
  flight.recordRotation(at('b', 1), retention - 1);
  assert.equal(flight.isSuperseded(at('a', 9)), true);

  // Capacity: the least recently written login is forgotten, i.e. unknown.
  flight.recordRotation(at('c', 0), retention - 1);
  flight.recordRotation(at('d', 0), retention - 1);
  assert.deepEqual(flight.ordering, { logins: 3, browsers: 0 });
  assert.equal(flight.isSuperseded(at('a', 9)), false, 'evicted history is unknown, not stale');
  assert.equal(flight.isSuperseded(at('b', 1)), true);

  // Past the 12-hour session limit nothing of the old logins is kept.
  flight.recordRotation(at('e', 0), 2 * retention);
  assert.deepEqual(flight.ordering, { logins: 1, browsers: 0 });
  assert.equal(flight.isSuperseded(at('b', 1)), false);

  // Browser → current login.
  const browsers = new RefreshSingleFlight(1_000, 2, 3, retention);
  assert.equal(browsers.isCurrentLogin(at('l1', 0, 'b1')), true, 'an unknown browser is not known to have moved on');
  browsers.beginLogin('b1', 'l1', 0);
  assert.equal(browsers.isCurrentLogin(at('l1', 0, 'b1')), true);
  browsers.beginLogin('b1', 'l2', 1);
  assert.equal(browsers.isCurrentLogin(at('l1', 0, 'b1')), false);
  assert.equal(browsers.isCurrentLogin(at('l2', 0, 'b1')), true);
  assert.equal(browsers.isCurrentLogin(at('l1', 0, 'b2')), true, 'keyed by browser, not by login or user');
  // A sign-out of a login the browser already left changes nothing.
  browsers.endLogin('b1', 'l1', 2);
  assert.equal(browsers.isCurrentLogin(at('l2', 0, 'b1')), true);
  browsers.endLogin('b1', 'l2', 3);
  assert.equal(browsers.isCurrentLogin(at('l2', 0, 'b1')), false);
  browsers.beginLogin('b1', 'l3', 4);
  assert.equal(browsers.isCurrentLogin(at('l3', 0, 'b1')), true);
  assert.deepEqual(browsers.ordering, { logins: 0, browsers: 1 });
  // Capacity and age.
  for (const browser of ['b2', 'b3', 'b4']) browsers.beginLogin(browser, `login-of-${browser}`, 5);
  assert.deepEqual(browsers.ordering, { logins: 0, browsers: 3 });
  assert.equal(browsers.isCurrentLogin(at('l2', 0, 'b1')), true, 'b1 was evicted: unknown again');
  browsers.beginLogin('b5', 'l5', 5 + retention);
  assert.deepEqual(browsers.ordering, { logins: 0, browsers: 1 });
});

test('Proxy applies the same commit rule when it hands a request on', async () => {
  const { load, cookie } = await setup();
  const { header } = await cookie({ validatedAgo: 0 });

  const current = await createAdminProxy(load)(csrfRequest(header));
  assert.ok(current.headers.get('x-middleware-next'));
  assert.ok(nextCookie(current.headers.getSetCookie()));

  // The same read, overtaken before Proxy answers: the request is still
  // allowed, but its cookie is not set.
  const overtaken = await createAdminProxy(async (headers) => ({ ...(await load(headers)), withholdSessionCookies: () => true }))(csrfRequest(header));
  assert.ok(overtaken.headers.get('x-middleware-next'));
  assert.deepEqual(overtaken.headers.getSetCookie(), []);
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
  // Every sign-in is its own login lineage, starting at refresh generation 0.
  assert.equal(token.refreshGeneration, 0);
  assert.match(String(token.loginId), /^[0-9a-f-]{36}$/);
  assert.match(String(token.browserInstanceId), /^[0-9a-f-]{36}$/);
  const again = await signIn({ id_token: 'id-token', refresh_token: 'refresh-token' });
  assert.notEqual(again?.loginId, token.loginId);
  assert.notEqual(token.loginId, KC_SUB);
  assert.notEqual(token.browserInstanceId, KC_SUB);

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
  for (const missing of ['refreshToken', 'keycloakSub', 'lastValidatedAt', 'loginId', 'browserInstanceId', 'refreshGeneration']) {
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

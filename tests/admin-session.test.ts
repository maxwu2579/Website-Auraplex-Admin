import assert from 'node:assert/strict';
import test from 'node:test';
import NextAuth from 'next-auth';
import { decode, encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

import { createAdminAuthConfig } from '../lib/admin/server/auth-config';
import { ADMIN_SESSION_POLICY, applyAdminSessionPolicy, evaluateAdminSession } from '../lib/admin/server/session-policy';
import { createAdminSessionLoader, withAdminRequestSession, type AdminSessionLoader } from '../lib/admin/server/session';
import { authSessionCookieName } from '../lib/admin/server/auth-cookies';
import { getUploads, putUpload } from '../lib/admin/server/upload-service';
import { UploadConcurrencyGuard } from '../lib/admin/server/upload-concurrency';
import { createAdminProxy } from '../proxy';
import { createKeycloakRevalidator, RefreshSingleFlight } from '../lib/admin/server/keycloak-revalidation';
import { createFakeKeycloak } from './helpers/fake-keycloak';

// Test-only configuration, read at call time by Proxy and the route helper.
// node:test runs each test file in its own process.
const TEST_ENV = {
  AUTH_SECRET: 'test-only-auth-secret-0123456789abcdef',
  KEYCLOAK_ISSUER: 'https://sso.example.test/realms/auraplex',
  KEYCLOAK_CLIENT_ID: 'website-test',
  KEYCLOAK_CLIENT_SECRET: 'test-only',
};
Object.assign(process.env, TEST_ENV);

const COOKIE = authSessionCookieName(false);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const IDLE = ADMIN_SESSION_POLICY.idleTimeoutSeconds * 1000;
const ABSOLUTE = ADMIN_SESSION_POLICY.absoluteLifetimeSeconds * 1000;
// A fixed injected clock: the policy never reads real time in these tests.
const T0 = Date.UTC(2026, 8, 28, 8, 0, 0);
const sec = (ms: number) => Math.floor(ms / 1000);

const KEYCLOAK = {
  issuer: TEST_ENV.KEYCLOAK_ISSUER,
  clientId: TEST_ENV.KEYCLOAK_CLIENT_ID,
  clientSecret: TEST_ENV.KEYCLOAK_CLIENT_SECRET,
};
const KEYCLOAK_SUB = 'keycloak-user-1';
// In-process stand-in; sessions older than the 60-second revalidation window
// are refreshed against it. Revalidation itself is covered in
// admin-revalidation.test.ts.
const keycloak = createFakeKeycloak(KEYCLOAK);

/** A real Auth.js instance with this app's config and an injectable clock. */
function authAt(clock: { now: number }): AdminSessionLoader {
  const now = () => clock.now;
  const loader = keycloak.then((fake) => {
    const revalidator = createKeycloakRevalidator({
      config: KEYCLOAK,
      fetcher: fake.fetcher(now),
      now,
      production: false,
      singleFlight: new RefreshSingleFlight(),
    });
    const { auth } = NextAuth(createAdminAuthConfig({ env: { ...TEST_ENV, NODE_ENV: 'test' }, now, revalidator }));
    return createAdminSessionLoader(auth);
  });
  return async (headers) => (await loader)(headers);
}

let cookieSerial = 0;

async function sessionCookie(claims: Record<string, unknown>, groups = ['auraplex-uploader']) {
  // Sessions with timestamps also carry Keycloak refresh state, last validated
  // at their last activity. Timestamp-less (legacy) tokens get none. Each
  // cookie is its own Keycloak user, so its groups are independent.
  const keycloakSub = `${KEYCLOAK_SUB}-${++cookieSerial}`;
  const refreshState = typeof claims.activeAt === 'number'
    ? {
        keycloakSub,
        refreshToken: (await keycloak).grant(keycloakSub, groups),
        lastValidatedAt: claims.activeAt,
      }
    : {};
  const token = await encode({
    secret: TEST_ENV.AUTH_SECRET,
    salt: COOKIE,
    // Long JWT expiry so only the session policy (not real time) decides.
    maxAge: 30 * 24 * 3600,
    token: { sub: 'user-1', email: 'user@example.test', groups, ...refreshState, ...claims },
  });
  return `${COOKIE}=${token}`;
}

const headersFor = (cookie?: string) =>
  new Headers({ host: 'admin.example.test', ...(cookie ? { cookie } : {}) });

/** Reads the re-issued session JWT from Auth.js Set-Cookie headers. */
async function reissued(setCookies: string[]) {
  const value = setCookies
    .find((cookie) => cookie.startsWith(`${COOKIE}=`))
    ?.split(';', 1)[0]
    .slice(COOKIE.length + 1);
  if (!value) return null;
  return decode({ secret: TEST_ENV.AUTH_SECRET, salt: COOKIE, token: value });
}

const clearsSession = (setCookies: string[]) =>
  setCookies.some((cookie) => cookie.startsWith(`${COOKIE}=;`) && /Max-Age=0/i.test(cookie));

test('policy: 30-minute idle and 12-hour absolute boundaries', () => {
  const now = T0 + 13 * HOUR;
  const login = sec(now - HOUR);
  assert.equal(evaluateAdminSession({ loginAt: login, activeAt: sec(now - 5 * MINUTE) }, now), 'valid');
  assert.equal(evaluateAdminSession({ loginAt: login, activeAt: sec(now - IDLE + 1000) }, now), 'valid');
  assert.equal(evaluateAdminSession({ loginAt: login, activeAt: sec(now - IDLE) }, now), 'idle-expired');
  assert.equal(evaluateAdminSession({ loginAt: sec(now - ABSOLUTE + 1000), activeAt: sec(now) }, now), 'valid');
  assert.equal(evaluateAdminSession({ loginAt: sec(now - ABSOLUTE), activeAt: sec(now) }, now), 'absolute-expired');
  // Tokens from before this policy (no timestamps) are not trusted.
  assert.equal(evaluateAdminSession({}, now), 'missing-timestamps');
  assert.equal(evaluateAdminSession({ loginAt: 'x', activeAt: sec(now) }, now), 'missing-timestamps');
});

test('sign-in fixes loginAt; refreshes move only activeAt', () => {
  const signedIn = applyAdminSessionPolicy({ sub: 'u', loginAt: 1, activeAt: 1 }, { signIn: true, nowMs: T0 });
  assert.deepEqual([signedIn?.loginAt, signedIn?.activeAt], [sec(T0), sec(T0)]);
  const refreshed = applyAdminSessionPolicy(signedIn!, { signIn: false, nowMs: T0 + 10 * MINUTE });
  assert.deepEqual([refreshed?.loginAt, refreshed?.activeAt], [sec(T0), sec(T0 + 10 * MINUTE)]);
  assert.equal(applyAdminSessionPolicy(signedIn!, { signIn: false, nowMs: T0 + IDLE }), null);
});

test('Auth.js sign-in callback records the login time from the injected clock', async () => {
  const config = createAdminAuthConfig({ env: { ...TEST_ENV, NODE_ENV: 'test' }, now: () => T0 });
  const token = await config.callbacks!.jwt!({
    token: { sub: 'user-1' },
    user: { id: 'user-1' },
    account: { provider: 'keycloak', type: 'oidc', providerAccountId: KEYCLOAK_SUB, id_token: 'id-token', refresh_token: 'refresh-token' },
    profile: { sub: KEYCLOAK_SUB, groups: ['auraplex-uploader'] },
  } as never);
  assert.ok(token);
  assert.equal(token.loginAt, sec(T0));
  assert.equal(token.activeAt, sec(T0));
  assert.deepEqual(token.groups, ['auraplex-uploader']);
});

test('a valid active session is accepted and its activity is re-issued', async () => {
  const clock = { now: T0 + 2 * HOUR };
  const cookie = await sessionCookie({ loginAt: sec(T0), activeAt: sec(clock.now - 5 * MINUTE) });
  const { session, setCookies } = await authAt(clock)(headersFor(cookie));
  assert.equal((session?.user as { id?: string } | undefined)?.id, 'user-1');
  // Only the session cookie is forwarded, not Auth.js CSRF/callback cookies.
  assert.ok(setCookies.length > 0 && setCookies.every((value) => value.startsWith(COOKIE)));
  const token = await reissued(setCookies);
  assert.equal(token?.activeAt, sec(clock.now));
  assert.equal(token?.loginAt, sec(T0), 'login time is never moved');
  // The re-issued cookie itself expires after the idle timeout.
  assert.equal(token?.exp, sec(Date.now()) + ADMIN_SESSION_POLICY.idleTimeoutSeconds);
});

test('a session idle for 30 minutes or more is rejected and cleared', async () => {
  const clock = { now: T0 + 2 * HOUR };
  const cookie = await sessionCookie({ loginAt: sec(T0), activeAt: sec(clock.now - IDLE - 1000) });
  const { session, setCookies } = await authAt(clock)(headersFor(cookie));
  assert.equal(session, null);
  assert.ok(clearsSession(setCookies));
});

test('a session younger than 12 hours is valid; older is rejected', async () => {
  const clock = { now: T0 + 20 * HOUR };
  const young = await sessionCookie({ loginAt: sec(clock.now - ABSOLUTE + MINUTE), activeAt: sec(clock.now - MINUTE) });
  assert.notEqual((await authAt(clock)(headersFor(young))).session, null);
  const old = await sessionCookie({ loginAt: sec(clock.now - ABSOLUTE - 1000), activeAt: sec(clock.now - MINUTE) });
  const expired = await authAt(clock)(headersFor(old));
  assert.equal(expired.session, null);
  assert.ok(clearsSession(expired.setCookies));
});

test('continuous activity never extends the 12-hour limit', async () => {
  const clock = { now: T0 };
  const load = authAt(clock);
  let cookie = await sessionCookie({ loginAt: sec(T0), activeAt: sec(T0) });
  // Stay active every 20 minutes, carrying forward each re-issued cookie.
  for (clock.now = T0 + 20 * MINUTE; clock.now < T0 + ABSOLUTE; clock.now += 20 * MINUTE) {
    const { session, setCookies } = await load(headersFor(cookie));
    assert.notEqual(session, null, `valid at +${(clock.now - T0) / MINUTE} min`);
    const next = setCookies.find((value) => value.startsWith(`${COOKIE}=`) && !/Max-Age=0/i.test(value));
    assert.ok(next);
    cookie = next.split(';', 1)[0];
    assert.equal((await reissued(setCookies))?.loginAt, sec(T0));
  }
  clock.now = T0 + ABSOLUTE; // last activity was 20 minutes ago
  const { session, setCookies } = await load(headersFor(cookie));
  assert.equal(session, null);
  assert.ok(clearsSession(setCookies));
});

test('legacy sessions without timestamps are rejected', async () => {
  const cookie = await sessionCookie({});
  assert.equal((await authAt({ now: T0 })(headersFor(cookie))).session, null);
});

// --- Proxy-bypassed upload endpoint and Proxy/handler consistency ---------

function uploadRequest(cookie?: string) {
  return new NextRequest('http://admin.example.test/api/admin/uploads', {
    method: 'PUT',
    body: new TextEncoder().encode('%PDF-1.7\nbody'),
    headers: {
      host: 'admin.example.test',
      'content-type': 'application/pdf',
      'x-product-id': '6470625',
      'x-product-line': 'labelling',
      'x-upload-filename': 'manual.pdf',
      'x-csrf-token': 'csrf',
      cookie: [cookie, 'auraplex-admin-csrf=csrf'].filter(Boolean).join('; '),
    },
  });
}

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

test('the Proxy-bypassed upload handler rejects an expired session on its own', async () => {
  const clock = { now: T0 + 3 * HOUR };
  const load = authAt(clock);
  for (const claims of [
    { loginAt: sec(T0), activeAt: sec(clock.now - IDLE - 1000) }, // idle
    { loginAt: sec(clock.now - ABSOLUTE - 1000), activeAt: sec(clock.now - MINUTE) }, // absolute
  ]) {
    const request = uploadRequest(await sessionCookie(claims));
    const storage = spyStorage();
    const response = await withAdminRequestSession(
      request,
      (authenticate) => putUpload(request, { ...serviceDeps(storage), authenticate }),
      load,
    );
    assert.equal(response.status, 401);
    assert.equal(((await response.json()) as { code: string }).code, 'UNAUTHENTICATED');
    assert.equal(storage.puts(), 0, 'nothing reaches storage');
    assert.ok(clearsSession(response.headers.getSetCookie()));
  }

  const request = uploadRequest(await sessionCookie({ loginAt: sec(T0), activeAt: sec(clock.now - MINUTE) }));
  const storage = spyStorage();
  const ok = await withAdminRequestSession(
    request,
    (authenticate) => putUpload(request, { ...serviceDeps(storage), authenticate }),
    load,
  );
  assert.equal(ok.status, 200);
  assert.equal(storage.puts(), 1);
  // Activity on the bypassed endpoint is persisted, but never the login time.
  const token = await reissued(ok.headers.getSetCookie());
  assert.deepEqual([token?.loginAt, token?.activeAt], [sec(T0), sec(clock.now)]);
});

test('Proxy and the upload route handler apply identical session rules', async () => {
  const clock = { now: T0 + 5 * HOUR };
  const load = authAt(clock);
  const proxy = createAdminProxy(load);
  const cases: Array<{ name: string; cookie?: string; expected: 200 | 401 | 403 }> = [
    { name: 'active', cookie: await sessionCookie({ loginAt: sec(T0), activeAt: sec(clock.now - MINUTE) }), expected: 200 },
    { name: 'idle', cookie: await sessionCookie({ loginAt: sec(T0), activeAt: sec(clock.now - IDLE) }), expected: 401 },
    { name: 'absolute', cookie: await sessionCookie({ loginAt: sec(clock.now - ABSOLUTE), activeAt: sec(clock.now) }), expected: 401 },
    { name: 'legacy', cookie: await sessionCookie({}), expected: 401 },
    { name: 'anonymous', expected: 401 },
    { name: 'wrong group', cookie: await sessionCookie({ loginAt: sec(T0), activeAt: sec(clock.now) }, ['Viewer']), expected: 403 },
  ];
  for (const { name, cookie, expected } of cases) {
    const api = await proxy(new NextRequest('http://admin.example.test/api/admin/csrf', { headers: headersFor(cookie) }));
    const apiStatus = api.headers.get('x-middleware-next') ? 200 : api.status;

    const request = new NextRequest('http://admin.example.test/api/admin/uploads', { headers: headersFor(cookie) });
    const handler = await withAdminRequestSession(
      request,
      (authenticate) => getUploads(request, { ...serviceDeps(spyStorage()), authenticate }),
      load,
    );
    assert.equal(apiStatus, expected, `proxy: ${name}`);
    assert.equal(handler.status, expected, `route handler: ${name}`);

    const page = await proxy(new NextRequest('http://admin.example.test/admin/upload', { headers: headersFor(cookie) }));
    if (expected === 401) {
      // Expired or missing page sessions go back through Keycloak sign-in.
      assert.equal(page.status, 307, `page: ${name}`);
      assert.match(page.headers.get('location') ?? '', /\/api\/auth\/signin\/keycloak\?callbackUrl=/);
    } else if (expected === 403) {
      assert.equal(page.status, 403);
    } else {
      assert.equal(page.headers.get('x-middleware-next'), '1');
      assert.equal((await reissued(page.headers.getSetCookie()))?.activeAt, sec(clock.now), 'proxy persists activity');
    }
  }
});

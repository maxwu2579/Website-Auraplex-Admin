import assert from 'node:assert/strict';
import test from 'node:test';
import { UploadContractError } from '../lib/admin/upload-errors';
import {
  canViewAllUploads,
  canUpload,
  extractKeycloakGroups,
  getAdminRoleMapping,
  requireUploadPermission,
} from '../lib/admin/server/authorization';
import {
  ADMIN_CSRF_COOKIE,
  ADMIN_CSRF_COOKIE_PATH,
  adminCsrfCookieOptions,
  doubleSubmitCsrfValidator,
} from '../lib/admin/server/csrf';
import { jsonAuditLogger, requestIp } from '../lib/admin/server/audit';
import { getMinioConfig } from '../lib/admin/server/config';
import { getAdminCsrfResponse } from '../lib/admin/server/csrf-service';
import { authCookieConfig } from '../lib/admin/server/auth-cookies';
import { buildKeycloakLogoutUrl, discoverKeycloakLogoutUrl, tryDiscoverKeycloakLogoutUrl } from '../lib/admin/server/keycloak-logout';
import { adminGuardStatus, config as proxyConfig, isProtectedAdminPath, PROXY_BYPASS_UPLOAD_PATH } from '../proxy';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { putUpload, type UploadServiceDependencies } from '../lib/admin/server/upload-service';
import { requireUploadPermission as requireUploader } from '../lib/admin/server/authorization';
import {
  InMemoryUploadRateLimiter,
  UPLOAD_RATE_LIMITS,
} from '../lib/admin/server/rate-limit';

test('authorization rejects unauthenticated and unauthorized users', () => {
  assert.throws(() => requireUploadPermission(null), (error: unknown) => {
    assert.ok(error instanceof UploadContractError);
    assert.equal(error.status, 401);
    return true;
  });
  assert.throws(
    () => requireUploadPermission({ userId: 'viewer', groups: ['Viewer'] }),
    (error: unknown) => {
      assert.ok(error instanceof UploadContractError);
      assert.equal(error.status, 403);
      return true;
    },
  );
});

test('Uploader and Admin groups can upload with centralized mapping', () => {
  assert.equal(canUpload({ userId: 'uploader', groups: ['auraplex-uploader'] }), true);
  assert.equal(canUpload({ userId: 'admin', groups: ['auraplex-admin'] }), true);
  assert.equal(canUpload({ userId: 'viewer', groups: ['Viewer'] }), false);
  assert.equal(canViewAllUploads({ userId: 'uploader', groups: ['auraplex-uploader'] }), false);
  assert.equal(canViewAllUploads({ userId: 'admin', groups: ['auraplex-admin'] }), true);
  assert.equal(canUpload({ userId: 'nested', groups: ['/auraplex-admin'] }), false);
  assert.equal(canUpload({ userId: 'nested', groups: ['/Admin'] }, { uploader: '/Uploader', admin: '/Admin' }), true);
});

test('Keycloak group defaults follow the task spec and remain configurable', () => {
  assert.deepEqual(getAdminRoleMapping({} as NodeJS.ProcessEnv), {
    uploader: 'auraplex-uploader',
    admin: 'auraplex-admin',
  });
  assert.deepEqual(getAdminRoleMapping({
    NODE_ENV: 'test',
    KEYCLOAK_UPLOADER_ROLE: 'custom-uploader',
    KEYCLOAK_ADMIN_ROLE: 'custom-admin',
  } as NodeJS.ProcessEnv), {
    uploader: 'custom-uploader',
    admin: 'custom-admin',
  });
});

test('only validated Keycloak ID-token groups grant admin access', () => {
  const profile = {
    groups: ['/auraplex-uploader'],
    realm_access: { roles: ['realm-reader'] },
    resource_access: {
      'website-client': { roles: ['auraplex-admin'] },
      'unrelated-client': { roles: ['unrelated-admin'] },
    },
  };
  assert.deepEqual(extractKeycloakGroups(profile), ['/auraplex-uploader']);
  assert.deepEqual(extractKeycloakGroups({ realm_access: { roles: ['auraplex-admin'] }, resource_access: profile.resource_access }), []);
});

test('double-submit CSRF requires matching header and cookie', () => {
  const valid = new Request('http://localhost/api/admin/uploads', {
    headers: {
      cookie: `${ADMIN_CSRF_COOKIE}=token-1`,
      'x-csrf-token': 'token-1',
    },
  });
  assert.doesNotThrow(() => doubleSubmitCsrfValidator.verify(valid));

  const invalid = new Request('http://localhost/api/admin/uploads', {
    headers: {
      cookie: `${ADMIN_CSRF_COOKIE}=token-1`,
      'x-csrf-token': 'token-2',
    },
  });
  assert.throws(() => doubleSubmitCsrfValidator.verify(invalid), (error: unknown) => {
    assert.ok(error instanceof UploadContractError);
    assert.equal(error.status, 403);
    return true;
  });
});

test('CSRF cookie is HttpOnly, production-secure, strict and API-scoped', () => {
  assert.deepEqual(adminCsrfCookieOptions(true), {
    httpOnly: true,
    sameSite: 'strict',
    secure: true,
    path: ADMIN_CSRF_COOKIE_PATH,
    maxAge: 3_600,
  });
  assert.equal(ADMIN_CSRF_COOKIE_PATH, '/api/admin');
});

const MAX_UPLOAD = 100 * 1024 * 1024;
const declared = (bytes: number) => ({ declaredBytes: bytes, maxUploadBytes: MAX_UPLOAD });
const unknownLength = { maxUploadBytes: MAX_UPLOAD };

test('in-memory limiter enforces minute, hour and byte boundaries', () => {
  const perMinute = new InMemoryUploadRateLimiter();
  const now = Date.now();
  for (let index = 0; index < UPLOAD_RATE_LIMITS.uploadsPerMinute; index += 1) {
    perMinute.admit('minute-user', declared(1), now).settle(1);
  }
  assert.throws(() => perMinute.admit('minute-user', declared(1), now), UploadContractError);

  const perHour = new InMemoryUploadRateLimiter();
  const hourStart = now - 3_599_999;
  for (let index = 0; index < UPLOAD_RATE_LIMITS.uploadsPerHour; index += 1) {
    perHour.admit('hour-user', declared(1), hourStart + index * 17_999).settle(1);
  }
  assert.throws(() => perHour.admit('hour-user', declared(1), now), UploadContractError);

  const bytes = new InMemoryUploadRateLimiter();
  bytes.admit('byte-user', declared(UPLOAD_RATE_LIMITS.bytesPerHour), now).settle(UPLOAD_RATE_LIMITS.bytesPerHour);
  assert.throws(() => bytes.admit('byte-user', declared(1), now), UploadContractError);
  assert.throws(() => bytes.admit('byte-user', unknownLength, now), UploadContractError);
});

test('missing Content-Length cannot bypass or zero the byte-volume limit', () => {
  const limiter = new InMemoryUploadRateLimiter();
  const now = Date.now();
  // Unknown length reserves up to the per-file maximum until settled.
  const first = limiter.admit('user', unknownLength, now);
  assert.equal(first.allowanceBytes, MAX_UPLOAD);
  first.settle(7_000);
  const events = (limiter as unknown as { events: Map<string, Array<{ bytes: number }>> }).events;
  assert.deepEqual(events.get('user')?.map((event) => event.bytes), [7_000]);

  // Near the hourly cap, the unknown-length allowance shrinks to what is left.
  const nearlyFull = new InMemoryUploadRateLimiter();
  nearlyFull.admit('user', declared(UPLOAD_RATE_LIMITS.bytesPerHour - 10), now).settle(UPLOAD_RATE_LIMITS.bytesPerHour - 10);
  assert.equal(nearlyFull.admit('user', unknownLength, now).allowanceBytes, 10);
});

test('request-count limits count one admission per upload, not per stream chunk', () => {
  const limiter = new InMemoryUploadRateLimiter();
  const now = Date.now();
  const reservation = limiter.admit('user', unknownLength, now);
  reservation.settle(64 * 1024 * 1024);
  reservation.settle(1); // Settling twice is ignored.
  const events = (limiter as unknown as { events: Map<string, Array<{ bytes: number }>> }).events;
  assert.equal(events.get('user')?.length, 1);
  assert.equal(events.get('user')?.[0].bytes, 64 * 1024 * 1024);
});

test('in-memory limiter garbage-collects expired users on later traffic', () => {
  const limiter = new InMemoryUploadRateLimiter();
  const tracked = (limiter as unknown as { events: Map<string, unknown> }).events;
  limiter.admit('inactive-user', declared(1), 1_000_000);
  assert.equal(tracked.has('inactive-user'), true);
  limiter.admit('active-user', declared(1), 1_000_000 + 3_600_001);
  assert.equal(tracked.has('inactive-user'), false);
  assert.equal(tracked.has('active-user'), true);
});

test('audit logger emits only the allowlisted event fields', () => {
  const messages: string[] = [];
  const original = console.info;
  console.info = (message?: unknown) => { messages.push(String(message)); };
  try {
    jsonAuditLogger.write({
      user: 'user-1',
      action: 'upload.accepted',
      key: 'labelling/product/manual.pdf',
      size: 10,
      ip: '127.0.0.1',
      timestamp: '2026-09-21T10:00:00.000Z',
    });
  } finally {
    console.info = original;
  }
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0], /secret|token|cookie|authorization/i);
  assert.deepEqual(Object.keys(JSON.parse(messages[0])).sort(), [
    'action', 'ip', 'key', 'size', 'timestamp', 'type', 'user',
  ]);
});

test('proxy IP parsing accepts only valid first-hop addresses', () => {
  assert.equal(requestIp(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })), '203.0.113.7');
  assert.equal(requestIp(new Headers({ 'x-forwarded-for': 'spoofed', 'x-real-ip': '192.0.2.4' })), '192.0.2.4');
  assert.equal(requestIp(new Headers({ 'x-forwarded-for': 'spoofed' })), 'unknown');
});

test('Cloudflare IP is accepted only with a trusted ingress proof', () => {
  const previous = process.env.ADMIN_TRUSTED_PROXY_SECRET;
  process.env.ADMIN_TRUSTED_PROXY_SECRET = 'test-only-proxy-secret';
  try {
    const headers = new Headers({
      'cf-connecting-ip': '203.0.113.21',
      'x-forwarded-for': '192.0.2.14',
    });
    assert.equal(requestIp(headers), '192.0.2.14');
    headers.set('x-auraplex-proxy-secret', 'wrong');
    assert.equal(requestIp(headers), '192.0.2.14');
    headers.set('x-auraplex-proxy-secret', 'test-only-proxy-secret');
    assert.equal(requestIp(headers), '203.0.113.21');
    headers.set('cf-connecting-ip', 'not-an-ip');
    assert.equal(requestIp(headers), '192.0.2.14');
  } finally {
    if (previous === undefined) delete process.env.ADMIN_TRUSTED_PROXY_SECRET;
    else process.env.ADMIN_TRUSTED_PROXY_SECRET = previous;
  }
});

test('missing runtime integration configuration fails in a controlled way', () => {
  assert.throws(
    () => getMinioConfig({} as NodeJS.ProcessEnv),
    (error: unknown) => {
      assert.ok(error instanceof UploadContractError);
      assert.equal(error.status, 503);
      assert.equal(error.code, 'BACKEND_NOT_CONFIGURED');
      return true;
    },
  );
});

test('proxy includes admin page and direct API paths', () => {
  for (const path of ['/admin', '/admin/upload', '/api/admin/csrf', '/api/admin/uploads']) {
    assert.equal(isProtectedAdminPath(path), true);
  }
  assert.equal(isProtectedAdminPath('/'), false);
  assert.equal(adminGuardStatus(undefined), 401);
  assert.equal(adminGuardStatus(['Viewer']), 403);
  assert.equal(adminGuardStatus(['auraplex-uploader']), 200);
  assert.equal(adminGuardStatus(['auraplex-admin']), 200);
});

// Next's own (untyped, internal) matcher compiler, so the test checks the
// regexes the build actually emits rather than a re-implementation.
const { getMiddlewareMatchers } = createRequire(join(process.cwd(), 'package.json'))(
  'next/dist/build/analysis/get-page-static-info',
) as {
  getMiddlewareMatchers(matchers: string[], nextConfig: object): Array<{ regexp: string }>;
};

function proxyRuns(pathname: string): boolean {
  return getMiddlewareMatchers(proxyConfig.matcher, {})
    .some((matcher) => new RegExp(matcher.regexp).test(pathname));
}

test('streaming upload path bypasses Proxy body cloning; other admin paths do not', () => {
  assert.equal(PROXY_BYPASS_UPLOAD_PATH, '/api/admin/uploads');
  assert.equal(proxyRuns('/api/admin/uploads'), false);
  for (const path of ['/api/admin', '/api/admin/csrf', '/admin', '/admin/upload']) {
    assert.equal(proxyRuns(path), true, path);
  }
  assert.equal(proxyRuns('/api/auth/signin/keycloak'), false);
  // The public landing page (also the post-logout target) is never gated.
  assert.equal(proxyRuns('/'), false);
});

function bypassedUploadRequest(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/admin/uploads', {
    method: 'PUT',
    body: new TextEncoder().encode('%PDF-1.7\nbody'),
    headers: {
      'content-type': 'application/pdf',
      'x-product-id': '6470625',
      'x-product-line': 'labelling',
      'x-upload-filename': 'manual.pdf',
      'x-csrf-token': 'header-token',
      ...headers,
    },
  });
}

function bypassDependencies(
  groups: string[] | null,
  overrides: Partial<UploadServiceDependencies> = {},
): Partial<UploadServiceDependencies> & { stored: () => boolean } {
  let stored = false;
  return {
    // Mirrors authenticateAdminRequest(): session + group check in the handler.
    authenticate: async () => requireUploader(groups ? { userId: 'u', groups } : null),
    csrf: doubleSubmitCsrfValidator,
    rateLimiter: new InMemoryUploadRateLimiter(),
    audit: { write() {} },
    storage: () => ({
      async putObject(input) { stored = true; for await (const _chunk of input.body) { /* drain */ } return {}; },
      async listObjects() { return []; },
      async deleteObject() {},
    }),
    qdrant: () => null,
    createUploadId: () => 'id',
    stored: () => stored,
    ...overrides,
  };
}

test('without Proxy, the upload handler still rejects anonymous and non-uploader users', async () => {
  for (const [groups, status] of [[null, 401], [['Viewer'], 403]] as const) {
    const deps = bypassDependencies(groups ? [...groups] : null);
    const response = await putUpload(bypassedUploadRequest({ cookie: `${ADMIN_CSRF_COOKIE}=header-token` }), deps);
    assert.equal(response.status, status);
    assert.equal(deps.stored(), false);
  }
});

test('without Proxy, the upload handler still enforces CSRF', async () => {
  for (const cookie of [undefined, `${ADMIN_CSRF_COOKIE}=other-token`]) {
    const deps = bypassDependencies(['auraplex-uploader']);
    const response = await putUpload(bypassedUploadRequest(cookie ? { cookie } : {}), deps);
    assert.equal(response.status, 403);
    assert.equal(deps.stored(), false);
  }
  const allowed = bypassDependencies(['auraplex-uploader']);
  const ok = await putUpload(bypassedUploadRequest({ cookie: `${ADMIN_CSRF_COOKIE}=header-token` }), allowed);
  assert.equal(ok.status, 200);
  assert.equal(allowed.stored(), true);
});

test('without Proxy, the upload handler still enforces rate limits', async () => {
  const limiter = new InMemoryUploadRateLimiter();
  for (let index = 0; index < UPLOAD_RATE_LIMITS.uploadsPerMinute; index += 1) {
    limiter.admit('u', { declaredBytes: 1, maxUploadBytes: 1 }).settle(1);
  }
  const deps = bypassDependencies(['auraplex-uploader'], { rateLimiter: limiter });
  const response = await putUpload(bypassedUploadRequest({ cookie: `${ADMIN_CSRF_COOKIE}=header-token` }), deps);
  assert.equal(response.status, 429);
  assert.equal(deps.stored(), false);
});

test('CSRF handler independently rejects missing or unauthorized groups', async () => {
  const unauthenticated = await getAdminCsrfResponse(async () => { throw new UploadContractError(401, 'UNAUTHENTICATED', 'Authentication is required'); });
  const forbidden = await getAdminCsrfResponse(async () => ({ userId: 'viewer', groups: ['Viewer'] }));
  assert.equal(unauthenticated.status, 401);
  assert.equal(forbidden.status, 403);
  const allowed = await getAdminCsrfResponse(async () => ({ userId: 'uploader', groups: ['auraplex-uploader'] }));
  assert.equal(allowed.status, 200);
  assert.match(allowed.headers.get('set-cookie') ?? '', /HttpOnly/i);
});

test('Auth.js cookies are explicitly HttpOnly and production secure', () => {
  const prod = authCookieConfig(true);
  const local = authCookieConfig(false);
  for (const cookie of Object.values(prod)) {
    assert.equal(cookie.options.httpOnly, true);
    assert.equal(cookie.options.sameSite, 'lax');
    assert.equal(cookie.options.path, '/');
    assert.equal(cookie.options.secure, true);
  }
  assert.equal(prod.sessionToken.name, '__Host-authjs.session-token');
  assert.equal(prod.csrfToken.name, '__Host-authjs.csrf-token');
  assert.equal(prod.pkceCodeVerifier.name.startsWith('__Secure-'), true);
  assert.equal(local.sessionToken.options.secure, false);
});

test('Keycloak logout URL uses discovery endpoint and server-held ID token hint', () => {
  const url = new URL(buildKeycloakLogoutUrl({
    issuer: 'https://sso.example.test/realms/auraplex',
    clientId: 'website',
    idToken: 'server-only-token',
    endpoint: 'https://sso.example.test/realms/auraplex/protocol/openid-connect/logout',
    postLogoutRedirectUri: 'https://site.example.test/',
  }));
  assert.equal(url.searchParams.get('id_token_hint'), 'server-only-token');
  assert.equal(url.searchParams.get('post_logout_redirect_uri'), 'https://site.example.test/');
  assert.throws(() => buildKeycloakLogoutUrl({
    issuer: 'https://sso.example.test/realms/auraplex',
    clientId: 'website', idToken: 'x',
    endpoint: 'https://evil.example.test/logout',
    postLogoutRedirectUri: 'https://site.example.test/',
  }));
});

test('Keycloak logout discovers the endpoint instead of hardcoding it', async () => {
  let requested = '';
  const fetcher = async (url: string | URL | Request) => {
    requested = String(url);
    return Response.json({
      issuer: 'https://sso.example.test/realms/auraplex',
      end_session_endpoint: 'https://sso.example.test/realms/auraplex/protocol/openid-connect/logout',
    });
  };
  const url = new URL(await discoverKeycloakLogoutUrl(
    'server-held-token',
    fetcher as typeof fetch,
    { issuer: 'https://sso.example.test/realms/auraplex', clientId: 'website', clientSecret: 'test-only' },
    'https://site.example.test',
  ));
  assert.equal(requested, 'https://sso.example.test/realms/auraplex/.well-known/openid-configuration');
  assert.equal(url.searchParams.get('id_token_hint'), 'server-held-token');
  assert.equal(url.searchParams.get('post_logout_redirect_uri'), 'https://site.example.test/');
});

test('Keycloak discovery failure falls back to local-only logout destination', async () => {
  assert.equal(await tryDiscoverKeycloakLogoutUrl(undefined), null);
  assert.equal(await tryDiscoverKeycloakLogoutUrl('token', async () => { throw new Error('offline'); }), null);
  assert.equal(await tryDiscoverKeycloakLogoutUrl('token', async () => 'https://sso.example.test/logout'), 'https://sso.example.test/logout');
});

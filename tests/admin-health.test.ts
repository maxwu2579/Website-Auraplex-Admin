// Next.js request APIs (connection()) need its Node environment set up before
// any of its modules load, so this import is first.
import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { workAsyncStorage } from 'next/dist/server/app-render/work-async-storage.external';
import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external';
import { createRequestStoreForAPI } from 'next/dist/server/async-storage/request-store';
import { createWorkStore } from 'next/dist/server/async-storage/work-store';

import { GET as healthRoute } from '../app/api/health/route';
import type { AdminSessionLoader } from '../lib/admin/server/session';
import { config as proxyConfig, createAdminProxy, isProtectedAdminPath } from '../proxy';

const HEALTH_PATH = '/api/health';

/**
 * Runs the Route Handler inside a Next.js request scope, as the server does.
 * The request carries no cookie or credential of any kind.
 */
function GET(): Promise<Response> {
  const request = new NextRequest(`http://admin.example.test${HEALTH_PATH}`, {
    headers: { host: 'admin.example.test' },
  });
  const workStore = createWorkStore({
    page: '/api/health/route',
    renderOpts: { cacheComponents: false, supportsDynamicResponse: true, experimental: { isRoutePPREnabled: false, authInterrupts: false } },
    buildId: 'test',
    deploymentId: '',
    previouslyRevalidatedTags: [],
  } as never);
  const requestStore = createRequestStoreForAPI(
    request,
    { pathname: HEALTH_PATH, search: '' },
    { tags: [], expirationsByCacheKind: new Map() } as never,
    () => {},
    undefined,
  );
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, () => healthRoute()));
}

// Next's own matcher compiler, so the regexes are the ones the build emits.
const { getMiddlewareMatchers } = createRequire(join(process.cwd(), 'package.json'))(
  'next/dist/build/analysis/get-page-static-info',
) as {
  getMiddlewareMatchers(matchers: string[], nextConfig: object): Array<{ regexp: string }>;
};
const proxyRuns = (pathname: string) =>
  getMiddlewareMatchers(proxyConfig.matcher, {})
    .some((matcher) => new RegExp(matcher.regexp).test(pathname));

test('GET /api/health returns 200 with the minimal fixed body', async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'ok', service: 'auraplex-admin' });
});

test('the health response is deterministic and exposes nothing about the environment', async () => {
  const marker = 'health-test-secret-marker';
  const previous = { ...process.env };
  Object.assign(process.env, {
    AUTH_SECRET: marker,
    KEYCLOAK_CLIENT_SECRET: marker,
    MINIO_SECRET_KEY: marker,
    QDRANT_API_KEY: marker,
  });
  try {
    const first = await (await GET()).text();
    const second = await (await GET()).text();
    assert.equal(first, second);
    assert.equal(first, '{"status":"ok","service":"auraplex-admin"}');
    assert.equal(first.includes(marker), false);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test('the health check works with no Auth, Keycloak, MinIO or Qdrant configuration and makes no outbound request', async () => {
  const names = [
    'AUTH_SECRET', 'AUTH_URL', 'KEYCLOAK_ISSUER', 'KEYCLOAK_CLIENT_ID', 'KEYCLOAK_CLIENT_SECRET',
    'MINIO_ENDPOINT', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY', 'QDRANT_URL', 'QDRANT_API_KEY',
  ];
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) delete process.env[name];
  const realFetch = globalThis.fetch;
  const outbound: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    outbound.push(String(input));
    throw new Error('the health check must not make outbound requests');
  }) as typeof fetch;
  try {
    const response = await GET();
    assert.equal(response.status, 200);
    assert.deepEqual(outbound, []);
  } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
  }
});

test('the health route depends on no session, storage or Qdrant module', () => {
  const source = readFileSync(join(process.cwd(), 'app', 'api', 'health', 'route.ts'), 'utf8');
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['next/server']);
});

test('the health route is public: Proxy is not selected for it and it is not a protected path', async () => {
  assert.equal(isProtectedAdminPath(HEALTH_PATH), false);
  assert.equal(proxyRuns(HEALTH_PATH), false);

  // Even if Proxy were invoked for it, no session would be read.
  const calls: Headers[] = [];
  const load: AdminSessionLoader = async (headers) => {
    calls.push(headers);
    return { session: null, setCookies: [] };
  };
  const response = await createAdminProxy(load)(
    new NextRequest(`http://admin.example.test${HEALTH_PATH}`, { headers: { host: 'admin.example.test' } }),
  );
  assert.equal(response.headers.get('x-middleware-next'), '1');
  assert.deepEqual(calls, []);
});

test('adding the health route leaves the Admin guard and the upload bypass unchanged', () => {
  assert.deepEqual(proxyConfig.matcher, [
    '/admin/:path*',
    '/api/admin',
    '/api/admin/((?!uploads$).*)',
  ]);
  for (const path of ['/admin', '/admin/upload', '/api/admin', '/api/admin/csrf']) {
    assert.equal(isProtectedAdminPath(path), true, path);
    assert.equal(proxyRuns(path), true, path);
  }
  assert.equal(isProtectedAdminPath('/api/admin/uploads'), true);
  assert.equal(proxyRuns('/api/admin/uploads'), false, 'upload bodies still bypass Proxy');
});

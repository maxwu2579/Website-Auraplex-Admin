// Next.js request APIs (redirect()) need its Node environment set up before
// any of its modules load, so this import is first.
import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { getURLFromRedirectError } from 'next/dist/client/components/redirect';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { renderToStaticMarkup } from 'react-dom/server';

import AdminPage from '../app/admin/page';
import RootPage from '../app/page';
import SignedOutPage from '../app/signed-out/page';
import { AdminDocument } from '../components/admin/admin-document';
import { FileDropzone } from '../components/admin/upload-panel-parts';
import { ADMIN_HOME_PATH, ADMIN_SIGNED_OUT_PATH } from '../lib/admin/admin-routes';
import { doubleSubmitCsrfValidator } from '../lib/admin/server/csrf';
import { discoverKeycloakLogoutUrl } from '../lib/admin/server/keycloak-logout';
import { InMemoryUploadRateLimiter } from '../lib/admin/server/rate-limit';
import type { AdminSessionLoader, LoadedAdminSession } from '../lib/admin/server/session';
import { putUpload } from '../lib/admin/server/upload-service';
import {
  config as proxyConfig,
  createAdminProxy,
  isProtectedAdminPath,
  PROXY_BYPASS_UPLOAD_PATH,
} from '../proxy';

process.env.AUTH_SECRET ??= 'test-only-auth-secret-0123456789abcdef';

const ORIGIN = 'http://admin.example.test';
const source = (...segments: string[]) => readFileSync(join(process.cwd(), ...segments), 'utf8');

function redirectTarget(render: () => unknown): string {
  try {
    render();
  } catch (error) {
    if (!isRedirectError(error)) throw error;
    return getURLFromRedirectError(error);
  }
  throw new Error('expected a redirect');
}

const anonymous: LoadedAdminSession = { session: null, setCookies: [] };
/** A session loader that records every call; Keycloak is never contacted. */
function recordingLoader(loaded: LoadedAdminSession = anonymous) {
  const calls: Headers[] = [];
  const load: AdminSessionLoader = async (headers) => {
    calls.push(headers);
    return loaded;
  };
  return { load, calls };
}

const visit = (proxy: ReturnType<typeof createAdminProxy>, pathname: string) =>
  proxy(new NextRequest(`${ORIGIN}${pathname}`, { headers: { host: 'admin.example.test' } }));

// Next's own matcher compiler, so the regexes are the ones the build emits.
const { getMiddlewareMatchers } = createRequire(join(process.cwd(), 'package.json'))(
  'next/dist/build/analysis/get-page-static-info',
) as {
  getMiddlewareMatchers(matchers: string[], nextConfig: object): Array<{ regexp: string }>;
};
const proxyRuns = (pathname: string) =>
  getMiddlewareMatchers(proxyConfig.matcher, {})
    .some((matcher) => new RegExp(matcher.regexp).test(pathname));

test('/admin redirects to /admin/upload', () => {
  assert.equal(ADMIN_HOME_PATH, '/admin/upload');
  assert.equal(redirectTarget(() => AdminPage()), '/admin/upload');
});

test('the root entry is Admin-owned and redirects to /admin/upload', () => {
  assert.equal(redirectTarget(() => RootPage()), '/admin/upload');
});

test('the root entry does not go through locale routing or read a session', async () => {
  assert.equal(proxyRuns('/'), false, 'Proxy is not selected for the root entry');
  const { load, calls } = recordingLoader();
  const response = await visit(createAdminProxy(load), '/');
  assert.equal(response.headers.get('x-middleware-next'), '1', 'passes straight to app/page.tsx');
  assert.equal(response.headers.get('location'), null, 'no redirect to a locale such as /en');
  assert.equal(response.headers.get('x-middleware-rewrite'), null);
  assert.deepEqual(calls, []);
});

test('the signed-out route is public and outside locale routing', async () => {
  assert.equal(ADMIN_SIGNED_OUT_PATH, '/signed-out');
  assert.equal(isProtectedAdminPath('/signed-out'), false);
  assert.equal(proxyRuns('/signed-out'), false, 'Proxy is not selected for the signed-out page');

  const { load, calls } = recordingLoader();
  const response = await visit(createAdminProxy(load), '/signed-out');
  assert.equal(response.headers.get('x-middleware-next'), '1');
  assert.equal(response.headers.get('location'), null);
  assert.deepEqual(calls, [], 'no session is needed to see the signed-out page');
});

test('the signed-out page is minimal and offers a way back in', () => {
  const html = renderToStaticMarkup(<SignedOutPage />);
  assert.match(html, /Auraplex Admin/);
  assert.match(html, /<h1[^>]*>Signed out<\/h1>/);
  assert.match(html, /<a href="\/admin\/upload"[^>]*>Sign in again<\/a>/);
  // It starts no sign-in by itself: no form, script or refresh.
  assert.doesNotMatch(html, /<form|<script|http-equiv/);
});

test('/admin/upload stays protected: an anonymous browser is sent to Keycloak sign-in', async () => {
  const { load, calls } = recordingLoader();
  const proxy = createAdminProxy(load);

  const page = await visit(proxy, '/admin/upload');
  assert.equal(page.status, 307);
  const location = new URL(page.headers.get('location')!);
  assert.equal(location.pathname, '/api/auth/signin/keycloak');
  assert.equal(location.searchParams.get('callbackUrl'), `${ORIGIN}/admin/upload`);

  const api = await visit(proxy, '/api/admin/csrf');
  assert.equal(api.status, 401);
  assert.equal((await api.json()).code, 'UNAUTHENTICATED');
  assert.equal(calls.length, 2, 'both protected requests read the session');
});

test('the Admin guard still fails closed when Keycloak revalidation is unavailable', async () => {
  const { load } = recordingLoader({ session: null, setCookies: [], revalidationUnavailable: true });
  const proxy = createAdminProxy(load);
  const page = await visit(proxy, '/admin/upload');
  assert.equal(page.status, 503);
  assert.deepEqual(page.headers.getSetCookie(), [], 'the session cookie is left untouched');
  const api = await visit(proxy, '/api/admin/csrf');
  assert.equal(api.status, 503);
  assert.equal((await api.json()).code, 'IDENTITY_PROVIDER_UNAVAILABLE');
});

test('entering Admin needs no locale: no step of the flow uses a locale path', async () => {
  const { load } = recordingLoader();
  const proxy = createAdminProxy(load);
  const hops = [
    redirectTarget(() => RootPage()),
    redirectTarget(() => AdminPage()),
    (await visit(proxy, '/admin/upload')).headers.get('location')!,
  ];
  for (const hop of hops) {
    assert.doesNotMatch(new URL(hop, ORIGIN).pathname, /^\/(en|ms|zh)(\/|$)/, hop);
  }
});

test('the upload API still bypasses Proxy; the other Admin paths still run it', () => {
  assert.equal(PROXY_BYPASS_UPLOAD_PATH, '/api/admin/uploads');
  assert.equal(proxyRuns('/api/admin/uploads'), false);
  for (const path of ['/admin', '/admin/upload', '/api/admin', '/api/admin/csrf']) {
    assert.equal(proxyRuns(path), true, path);
  }
  assert.equal(proxyRuns('/api/auth/signin/keycloak'), false);
  assert.deepEqual(proxyConfig.matcher, [
    '/admin/:path*',
    '/api/admin',
    '/api/admin/((?!uploads$).*)',
  ]);
});

test('the bypassed upload Route Handler still authenticates each request itself', async () => {
  const route = source('app', 'api', 'admin', 'uploads', 'route.ts');
  assert.match(route, /export async function PUT[\s\S]*?withAdminRequestSession\(request, \(authenticate\) => putUpload\(request, \{ authenticate \}\)\)/);

  // Any use of storage is recorded: resolving the adapter or calling it.
  const storageCalls: string[] = [];
  const response = await putUpload(
    new Request(`${ORIGIN}/api/admin/uploads`, {
      method: 'PUT',
      body: new TextEncoder().encode('%PDF-1.7\nbody'),
      headers: {
        'content-type': 'application/pdf',
        'x-product-id': '6470625',
        'x-product-line': 'labelling',
        'x-upload-filename': 'manual.pdf',
        'x-csrf-token': 'header-token',
      },
    }),
    {
      authenticate: async () => null,
      csrf: doubleSubmitCsrfValidator,
      rateLimiter: new InMemoryUploadRateLimiter(),
      audit: { write() {} },
      storage: () => {
        storageCalls.push('storage');
        return {
          async putObject() { storageCalls.push('putObject'); return {}; },
          async listObjects() { storageCalls.push('listObjects'); return []; },
          async deleteObject() { storageCalls.push('deleteObject'); },
        };
      },
      qdrant: () => null,
    },
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'UNAUTHENTICATED');
  assert.deepEqual(storageCalls, [], 'an anonymous upload never reaches storage');
});

test('logout no longer points at the public website: fallback and Keycloak both use /signed-out', async () => {
  const action = source('app', 'admin', 'upload', 'actions.ts');
  assert.match(action, /redirect\(endSessionUrl \?\? ADMIN_SIGNED_OUT_PATH\)/);
  for (const file of [action, source('lib', 'admin', 'server', 'keycloak-logout.ts')]) {
    assert.doesNotMatch(file, /['"`]\/en['"`/]/);
  }

  const url = new URL(await discoverKeycloakLogoutUrl(
    'server-held-token',
    (async () => Response.json({
      issuer: 'https://sso.example.test/realms/auraplex',
      end_session_endpoint: 'https://sso.example.test/realms/auraplex/protocol/openid-connect/logout',
    })) as typeof fetch,
    { issuer: 'https://sso.example.test/realms/auraplex', clientId: 'website', clientSecret: 'test-only' },
    'https://admin.example.test',
  ));
  assert.equal(url.searchParams.get('post_logout_redirect_uri'), 'https://admin.example.test/signed-out');
  assert.equal(url.searchParams.get('id_token_hint'), 'server-held-token');
  assert.equal(url.searchParams.get('client_id'), 'website');
});

test('the Admin document renders with no website providers', () => {
  const html = renderToStaticMarkup(
    <AdminDocument fontClassName="font-a font-b">
      <FileDropzone onFiles={() => {}} />
    </AdminDocument>,
  );
  assert.match(html, /^<html lang="en" class="font-a font-b"><head><\/head><body class="[^"]*">/);
  // The existing upload UI renders inside it unchanged.
  assert.match(html, /<button type="button"[^>]*>Browse files<\/button>/);
  assert.match(html, /Drop source files here/);
});

test('Admin layouts and stylesheet do not depend on the public website', () => {
  const websiteOnly = /next-intl|globals\.css|styles\/motion|\[locale\]|lib\/navigation|lib\/i18n|sanity|components\/(sections|layout|motion|three|forms)/;
  for (const file of [
    ['app', 'admin', 'layout.tsx'],
    ['app', 'signed-out', 'layout.tsx'],
    ['app', 'signed-out', 'page.tsx'],
    ['app', 'page.tsx'],
    ['components', 'admin', 'admin-document.tsx'],
    ['lib', 'admin', 'admin-fonts.ts'],
    ['lib', 'admin', 'admin-routes.ts'],
  ]) {
    assert.doesNotMatch(source(...file), websiteOnly, file.join('/'));
  }
  for (const layout of [source('app', 'admin', 'layout.tsx'), source('app', 'signed-out', 'layout.tsx')]) {
    assert.match(layout, /import '@\/styles\/admin\.css';/);
  }

  const css = source('styles', 'admin.css');
  const imports = [...css.matchAll(/@import\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['tailwindcss'], 'no website stylesheet is imported');
  assert.match(css, /@import 'tailwindcss' source\(none\);/, 'utilities come only from the listed Admin sources');
  const sources = [...css.matchAll(/@source\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(sources, [
    '../app/admin',
    '../app/signed-out',
    '../components/admin',
    '../components/primitives/button.tsx',
  ]);
});

test('the Admin stylesheet defines every design token the Admin UI references', () => {
  const css = source('styles', 'admin.css');
  const defined = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((match) => match[1]));
  const used = new Set<string>();
  for (const file of [
    ['app', 'signed-out', 'page.tsx'],
    ['components', 'admin', 'admin-document.tsx'],
    ['components', 'admin', 'upload-panel.tsx'],
    ['components', 'admin', 'upload-panel-parts.tsx'],
    ['components', 'primitives', 'button.tsx'],
  ]) {
    for (const match of source(...file).matchAll(/var\((--[a-z0-9-]+)/g)) used.add(match[1]);
  }
  assert.ok(used.size > 0);
  for (const token of used) assert.ok(defined.has(token), `${token} is defined in styles/admin.css`);
  for (const token of ['--font-display', '--font-body', '--font-mono', '--ease-out']) {
    assert.ok(defined.has(token), token);
  }
});

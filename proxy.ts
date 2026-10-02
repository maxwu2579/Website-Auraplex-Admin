import createMiddleware from 'next-intl/middleware';
import { NextRequest, NextResponse } from 'next/server';
import { routing } from './lib/navigation';
import { canUpload, identityFromSession } from './lib/admin/server/authorization';
import {
  PROXY_IDENTITY_HEADER,
  appendSetCookies,
  loadAdminSession,
  sealProxyIdentity,
  type AdminSessionLoader,
} from './lib/admin/server/session';

const localeProxy = createMiddleware(routing);

export function isProtectedAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/') ||
    pathname === '/api/admin' || pathname.startsWith('/api/admin/');
}

export function adminGuardStatus(groups: unknown): 200 | 401 | 403 {
  if (!Array.isArray(groups)) return 401;
  return canUpload({
    userId: 'proxy',
    groups: groups.filter((group): group is string => typeof group === 'string'),
  }) ? 200 : 403;
}

function adminGuardResponse(request: NextRequest, status: 401 | 403): NextResponse {
  const pathname = request.nextUrl.pathname;
  if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) {
    return NextResponse.json(
      { ok: false, code: status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN', error: 'Access denied' },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (status === 403) return new NextResponse('Forbidden', { status: 403 });
  const login = new URL('/api/auth/signin/keycloak', request.url);
  login.searchParams.set('callbackUrl', new URL(pathname, request.url).toString());
  return NextResponse.redirect(login);
}

function identityProviderUnavailable(pathname: string): NextResponse {
  const headers = { 'Cache-Control': 'no-store' };
  if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) {
    return NextResponse.json(
      { ok: false, code: 'IDENTITY_PROVIDER_UNAVAILABLE', error: 'Sign-in could not be re-verified; retry shortly' },
      { status: 503, headers },
    );
  }
  return new NextResponse('Sign-in could not be re-verified; retry shortly', { status: 503, headers });
}

/**
 * Admin gate. Sessions are read through Auth.js (loadAdminSession), so the
 * 30-minute idle and 12-hour absolute limits are the exact rules the route
 * handlers apply. The re-issued cookie (activity) or its removal (expiry) is
 * attached to every admin response, including redirects and 401s. When the
 * 60-second Keycloak revalidation is due but Keycloak cannot be reached, the
 * request is denied with 503 and the cookie is left untouched.
 *
 * An allowed request continues with the authenticated identity in an
 * encrypted request header, so the page or Route Handler behind Proxy uses
 * this one decision instead of reading the session again a moment later.
 */
export function createAdminProxy(loadSession: AdminSessionLoader = loadAdminSession) {
  return async function proxy(request: NextRequest) {
    const pathname = request.nextUrl.pathname;
    if (!isProtectedAdminPath(pathname)) return localeProxy(request);

    if (!process.env.AUTH_SECRET) {
      return new NextResponse('Authentication is not configured', { status: 503 });
    }
    const { session, keycloakSub, setCookies, revalidationUnavailable } = await loadSession(request.headers);
    if (revalidationUnavailable) return identityProviderUnavailable(pathname);
    const identity = identityFromSession(session, keycloakSub);
    const status = identity ? adminGuardStatus(identity.groups) : 401;
    if (!identity || status !== 200) {
      return appendSetCookies(adminGuardResponse(request, status === 200 ? 401 : status), setCookies);
    }
    // Always set here, which also discards any client-supplied value.
    const headers = new Headers(request.headers);
    headers.set(PROXY_IDENTITY_HEADER, await sealProxyIdentity(identity));
    return appendSetCookies(NextResponse.next({ request: { headers } }), setCookies);
  };
}

export default createAdminProxy();

/**
 * Streaming upload endpoint that must never run through Proxy. When Proxy runs,
 * Next.js tees the request body into an in-memory clone capped by
 * `proxyClientMaxBodySize` (10 MiB) and truncates the Route Handler's copy at
 * that cap. Its handlers (PUT/GET/DELETE) authenticate the session, enforce
 * Keycloak groups, CSRF, rate limits and validation themselves.
 */
export const PROXY_BYPASS_UPLOAD_PATH = '/api/admin/uploads';

export const config = {
  // Public i18n plus explicit admin pages/APIs. Auth.js itself is excluded,
  // and so is PROXY_BYPASS_UPLOAD_PATH (see above).
  matcher: [
    '/((?!api|_next|_vercel|studio|admin|.*\\..*).*)',
    '/admin/:path*',
    '/api/admin',
    '/api/admin/((?!uploads$).*)',
  ],
};

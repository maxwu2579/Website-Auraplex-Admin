import createMiddleware from 'next-intl/middleware';
import { NextRequest, NextResponse } from 'next/server';
import { routing } from './lib/navigation';
import { canUpload, identityFromSession } from './lib/admin/server/authorization';
import { appendSetCookies, loadAdminSession, type AdminSessionLoader } from './lib/admin/server/session';

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

function adminGuardResponse(request: NextRequest, status: 200 | 401 | 403): NextResponse {
  const pathname = request.nextUrl.pathname;
  if (status === 200) return NextResponse.next();
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

/**
 * Admin gate. Sessions are read through Auth.js (loadAdminSession), so the
 * 30-minute idle and 12-hour absolute limits are the exact rules the route
 * handlers apply. The re-issued cookie (activity) or its removal (expiry) is
 * attached to every admin response, including redirects and 401s.
 */
export function createAdminProxy(loadSession: AdminSessionLoader = loadAdminSession) {
  return async function proxy(request: NextRequest) {
    const pathname = request.nextUrl.pathname;
    if (!isProtectedAdminPath(pathname)) return localeProxy(request);

    if (!process.env.AUTH_SECRET) {
      return new NextResponse('Authentication is not configured', { status: 503 });
    }
    const { session, setCookies } = await loadSession(request.headers);
    const identity = identityFromSession(session);
    const status = identity ? adminGuardStatus(identity.groups) : 401;
    return appendSetCookies(adminGuardResponse(request, status), setCookies);
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

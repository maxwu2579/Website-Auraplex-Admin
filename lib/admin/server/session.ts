import type { Session } from 'next-auth';
import { getKeycloakConfig } from '@/lib/admin/server/config';
import { identityFromSession, type AdminIdentity } from '@/lib/admin/server/authorization';
import { authSessionCookieName } from '@/lib/admin/server/auth-cookies';

export interface LoadedAdminSession {
  session: Session | null;
  /**
   * Auth.js Set-Cookie headers from the same read: the re-issued session with
   * refreshed activity, or cookie removal when the session has expired.
   */
  setCookies: string[];
}

export type AdminSessionLoader = (headers: Headers) => Promise<LoadedAdminSession>;

type ApiRouteAuth = (
  request: { headers: Headers },
  response: { headers: Headers },
) => Promise<Session | null>;

/**
 * Reads the session through Auth.js's own session action, so every caller
 * (Proxy, route handlers, the admin page) runs the same `jwt` callback and
 * session policy. The no-argument `auth()` form discards the re-issued cookie;
 * the API-route form used here hands it back so activity can be persisted.
 * Only the session cookie (and its chunks) is forwarded; Auth.js's own CSRF
 * and callback cookies are left to its sign-in/sign-out routes.
 */
export function createAdminSessionLoader(
  auth: unknown,
  sessionCookie = authSessionCookieName(process.env.NODE_ENV === 'production'),
): AdminSessionLoader {
  return async (headers) => {
    const response = { headers: new Headers() };
    const session = await (auth as ApiRouteAuth)({ headers }, response);
    const setCookies = response.headers
      .getSetCookie()
      .filter((cookie) => /^[^=]+/.exec(cookie)?.[0].startsWith(sessionCookie));
    return { session, setCookies };
  };
}

export const loadAdminSession: AdminSessionLoader = async (headers) => {
  const { auth } = await import('@/auth');
  return createAdminSessionLoader(auth)(headers);
};

export function appendSetCookies(response: Response, setCookies: readonly string[]): Response {
  for (const cookie of setCookies) response.headers.append('set-cookie', cookie);
  return response;
}

/**
 * For route handlers that Proxy does not run for (the streaming upload
 * endpoint): authenticates lazily with the same rules as Proxy and applies the
 * refreshed or cleared session cookie to whatever response the handler
 * returns. The refreshed cookie records activity at request start, when the
 * session was validated; it never moves the fixed 12-hour login boundary.
 */
export async function withAdminRequestSession(
  request: Request,
  handle: (authenticate: () => Promise<AdminIdentity | null>) => Promise<Response>,
  load: AdminSessionLoader = loadAdminSession,
): Promise<Response> {
  let setCookies: string[] = [];
  let identity: Promise<AdminIdentity | null> | undefined;
  const authenticate = () => (identity ??= (async () => {
    // Fail with a controlled 503 before invoking Auth.js when Keycloak
    // configuration is absent, rather than pretending SSO was verified.
    getKeycloakConfig();
    const loaded = await load(request.headers);
    setCookies = loaded.setCookies;
    return identityFromSession(loaded.session);
  })());
  return appendSetCookies(await handle(authenticate), setCookies);
}

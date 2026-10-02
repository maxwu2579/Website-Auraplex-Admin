import type { Session } from 'next-auth';
import { decode, encode, getToken } from 'next-auth/jwt';
import { UploadContractError } from '@/lib/admin/upload-errors';
import { getKeycloakConfig } from '@/lib/admin/server/config';
import { identityFromSession, type AdminIdentity } from '@/lib/admin/server/authorization';
import { authSessionCookieName } from '@/lib/admin/server/auth-cookies';
import { REVALIDATION_UNAVAILABLE_FLAG } from '@/lib/admin/server/session-policy';

export interface LoadedAdminSession {
  session: Session | null;
  /**
   * The verified Keycloak subject of a valid session. It is the stable
   * identity used for upload ownership; it is read from the encrypted session
   * JWT on the server and is not part of the browser-visible session JSON.
   */
  keycloakSub?: string;
  /**
   * Auth.js Set-Cookie headers from the same read: the re-issued session with
   * refreshed activity, or cookie removal when the session has expired.
   */
  setCookies: string[];
  /**
   * Keycloak revalidation was due and could not be completed. The session is
   * neither trusted nor ended: the request is denied with 503 and the existing
   * cookie is left as it is, so the browser can retry.
   */
  revalidationUnavailable?: boolean;
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
 * That same read performs the 60-second Keycloak revalidation when it is due.
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
    if (session && (session as unknown as Record<string, unknown>)[REVALIDATION_UNAVAILABLE_FLAG]) {
      return { session: null, setCookies: [], revalidationUnavailable: true };
    }
    const setCookies = response.headers
      .getSetCookie()
      .filter((cookie) => /^[^=]+/.exec(cookie)?.[0].startsWith(sessionCookie));
    if (!session) return { session, setCookies };
    // Auth.js accepted this cookie, and the session callback deliberately
    // leaves the Keycloak subject out of the session JSON, so it is read from
    // the same encrypted JWT. Revalidation never changes it.
    const token = await getToken({
      req: { headers },
      secret: process.env.AUTH_SECRET,
      cookieName: sessionCookie,
    }).catch(() => null);
    const keycloakSub = typeof token?.keycloakSub === 'string' && token.keycloakSub ? token.keycloakSub : undefined;
    return { session, keycloakSub, setCookies };
  };
}

export const loadAdminSession: AdminSessionLoader = async (headers) => {
  const { auth } = await import('@/auth');
  return createAdminSessionLoader(auth)(headers);
};

/**
 * The identity of a loaded session. Fails closed with a controlled 503 when
 * revalidation could not complete.
 */
export function identityFromLoadedSession(loaded: LoadedAdminSession): AdminIdentity | null {
  if (loaded.revalidationUnavailable) {
    throw new UploadContractError(
      503,
      'IDENTITY_PROVIDER_UNAVAILABLE',
      'Sign-in could not be re-verified with the identity provider; retry shortly',
    );
  }
  return identityFromSession(loaded.session, loaded.keycloakSub);
}

export function appendSetCookies(response: Response, setCookies: readonly string[]): Response {
  for (const cookie of setCookies) response.headers.append('set-cookie', cookie);
  return response;
}

/**
 * For route handlers that Proxy does not run for (the streaming upload
 * endpoint): authenticates lazily with the same rules as Proxy, including
 * Keycloak revalidation, and applies the refreshed or cleared session cookie
 * to whatever response the handler returns. The refreshed cookie records
 * activity at request start, when the session was validated; it never moves
 * the fixed 12-hour login boundary.
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
    return identityFromLoadedSession(loaded);
  })());
  return appendSetCookies(await handle(authenticate), setCookies);
}

// --- Proxy → page / Route Handler handoff -----------------------------------

/**
 * Request header in which Proxy hands the identity it authenticated to the
 * page or Route Handler behind it. Proxy always overwrites it, so a value sent
 * by a client never reaches a handler, and it is never sent to the browser.
 */
export const PROXY_IDENTITY_HEADER = 'x-auraplex-admin-identity';
const PROXY_IDENTITY_SALT = 'auraplex.admin.proxy-identity';
/** Only has to outlive one request; a leaked value is useless soon after. */
const PROXY_IDENTITY_MAX_AGE_SECONDS = 120;

/** Encrypts the identity with AUTH_SECRET (same JWE as the session cookie). */
export function sealProxyIdentity(identity: AdminIdentity, secret = process.env.AUTH_SECRET): Promise<string> {
  if (!secret) throw new Error('AUTH_SECRET is required');
  return encode({
    token: { userId: identity.userId, email: identity.email, groups: identity.groups },
    secret,
    salt: PROXY_IDENTITY_SALT,
    maxAge: PROXY_IDENTITY_MAX_AGE_SECONDS,
  });
}

async function openProxyIdentity(headers: Headers, secret = process.env.AUTH_SECRET): Promise<AdminIdentity | null> {
  const sealed = headers.get(PROXY_IDENTITY_HEADER);
  if (!sealed || !secret) return null;
  // Anything not produced by sealProxyIdentity (forged, expired, another
  // secret) fails decryption and is ignored.
  const payload = await decode({ token: sealed, secret, salt: PROXY_IDENTITY_SALT }).catch(() => null);
  if (!payload || typeof payload.userId !== 'string' || !payload.userId || !Array.isArray(payload.groups)) return null;
  return {
    userId: payload.userId,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    groups: payload.groups.filter((group): group is string => typeof group === 'string'),
  };
}

/**
 * Identity for code that runs behind Proxy (the admin page and the CSRF
 * route). Proxy has already authenticated this request, revalidated it with
 * Keycloak when due, and persisted the cookie, so its decision is used as is:
 * one request gets one session decision. Reading the session a second time,
 * moments later, could cross the 60-second window after Proxy had already
 * let the request through and re-issued the cookie.
 *
 * Without a valid handoff (Proxy did not run for this request) the session is
 * read here instead, with the same rules.
 */
export async function proxiedRequestIdentity(
  headers: Headers,
  load: AdminSessionLoader = loadAdminSession,
): Promise<AdminIdentity | null> {
  return (await openProxyIdentity(headers)) ?? identityFromLoadedSession(await load(headers));
}

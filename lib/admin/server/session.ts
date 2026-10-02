import type { Session } from 'next-auth';
import { decode, encode, getToken } from 'next-auth/jwt';
import { UploadContractError } from '@/lib/admin/upload-errors';
import { getKeycloakConfig } from '@/lib/admin/server/config';
import { identityFromSession, type AdminIdentity } from '@/lib/admin/server/authorization';
import { authSessionCookieName } from '@/lib/admin/server/auth-cookies';
import { REVALIDATION_UNAVAILABLE_FLAG } from '@/lib/admin/server/session-policy';
import { sharedRefreshSingleFlight, type RefreshSingleFlight } from '@/lib/admin/server/keycloak-revalidation';
import {
  runInAdminAuthScope,
  type AdminAuthScope,
  type SessionEndReason,
  type SessionReadOutcome,
} from '@/lib/admin/server/session-context';

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
  /**
   * Why the session was ended, when this read ended it. Internal: it decides
   * cookie handling only and is never sent to the browser.
   */
  endReason?: SessionEndReason;
  /**
   * Whether `setCookies` (a re-issued cookie or a removal) must be left out
   * because the browser's session has moved on since this read. Evaluated when
   * the response is about to be sent (see sessionCookiesToCommit).
   */
  withholdSessionCookies?: () => boolean;
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
 *
 * The `jwt` callback reports, through the request scope opened here, which
 * login and refresh generation the read was about and why a session ended.
 * `ordering` is the process-wide coordinator those are later compared with.
 */
export function createAdminSessionLoader(
  auth: unknown,
  sessionCookie = authSessionCookieName(process.env.NODE_ENV === 'production'),
  ordering: SessionOrdering = sharedRefreshSingleFlight(),
): AdminSessionLoader {
  return async (headers) => {
    const response = { headers: new Headers() };
    const scope: AdminAuthScope = {};
    const session = await runInAdminAuthScope(scope, () => (auth as ApiRouteAuth)({ headers }, response));
    if (session && (session as unknown as Record<string, unknown>)[REVALIDATION_UNAVAILABLE_FLAG]) {
      return { session: null, setCookies: [], revalidationUnavailable: true };
    }
    const setCookies = response.headers.getSetCookie().filter((cookie) => isSessionCookie(cookie, sessionCookie));
    const { outcome } = scope;
    const withholdSessionCookies = () => mustWithholdSessionCookies(outcome, ordering);
    if (!session) {
      return { session, setCookies, endReason: outcome?.status === 'ended' ? outcome.reason : undefined, withholdSessionCookies };
    }
    // Auth.js accepted this cookie, and the session callback deliberately
    // leaves the Keycloak subject out of the session JSON, so it is read from
    // the same encrypted JWT. Revalidation never changes it.
    const token = await getToken({
      req: { headers },
      secret: process.env.AUTH_SECRET,
      cookieName: sessionCookie,
    }).catch(() => null);
    const keycloakSub = typeof token?.keycloakSub === 'string' && token.keycloakSub ? token.keycloakSub : undefined;
    return { session, keycloakSub, setCookies, withholdSessionCookies };
  };
}

export type SessionOrdering = Pick<RefreshSingleFlight, 'isSuperseded' | 'isCurrentLogin'>;

/** A Set-Cookie header for the Auth.js session cookie or one of its chunks. */
export function isSessionCookie(setCookie: string, sessionCookie: string): boolean {
  const name = /^[^=]+/.exec(setCookie)?.[0] ?? '';
  return name === sessionCookie || name.startsWith(`${sessionCookie}.`);
}

/**
 * Whether a response must leave the browser's session cookie alone. It never
 * changes the response itself: a denied request stays denied and an allowed
 * one stays allowed.
 *
 * - The browser instance has signed out of this login, or signed in again
 *   since: neither a re-issued cookie nor a removal from the old login is
 *   applied to the browser's present session.
 * - Re-issued cookie whose refresh generation has been redeemed by a later
 *   refresh of the same login: it would put a consumed refresh token (and that
 *   generation's groups) back.
 * - Removal because Keycloak refused a refresh token that was already known to
 *   be replaced: the refusal is about the old token, not the newer session.
 *
 * - Sign-out of a login the browser had already left: its removal is not
 *   applied either. A sign-out of the browser's current login is.
 * - Revalidation could not be completed: the request is refused and the
 *   existing cookie is left exactly as it is.
 *
 * Every other removal is applied: idle or 12-hour expiry, a refresh that
 * succeeded but crossed a local limit, Keycloak refusing the login's newest
 * refresh token, and sessions that cannot be revalidated. Without a reported
 * outcome (Auth.js could not read the cookie) nothing is withheld.
 *
 * This is the one rule for every place that writes the session cookie: the
 * upload handlers, Proxy and the Auth.js routes (see withBrowserInstance).
 */
export function mustWithholdSessionCookies(
  outcome: SessionReadOutcome | undefined,
  ordering: SessionOrdering = sharedRefreshSingleFlight(),
): boolean {
  if (!outcome) return false;
  if (outcome.status === 'revalidation-unavailable') return true;
  if (outcome.status === 'signed-out') return !outcome.wasCurrentLogin;
  if (!outcome.lineage) return false;
  if (!ordering.isCurrentLogin(outcome.lineage)) return true;
  if (outcome.status === 'active') return ordering.isSuperseded(outcome.lineage);
  return outcome.reason === 'provider-superseded-refresh-rejected';
}

/**
 * The session cookies a response may set, decided at the moment it is sent
 * rather than when the session was read: requests of one browser overlap and
 * do not finish in the order they started.
 */
export function sessionCookiesToCommit(loaded: LoadedAdminSession): string[] {
  return loaded.withholdSessionCookies?.() ? [] : loaded.setCookies;
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
 * the fixed 12-hour login boundary. A long upload can outlast a later refresh
 * of the same session, so whether that cookie is still current is decided
 * only once the handler has finished (sessionCookiesToCommit).
 */
export async function withAdminRequestSession(
  request: Request,
  handle: (authenticate: () => Promise<AdminIdentity | null>) => Promise<Response>,
  load: AdminSessionLoader = loadAdminSession,
): Promise<Response> {
  let loaded: LoadedAdminSession | undefined;
  let identity: Promise<AdminIdentity | null> | undefined;
  const authenticate = () => (identity ??= (async () => {
    // Fail with a controlled 503 before invoking Auth.js when Keycloak
    // configuration is absent, rather than pretending SSO was verified.
    getKeycloakConfig();
    loaded = await load(request.headers);
    return identityFromLoadedSession(loaded);
  })());
  const response = await handle(authenticate);
  return appendSetCookies(response, loaded ? sessionCookiesToCommit(loaded) : []);
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

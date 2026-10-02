/**
 * Browser-instance identifier (AURA-INT-001). An opaque random id kept in its
 * own cookie so that successive logins from one browser profile can be told
 * apart from logins on another browser or device, even for the same Keycloak
 * user. The sign-in callback binds each new login to it; the process-local
 * coordinator then knows which login is current for that browser, and a
 * response that belongs to an earlier login leaves the session cookie alone
 * (see sessionCookiesToCommit in session.ts).
 *
 * It is not a credential: it grants nothing, is never compared with a user or
 * a group, and a missing or foreign value only loses that ordering. It
 * survives sign-out on purpose, and is never logged.
 */
import { authSessionCookieName } from '@/lib/admin/server/auth-cookies';
import { sharedRefreshSingleFlight } from '@/lib/admin/server/keycloak-revalidation';
import { isSessionCookie, mustWithholdSessionCookies, type SessionOrdering } from '@/lib/admin/server/session';
import { runInAdminAuthScope, type AdminAuthScope } from '@/lib/admin/server/session-context';

/** Browsers cap cookie lifetimes at about 400 days; renewed at every sign-in. */
const BROWSER_INSTANCE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function browserInstanceCookieName(production: boolean): string {
  return `${production ? '__Host-' : ''}auraplex.browser-instance`;
}

function readBrowserInstanceId(headers: Headers, cookieName: string): string | null {
  for (const pair of (headers.get('cookie') ?? '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0 || pair.slice(0, separator).trim() !== cookieName) continue;
    const value = pair.slice(separator + 1).trim();
    // Anything that is not an id this module issued is ignored and replaced.
    return UUID.test(value) ? value : null;
  }
  return null;
}

function browserInstanceCookie(name: string, id: string, production: boolean): string {
  return `${name}=${id}; Path=/; Max-Age=${BROWSER_INSTANCE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${production ? '; Secure' : ''}`;
}

export interface AuthRouteOptions {
  production?: boolean;
  /** Process-local response-ordering state; defaults to the shared one. */
  ordering?: SessionOrdering;
}

/**
 * Wraps the Auth.js route handlers (GET and POST).
 *
 * Before: the request's browser-instance id (or a new one) is made available
 * to the sign-in callback. Its cookie is set only on the response that
 * completed a sign-in, which is the one place it is used.
 *
 * After: Auth.js writes the session cookie on these routes itself
 * (`/api/auth/session` re-issues or removes it, `/api/auth/signout` removes
 * it), so the same commit rule as for the admin handlers and Proxy is applied
 * here, from what the callbacks reported while Auth.js handled this request;
 * the session is not read a second time. When the rule says the browser's
 * session cookie must be left alone, only the session cookie (and its chunks)
 * is taken out of the response. Status, body, every other header and every
 * other cookie (CSRF, callback URL, state, PKCE, nonce) are passed through.
 */
export async function withBrowserInstance<R extends Request>(
  request: R,
  handle: (request: R) => Promise<Response>,
  { production = process.env.NODE_ENV === 'production', ordering = sharedRefreshSingleFlight() }: AuthRouteOptions = {},
): Promise<Response> {
  const cookieName = browserInstanceCookieName(production);
  const scope: AdminAuthScope = {
    browserInstanceId: readBrowserInstanceId(request.headers, cookieName) ?? crypto.randomUUID(),
  };
  const response = await runInAdminAuthScope(scope, () => handle(request));
  const bound = scope.browserInstanceBound && scope.browserInstanceId ? scope.browserInstanceId : null;
  const withhold = mustWithholdSessionCookies(scope.outcome, ordering);
  if (!bound && !withhold) return response;

  // Auth.js may hand back a response with immutable headers (a redirect).
  const sessionCookie = authSessionCookieName(production);
  const headers = new Headers(response.headers);
  headers.delete('set-cookie');
  for (const cookie of response.headers.getSetCookie()) {
    if (withhold && isSessionCookie(cookie, sessionCookie)) continue;
    headers.append('set-cookie', cookie);
  }
  if (bound) headers.append('set-cookie', browserInstanceCookie(cookieName, bound, production));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

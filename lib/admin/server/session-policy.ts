/**
 * Admin session lifetime rules (AURA-INT-001): a session ends after 30 minutes
 * without authenticated admin activity, and never lives longer than 12 hours
 * after the original Keycloak login. Activity refreshes `activeAt` only;
 * `loginAt` is fixed at sign-in, so refreshes cannot extend the 12-hour limit.
 *
 * This module is pure (no Next/Auth.js imports). The Auth.js `jwt` callback
 * applies it, and Proxy, route handlers and the admin page all read sessions
 * through that same callback (see session.ts).
 */
export const ADMIN_SESSION_POLICY = Object.freeze({
  idleTimeoutSeconds: 30 * 60,
  absoluteLifetimeSeconds: 12 * 60 * 60,
});

export type AdminSessionState = 'valid' | 'missing-timestamps' | 'idle-expired' | 'absolute-expired';

/** Session timestamps stored in the encrypted Auth.js JWT, in epoch seconds. */
export interface AdminSessionClaims {
  loginAt?: unknown;
  activeAt?: unknown;
}

function epochSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function evaluateAdminSession(
  claims: AdminSessionClaims,
  nowMs: number,
  policy = ADMIN_SESSION_POLICY,
): AdminSessionState {
  const loginAt = epochSeconds(claims.loginAt);
  const activeAt = epochSeconds(claims.activeAt);
  // Tokens issued before these rules (or tampered ones) carry no timestamps.
  if (loginAt === null || activeAt === null) return 'missing-timestamps';
  const now = nowMs / 1000;
  if (now - loginAt >= policy.absoluteLifetimeSeconds) return 'absolute-expired';
  if (now - activeAt >= policy.idleTimeoutSeconds) return 'idle-expired';
  return 'valid';
}

/**
 * Auth.js `jwt` callback body. Returns the token with refreshed activity, or
 * null to end the session (Auth.js then clears the session cookie).
 */
export function applyAdminSessionPolicy<T extends Record<string, unknown>>(
  token: T,
  { signIn, nowMs }: { signIn: boolean; nowMs: number },
  policy = ADMIN_SESSION_POLICY,
): (T & { loginAt: number; activeAt: number }) | null {
  const now = Math.floor(nowMs / 1000);
  if (signIn) return { ...token, loginAt: now, activeAt: now };
  if (evaluateAdminSession(token, nowMs, policy) !== 'valid') return null;
  return { ...token, loginAt: token.loginAt as number, activeAt: now };
}

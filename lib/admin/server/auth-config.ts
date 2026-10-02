import type { NextAuthConfig } from 'next-auth';
import Keycloak from 'next-auth/providers/keycloak';
import { extractKeycloakGroups } from '@/lib/admin/server/authorization';
import { tryGetKeycloakConfig } from '@/lib/admin/server/config';
import { authCookieConfig } from '@/lib/admin/server/auth-cookies';
import {
  createKeycloakRevalidator,
  readKeycloakSessionState,
  type KeycloakRevalidationResult,
  type KeycloakRevalidator,
} from '@/lib/admin/server/keycloak-revalidation';
import {
  ADMIN_SESSION_POLICY,
  REVALIDATION_UNAVAILABLE_FLAG,
  applyAdminSessionPolicy,
  evaluateAdminSession,
  isKeycloakRevalidationDue,
} from '@/lib/admin/server/session-policy';

export interface AdminAuthConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Injectable clock for deterministic session-expiry tests. */
  now?: () => number;
  /** Injectable Keycloak revalidation for tests; defaults to the real one. */
  revalidator?: KeycloakRevalidator;
}

export function createAdminAuthConfig({
  env = process.env,
  now = Date.now,
  revalidator,
}: AdminAuthConfigOptions = {}): NextAuthConfig {
  let keycloak: ReturnType<typeof tryGetKeycloakConfig> = null;
  try {
    keycloak = tryGetKeycloakConfig(env);
  } catch {
    // The admin API reports partial configuration as a controlled 503 before it
    // invokes Auth.js. Keeping bootstrap inert also lets local builds run safely.
  }
  const revalidate: KeycloakRevalidator | null = revalidator ??
    (keycloak ? createKeycloakRevalidator({ config: keycloak, now, production: env.NODE_ENV === 'production' }) : null);

  return {
    secret: env.AUTH_SECRET || undefined,
    trustHost: true,
    // maxAge is the idle timeout: every refresh re-issues the JWT and cookie
    // with a new 30-minute expiry, so an idle browser drops the cookie. The
    // fixed 12-hour limit is enforced by applyAdminSessionPolicy via loginAt.
    session: { strategy: 'jwt', maxAge: ADMIN_SESSION_POLICY.idleTimeoutSeconds },
    cookies: authCookieConfig(env.NODE_ENV === 'production'),
    providers: keycloak
      ? [
          Keycloak({
            issuer: keycloak.issuer,
            clientId: keycloak.clientId,
            clientSecret: keycloak.clientSecret,
          }),
        ]
      : [],
    callbacks: {
      async jwt({ token: stored, profile, account }) {
        // The flag describes one failed read and must never carry over.
        const token: Record<string, unknown> = { ...stored };
        delete token[REVALIDATION_UNAVAILABLE_FLAG];

        // `account` is present only on the sign-in callback, which starts the
        // fixed 12-hour lifetime and counts as the first Keycloak validation.
        if (account) {
          // Auth.js sets token.sub to its own per-login user id. The Keycloak
          // subject is kept separately and binds every later ID token.
          const keycloakSub = typeof profile?.sub === 'string' && profile.sub ? profile.sub : account.providerAccountId;
          // Without a refresh token the session could never be revalidated.
          if (!account.refresh_token || !keycloakSub) return null;
          const nowSeconds = Math.floor(now() / 1000);
          const refreshExpiresIn = account.refresh_expires_in;
          // Auth.js passes validated ID-token claims as profile for OIDC
          // providers. The refresh and ID tokens stay in the encrypted,
          // HttpOnly server JWT (revalidation and RP logout); the access token
          // is not kept.
          return applyAdminSessionPolicy({
            ...token,
            groups: extractKeycloakGroups(profile),
            idToken: account.id_token,
            keycloakSub,
            refreshToken: account.refresh_token,
            refreshExpiresAt: typeof refreshExpiresIn === 'number' && refreshExpiresIn > 0
              ? nowSeconds + Math.floor(refreshExpiresIn)
              : undefined,
            lastValidatedAt: nowSeconds,
          }, { signIn: true, nowMs: now() });
        }

        // 1. Local idle/absolute limits, before Keycloak is contacted.
        if (evaluateAdminSession(token, now()) !== 'valid') return null;
        // Sessions from before revalidation carry no refresh state.
        const state = readKeycloakSessionState(token);
        if (!state) return null;

        // 2. Authoritative freshness.
        let current = token;
        if (isKeycloakRevalidationDue(state.lastValidatedAt, now())) {
          let result: KeycloakRevalidationResult;
          if (state.refreshExpiresAt !== undefined && now() / 1000 >= state.refreshExpiresAt) {
            result = { status: 'revoked' }; // The Keycloak session has already ended.
          } else if (!revalidate) {
            result = { status: 'unavailable', reason: 'not-configured' };
          } else {
            result = await revalidate(state);
          }
          if (result.status === 'revoked') return null;
          if (result.status === 'unavailable') {
            console.warn(JSON.stringify({
              type: 'admin_session_revalidation',
              outcome: 'unavailable',
              reason: result.reason,
            }));
            // Denied without touching activeAt, lastValidatedAt or the groups.
            return { ...token, [REVALIDATION_UNAVAILABLE_FLAG]: true };
          }
          current = {
            ...token,
            groups: result.groups, // replaced, not merged: removed groups are gone
            idToken: result.idToken,
            refreshToken: result.refreshToken,
            refreshExpiresAt: result.refreshExpiresAt,
            lastValidatedAt: result.validatedAt,
          };
        }

        // Read the clock again: the Keycloak round trip may have crossed the
        // 12-hour boundary. loginAt is carried over unchanged.
        return applyAdminSessionPolicy(current, { signIn: false, nowMs: now() });
      },
      session({ session, token }) {
        if (token[REVALIDATION_UNAVAILABLE_FLAG]) {
          // No identity or groups: the session loader maps this to a 503.
          return { expires: session.expires, [REVALIDATION_UNAVAILABLE_FLAG]: true } as unknown as typeof session;
        }
        if (session.user) {
          const user = session.user as typeof session.user & {
            id?: string;
            groups?: string[];
          };
          if (token.sub) user.id = token.sub;
          user.groups = Array.isArray(token.groups)
            ? token.groups.filter((group): group is string => typeof group === 'string')
            : [];
        }
        return session;
      },
    },
  };
}

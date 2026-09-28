import type { NextAuthConfig } from 'next-auth';
import Keycloak from 'next-auth/providers/keycloak';
import { extractKeycloakGroups } from '@/lib/admin/server/authorization';
import { tryGetKeycloakConfig } from '@/lib/admin/server/config';
import { authCookieConfig } from '@/lib/admin/server/auth-cookies';
import { ADMIN_SESSION_POLICY, applyAdminSessionPolicy } from '@/lib/admin/server/session-policy';

export interface AdminAuthConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Injectable clock for deterministic session-expiry tests. */
  now?: () => number;
}

export function createAdminAuthConfig({
  env = process.env,
  now = Date.now,
}: AdminAuthConfigOptions = {}): NextAuthConfig {
  let keycloak: ReturnType<typeof tryGetKeycloakConfig> = null;
  try {
    keycloak = tryGetKeycloakConfig(env);
  } catch {
    // The admin API reports partial configuration as a controlled 503 before it
    // invokes Auth.js. Keeping bootstrap inert also lets local builds run safely.
  }

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
      jwt({ token, profile, account }) {
        // Auth.js passes validated ID-token claims as profile for OIDC providers.
        // Keep the raw ID token only in the encrypted, HttpOnly server JWT for RP logout.
        if (profile) token.groups = extractKeycloakGroups(profile);
        if (account?.id_token) token.idToken = account.id_token;
        // `account` is present only on the sign-in callback, which starts the
        // fixed 12-hour lifetime. Every later read validates and refreshes.
        return applyAdminSessionPolicy(token, { signIn: Boolean(account), nowMs: now() });
      },
      session({ session, token }) {
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

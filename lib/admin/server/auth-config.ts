import type { NextAuthConfig } from 'next-auth';
import Keycloak from 'next-auth/providers/keycloak';
import { extractKeycloakGroups } from '@/lib/admin/server/authorization';
import { tryGetKeycloakConfig } from '@/lib/admin/server/config';
import { authCookieConfig } from '@/lib/admin/server/auth-cookies';
import {
  createKeycloakRevalidator,
  readKeycloakSessionState,
  readSessionLineage,
  sharedRefreshSingleFlight,
  type KeycloakRevalidationResult,
  type KeycloakRevalidator,
  type RefreshSingleFlight,
} from '@/lib/admin/server/keycloak-revalidation';
import {
  currentAdminAuthScope,
  type SessionEndReason,
  type SessionLineage,
  type SessionReadOutcome,
} from '@/lib/admin/server/session-context';
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
  /** Process-local refresh and response-ordering state; defaults to the shared one. */
  coordinator?: RefreshSingleFlight;
}

/** Tells the session loader (if one is listening) how this read was decided. */
function report(outcome: SessionReadOutcome): void {
  const scope = currentAdminAuthScope();
  if (scope) scope.outcome = outcome;
}

/** Ends the session; Auth.js only sees `null` and clears the cookie. */
function end(reason: SessionEndReason, lineage?: SessionLineage): null {
  report({ status: 'ended', reason, lineage });
  return null;
}

export function createAdminAuthConfig({
  env = process.env,
  now = Date.now,
  revalidator,
  coordinator = sharedRefreshSingleFlight(),
}: AdminAuthConfigOptions = {}): NextAuthConfig {
  let keycloak: ReturnType<typeof tryGetKeycloakConfig> = null;
  try {
    keycloak = tryGetKeycloakConfig(env);
  } catch {
    // The admin API reports partial configuration as a controlled 503 before it
    // invokes Auth.js. Keeping bootstrap inert also lets local builds run safely.
  }
  const revalidate: KeycloakRevalidator | null = revalidator ??
    (keycloak
      ? createKeycloakRevalidator({ config: keycloak, now, production: env.NODE_ENV === 'production', singleFlight: coordinator })
      : null);

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
          // Every sign-in is a new login lineage, starting at refresh
          // generation 0, and becomes the current login of the browser
          // instance the Auth.js route identified. Without that route (no
          // scope) the login is tied to no known browser.
          const scope = currentAdminAuthScope();
          const lineage: SessionLineage = {
            browserInstanceId: scope?.browserInstanceId ?? crypto.randomUUID(),
            loginId: crypto.randomUUID(),
            refreshGeneration: 0,
          };
          coordinator.beginLogin(lineage.browserInstanceId, lineage.loginId, now());
          if (scope?.browserInstanceId) scope.browserInstanceBound = true;
          report({ status: 'active', lineage });
          // Auth.js passes validated ID-token claims as profile for OIDC
          // providers. The refresh and ID tokens stay in the encrypted,
          // HttpOnly server JWT (revalidation and RP logout); the access token
          // is not kept.
          return applyAdminSessionPolicy({
            ...token,
            ...lineage,
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
        const local = evaluateAdminSession(token, now());
        if (local === 'idle-expired') return end('local-idle-expired', readSessionLineage(token) ?? undefined);
        if (local === 'absolute-expired') return end('local-absolute-expired', readSessionLineage(token) ?? undefined);
        // Sessions from before revalidation and response ordering carry no
        // timestamps, refresh state or lineage.
        const state = local === 'valid' ? readKeycloakSessionState(token) : null;
        if (!state) return end('not-revalidatable');
        const { lineage } = state;

        // 2. Authoritative freshness.
        let current = token;
        let refreshed = false;
        if (isKeycloakRevalidationDue(state.lastValidatedAt, now())) {
          let result: KeycloakRevalidationResult;
          if (state.refreshExpiresAt !== undefined && now() / 1000 >= state.refreshExpiresAt) {
            result = { status: 'revoked' }; // The Keycloak session has already ended.
          } else if (!revalidate) {
            result = { status: 'unavailable', reason: 'not-configured' };
          } else {
            result = await revalidate(state);
          }
          if (result.status === 'revoked') {
            // The request is denied either way. The reason differs: a refresh
            // token that a later refresh of this login already replaced was
            // bound to be refused and says nothing about the newer session.
            return end(
              coordinator.isSuperseded(lineage) ? 'provider-superseded-refresh-rejected' : 'provider-current-session-rejected',
              lineage,
            );
          }
          if (result.status === 'unavailable') {
            console.warn(JSON.stringify({
              type: 'admin_session_revalidation',
              outcome: 'unavailable',
              reason: result.reason,
            }));
            report({ status: 'revalidation-unavailable' });
            // Denied without touching activeAt, lastValidatedAt or the groups.
            return { ...token, [REVALIDATION_UNAVAILABLE_FLAG]: true };
          }
          refreshed = true;
          current = {
            ...token,
            groups: result.groups, // replaced, not merged: removed groups are gone
            idToken: result.idToken,
            refreshToken: result.refreshToken,
            refreshExpiresAt: result.refreshExpiresAt,
            lastValidatedAt: result.validatedAt,
            refreshGeneration: lineage.refreshGeneration + 1,
          };
        }

        // Read the clock again: the Keycloak round trip may have crossed the
        // 12-hour boundary. loginAt is carried over unchanged.
        const next = applyAdminSessionPolicy(current, { signIn: false, nowMs: now() });
        if (!next) {
          // The login itself is over, whatever happened to its refresh token.
          if (refreshed) return end('refresh-succeeded-but-local-session-expired', lineage);
          return end(evaluateAdminSession(current, now()) === 'idle-expired' ? 'local-idle-expired' : 'local-absolute-expired', lineage);
        }
        report({ status: 'active', lineage: { ...lineage, refreshGeneration: next.refreshGeneration as number } });
        return next;
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
    events: {
      // Fired for the logout server action and for Auth.js's own sign-out
      // route. Retires the login for its browser instance, so a response of
      // that login still in flight does not set the session cookie again.
      signOut(message) {
        const token = 'token' in message ? message.token : null;
        const lineage = token ? readSessionLineage(token) : null;
        if (!lineage) return;
        // Whether this is still the browser's login decides if the response
        // may remove the session cookie (see mustWithholdSessionCookies).
        report({ status: 'signed-out', lineage, wasCurrentLogin: coordinator.isCurrentLogin(lineage) });
        coordinator.endLogin(lineage.browserInstanceId, lineage.loginId, now());
      },
    },
  };
}

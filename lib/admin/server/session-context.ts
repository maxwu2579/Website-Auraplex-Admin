/**
 * Per-request scope shared by the code that calls Auth.js and the Auth.js
 * callbacks it triggers (AURA-INT-001). Auth.js gives a callback no access to
 * the request and reports every ended session as a bare `null`, so the two
 * sides exchange a little internal state here:
 *
 * - the Auth.js route passes in the browser-instance identifier, which the
 *   sign-in callback binds to the new login;
 * - the `jwt` callback reports why a session read ended, and which login
 *   lineage and refresh generation it was about, so the session loader can
 *   decide what the response may do to the session cookie.
 *
 * Nothing in this scope is sent to the browser or written to a log.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Where a session cookie sits in the ordering of one browser's sessions. */
export interface SessionLineage {
  /** Opaque id of the browser profile that signed in. Not a credential. */
  browserInstanceId: string;
  /** Random id of one Keycloak sign-in; fixed for the life of that login. */
  loginId: string;
  /** 0 at sign-in, +1 on every refresh-token rotation of that login. */
  refreshGeneration: number;
}

/** Why a session read ended the session. Internal; never exposed. */
export type SessionEndReason =
  /** No authenticated admin request for 30 minutes. */
  | 'local-idle-expired'
  /** 12 hours since sign-in. True for every cookie of the login. */
  | 'local-absolute-expired'
  /** Keycloak refreshed the session, but a local limit passed meanwhile. */
  | 'refresh-succeeded-but-local-session-expired'
  /** Keycloak refused the newest refresh token of the login: it is over. */
  | 'provider-current-session-rejected'
  /**
   * Keycloak refused a refresh token that a later, successful refresh of the
   * same login had already replaced. Says nothing about the newer session.
   */
  | 'provider-superseded-refresh-rejected'
  /** Issued before these rules: no timestamps, refresh state or lineage. */
  | 'not-revalidatable';

export type SessionReadOutcome =
  /** `lineage` is that of the cookie being re-issued. */
  | { status: 'active'; lineage: SessionLineage }
  /** `lineage` is that of the cookie the request carried, when it had one. */
  | { status: 'ended'; reason: SessionEndReason; lineage?: SessionLineage }
  | { status: 'revalidation-unavailable' }
  /**
   * A sign-out of the login in `lineage`. `wasCurrentLogin` is false when the
   * browser had already signed out of it or signed in again before this
   * request was handled.
   */
  | { status: 'signed-out'; lineage: SessionLineage; wasCurrentLogin: boolean };

export interface AdminAuthScope {
  /** Set by the Auth.js route for the sign-in callback. */
  browserInstanceId?: string;
  /** Set by the sign-in callback when it bound a login to that browser. */
  browserInstanceBound?: boolean;
  /** Set by the `jwt` callback on every session read it decides, and by the sign-out event. */
  outcome?: SessionReadOutcome;
}

const SHARED_SCOPE = Symbol.for('auraplex.admin.authScope');

/** One store per process, like the refresh coordinator (separate bundles). */
function storage(): AsyncLocalStorage<AdminAuthScope> {
  const holder = globalThis as { [SHARED_SCOPE]?: AsyncLocalStorage<AdminAuthScope> };
  return (holder[SHARED_SCOPE] ??= new AsyncLocalStorage<AdminAuthScope>());
}

export function runInAdminAuthScope<T>(scope: AdminAuthScope, run: () => Promise<T>): Promise<T> {
  return storage().run(scope, run);
}

/** Undefined when the caller did not open a scope; reporting is then a no-op. */
export function currentAdminAuthScope(): AdminAuthScope | undefined {
  return storage().getStore();
}

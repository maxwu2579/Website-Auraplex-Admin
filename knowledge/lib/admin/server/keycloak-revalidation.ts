/**
 * Authoritative Keycloak revalidation (AURA-INT-001). When a session's last
 * validation is older than KEYCLOAK_REVALIDATION_WINDOW_SECONDS, the Auth.js
 * `jwt` callback calls this module to redeem the stored refresh token, verify
 * the fresh ID token and take its groups. This is the only place that talks to
 * Keycloak's token endpoint; Proxy, the route handlers and the admin page all
 * reach it through the same session read (see session.ts).
 *
 * Nothing here logs or returns a token to callers other than the `jwt`
 * callback, which keeps it inside the encrypted session JWT.
 */
import { createHash } from 'node:crypto';
import { createLocalJWKSet, errors as joseErrors, jwtVerify, type JSONWebKeySet } from 'jose';
import { extractKeycloakGroups } from '@/lib/admin/server/authorization';
import type { KeycloakConfig } from '@/lib/admin/server/config';
import { ADMIN_SESSION_POLICY } from '@/lib/admin/server/session-policy';
import type { SessionLineage } from '@/lib/admin/server/session-context';

/** One budget for discovery, JWKS and the token request together. */
export const KEYCLOAK_REVALIDATION_TIMEOUT_MS = 5_000;
/** How long discovery metadata and signing keys are cached in this process. */
const PROVIDER_METADATA_TTL_MS = 10 * 60_000;
/**
 * How long a successful refresh stays reusable for requests that still carry
 * the previous cookie. Keycloak rotates the refresh token on use, so a second
 * redemption of the old one would fail; this covers the route handler that
 * runs after Proxy in the same request, and parallel browser requests sent
 * before the new Set-Cookie was applied.
 */
export const REFRESH_RESULT_REUSE_MS = 10_000;
export const REFRESH_STATE_CAPACITY = 256;
/**
 * How many logins and how many browser instances are remembered for response
 * ordering (see RefreshSingleFlight). An entry is an id and two numbers.
 */
export const SESSION_ORDERING_CAPACITY = 1024;
/**
 * Ordering state is forgotten once no session could still depend on it:
 * `loginAt` is fixed, so every cookie of a login is rejected after 12 hours.
 */
export const SESSION_ORDERING_RETENTION_MS = ADMIN_SESSION_POLICY.absoluteLifetimeSeconds * 1000;
/**
 * Allowed clock difference between this host and Keycloak when checking an ID
 * token's `exp` and `iat`. A token issued further in the future is rejected.
 */
export const ID_TOKEN_CLOCK_TOLERANCE_SECONDS = 30;

const ID_TOKEN_ALGORITHMS = [
  'RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA',
];

export type KeycloakUnavailableReason = 'timeout' | 'network' | 'http-error' | 'protocol' | 'busy' | 'not-configured';

export type KeycloakRevalidationResult =
  | {
      status: 'ok';
      /** The rotated refresh token Keycloak issued in exchange for the old one. */
      refreshToken: string;
      idToken: string;
      /** Replaces the cached groups; never merged with them. */
      groups: string[];
      /** Epoch seconds. */
      validatedAt: number;
      refreshExpiresAt?: number;
    }
  /** Keycloak explicitly refused the grant: the session must end. */
  | { status: 'revoked' }
  /** Keycloak could not be reached or its answer could not be trusted. */
  | { status: 'unavailable'; reason: KeycloakUnavailableReason };

export interface KeycloakRevalidationInput {
  refreshToken: string;
  keycloakSub: string;
  /** Where this refresh token sits in its login; recorded when it is rotated. */
  lineage?: SessionLineage;
}

export type KeycloakRevalidator = (input: KeycloakRevalidationInput) => Promise<KeycloakRevalidationResult>;

/** Revalidation state kept in the encrypted Auth.js JWT. */
export interface KeycloakSessionState extends KeycloakRevalidationInput {
  lastValidatedAt: number;
  refreshExpiresAt?: number;
  lineage: SessionLineage;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The ordering claims of a session token: which browser instance and login it
 * belongs to and how many times that login's refresh token has been rotated.
 */
export function readSessionLineage(token: Record<string, unknown>): SessionLineage | null {
  const browserInstanceId = nonEmptyString(token.browserInstanceId);
  const loginId = nonEmptyString(token.loginId);
  const refreshGeneration = token.refreshGeneration;
  if (!browserInstanceId || !loginId) return null;
  if (typeof refreshGeneration !== 'number' || !Number.isSafeInteger(refreshGeneration) || refreshGeneration < 0) return null;
  return { browserInstanceId, loginId, refreshGeneration };
}

/**
 * Returns null for sessions issued before revalidation and response ordering
 * existed (or otherwise incomplete): they cannot be revalidated or ordered, so
 * they must sign in again.
 */
export function readKeycloakSessionState(token: Record<string, unknown>): KeycloakSessionState | null {
  const refreshToken = nonEmptyString(token.refreshToken);
  const keycloakSub = nonEmptyString(token.keycloakSub);
  const lastValidatedAt = positiveNumber(token.lastValidatedAt);
  const lineage = readSessionLineage(token);
  if (!refreshToken || !keycloakSub || lastValidatedAt === null || !lineage) return null;
  return { refreshToken, keycloakSub, lastValidatedAt, refreshExpiresAt: positiveNumber(token.refreshExpiresAt) ?? undefined, lineage };
}

/**
 * Process-local coordination of refreshes. Requests carrying the same refresh
 * state share one Keycloak call, and a successful result stays reusable for
 * REFRESH_RESULT_REUSE_MS. Entries are keyed by a SHA-256 digest, never the raw
 * token; both maps are capped and in-flight entries are removed on completion.
 *
 * It also keeps what is needed to order responses (see sessionCookiesToCommit
 * in session.ts), none of which is ever used to accept a request:
 *
 * - per login, the highest refresh generation known to exist. The generation
 *   number travels in the session token; a token whose generation is lower has
 *   a refresh token that was already redeemed.
 * - per browser instance, the login that is current there. A sign-in replaces
 *   it and a sign-out retires it, so a response of an earlier login can be
 *   told apart from the browser's present session.
 *
 * Both are capped, least recently written first out, and dropped after the
 * 12-hour session limit. A login or browser that is not remembered is treated
 * as current, which is the behaviour without this record.
 *
 * This assumes a single Node.js instance. A second instance would not see this
 * state and would redeem an already-rotated refresh token.
 */
export class RefreshSingleFlight {
  private readonly inFlight = new Map<string, Promise<KeycloakRevalidationResult>>();
  private readonly settled = new Map<string, { result: KeycloakRevalidationResult; expiresAt: number }>();
  /** loginId → highest refresh generation issued. Oldest write first. */
  private readonly logins = new Map<string, { latestGeneration: number; writtenAt: number }>();
  /** browserInstanceId → its current login (null after sign-out). */
  private readonly browsers = new Map<string, { loginId: string | null; writtenAt: number }>();

  constructor(
    private readonly reuseMs = REFRESH_RESULT_REUSE_MS,
    private readonly capacity = REFRESH_STATE_CAPACITY,
    private readonly orderingCapacity = SESSION_ORDERING_CAPACITY,
    private readonly orderingRetentionMs = SESSION_ORDERING_RETENTION_MS,
  ) {}

  run(
    key: string,
    now: () => number,
    refresh: () => Promise<KeycloakRevalidationResult>,
  ): Promise<KeycloakRevalidationResult> {
    const reusable = this.settled.get(key);
    if (reusable) {
      if (now() < reusable.expiresAt) return Promise.resolve(reusable.result);
      this.settled.delete(key);
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    if (this.inFlight.size >= this.capacity) {
      return Promise.resolve({ status: 'unavailable', reason: 'busy' });
    }
    const started = refresh()
      .then((result) => {
        // Only trusted successes are reusable; failures are always retried.
        if (result.status === 'ok') this.remember(key, result, now());
        return result;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, started);
    return started;
  }

  private remember(key: string, result: KeycloakRevalidationResult, nowMs: number): void {
    for (const [existing, entry] of this.settled) {
      if (nowMs >= entry.expiresAt) this.settled.delete(existing);
    }
    while (this.settled.size >= this.capacity) {
      this.settled.delete(this.settled.keys().next().value as string);
    }
    this.settled.set(key, { result, expiresAt: nowMs + this.reuseMs });
  }

  private write<V extends { writtenAt: number }>(map: Map<string, V>, key: string, value: V): void {
    for (const [existing, entry] of map) {
      if (value.writtenAt - entry.writtenAt >= this.orderingRetentionMs) map.delete(existing);
    }
    map.delete(key);
    map.set(key, value);
    while (map.size > Math.max(this.orderingCapacity, 1)) map.delete(map.keys().next().value as string);
  }

  /**
   * Records that the refresh token of `redeemed` was exchanged for the next
   * generation of the same login. Called only for a successful, verified
   * rotation, so a failed refresh leaves nothing behind.
   */
  recordRotation(redeemed: SessionLineage, nowMs: number): void {
    const latestGeneration = Math.max(this.logins.get(redeemed.loginId)?.latestGeneration ?? 0, redeemed.refreshGeneration + 1);
    this.write(this.logins, redeemed.loginId, { latestGeneration, writtenAt: nowMs });
  }

  /**
   * True when a newer refresh generation of the same login is known, i.e. this
   * one's refresh token has already been redeemed. Does not depend on the
   * clock; an unknown login is not superseded.
   */
  isSuperseded({ loginId, refreshGeneration }: SessionLineage): boolean {
    const login = this.logins.get(loginId);
    return login !== undefined && refreshGeneration < login.latestGeneration;
  }

  /** A sign-in: `loginId` becomes the current login of that browser instance. */
  beginLogin(browserInstanceId: string, loginId: string, nowMs: number): void {
    this.write(this.browsers, browserInstanceId, { loginId, writtenAt: nowMs });
  }

  /**
   * A sign-out: the browser instance has no current login until the next
   * sign-in. Ignored when the browser has already moved on to another login.
   */
  endLogin(browserInstanceId: string, loginId: string, nowMs: number): void {
    const browser = this.browsers.get(browserInstanceId);
    if (browser && browser.loginId !== loginId) return;
    this.write(this.browsers, browserInstanceId, { loginId: null, writtenAt: nowMs });
  }

  /**
   * False when the browser instance is known to have signed out of this login
   * or to have signed in again since. An unknown browser counts as current.
   */
  isCurrentLogin({ browserInstanceId, loginId }: SessionLineage): boolean {
    const browser = this.browsers.get(browserInstanceId);
    return browser === undefined || browser.loginId === loginId;
  }

  /** Entries currently held, for tests and diagnostics. */
  get size(): { inFlight: number; settled: number } {
    return { inFlight: this.inFlight.size, settled: this.settled.size };
  }

  /** Remembered ordering entries, for tests and diagnostics. */
  get ordering(): { logins: number; browsers: number } {
    return { logins: this.logins.size, browsers: this.browsers.size };
  }
}

const SHARED_SINGLE_FLIGHT = Symbol.for('auraplex.admin.keycloakRefreshSingleFlight');

/**
 * One instance per process. Proxy and the route handlers can be bundled
 * separately, so module scope alone would not be shared between them.
 */
export function sharedRefreshSingleFlight(): RefreshSingleFlight {
  const holder = globalThis as { [SHARED_SINGLE_FLIGHT]?: RefreshSingleFlight };
  return (holder[SHARED_SINGLE_FLIGHT] ??= new RefreshSingleFlight());
}

function refreshStateKey({ keycloakSub, refreshToken }: KeycloakRevalidationInput): string {
  return createHash('sha256').update(keycloakSub).update('\0').update(refreshToken).digest('base64url');
}

class Unavailable extends Error {
  constructor(readonly reason: KeycloakUnavailableReason) {
    super(reason);
  }
}

interface ProviderMetadata {
  tokenEndpoint: string;
  jwksUri: string;
  keys: ReturnType<typeof createLocalJWKSet>;
  expiresAt: number;
}

export interface KeycloakRevalidatorOptions {
  config: KeycloakConfig;
  fetcher?: typeof fetch;
  now?: () => number;
  production?: boolean;
  singleFlight?: RefreshSingleFlight;
}

export function createKeycloakRevalidator({
  config,
  fetcher = fetch,
  now = Date.now,
  production = process.env.NODE_ENV === 'production',
  singleFlight = sharedRefreshSingleFlight(),
}: KeycloakRevalidatorOptions): KeycloakRevalidator {
  let metadata: ProviderMetadata | null = null;

  async function request(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    try {
      return await fetcher(url, { ...init, cache: 'no-store', redirect: 'error', signal });
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      throw new Unavailable(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
    }
  }

  async function json(response: Response): Promise<Record<string, unknown>> {
    try {
      const body: unknown = await response.json();
      if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
    } catch {
      // Falls through: an unreadable body is a protocol failure.
    }
    throw new Unavailable('protocol');
  }

  /** Endpoints must be advertised by, and live under, the configured issuer. */
  function issuerEndpoint(value: unknown): string {
    const issuer = new URL(config.issuer);
    let endpoint: URL;
    try {
      endpoint = new URL(nonEmptyString(value) ?? '');
    } catch {
      throw new Unavailable('protocol');
    }
    const insideIssuer = endpoint.origin === issuer.origin &&
      endpoint.pathname.startsWith(`${issuer.pathname.replace(/\/$/, '')}/`);
    if (!insideIssuer || (production && endpoint.protocol !== 'https:')) throw new Unavailable('protocol');
    return endpoint.toString();
  }

  async function fetchJson(url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await request(url, { headers: { accept: 'application/json' } }, signal);
    if (!response.ok) throw new Unavailable('http-error');
    return json(response);
  }

  async function loadMetadata(signal: AbortSignal): Promise<ProviderMetadata> {
    if (metadata && now() < metadata.expiresAt) return metadata;
    const discovery = await fetchJson(`${config.issuer}/.well-known/openid-configuration`, signal);
    if (discovery.issuer !== config.issuer) throw new Unavailable('protocol');
    const tokenEndpoint = issuerEndpoint(discovery.token_endpoint);
    const jwksUri = issuerEndpoint(discovery.jwks_uri);
    const jwks = await fetchJson(jwksUri, signal);
    if (!Array.isArray(jwks.keys)) throw new Unavailable('protocol');
    metadata = {
      tokenEndpoint,
      jwksUri,
      keys: createLocalJWKSet(jwks as unknown as JSONWebKeySet),
      expiresAt: now() + PROVIDER_METADATA_TTL_MS,
    };
    return metadata;
  }

  async function verifyIdToken(idToken: string, keycloakSub: string, signal: AbortSignal) {
    const verify = async () => {
      const { keys } = await loadMetadata(signal);
      const { payload } = await jwtVerify(idToken, keys, {
        issuer: config.issuer,
        audience: config.clientId,
        subject: keycloakSub,
        algorithms: ID_TOKEN_ALGORITHMS,
        requiredClaims: ['exp', 'iat'],
        currentDate: new Date(now()),
        clockTolerance: ID_TOKEN_CLOCK_TOLERANCE_SECONDS,
      });
      // jose only requires `iat` to be present; a token issued in the future
      // (beyond clock tolerance) is not a fresh answer to this request.
      if (typeof payload.iat !== 'number' || payload.iat > now() / 1000 + ID_TOKEN_CLOCK_TOLERANCE_SECONDS) {
        throw new Unavailable('protocol');
      }
      // OIDC Core 3.1.3.7: with several audiences `azp` must be present, and
      // whenever it is present it must be this client.
      const severalAudiences = Array.isArray(payload.aud) && payload.aud.length > 1;
      if (severalAudiences ? payload.azp !== config.clientId : payload.azp !== undefined && payload.azp !== config.clientId) {
        throw new Unavailable('protocol');
      }
      return payload;
    };
    try {
      return await verify();
    } catch (error) {
      if (!(error instanceof joseErrors.JWKSNoMatchingKey)) throw error;
      // Keycloak may have rotated its signing key since the JWKS was cached.
      metadata = null;
      return verify();
    }
  }

  async function refresh({ refreshToken, keycloakSub }: KeycloakRevalidationInput): Promise<KeycloakRevalidationResult> {
    const signal = AbortSignal.timeout(KEYCLOAK_REVALIDATION_TIMEOUT_MS);
    try {
      const { tokenEndpoint } = await loadMetadata(signal);
      const credentials = Buffer.from(
        `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`,
      ).toString('base64');
      const response = await request(tokenEndpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Basic ${credentials}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
      }, signal);

      if (!response.ok) {
        if (response.status >= 500) return { status: 'unavailable', reason: 'http-error' };
        // Keycloak answers invalid_grant for a revoked, expired or reused
        // refresh token, an ended SSO session and a disabled user. Any other
        // rejection (e.g. invalid_client) is a deployment fault, not the user's.
        const body = await json(response).catch(() => null);
        return body?.error === 'invalid_grant'
          ? { status: 'revoked' }
          : { status: 'unavailable', reason: 'http-error' };
      }

      const body = await json(response);
      const idToken = nonEmptyString(body.id_token);
      // Keycloak rotates the refresh token on use, so the one just presented is
      // spent. A success without a replacement cannot be revalidated again and
      // is not accepted; the spent token is never kept.
      const rotatedRefreshToken = nonEmptyString(body.refresh_token);
      if (!idToken || !rotatedRefreshToken || rotatedRefreshToken === refreshToken) throw new Unavailable('protocol');
      const claims = await verifyIdToken(idToken, keycloakSub, signal);
      const validatedAt = Math.floor(now() / 1000);
      const refreshExpiresIn = positiveNumber(body.refresh_expires_in);
      return {
        status: 'ok',
        refreshToken: rotatedRefreshToken,
        idToken,
        groups: extractKeycloakGroups(claims),
        validatedAt,
        refreshExpiresAt: refreshExpiresIn === null ? undefined : validatedAt + Math.floor(refreshExpiresIn),
      };
    } catch (error) {
      // Signature, issuer, audience, subject or expiry failures land here too:
      // an untrusted answer never yields groups.
      return { status: 'unavailable', reason: error instanceof Unavailable ? error.reason : 'protocol' };
    }
  }

  return (input) => singleFlight.run(refreshStateKey(input), now, async () => {
    const result = await refresh(input);
    // Recorded before any request can see the result, so the redeemed
    // generation is known to be superseded from the moment it is.
    if (result.status === 'ok' && input.lineage) singleFlight.recordRotation(input.lineage, now());
    return result;
  });
}

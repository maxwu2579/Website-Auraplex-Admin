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
}

export type KeycloakRevalidator = (input: KeycloakRevalidationInput) => Promise<KeycloakRevalidationResult>;

/** Revalidation state kept in the encrypted Auth.js JWT. */
export interface KeycloakSessionState extends KeycloakRevalidationInput {
  lastValidatedAt: number;
  refreshExpiresAt?: number;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Returns null for sessions issued before revalidation existed (or otherwise
 * incomplete): they cannot be revalidated, so they must sign in again.
 */
export function readKeycloakSessionState(token: Record<string, unknown>): KeycloakSessionState | null {
  const refreshToken = nonEmptyString(token.refreshToken);
  const keycloakSub = nonEmptyString(token.keycloakSub);
  const lastValidatedAt = positiveNumber(token.lastValidatedAt);
  if (!refreshToken || !keycloakSub || lastValidatedAt === null) return null;
  return { refreshToken, keycloakSub, lastValidatedAt, refreshExpiresAt: positiveNumber(token.refreshExpiresAt) ?? undefined };
}

/**
 * Process-local coordination of refreshes. Requests carrying the same refresh
 * state share one Keycloak call, and a successful result stays reusable for
 * REFRESH_RESULT_REUSE_MS. Entries are keyed by a SHA-256 digest, never the raw
 * token; both maps are capped and in-flight entries are removed on completion.
 *
 * This assumes a single Node.js instance. A second instance would not see this
 * state and would redeem an already-rotated refresh token.
 */
export class RefreshSingleFlight {
  private readonly inFlight = new Map<string, Promise<KeycloakRevalidationResult>>();
  private readonly settled = new Map<string, { result: KeycloakRevalidationResult; expiresAt: number }>();

  constructor(
    private readonly reuseMs = REFRESH_RESULT_REUSE_MS,
    private readonly capacity = REFRESH_STATE_CAPACITY,
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

  /** Entries currently held, for tests and diagnostics. */
  get size(): { inFlight: number; settled: number } {
    return { inFlight: this.inFlight.size, settled: this.settled.size };
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

  return (input) => singleFlight.run(refreshStateKey(input), now, () => refresh(input));
}

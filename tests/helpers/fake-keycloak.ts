import { SignJWT, exportJWK, generateKeyPair, type JWTPayload } from 'jose';

/**
 * In-process Keycloak stand-in for session tests: OIDC discovery, JWKS and a
 * refresh-token endpoint that rotates the refresh token on every use. It is
 * reached only through an injected fetch; nothing here opens a socket.
 */
export interface FakeKeycloakConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export type FakeKeycloakMode =
  | 'ok' | 'timeout' | 'network' | 'http-5xx' | 'not-json' | 'no-id-token' | 'no-refresh-token' | 'same-refresh-token';

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

async function signingKey(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  return { privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' } };
}

export async function createFakeKeycloak(config: FakeKeycloakConfig) {
  let key = await signingKey('test-key-1');
  const users = new Map<string, { groups: string[]; enabled: boolean }>();
  /** Live refresh tokens. A redeemed token is removed, as with rotation. */
  const grants = new Map<string, string>();
  let serial = 0;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fake = {
    mode: 'ok' as FakeKeycloakMode,
    calls: { discovery: 0, jwks: 0, token: 0 },
    /** Refresh tokens presented to the token endpoint, in order. */
    presented: [] as string[],
    /** Runs while the token request is "on the network". */
    duringTokenRequest: null as null | (() => void | Promise<void>),
    /** Alters the ID-token claims before signing. */
    tamper: null as null | ((claims: JWTPayload) => JWTPayload),
    /** Signs the ID token with a key that is not in the JWKS. */
    forgeSignature: false,

    /** Registers (or updates) a user and returns a live refresh token. */
    grant(sub: string, groups: string[]): string {
      users.set(sub, { groups, enabled: true });
      const refreshToken = `refresh-${sub}-${++serial}`;
      grants.set(refreshToken, sub);
      return refreshToken;
    },
    setGroups(sub: string, groups: string[]) {
      users.get(sub)!.groups = groups;
    },
    disable(sub: string) {
      users.get(sub)!.enabled = false;
    },
    /** Ends one Keycloak session: its refresh token is no longer accepted. */
    revoke(refreshToken: string) {
      grants.delete(refreshToken);
    },
    async rotateSigningKey() {
      key = await signingKey(`test-key-${++serial}`);
    },

    fetcher(now: () => number): typeof fetch {
      return async (input, init) => {
        const url = String(input);
        if (url === `${config.issuer}/.well-known/openid-configuration`) {
          fake.calls.discovery += 1;
          return json({
            issuer: config.issuer,
            token_endpoint: `${config.issuer}/protocol/openid-connect/token`,
            jwks_uri: `${config.issuer}/protocol/openid-connect/certs`,
          });
        }
        if (url === `${config.issuer}/protocol/openid-connect/certs`) {
          fake.calls.jwks += 1;
          return json({ keys: [key.jwk] });
        }
        if (url !== `${config.issuer}/protocol/openid-connect/token`) throw new Error(`Unexpected request: ${url}`);

        fake.calls.token += 1;
        const headers = new Headers(init?.headers);
        const expected = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
        if (init?.method !== 'POST' || headers.get('authorization') !== expected) {
          return json({ error: 'invalid_client' }, 401);
        }
        const form = new URLSearchParams(String(init.body));
        const presented = form.get('refresh_token') ?? '';
        fake.presented.push(presented);

        if (fake.mode === 'network') throw new TypeError('fetch failed');
        if (fake.mode === 'timeout') throw new DOMException('The operation timed out', 'TimeoutError');
        if (fake.mode === 'http-5xx') return json({ error: 'server_error' }, 503);

        const sub = grants.get(presented);
        const user = sub ? users.get(sub) : undefined;
        if (form.get('grant_type') !== 'refresh_token' || !sub || !user?.enabled) {
          return json({ error: 'invalid_grant', error_description: 'Token is not active' }, 400);
        }
        grants.delete(presented);
        const refreshToken = `refresh-${sub}-${++serial}`;
        grants.set(refreshToken, sub);

        await fake.duringTokenRequest?.();
        if (fake.mode === 'not-json') return new Response('<html>gateway</html>', { status: 200 });

        const iat = Math.floor(now() / 1000);
        const claims: JWTPayload = {
          iss: config.issuer,
          aud: config.clientId,
          azp: config.clientId,
          sub,
          iat,
          exp: iat + 300,
          groups: [...user.groups],
        };
        const signer: SigningKey = fake.forgeSignature ? (await signingKey(key.jwk.kid)).privateKey : key.privateKey;
        const idToken = await new SignJWT(fake.tamper ? fake.tamper(claims) : claims)
          .setProtectedHeader({ alg: 'ES256', kid: key.jwk.kid })
          .sign(signer);
        return json({
          token_type: 'Bearer',
          access_token: `access-${serial}`,
          expires_in: 300,
          ...(fake.mode === 'no-refresh-token' ? {} : { refresh_token: fake.mode === 'same-refresh-token' ? presented : refreshToken }),
          refresh_expires_in: 1800,
          ...(fake.mode === 'no-id-token' ? {} : { id_token: idToken }),
        });
      };
    },
  };
  return fake;
}

export type FakeKeycloak = Awaited<ReturnType<typeof createFakeKeycloak>>;

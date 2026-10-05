export function authSessionCookieName(production: boolean): string {
  return `${production ? '__Host-' : ''}authjs.session-token`;
}

export function authCookieConfig(production: boolean) {
  const prefix = production ? '__Secure-' : '';
  const options = {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure: production,
  };
  const transient = { ...options, maxAge: 15 * 60 };
  return {
    sessionToken: { name: authSessionCookieName(production), options },
    csrfToken: { name: `${production ? '__Host-' : ''}authjs.csrf-token`, options },
    callbackUrl: { name: `${prefix}authjs.callback-url`, options },
    pkceCodeVerifier: { name: `${prefix}authjs.pkce.code_verifier`, options: transient },
    state: { name: `${prefix}authjs.state`, options: transient },
    nonce: { name: `${prefix}authjs.nonce`, options: transient },
  };
}

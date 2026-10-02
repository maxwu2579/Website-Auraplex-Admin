import assert from 'node:assert/strict';
import { decode } from 'next-auth/jwt';

/**
 * A browser's cookie jar for the Auth.js session cookie. Every response is
 * applied in the order it is received: a re-issued session cookie replaces the
 * stored one, a removal deletes it, and a response without a session cookie
 * leaves it alone.
 */
export function createBrowserJar(cookieName: string, secret: string) {
  /** The re-issued session cookie as a request Cookie header, if one was set. */
  const nextCookie = (setCookies: string[]): string | null => {
    const value = setCookies.find((cookie) => cookie.startsWith(`${cookieName}=`) && !/Max-Age=0/i.test(cookie));
    return value ? value.split(';', 1)[0] : null;
  };
  const clearsSession = (setCookies: string[]) =>
    setCookies.some((cookie) => cookie.startsWith(`${cookieName}=;`) && /Max-Age=0/i.test(cookie));

  function browserWith(initial: string | null) {
    let cookie: string | null = initial;
    return {
      get cookie() {
        assert.ok(cookie, 'the browser holds a session cookie');
        return cookie;
      },
      get signedIn() { return cookie !== null; },
      /** The cookie left by a completed sign-in (or null after a sign-out). */
      set(next: string | null) { cookie = next; },
      receive(response: Response) {
        const setCookies = response.headers.getSetCookie();
        if (clearsSession(setCookies)) cookie = null;
        else cookie = nextCookie(setCookies) ?? cookie;
        return response;
      },
      token: async () => (cookie ? decode({ secret, salt: cookieName, token: cookie.slice(cookieName.length + 1) }) : null),
    };
  }

  return { browserWith, nextCookie, clearsSession };
}

// Next.js request APIs (headers(), cookies(), redirect()) need its Node
// environment set up before any of its modules load, so this import is first.
import 'next/dist/server/node-environment-baseline';
import assert from 'node:assert/strict';
import test from 'node:test';
import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import { getURLFromRedirectError } from 'next/dist/client/components/redirect';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { workAsyncStorage } from 'next/dist/server/app-render/work-async-storage.external';
import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external';
import { createRequestStoreForAPI } from 'next/dist/server/async-storage/request-store';
import { createWorkStore } from 'next/dist/server/async-storage/work-store';

import { createAdminAuthConfig } from '../lib/admin/server/auth-config';
import { authSessionCookieName } from '../lib/admin/server/auth-cookies';
import { browserInstanceCookieName } from '../lib/admin/server/browser-instance';
import { sharedRefreshSingleFlight } from '../lib/admin/server/keycloak-revalidation';
import { createAdminSessionLoader, identityFromLoadedSession, isSessionCookie } from '../lib/admin/server/session';
import { runInAdminAuthScope, type SessionLineage } from '../lib/admin/server/session-context';
import { createBrowserJar } from './helpers/browser-jar';

// The logout server action (app/admin/upload/actions.ts) is run for real: its
// own getToken, Keycloak logout discovery, next-auth signOut() and redirect().
// It uses the application's Auth.js instance and the process-wide coordinator,
// so the configuration is set before those modules are imported below.
const TEST_ENV = {
  AUTH_SECRET: 'test-only-auth-secret-0123456789abcdef',
  AUTH_URL: 'http://admin.example.test',
  KEYCLOAK_ISSUER: 'https://sso.example.test/realms/auraplex',
  KEYCLOAK_CLIENT_ID: 'website-test',
  KEYCLOAK_CLIENT_SECRET: 'test-only',
};
Object.assign(process.env, TEST_ENV);

const COOKIE = authSessionCookieName(false);
const KC_SUB = 'keycloak-user-1';
const DISCOVERY_URL = `${TEST_ENV.KEYCLOAK_ISSUER}/.well-known/openid-configuration`;
const END_SESSION_ENDPOINT = `${TEST_ENV.KEYCLOAK_ISSUER}/protocol/openid-connect/logout`;

// Keycloak is not contacted: the only outbound request the action makes is
// OIDC discovery for the logout endpoint, answered here.
const keycloak = { available: true, requests: [] as string[] };
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  keycloak.requests.push(url);
  if (url !== DISCOVERY_URL) throw new Error(`Unexpected request: ${url}`);
  if (!keycloak.available) throw new TypeError('fetch failed');
  return Response.json({ issuer: TEST_ENV.KEYCLOAK_ISSUER, end_session_endpoint: END_SESSION_ENDPOINT });
}) as typeof fetch;

const { browserWith, clearsSession } = createBrowserJar(COOKIE, TEST_ENV.AUTH_SECRET);
const coordinator = sharedRefreshSingleFlight();
// Same configuration and coordinator as the application's own Auth.js instance.
const config = createAdminAuthConfig();
let loginSerial = 0;

/** A completed Keycloak sign-in from the given browser, through the app's `jwt` callback. */
async function signIn(browserInstanceId: string) {
  const serial = ++loginSerial;
  const idToken = `test-id-token-${serial}`;
  const token = await runInAdminAuthScope({ browserInstanceId }, async () => config.callbacks!.jwt!({
    token: { sub: `app-user-${serial}`, email: 'user@example.test' },
    user: { id: `app-user-${serial}` },
    account: { provider: 'keycloak', type: 'oidc', providerAccountId: KC_SUB, id_token: idToken, refresh_token: `test-refresh-${serial}` },
    profile: { sub: KC_SUB, groups: ['auraplex-uploader'] },
  } as never));
  assert.ok(token);
  const jwt = await encode({ secret: TEST_ENV.AUTH_SECRET, salt: COOKIE, token });
  const lineage: SessionLineage = {
    browserInstanceId: token.browserInstanceId as string,
    loginId: token.loginId as string,
    refreshGeneration: token.refreshGeneration as number,
  };
  return { header: `${COOKIE}=${jwt}`, idToken, lineage };
}

/**
 * Submits the logout form: runs the server action inside a Next.js request
 * scope whose request carries `cookieHeader`. Returns where the action
 * redirected to and the response it would send (the cookies it changed).
 */
async function submitLogout(cookieHeader: string) {
  const { logoutFromKeycloak } = await import('../app/admin/upload/actions');
  const request = new NextRequest('http://admin.example.test/admin/upload', {
    method: 'POST',
    headers: { host: 'admin.example.test', 'x-forwarded-proto': 'http', cookie: cookieHeader },
  });
  let setCookies: string[] = [];
  const workStore = createWorkStore({
    page: '/admin/upload/page',
    renderOpts: { cacheComponents: false, supportsDynamicResponse: true, experimental: { isRoutePPREnabled: false, authInterrupts: false } },
    buildId: 'test',
    deploymentId: '',
    previouslyRevalidatedTags: [],
  } as never);
  const requestStore = createRequestStoreForAPI(
    request,
    { pathname: '/admin/upload', search: '' },
    { tags: [], expirationsByCacheKind: new Map() } as never,
    (cookies: string[]) => { setCookies = cookies; },
    undefined,
  );

  let redirectedTo: string | null = null;
  try {
    await workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(requestStore, () => logoutFromKeycloak()));
  } catch (error) {
    if (!isRedirectError(error)) throw error;
    redirectedTo = getURLFromRedirectError(error);
  }
  assert.ok(redirectedTo, 'the action always ends in a redirect');
  const response = new Response(null, { status: 303 });
  for (const cookie of setCookies) response.headers.append('set-cookie', cookie);
  return { redirectedTo, response, sessionCookies: setCookies.filter((cookie) => isSessionCookie(cookie, COOKIE)) };
}

function assertKeycloakLogoutRedirect(redirectedTo: string, idToken: string) {
  const url = new URL(redirectedTo);
  assert.equal(`${url.origin}${url.pathname}`, END_SESSION_ENDPOINT);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: TEST_ENV.KEYCLOAK_CLIENT_ID,
    id_token_hint: idToken,
    post_logout_redirect_uri: 'http://admin.example.test/',
  });
}

/** Whether the application still accepts this cookie, read through its own Auth.js instance. */
async function sessionIdentity(cookieHeader: string) {
  const { auth } = await import('../auth');
  const loaded = await createAdminSessionLoader(auth)(new Headers({ host: 'admin.example.test', cookie: cookieHeader }));
  return identityFromLoadedSession(loaded);
}

test('logout action, current login: the session is cleared, the login retired, and Keycloak logout is the redirect', async () => {
  const login = await signIn('browser-a');
  const browser = browserWith(login.header);
  assert.equal(coordinator.isCurrentLogin(login.lineage), true);
  assert.equal((await sessionIdentity(browser.cookie))?.userId, KC_SUB);

  const { redirectedTo, response, sessionCookies } = await submitLogout(browser.cookie);

  assert.ok(clearsSession(sessionCookies), 'the local session cookie is removed');
  browser.receive(response);
  assert.equal(browser.signedIn, false);
  assert.equal(coordinator.isCurrentLogin(login.lineage), false, 'the login is retired for this browser');
  assertKeycloakLogoutRedirect(redirectedTo, login.idToken);
  assert.equal(
    response.headers.getSetCookie().some((cookie) => cookie.startsWith(browserInstanceCookieName(false))),
    false,
    'the browser-instance cookie is left alone',
  );

  // Discovery unavailable: local logout still completes, with the fallback redirect.
  const second = await signIn('browser-a');
  browser.set(second.header);
  keycloak.available = false;
  try {
    const fallback = await submitLogout(browser.cookie);
    assert.equal(fallback.redirectedTo, '/');
    browser.receive(fallback.response);
    assert.equal(browser.signedIn, false);
    assert.equal(coordinator.isCurrentLogin(second.lineage), false);
  } finally {
    keycloak.available = true;
  }
});

test('logout action, delayed old login: it does not clear the newer login of the same browser', async () => {
  const oldLogin = await signIn('browser-b');
  // The same browser signs in again before the old login's logout is handled.
  const newLogin = await signIn('browser-b');
  const browser = browserWith(newLogin.header);
  assert.equal(coordinator.isCurrentLogin(oldLogin.lineage), false);
  assert.equal(coordinator.isCurrentLogin(newLogin.lineage), true);

  // The logout submitted with the old login's cookie is processed only now.
  const { redirectedTo, response, sessionCookies } = await submitLogout(oldLogin.header);

  assert.deepEqual(sessionCookies, [], 'the old action does not touch the session cookie');
  browser.receive(response);
  assert.equal(browser.signedIn, true);
  assert.equal((await browser.token())?.loginId, newLogin.lineage.loginId);
  assert.equal(coordinator.isCurrentLogin(newLogin.lineage), true, 'the newer login is not retired');
  assert.equal((await sessionIdentity(browser.cookie))?.userId, KC_SUB, 'the newer login is still accepted');
  // Unchanged: the redirect still ends the Keycloak session of the login that was submitted.
  assertKeycloakLogoutRedirect(redirectedTo, oldLogin.idToken);

  // The newer login's own logout works as usual afterwards.
  const current = await submitLogout(browser.cookie);
  assert.ok(clearsSession(current.sessionCookies));
  browser.receive(current.response);
  assert.equal(browser.signedIn, false);
  assert.equal(coordinator.isCurrentLogin(newLogin.lineage), false);
  assertKeycloakLogoutRedirect(current.redirectedTo, newLogin.idToken);

  assert.ok(keycloak.requests.every((url) => url === DISCOVERY_URL), 'only logout discovery left the process');
});

'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getToken } from 'next-auth/jwt';
import { signOut } from '@/auth';
import { ADMIN_SIGNED_OUT_PATH } from '@/lib/admin/admin-routes';
import { authSessionCookieName } from '@/lib/admin/server/auth-cookies';
import { readSessionLineage, sharedRefreshSingleFlight } from '@/lib/admin/server/keycloak-revalidation';
import { tryDiscoverKeycloakLogoutUrl } from '@/lib/admin/server/keycloak-logout';

export async function logoutFromKeycloak(): Promise<void> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('Authentication is not configured');
  const token = await getToken({
    req: { headers: await headers() },
    secret,
    cookieName: authSessionCookieName(process.env.NODE_ENV === 'production'),
  });
  const endSessionUrl = await tryDiscoverKeycloakLogoutUrl(
    typeof token?.idToken === 'string' ? token.idToken : undefined,
  );
  // A logout submitted from a login this browser has since left (signed out,
  // or signed in again) must not remove the newer session cookie. The
  // Keycloak session of the submitted login is still ended below.
  const lineage = token ? readSessionLineage(token) : null;
  if (!lineage || sharedRefreshSingleFlight().isCurrentLogin(lineage)) await signOut({ redirect: false });
  redirect(endSessionUrl ?? ADMIN_SIGNED_OUT_PATH);
}

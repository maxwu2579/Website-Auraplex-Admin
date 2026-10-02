import type { Session } from 'next-auth';
import { UploadContractError } from '@/lib/admin/upload-errors';
import { getKeycloakConfig } from '@/lib/admin/server/config';

export interface AdminIdentity {
  userId: string;
  email?: string;
  groups: string[];
}

export interface AdminRoleMapping {
  uploader: string;
  admin: string;
}

export function getAdminRoleMapping(
  env: NodeJS.ProcessEnv = process.env,
): AdminRoleMapping {
  return {
    uploader: env.KEYCLOAK_UPLOADER_ROLE?.trim() || 'auraplex-uploader',
    admin: env.KEYCLOAK_ADMIN_ROLE?.trim() || 'auraplex-admin',
  };
}

function normalizedGroup(group: string): string {
  return group.trim().toLowerCase();
}

export function canUpload(
  identity: AdminIdentity,
  mapping: AdminRoleMapping = getAdminRoleMapping(),
): boolean {
  const allowed = new Set([
    normalizedGroup(mapping.uploader),
    normalizedGroup(mapping.admin),
  ]);
  return identity.groups.some((group) => allowed.has(normalizedGroup(group)));
}

export function canViewAllUploads(
  identity: AdminIdentity,
  mapping: AdminRoleMapping = getAdminRoleMapping(),
): boolean {
  const adminGroup = normalizedGroup(mapping.admin);
  return identity.groups.some((group) => normalizedGroup(group) === adminGroup);
}

export function requireAdminPermission(
  identity: AdminIdentity | null,
  mapping: AdminRoleMapping = getAdminRoleMapping(),
): AdminIdentity {
  if (!identity) {
    throw new UploadContractError(401, 'UNAUTHENTICATED', 'Authentication is required');
  }
  if (!canViewAllUploads(identity, mapping)) {
    throw new UploadContractError(403, 'FORBIDDEN', 'Admin permission is required');
  }
  return identity;
}

export function requireUploadPermission(
  identity: AdminIdentity | null,
  mapping?: AdminRoleMapping,
): AdminIdentity {
  if (!identity) {
    throw new UploadContractError(401, 'UNAUTHENTICATED', 'Authentication is required');
  }
  if (!canUpload(identity, mapping)) {
    throw new UploadContractError(403, 'FORBIDDEN', 'Uploader or Admin permission is required');
  }
  return identity;
}

/**
 * `userId` is the verified Keycloak subject, which is the same on every login
 * and therefore the key for upload ownership, rate limits and audit events.
 * Auth.js's own `session.user.id` (token.sub) is a random id generated at each
 * sign-in; it identifies the application session only and is not used here.
 */
export function identityFromSession(session: Session | null, keycloakSub: string | undefined): AdminIdentity | null {
  if (!session?.user || !keycloakSub) return null;
  const user = session.user as Session['user'] & { groups?: string[] };
  return {
    userId: keycloakSub,
    email: user.email ?? undefined,
    groups: Array.isArray(user.groups) ? user.groups : [],
  };
}

/**
 * Session identity for the current request (admin page, CSRF route). These
 * run behind Proxy, which applied the 30-minute idle / 12-hour absolute policy
 * and the 60-second Keycloak revalidation, persisted the refreshed cookie and
 * handed over the identity it authenticated (see proxiedRequestIdentity).
 */
export async function currentRequestIdentity(): Promise<AdminIdentity | null> {
  // Fail clearly before invoking Auth.js when local/production Keycloak values
  // are absent. This avoids pretending that SSO has been verified.
  getKeycloakConfig();
  const [{ headers }, { proxiedRequestIdentity }] = await Promise.all([
    import('next/headers'),
    import('@/lib/admin/server/session'),
  ]);
  return proxiedRequestIdentity(await headers());
}

export async function authenticateAdminRequest(): Promise<AdminIdentity> {
  return requireUploadPermission(await currentRequestIdentity());
}

export function extractKeycloakGroups(profile: unknown): string[] {
  if (!profile || typeof profile !== 'object') return [];
  const value = profile as { groups?: unknown };
  const groups = Array.isArray(value.groups)
    ? value.groups.filter((item): item is string => typeof item === 'string')
    : [];
  return Array.from(new Set(groups));
}

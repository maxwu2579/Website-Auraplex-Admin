import { randomBytes, timingSafeEqual } from 'node:crypto';
import { UploadContractError } from '@/lib/admin/upload-errors';
import { UPLOAD_HEADERS } from '@/lib/admin/upload-contract';

export const ADMIN_CSRF_COOKIE = 'auraplex-admin-csrf';
export const ADMIN_CSRF_COOKIE_PATH = '/api/admin';
export const ADMIN_CSRF_MAX_AGE_SECONDS = 60 * 60;

export function adminCsrfCookieOptions(production: boolean) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: production,
    path: ADMIN_CSRF_COOKIE_PATH,
    maxAge: ADMIN_CSRF_MAX_AGE_SECONDS,
  };
}

export interface CsrfValidator {
  verify(request: Request): void | Promise<void>;
}

export function issueCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export const doubleSubmitCsrfValidator: CsrfValidator = {
  verify(request) {
    const header = request.headers.get(UPLOAD_HEADERS.csrfToken)?.trim();
    const cookie = cookieValue(request.headers.get('cookie'), ADMIN_CSRF_COOKIE);
    if (!header || !cookie || !constantTimeEqual(header, cookie)) {
      throw new UploadContractError(403, 'FORBIDDEN', 'CSRF token verification failed');
    }
  },
};

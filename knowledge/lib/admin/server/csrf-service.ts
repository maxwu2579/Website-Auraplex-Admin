import { NextResponse } from 'next/server';
import { normalizeUploadError } from '@/lib/admin/upload-errors';
import { currentRequestIdentity, requireUploadPermission, type AdminIdentity } from '@/lib/admin/server/authorization';
import { ADMIN_CSRF_COOKIE, adminCsrfCookieOptions, issueCsrfToken } from '@/lib/admin/server/csrf';

export async function getAdminCsrfResponse(
  authenticate: () => Promise<AdminIdentity | null> = currentRequestIdentity,
): Promise<Response> {
  try {
    requireUploadPermission(await authenticate());
    const csrfToken = issueCsrfToken();
    const response = NextResponse.json(
      { ok: true, csrfToken },
      { headers: { 'Cache-Control': 'no-store' } },
    );
    response.cookies.set(
      ADMIN_CSRF_COOKIE,
      csrfToken,
      adminCsrfCookieOptions(process.env.NODE_ENV === 'production'),
    );
    return response;
  } catch (error) {
    const normalized = normalizeUploadError(error);
    return NextResponse.json(normalized.body, {
      status: normalized.status,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}

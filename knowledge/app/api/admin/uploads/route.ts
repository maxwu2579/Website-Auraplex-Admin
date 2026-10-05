import { NextRequest } from 'next/server';
import { getUploads, putUpload } from '@/lib/admin/server/upload-service';
import { deleteUpload } from '@/lib/admin/server/delete-service';
import { assertAdminNodeRuntime } from '@/lib/admin/server/node-runtime';
import { withAdminRequestSession } from '@/lib/admin/server/session';

// Proxy does not run for this path (see PROXY_BYPASS_UPLOAD_PATH), so each
// handler validates the session itself with the same idle/absolute rules and
// returns Auth.js's refreshed or cleared session cookie.

export async function PUT(request: NextRequest) {
  assertAdminNodeRuntime();
  return withAdminRequestSession(request, (authenticate) => putUpload(request, { authenticate }));
}

export async function GET(request: NextRequest) {
  assertAdminNodeRuntime();
  return withAdminRequestSession(request, (authenticate) => getUploads(request, { authenticate }));
}

export async function DELETE(request: NextRequest) {
  assertAdminNodeRuntime();
  return withAdminRequestSession(request, (authenticate) => deleteUpload(request, { authenticate }));
}

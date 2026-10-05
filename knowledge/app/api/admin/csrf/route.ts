import { getAdminCsrfResponse } from '@/lib/admin/server/csrf-service';
import { assertAdminNodeRuntime } from '@/lib/admin/server/node-runtime';

export async function GET() {
  assertAdminNodeRuntime();
  return getAdminCsrfResponse();
}

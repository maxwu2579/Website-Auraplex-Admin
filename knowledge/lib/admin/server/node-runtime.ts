/**
 * Next 16 with Cache Components rejects route-level `runtime` exports. Route
 * handlers default to Node.js and Nomad runs the standalone Node server; this
 * fail-closed assertion prevents an accidental Edge deployment of admin APIs.
 */
export function assertAdminNodeRuntime(): void {
  if (process.env.NEXT_RUNTIME === 'edge' || process.release?.name !== 'node') {
    throw new Error('Admin routes require the Node.js runtime');
  }
}

// This is intentionally read on the server request path. NEXT_PUBLIC_* values
// are baked into the client bundle and must not decide the enforced limit.
export const DEFAULT_SERVER_UPLOAD_MAX_MB = 100;
export const MAX_SUPPORTED_UPLOAD_MB = 500;

export function getServerUploadMaxMb(env: Record<string, string | undefined> = process.env): number {
  const raw = env.ADMIN_UPLOAD_MAX_MB?.trim();
  if (!raw) return DEFAULT_SERVER_UPLOAD_MAX_MB;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > MAX_SUPPORTED_UPLOAD_MB) {
    throw new Error(`ADMIN_UPLOAD_MAX_MB must be an integer from 1 to ${MAX_SUPPORTED_UPLOAD_MB}`);
  }
  return value;
}

export function getServerUploadMaxBytes(env: Record<string, string | undefined> = process.env): number {
  return getServerUploadMaxMb(env) * 1024 * 1024;
}

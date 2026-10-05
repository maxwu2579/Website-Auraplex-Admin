import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

export interface UploadAuditEvent {
  user: string;
  action: 'upload.accepted' | 'upload.failed' | 'delete.accepted' | 'delete.failed' | 'delete.partial';
  key: string;
  size: number;
  ip: string;
  timestamp: string;
}

export interface AuditLogger {
  write(event: UploadAuditEvent): void;
}

export const jsonAuditLogger: AuditLogger = {
  write(event) {
    console.info(JSON.stringify({ type: 'admin_upload_audit', ...event }));
  },
};

export function requestIp(headers: Headers): string {
  // APISIX must strip any client-supplied copy of this proof header, then
  // inject the shared secret itself. Without that proof, CF headers are ignored.
  const proxySecret = process.env.ADMIN_TRUSTED_PROXY_SECRET;
  const presentedSecret = headers.get('x-auraplex-proxy-secret');
  const trustedProxy = Boolean(
    proxySecret && presentedSecret &&
    Buffer.byteLength(proxySecret) === Buffer.byteLength(presentedSecret) &&
    timingSafeEqual(Buffer.from(proxySecret), Buffer.from(presentedSecret)),
  );
  const candidates = [
    trustedProxy ? headers.get('cf-connecting-ip')?.trim() : null,
    headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
    headers.get('x-real-ip')?.trim(),
  ];
  return candidates.find((candidate) => candidate && isIP(candidate)) || 'unknown';
}

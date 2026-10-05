import { UploadContractError } from '@/lib/admin/upload-errors';

export const UPLOAD_RATE_LIMITS = {
  uploadsPerMinute: 20,
  uploadsPerHour: 200,
  bytesPerHour: 5 * 1024 * 1024 * 1024,
} as const;

type UploadEvent = { at: number; bytes: number };

export interface UploadAdmissionRequest {
  /** Declared Content-Length, when the request carried one. */
  declaredBytes?: number;
  /** Runtime per-file maximum; bounds the reservation for unknown lengths. */
  maxUploadBytes: number;
}

export interface UploadVolumeReservation {
  /** Byte volume reserved for this upload; the stream must not exceed it. */
  readonly allowanceBytes: number;
  /** Replaces the reservation with the bytes actually received. */
  settle(actualBytes: number): void;
}

export interface UploadRateLimiter {
  /**
   * Counts exactly one upload request against the request-count limits and
   * reserves byte volume. Byte volume is settled later from the actual stream,
   * so a missing Content-Length cannot bypass or zero the volume limit.
   */
  admit(userId: string, request: UploadAdmissionRequest, now?: number): UploadVolumeReservation;
}

function rateLimited(): UploadContractError {
  return new UploadContractError(429, 'RATE_LIMITED', 'Upload rate limit exceeded');
}

export class InMemoryUploadRateLimiter implements UploadRateLimiter {
  private readonly events = new Map<string, UploadEvent[]>();
  private lastSweepAt = 0;

  // Sweep inactive users on traffic rather than keeping a process-wide timer.
  private pruneExpired(now: number): void {
    if (now >= this.lastSweepAt && now - this.lastSweepAt < 60_000) return;
    const hourAgo = now - 60 * 60 * 1000;
    for (const [userId, events] of this.events) {
      const recent = events.filter((event) => event.at > hourAgo);
      if (recent.length) this.events.set(userId, recent);
      else this.events.delete(userId);
    }
    this.lastSweepAt = now;
  }

  admit(userId: string, request: UploadAdmissionRequest, now = Date.now()): UploadVolumeReservation {
    this.pruneExpired(now);
    const hourAgo = now - 60 * 60 * 1000;
    const minuteAgo = now - 60 * 1000;
    const recent = (this.events.get(userId) ?? []).filter((event) => event.at > hourAgo);
    const minuteCount = recent.filter((event) => event.at > minuteAgo).length;
    const hourBytes = recent.reduce((total, event) => total + event.bytes, 0);
    const remainingBytes = UPLOAD_RATE_LIMITS.bytesPerHour - hourBytes;

    if (
      minuteCount >= UPLOAD_RATE_LIMITS.uploadsPerMinute ||
      recent.length >= UPLOAD_RATE_LIMITS.uploadsPerHour ||
      remainingBytes <= 0 ||
      (request.declaredBytes !== undefined && request.declaredBytes > remainingBytes)
    ) {
      throw rateLimited();
    }

    // Unknown length: reserve the most this upload could legitimately use, so
    // concurrent unknown-length uploads cannot jointly overrun the hour budget.
    const allowanceBytes = request.declaredBytes ?? Math.min(request.maxUploadBytes, remainingBytes);
    const event: UploadEvent = { at: now, bytes: allowanceBytes };
    recent.push(event);
    this.events.set(userId, recent);

    let settled = false;
    return {
      allowanceBytes,
      settle(actualBytes) {
        if (settled) return;
        settled = true;
        event.bytes = Math.max(0, actualBytes);
      },
    };
  }
}

export const uploadRateLimiter = new InMemoryUploadRateLimiter();

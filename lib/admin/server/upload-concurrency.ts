/**
 * Caps how many uploads ONE Node.js process streams at the same time. It is
 * not a distributed or cluster-wide limit: each Nomad allocation / process
 * has its own counter, so N allocations allow up to N × limit uploads.
 *
 * Default 4: an unknown-length upload buffers up to (queueSize + 1) × 8 MiB =
 * 24 MiB in lib-storage plus stream/SDK buffers. Measured locally (Node 24,
 * 100 MiB bodies, local S3 sink): 4 concurrent unknown-length uploads added
 * ~145 MiB RSS (~36 MiB each) and 8 added ~260 MiB; 4 known-length uploads
 * added ~10 MiB. Four therefore keeps upload overhead near 150 MiB, leaving
 * most of the 1 GiB Nomad task memory for the Next.js server itself, and
 * bounds connections to 4 inbound plus at most 8 concurrent part uploads.
 */
export const DEFAULT_MAX_CONCURRENT_UPLOADS = 4;
export const MAX_SUPPORTED_CONCURRENT_UPLOADS = 16;

export function getMaxConcurrentUploads(env: Record<string, string | undefined> = process.env): number {
  const raw = env.ADMIN_UPLOAD_MAX_CONCURRENT?.trim();
  if (!raw) return DEFAULT_MAX_CONCURRENT_UPLOADS;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > MAX_SUPPORTED_CONCURRENT_UPLOADS) {
    throw new Error(`ADMIN_UPLOAD_MAX_CONCURRENT must be an integer from 1 to ${MAX_SUPPORTED_CONCURRENT_UPLOADS}`);
  }
  return value;
}

export interface UploadSlot {
  /** Idempotent; always call from `finally`. */
  release(): void;
}

export class UploadConcurrencyGuard {
  private active = 0;

  constructor(private readonly limit: () => number = getMaxConcurrentUploads) {}

  get inUse(): number {
    return this.active;
  }

  /** Non-blocking: returns null when the process is already at capacity. */
  tryAcquire(): UploadSlot | null {
    if (this.active >= this.limit()) return null;
    this.active += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
      },
    };
  }
}

export const uploadConcurrencyGuard = new UploadConcurrencyGuard();

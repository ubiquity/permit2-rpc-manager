export type CapabilityStatus = "supported" | "unsupported" | "unknown";

interface CapabilityRecord {
  status: CapabilityStatus;
  updatedAt: number;
  expiresAt?: number;
  reason?: string;
  strikeCount: number;
  windowStartAt: number;
}

export interface RpcMethodCapabilitiesOptions {
  now?: () => number;
  strikeWindowMs?: number;
  maxTtlMs?: number;
  maxEntries?: number;
}

export class RpcMethodCapabilities {
  private records = new Map<string, CapabilityRecord>();
  private readonly now: () => number;
  private readonly strikeWindowMs: number;
  private readonly maxTtlMs: number;
  private readonly maxEntries: number;

  constructor(options: RpcMethodCapabilitiesOptions = {}) {
    this.now = options.now ?? Date.now;
    this.strikeWindowMs = options.strikeWindowMs ?? 30 * 60_000;
    this.maxTtlMs = options.maxTtlMs ?? 6 * 60 * 60_000;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  get(chainId: number, rpcUrl: string, method: string): CapabilityStatus {
    const key = this.makeKey(chainId, rpcUrl, method);
    const record = this.records.get(key);
    if (!record) return "unknown";

    if (record.expiresAt !== undefined && record.expiresAt <= this.now()) {
      this.records.delete(key);
      return "unknown";
    }

    return record.status;
  }

  markUnsupported(
    chainId: number,
    rpcUrl: string,
    method: string,
    reason: string,
    ttlMs: number,
  ): void {
    const now = this.now();
    const key = this.makeKey(chainId, rpcUrl, method);
    const existing = this.records.get(key);

    let strikeCount = 1;
    let windowStartAt = now;
    if (existing?.status === "unsupported") {
      if (now - existing.windowStartAt <= this.strikeWindowMs) {
        strikeCount = existing.strikeCount + 1;
        windowStartAt = existing.windowStartAt;
      }
    }

    const multiplier = Math.min(2 ** (strikeCount - 1), 32);
    const effectiveTtlMs = Math.min(ttlMs * multiplier, this.maxTtlMs);

    this.records.set(key, {
      status: "unsupported",
      updatedAt: now,
      expiresAt: now + effectiveTtlMs,
      reason,
      strikeCount,
      windowStartAt,
    });

    this.evictIfNeeded();
  }

  markSupported(chainId: number, rpcUrl: string, method: string): void {
    const key = this.makeKey(chainId, rpcUrl, method);
    this.records.delete(key);
  }

  filterSupported(chainId: number, method: string, rpcUrls: string[]): string[] {
    return rpcUrls.filter((rpcUrl) => this.get(chainId, rpcUrl, method) !== "unsupported");
  }

  private makeKey(chainId: number, rpcUrl: string, method: string): string {
    return JSON.stringify([chainId, rpcUrl, method]);
  }

  private evictIfNeeded(): void {
    const excess = this.records.size - this.maxEntries;
    if (excess <= 0) return;

    const entries = [...this.records.entries()];
    entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt);

    for (let i = 0; i < excess; i++) {
      const key = entries[i]?.[0];
      if (key) this.records.delete(key);
    }
  }
}

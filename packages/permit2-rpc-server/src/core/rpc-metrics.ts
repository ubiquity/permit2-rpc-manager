import type { MethodStats, RpcMetricsProvider } from "./rpc-scoring-v2.ts";

export type RpcMetricKey = { chainId: number; rpcUrl: string; method: string };

export interface RpcMetricsRegistryOptions {
  maxLatencySamples?: number;
  maxHeadLagSamples?: number;
  maxMethodEntries?: number;
  now?: () => number;
}

interface MethodMetrics {
  requestsTotal: number;
  successes: number;
  errors: number;
  throttles: number;
  misbehaviors: number;
  latencySamples: RingBuffer<number>;
  updatedAt: number;
}

interface HeadLagMetrics {
  lagSamples: RingBuffer<number>;
  updatedAt: number;
}

class RingBuffer<T> {
  private values: T[] = [];
  private nextIndex = 0;

  constructor(private readonly capacity: number) {}

  push(value: T): void {
    if (this.capacity <= 0) return;

    if (this.values.length < this.capacity) {
      this.values.push(value);
      return;
    }

    this.values[this.nextIndex] = value;
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
  }

  toArray(): T[] {
    return [...this.values];
  }

  get size(): number {
    return this.values.length;
  }
}

function quantile(sortedAscending: number[], q: number): number | undefined {
  if (sortedAscending.length === 0) return undefined;
  const clampedQ = Math.max(0, Math.min(1, q));
  const idx = Math.max(0, Math.min(Math.ceil(clampedQ * sortedAscending.length) - 1, sortedAscending.length - 1));
  return sortedAscending[idx];
}

function median(sortedAscending: number[]): number | undefined {
  if (sortedAscending.length === 0) return undefined;
  const mid = Math.floor(sortedAscending.length / 2);
  if (sortedAscending.length % 2 === 0) {
    return (sortedAscending[mid - 1] + sortedAscending[mid]) / 2;
  }
  return sortedAscending[mid];
}

function methodKey({ chainId, rpcUrl, method }: RpcMetricKey): string {
  return JSON.stringify([chainId, rpcUrl, method]);
}

function headKey(chainId: number, rpcUrl: string): string {
  return JSON.stringify([chainId, rpcUrl]);
}

function isThrottleReason(reason: string | undefined): boolean {
  const normalized = reason?.trim().toLowerCase();
  return normalized === "rate_limit" || normalized === "limit_exceeded";
}

export class RpcMetricsRegistry implements RpcMetricsProvider {
  private readonly maxLatencySamples: number;
  private readonly maxHeadLagSamples: number;
  private readonly maxMethodEntries: number;
  private readonly now: () => number;

  private readonly methodMetrics = new Map<string, MethodMetrics>();
  private readonly headLagMetrics = new Map<string, HeadLagMetrics>();

  constructor(options: RpcMetricsRegistryOptions = {}) {
    this.maxLatencySamples = options.maxLatencySamples ?? 200;
    this.maxHeadLagSamples = options.maxHeadLagSamples ?? 50;
    this.maxMethodEntries = options.maxMethodEntries ?? 20_000;
    this.now = options.now ?? Date.now;
  }

  recordSuccess(key: RpcMetricKey, latencyMs: number): void {
    const record = this.getOrCreateMethodMetrics(key);
    record.requestsTotal += 1;
    record.successes += 1;
    if (Number.isFinite(latencyMs) && latencyMs >= 0) record.latencySamples.push(latencyMs);
    record.updatedAt = this.now();
    this.evictOldestIfNeeded();
  }

  recordFailure(key: RpcMetricKey, classification: { reason?: string; isProviderIssue?: boolean } | undefined): void {
    const record = this.getOrCreateMethodMetrics(key);
    record.requestsTotal += 1;

    const providerIssue = classification?.isProviderIssue ?? false;
    if (providerIssue) {
      record.errors += 1;
      if (isThrottleReason(classification?.reason)) record.throttles += 1;
    }

    record.updatedAt = this.now();
    this.evictOldestIfNeeded();
  }

  recordMisbehavior(key: RpcMetricKey): void {
    const record = this.getOrCreateMethodMetrics(key);
    record.misbehaviors += 1;
    record.updatedAt = this.now();
    this.evictOldestIfNeeded();
  }

  recordHeadLagSample(chainId: number, rpcUrl: string, headLagBlocks: number): void {
    const now = this.now();
    const key = headKey(chainId, rpcUrl);
    const existing = this.headLagMetrics.get(key);
    const record = existing ?? {
      lagSamples: new RingBuffer<number>(this.maxHeadLagSamples),
      updatedAt: now,
    };

    if (Number.isFinite(headLagBlocks) && headLagBlocks >= 0) record.lagSamples.push(headLagBlocks);
    record.updatedAt = now;
    this.headLagMetrics.set(key, record);
  }

  getMethodStats(chainId: number, method: string, rpcUrls: string[]): Map<string, MethodStats> {
    const stats = new Map<string, MethodStats>();

    for (const rpcUrl of rpcUrls) {
      const key = methodKey({ chainId, rpcUrl, method });
      const record = this.methodMetrics.get(key);

      const requestsTotal = record?.requestsTotal ?? 0;
      const errors = record?.errors ?? 0;
      const throttles = record?.throttles ?? 0;
      const misbehaviors = record?.misbehaviors ?? 0;

      const latencySamples = record?.latencySamples.toArray() ?? [];
      const sortedLatency = latencySamples.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);

      const latencyQuantiles: Record<string, number> = {};
      const p70 = quantile(sortedLatency, 0.7);
      const p95 = quantile(sortedLatency, 0.95);
      if (typeof p70 === "number") latencyQuantiles["0.7"] = p70;
      if (typeof p95 === "number") latencyQuantiles["0.95"] = p95;

      const headLagKey = headKey(chainId, rpcUrl);
      const headRecord = this.headLagMetrics.get(headLagKey);
      const headSorted = headRecord?.lagSamples
        .toArray()
        .filter((v) => Number.isFinite(v) && v >= 0)
        .sort((a, b) => a - b) ?? [];
      const headLag = median(headSorted);

      const errorRate = requestsTotal > 0 ? errors / requestsTotal : undefined;
      const throttleRate = requestsTotal > 0 ? throttles / requestsTotal : undefined;
      const misbehaviorRate = requestsTotal > 0 ? misbehaviors / requestsTotal : undefined;

      stats.set(rpcUrl, {
        requestsTotal,
        latencyQuantiles: Object.keys(latencyQuantiles).length > 0 ? latencyQuantiles : undefined,
        errorRate,
        throttleRate,
        headLag,
        misbehaviorRate,
      });
    }

    return stats;
  }

  private getOrCreateMethodMetrics(key: RpcMetricKey): MethodMetrics {
    const mapKey = methodKey(key);
    const existing = this.methodMetrics.get(mapKey);
    if (existing) return existing;

    const record: MethodMetrics = {
      requestsTotal: 0,
      successes: 0,
      errors: 0,
      throttles: 0,
      misbehaviors: 0,
      latencySamples: new RingBuffer<number>(this.maxLatencySamples),
      updatedAt: this.now(),
    };
    this.methodMetrics.set(mapKey, record);
    return record;
  }

  private evictOldestIfNeeded(): void {
    const excess = this.methodMetrics.size - this.maxMethodEntries;
    if (excess <= 0) return;

    const entries = [...this.methodMetrics.entries()];
    entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt);

    for (let i = 0; i < excess; i++) {
      const key = entries[i]?.[0];
      if (key) this.methodMetrics.delete(key);
    }
  }
}

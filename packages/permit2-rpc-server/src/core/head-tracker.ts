import type { RpcMetricsRegistry } from "./rpc-metrics.ts";

type LoggerFn = (level: "debug" | "info" | "warn" | "error", message: string, ...optionalParams: unknown[]) => void;

export interface HeadSamplingOptions {
  now?: () => number;
  sampleIntervalMs?: number;
  maxRpcsPerSample?: number;
  timeoutMs?: number;
  logger?: LoggerFn;
}

const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;
const DEFAULT_MAX_RPCS_PER_SAMPLE = 5;
const DEFAULT_TIMEOUT_MS = 2000;

function parseHexNumber(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed.startsWith("0x")) return undefined;
  const parsed = Number.parseInt(trimmed, 16);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

export class HeadTracker {
  private readonly now: () => number;
  private readonly sampleIntervalMs: number;
  private readonly maxRpcsPerSample: number;
  private readonly timeoutMs: number;
  private readonly log: LoggerFn;

  private lastSampleAtByChain = new Map<number, number>();
  private inflightByChain = new Map<number, Promise<void>>();

  constructor(
    private readonly metrics: RpcMetricsRegistry,
    options: HeadSamplingOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.maxRpcsPerSample = options.maxRpcsPerSample ?? DEFAULT_MAX_RPCS_PER_SAMPLE;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options.logger ?? (() => {});
  }

  maybeSampleHeads(chainId: number, rpcUrls: string[]): Promise<void> {
    if (rpcUrls.length === 0) return Promise.resolve();

    const now = this.now();
    const lastSampleAt = this.lastSampleAtByChain.get(chainId) ?? 0;
    if (now - lastSampleAt < this.sampleIntervalMs) return Promise.resolve();

    const inflight = this.inflightByChain.get(chainId);
    if (inflight) return inflight;

    const promise = this.sampleHeads(chainId, rpcUrls).finally(() => {
      this.inflightByChain.delete(chainId);
    });

    this.inflightByChain.set(chainId, promise);
    return promise;
  }

  private async sampleHeads(chainId: number, rpcUrls: string[]): Promise<void> {
    this.lastSampleAtByChain.set(chainId, this.now());
    const urls = rpcUrls.slice(0, Math.max(1, this.maxRpcsPerSample));

    const results = await Promise.allSettled(urls.map((url) => this.fetchBlockNumber(url)));
    const headsByUrl = new Map<string, number>();

    results.forEach((result, idx) => {
      const url = urls[idx];
      if (!url) return;
      if (result.status === "fulfilled") {
        headsByUrl.set(url, result.value);
      }
    });

    if (headsByUrl.size === 0) return;

    const medianHead = median([...headsByUrl.values()]);
    if (medianHead === undefined || !Number.isFinite(medianHead)) return;

    for (const [url, head] of headsByUrl.entries()) {
      const lag = Math.max(0, Math.round(medianHead - head));
      this.metrics.recordHeadLagSample(chainId, url, lag);
    }
  }

  private async fetchBlockNumber(rpcUrl: string): Promise<number> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort("timeout"), this.timeoutMs);
    const requestBody = {
      jsonrpc: "2.0",
      method: "eth_blockNumber",
      params: [],
      id: `head-tracker-${this.now()}`,
    };

    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const json = (await response.json()) as { result?: unknown; error?: { code?: number; message?: string } };
      if (json?.error) {
        throw new Error(`RPC error ${json.error.code ?? "unknown"}: ${json.error.message ?? "unknown"}`);
      }

      const head = parseHexNumber(json?.result);
      if (head === undefined) {
        throw new Error(`Invalid eth_blockNumber result: ${JSON.stringify(json?.result)}`);
      }

      return head;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.log("debug", `HeadTracker sample failed for ${rpcUrl}: ${err.message}`);
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

import { RpcMetricsRegistry } from "./rpc-metrics.ts";

export interface ConsensusConfig {
  enabled: boolean;
  methods: string[];
  participants: number;
  agreementThreshold: number;
  preferNonEmpty: boolean;
}

export interface ConsensusOptions {
  enabled?: boolean;
  methods?: string[];
  participants?: number;
  agreementThreshold?: number;
  preferNonEmpty?: boolean;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);

  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }

  if (type === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(String(value));
}

function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "0x") return false;
    return trimmed.length > 0;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

export class ConsensusExecutor {
  constructor(private readonly metrics: RpcMetricsRegistry) {}

  async execute<T>(
    chainId: number,
    method: string,
    candidates: string[],
    requestFn: (rpcUrl: string) => Promise<T>,
    config: ConsensusConfig,
  ): Promise<T> {
    const participantCount = Math.min(Math.max(1, config.participants), candidates.length);
    const quorum = Math.min(Math.max(1, config.agreementThreshold), participantCount);
    const selected = candidates.slice(0, participantCount);

    const results = await Promise.allSettled(
      selected.map(async (rpcUrl) => ({ rpcUrl, value: await requestFn(rpcUrl) })),
    );

    const successes: Array<{ rpcUrl: string; value: T; key: string }> = [];
    let lastError: unknown;

    for (const res of results) {
      if (res.status === "fulfilled") {
        const key = stableStringify(res.value.value);
        successes.push({ rpcUrl: res.value.rpcUrl, value: res.value.value, key });
      } else {
        lastError = res.reason;
      }
    }

    if (successes.length === 0) {
      throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError ?? "Consensus: all participants failed"));
    }

    const buckets = new Map<string, Array<{ rpcUrl: string; value: T }>>();
    for (const entry of successes) {
      const arr = buckets.get(entry.key) ?? [];
      arr.push({ rpcUrl: entry.rpcUrl, value: entry.value });
      buckets.set(entry.key, arr);
    }

    let winnerKey: string | undefined;
    let winnerCount = 0;
    for (const [key, arr] of buckets.entries()) {
      if (arr.length > winnerCount) {
        winnerCount = arr.length;
        winnerKey = key;
      }
    }

    if (!winnerKey) {
      return successes[0].value;
    }

    const winnerBucket = buckets.get(winnerKey) ?? [];

    if (winnerBucket.length < quorum) {
      if (config.preferNonEmpty) {
        const nonEmpty = successes.find((s) => isNonEmpty(s.value));
        if (nonEmpty) return nonEmpty.value;
      }
      return winnerBucket[0]?.value ?? successes[0].value;
    }

    const winner = winnerBucket[0]?.value ?? successes[0].value;

    for (const entry of successes) {
      if (entry.key === winnerKey) continue;
      this.metrics.recordMisbehavior({ chainId, rpcUrl: entry.rpcUrl, method });
    }

    return winner;
  }
}

export interface ScoringConfig {
  latencyQuantile: number;
  minSamplesForConfidence: number;
  emaPrevWeight: number;

  wLatency: number;
  wError: number;
  wThrottle: number;
  wHeadLag: number;
  wMisbehavior: number;

  logNormalizeLatency: boolean;
  logNormalizeHeadLag: boolean;
}

export interface MethodStats {
  requestsTotal: number;

  /**
   * Optional quantiles keyed by numeric-string, e.g. { "0.7": 120 } (ms).
   */
  latencyQuantiles?: Record<string, number>;

  errorRate?: number; // 0..1
  throttleRate?: number; // 0..1
  headLag?: number; // blocks behind peer median (>=0 preferred)
  misbehaviorRate?: number; // 0..1
}

export interface RpcMetricsProvider {
  getMethodStats(chainId: number, method: string, rpcUrls: string[]): Map<string, MethodStats>;
}

export interface RpcScoreComponents {
  confidence: number;

  effectiveLatencyMs: number;
  effectiveErrorRate: number;
  effectiveThrottleRate: number;
  effectiveHeadLag: number;
  effectiveMisbehaviorRate: number;

  normalizedLatency: number;
  normalizedError: number;
  normalizedThrottle: number;
  normalizedHeadLag: number;
  normalizedMisbehavior: number;
}

export interface RpcScoreDetails {
  instant: number;
  smoothed: number;
  components: RpcScoreComponents;
}

const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  latencyQuantile: 0.7,
  minSamplesForConfidence: 50,
  emaPrevWeight: 0.7,

  wLatency: 1.0,
  wError: 1.0,
  wThrottle: 1.0,
  wHeadLag: 0.0,
  wMisbehavior: 0.0,

  logNormalizeLatency: true,
  logNormalizeHeadLag: true,
};

const DEFAULT_BASELINE_LATENCY_MS = 1000;

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampNonNegative(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function medianPositive(values: number[]): number | undefined {
  return median(values.filter((v) => Number.isFinite(v) && v > 0));
}

function getClosestQuantileMs(latencyQuantiles: Record<string, number> | undefined, q: number): number | undefined {
  if (!latencyQuantiles) return undefined;

  const exact = latencyQuantiles[String(q)];
  if (typeof exact === "number" && Number.isFinite(exact)) return exact;

  let bestValue: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [k, v] of Object.entries(latencyQuantiles)) {
    const keyQ = Number(k);
    if (!Number.isFinite(keyQ) || !Number.isFinite(v)) continue;
    const distance = Math.abs(keyQ - q);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestValue = v;
    }
  }

  return bestValue;
}

function minMaxNormalize(values: number[]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 0 };
  }
  return { min, max };
}

function normalizeToUnit(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  if (max <= min) return 0;
  return clamp01((value - min) / (max - min));
}

function scoreKey(chainId: number, method: string, rpcUrl: string): string {
  return `${chainId}:${method}:${rpcUrl}`;
}

export class RpcScorerV2 {
  private previousScores = new Map<string, number>();
  private config: ScoringConfig;

  constructor(
    private metrics: RpcMetricsProvider,
    config: Partial<ScoringConfig> = {},
  ) {
    this.config = { ...DEFAULT_SCORING_CONFIG, ...config };
  }

  rank(chainId: number, method: string, candidates: string[]): string[] {
    return this.rankWithDetails(chainId, method, candidates).ranked;
  }

  rankWithDetails(
    chainId: number,
    method: string,
    candidates: string[],
  ): {
    ranked: string[];
    details: Map<string, RpcScoreDetails>;
  } {
    const rpcUrls = [...candidates];
    if (rpcUrls.length <= 1) {
      const details = new Map<string, RpcScoreDetails>();
      if (rpcUrls.length === 1) {
        details.set(rpcUrls[0], {
          instant: 1,
          smoothed: 1,
          components: {
            confidence: 0,
            effectiveLatencyMs: 0,
            effectiveErrorRate: 0,
            effectiveThrottleRate: 0,
            effectiveHeadLag: 0,
            effectiveMisbehaviorRate: 0,
            normalizedLatency: 0,
            normalizedError: 0,
            normalizedThrottle: 0,
            normalizedHeadLag: 0,
            normalizedMisbehavior: 0,
          },
        });
      }
      return { ranked: rpcUrls, details };
    }

    const statsByRpc = this.metrics.getMethodStats(chainId, method, rpcUrls);

    const rawLatencyQByRpc = new Map<string, number>();
    const rawErrorByRpc = new Map<string, number>();
    const rawThrottleByRpc = new Map<string, number>();
    const rawHeadLagByRpc = new Map<string, number>();
    const rawMisbehaviorByRpc = new Map<string, number>();
    const requestsByRpc = new Map<string, number>();

    for (const rpcUrl of rpcUrls) {
      const stats = statsByRpc.get(rpcUrl);
      const requestsTotal = stats?.requestsTotal ?? 0;
      requestsByRpc.set(rpcUrl, clampNonNegative(requestsTotal));

      const latencyQ = getClosestQuantileMs(stats?.latencyQuantiles, this.config.latencyQuantile);
      if (typeof latencyQ === "number" && Number.isFinite(latencyQ) && latencyQ > 0) {
        rawLatencyQByRpc.set(rpcUrl, latencyQ);
      }

      if (typeof stats?.errorRate === "number") rawErrorByRpc.set(rpcUrl, clamp01(stats.errorRate));
      if (typeof stats?.throttleRate === "number") rawThrottleByRpc.set(rpcUrl, clamp01(stats.throttleRate));
      if (typeof stats?.headLag === "number") rawHeadLagByRpc.set(rpcUrl, clampNonNegative(stats.headLag));
      if (typeof stats?.misbehaviorRate === "number") rawMisbehaviorByRpc.set(rpcUrl, clamp01(stats.misbehaviorRate));
    }

    const baselineLatency = medianPositive([...rawLatencyQByRpc.values()]) ?? DEFAULT_BASELINE_LATENCY_MS;
    const baselineError = median([...rawErrorByRpc.values()]) ?? 0;
    const baselineThrottle = median([...rawThrottleByRpc.values()]) ?? 0;
    const baselineHeadLag = median([...rawHeadLagByRpc.values()]) ?? 0;
    const baselineMisbehavior = median([...rawMisbehaviorByRpc.values()]) ?? 0;

    const effectiveLatency = new Map<string, number>();
    const effectiveError = new Map<string, number>();
    const effectiveThrottle = new Map<string, number>();
    const effectiveHeadLag = new Map<string, number>();
    const effectiveMisbehavior = new Map<string, number>();
    const confidenceByRpc = new Map<string, number>();

    for (const rpcUrl of rpcUrls) {
      const requestsTotal = requestsByRpc.get(rpcUrl) ?? 0;
      const confidence = this.config.minSamplesForConfidence <= 0
        ? 1
        : clamp01(requestsTotal / this.config.minSamplesForConfidence);
      confidenceByRpc.set(rpcUrl, confidence);

      const latency = rawLatencyQByRpc.get(rpcUrl) ?? baselineLatency;
      const error = rawErrorByRpc.get(rpcUrl) ?? baselineError;
      const throttle = rawThrottleByRpc.get(rpcUrl) ?? baselineThrottle;
      const headLag = rawHeadLagByRpc.get(rpcUrl) ?? baselineHeadLag;
      const misbehavior = rawMisbehaviorByRpc.get(rpcUrl) ?? baselineMisbehavior;

      effectiveLatency.set(rpcUrl, confidence * latency + (1 - confidence) * baselineLatency);
      effectiveError.set(rpcUrl, confidence * error + (1 - confidence) * baselineError);
      effectiveThrottle.set(rpcUrl, confidence * throttle + (1 - confidence) * baselineThrottle);
      effectiveHeadLag.set(rpcUrl, confidence * headLag + (1 - confidence) * baselineHeadLag);
      effectiveMisbehavior.set(rpcUrl, confidence * misbehavior + (1 - confidence) * baselineMisbehavior);
    }

    const latencyValues = rpcUrls.map((rpcUrl) => {
      const v = effectiveLatency.get(rpcUrl) ?? baselineLatency;
      return this.config.logNormalizeLatency ? Math.log1p(clampNonNegative(v)) : clampNonNegative(v);
    });
    const errorValues = rpcUrls.map((rpcUrl) => clamp01(effectiveError.get(rpcUrl) ?? baselineError));
    const throttleValues = rpcUrls.map((rpcUrl) => clamp01(effectiveThrottle.get(rpcUrl) ?? baselineThrottle));
    const headLagValues = rpcUrls.map((rpcUrl) => {
      const v = effectiveHeadLag.get(rpcUrl) ?? baselineHeadLag;
      return this.config.logNormalizeHeadLag ? Math.log1p(clampNonNegative(v)) : clampNonNegative(v);
    });
    const misbehaviorValues = rpcUrls.map((rpcUrl) => clamp01(effectiveMisbehavior.get(rpcUrl) ?? baselineMisbehavior));

    const { min: minLatency, max: maxLatency } = minMaxNormalize(latencyValues);
    const { min: minError, max: maxError } = minMaxNormalize(errorValues);
    const { min: minThrottle, max: maxThrottle } = minMaxNormalize(throttleValues);
    const { min: minHeadLag, max: maxHeadLag } = minMaxNormalize(headLagValues);
    const { min: minMisbehavior, max: maxMisbehavior } = minMaxNormalize(misbehaviorValues);

    const details = new Map<string, RpcScoreDetails>();

    for (let i = 0; i < rpcUrls.length; i++) {
      const rpcUrl = rpcUrls[i];

      const effLatency = effectiveLatency.get(rpcUrl) ?? baselineLatency;
      const effError = effectiveError.get(rpcUrl) ?? baselineError;
      const effThrottle = effectiveThrottle.get(rpcUrl) ?? baselineThrottle;
      const effHeadLag = effectiveHeadLag.get(rpcUrl) ?? baselineHeadLag;
      const effMisbehavior = effectiveMisbehavior.get(rpcUrl) ?? baselineMisbehavior;

      const latencyNormInput = this.config.logNormalizeLatency ? Math.log1p(clampNonNegative(effLatency)) : effLatency;
      const headLagNormInput = this.config.logNormalizeHeadLag ? Math.log1p(clampNonNegative(effHeadLag)) : effHeadLag;

      const normalizedLatency = normalizeToUnit(latencyNormInput, minLatency, maxLatency);
      const normalizedError = normalizeToUnit(clamp01(effError), minError, maxError);
      const normalizedThrottle = normalizeToUnit(clamp01(effThrottle), minThrottle, maxThrottle);
      const normalizedHeadLag = normalizeToUnit(headLagNormInput, minHeadLag, maxHeadLag);
      const normalizedMisbehavior = normalizeToUnit(clamp01(effMisbehavior), minMisbehavior, maxMisbehavior);

      let instant = 1.0;
      instant -= this.config.wLatency * normalizedLatency;
      instant -= this.config.wError * normalizedError;
      instant -= this.config.wThrottle * normalizedThrottle;
      instant -= this.config.wHeadLag * normalizedHeadLag;
      instant -= this.config.wMisbehavior * normalizedMisbehavior;

      const prev = this.previousScores.get(scoreKey(chainId, method, rpcUrl));
      const smoothed = typeof prev === "number"
        ? this.config.emaPrevWeight * prev + (1 - this.config.emaPrevWeight) * instant
        : instant;

      this.previousScores.set(scoreKey(chainId, method, rpcUrl), smoothed);

      details.set(rpcUrl, {
        instant,
        smoothed,
        components: {
          confidence: confidenceByRpc.get(rpcUrl) ?? 0,
          effectiveLatencyMs: effLatency,
          effectiveErrorRate: clamp01(effError),
          effectiveThrottleRate: clamp01(effThrottle),
          effectiveHeadLag: clampNonNegative(effHeadLag),
          effectiveMisbehaviorRate: clamp01(effMisbehavior),
          normalizedLatency,
          normalizedError,
          normalizedThrottle,
          normalizedHeadLag,
          normalizedMisbehavior,
        },
      });
    }

    const ranked = rpcUrls
      .map((rpcUrl, index) => ({ rpcUrl, index, score: details.get(rpcUrl)?.smoothed ?? 0 }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.index - b.index;
      })
      .map(({ rpcUrl }) => rpcUrl);

    return { ranked, details };
  }
}

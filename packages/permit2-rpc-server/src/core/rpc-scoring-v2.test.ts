import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import type { MethodStats, RpcMetricsProvider } from "./rpc-scoring-v2.ts";
import { RpcScorerV2 } from "./rpc-scoring-v2.ts";

class FakeMetricsProvider implements RpcMetricsProvider {
  private stats = new Map<string, MethodStats>();

  set(chainId: number, method: string, rpcUrl: string, stats: MethodStats): void {
    this.stats.set(`${chainId}:${method}:${rpcUrl}`, stats);
  }

  getMethodStats(chainId: number, method: string, rpcUrls: string[]): Map<string, MethodStats> {
    const result = new Map<string, MethodStats>();
    for (const rpcUrl of rpcUrls) {
      result.set(rpcUrl, this.stats.get(`${chainId}:${method}:${rpcUrl}`) ?? { requestsTotal: 0 });
    }
    return result;
  }
}

Deno.test("RpcScorerV2: confidence weighting pulls low-sample stats toward peer baseline", () => {
  const metrics = new FakeMetricsProvider();
  const chainId = 1;
  const method = "eth_call";

  const a = "https://rpc-a.example";
  const b = "https://rpc-b.example";
  const c = "https://rpc-c.example";

  metrics.set(chainId, method, a, { requestsTotal: 1, latencyQuantiles: { "0.7": 1 } });
  metrics.set(chainId, method, b, { requestsTotal: 100, latencyQuantiles: { "0.7": 200 } });
  metrics.set(chainId, method, c, { requestsTotal: 100, latencyQuantiles: { "0.7": 210 } });

  const scorer = new RpcScorerV2(metrics, {
    latencyQuantile: 0.7,
    minSamplesForConfidence: 100,
    emaPrevWeight: 0,
    wLatency: 1,
    wError: 0,
    wThrottle: 0,
    wHeadLag: 0,
    wMisbehavior: 0,
    logNormalizeLatency: false,
  });

  const { details } = scorer.rankWithDetails(chainId, method, [a, b, c]);

  const aDetails = details.get(a);
  const bDetails = details.get(b);
  const cDetails = details.get(c);

  assertEquals(aDetails?.components.confidence, 0.01);
  assertEquals(bDetails?.components.confidence, 1);
  assertEquals(cDetails?.components.confidence, 1);

  // Baseline median of [1,200,210] is 200; low-sample A should be pulled close to 200.
  assertAlmostEquals(aDetails?.components.effectiveLatencyMs ?? 0, 198.01, 0.2);
  assertAlmostEquals(bDetails?.components.effectiveLatencyMs ?? 0, 200, 0.001);
  assertAlmostEquals(cDetails?.components.effectiveLatencyMs ?? 0, 210, 0.001);
});

Deno.test("RpcScorerV2: EMA smoothing prevents rapid rank flapping", () => {
  const metrics = new FakeMetricsProvider();
  const chainId = 1;
  const method = "eth_call";

  const a = "https://rpc-a.example";
  const b = "https://rpc-b.example";

  const scorer = new RpcScorerV2(metrics, {
    latencyQuantile: 0.7,
    minSamplesForConfidence: 1,
    emaPrevWeight: 0.9,
    wLatency: 1,
    wError: 0,
    wThrottle: 0,
    wHeadLag: 0,
    wMisbehavior: 0,
    logNormalizeLatency: false,
  });

  // Initial: A is faster.
  metrics.set(chainId, method, a, { requestsTotal: 100, latencyQuantiles: { "0.7": 100 } });
  metrics.set(chainId, method, b, { requestsTotal: 100, latencyQuantiles: { "0.7": 110 } });

  assertEquals(scorer.rank(chainId, method, [a, b]), [a, b]);

  // Swap instantly: B becomes faster.
  metrics.set(chainId, method, a, { requestsTotal: 100, latencyQuantiles: { "0.7": 110 } });
  metrics.set(chainId, method, b, { requestsTotal: 100, latencyQuantiles: { "0.7": 100 } });

  // First update should still prefer A due to EMA.
  let ranked = scorer.rank(chainId, method, [a, b]);
  assertEquals(ranked, [a, b]);

  // After ~7 updates, EMA crosses and B should win.
  for (let i = 0; i < 6; i++) {
    ranked = scorer.rank(chainId, method, [a, b]);
  }
  assertEquals(ranked, [b, a]);
});

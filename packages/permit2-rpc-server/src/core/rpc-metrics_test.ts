import { assertEquals } from "jsr:@std/assert@1";
import { RpcMetricsRegistry } from "./rpc-metrics.ts";

Deno.test("RpcMetricsRegistry: records successes and computes latency quantiles from bounded samples", () => {
  const metrics = new RpcMetricsRegistry({ maxLatencySamples: 200 });

  const chainId = 1;
  const rpcUrl = "https://a.example";
  const method = "eth_call";

  for (let i = 1; i <= 300; i++) {
    metrics.recordSuccess({ chainId, rpcUrl, method }, i);
  }

  const stats = metrics.getMethodStats(chainId, method, [rpcUrl]).get(rpcUrl);
  assertEquals(stats?.requestsTotal, 300);
  assertEquals(stats?.latencyQuantiles?.["0.7"], 240);
  assertEquals(stats?.latencyQuantiles?.["0.95"], 290);
});

Deno.test("RpcMetricsRegistry: records provider failures and separates throttle rate", () => {
  const metrics = new RpcMetricsRegistry();
  const chainId = 1;
  const rpcUrl = "https://a.example";
  const method = "eth_getLogs";

  metrics.recordFailure({ chainId, rpcUrl, method }, { reason: "network_error", isProviderIssue: true });
  metrics.recordFailure({ chainId, rpcUrl, method }, { reason: "limit_exceeded", isProviderIssue: true });
  metrics.recordFailure({ chainId, rpcUrl, method }, { reason: "invalid_params", isProviderIssue: false });

  const stats = metrics.getMethodStats(chainId, method, [rpcUrl]).get(rpcUrl);
  assertEquals(stats?.requestsTotal, 3);
  assertEquals(stats?.errorRate, 2 / 3);
  assertEquals(stats?.throttleRate, 1 / 3);
});

Deno.test("RpcMetricsRegistry: records head lag samples per upstream", () => {
  const metrics = new RpcMetricsRegistry({ maxHeadLagSamples: 10 });
  const chainId = 1;
  const method = "eth_call";
  const a = "https://a.example";
  const b = "https://b.example";

  metrics.recordHeadLagSample(chainId, a, 0);
  metrics.recordHeadLagSample(chainId, a, 2);
  metrics.recordHeadLagSample(chainId, b, 5);

  const stats = metrics.getMethodStats(chainId, method, [a, b]);
  assertEquals(stats.get(a)?.headLag, 1);
  assertEquals(stats.get(b)?.headLag, 5);
});

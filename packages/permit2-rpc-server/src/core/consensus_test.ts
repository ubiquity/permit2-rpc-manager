import { assertEquals } from "jsr:@std/assert@1";
import { ConsensusExecutor } from "./consensus.ts";
import { RpcMetricsRegistry } from "./rpc-metrics.ts";

Deno.test("ConsensusExecutor: returns majority value and records misbehavior for outliers", async () => {
  const metrics = new RpcMetricsRegistry();
  const consensus = new ConsensusExecutor(metrics);

  const chainId = 1;
  const method = "eth_call";
  const candidates = ["https://a.example", "https://b.example", "https://c.example"];

  const requestFn = (rpcUrl: string) => {
    metrics.recordSuccess({ chainId, rpcUrl, method }, 1);
    if (rpcUrl.endsWith("a.example")) return Promise.resolve({ ok: true, n: 1 });
    if (rpcUrl.endsWith("b.example")) return Promise.resolve({ ok: true, n: 1 });
    return Promise.resolve({ ok: true, n: 2 });
  };

  const result = await consensus.execute(chainId, method, candidates, requestFn, {
    enabled: true,
    methods: [method],
    participants: 3,
    agreementThreshold: 2,
    preferNonEmpty: false,
  });

  assertEquals(result, { ok: true, n: 1 });

  const stats = metrics.getMethodStats(chainId, method, candidates);
  assertEquals(stats.get("https://c.example")?.misbehaviorRate, 1);
  assertEquals(stats.get("https://a.example")?.misbehaviorRate, 0);
});

Deno.test("ConsensusExecutor: preferNonEmpty picks non-empty result when no quorum", async () => {
  const metrics = new RpcMetricsRegistry();
  const consensus = new ConsensusExecutor(metrics);

  const chainId = 1;
  const method = "eth_getCode";
  const candidates = ["https://a.example", "https://b.example"];

  const requestFn = (rpcUrl: string) => {
    if (rpcUrl.endsWith("a.example")) return Promise.resolve("0x");
    return Promise.resolve("0x1234");
  };

  const result = await consensus.execute(chainId, method, candidates, requestFn, {
    enabled: true,
    methods: [method],
    participants: 2,
    agreementThreshold: 2,
    preferNonEmpty: true,
  });

  assertEquals(result, "0x1234");
});

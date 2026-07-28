import { assertEquals } from "jsr:@std/assert@1";
import { CacheManager } from "../infra/cache-manager.ts";
import type { LatencyTestResult } from "../infra/latency-tester.ts";
import { getRpcEndpointId } from "./rpc-endpoint-id.ts";
import { RpcSelector } from "./rpc-selector.ts";

class MemoryCacheManager extends CacheManager {
  private store = new Map<number, { fastestRpc: string | null; latencyMap: Record<string, LatencyTestResult> }>();

  constructor() {
    super({ disableCache: true });
  }

  override getFastestRpc(chainId: number): Promise<string | null> {
    return Promise.resolve(this.store.get(chainId)?.fastestRpc ?? null);
  }

  override getLatencyMap(chainId: number): Promise<Record<string, LatencyTestResult> | null> {
    return Promise.resolve(this.store.get(chainId)?.latencyMap ?? null);
  }

  override updateChainCache(
    chainId: number,
    latencyMap: Record<string, LatencyTestResult>,
    fastestRpc: string | null,
  ): Promise<void> {
    this.store.set(chainId, { fastestRpc, latencyMap });
    return Promise.resolve();
  }
}

Deno.test("RpcSelector: excludes wrong_chain_id endpoints", async () => {
  const chainId = 1;
  const wrongRpc = "https://wrong.example/rpc";
  const okRpc = "https://ok.example/rpc";

  const dataSource = {
    getRpcUrls: (_chainId: number) => [wrongRpc, okRpc],
  };

  const cacheManager = new CacheManager({ disableCache: true });

  const latencyTester = {
    testRpcUrls: (_chainId: number, urls: string[]): Promise<Record<string, LatencyTestResult>> => {
      const map: Record<string, LatencyTestResult> = {};
      for (const url of urls) {
        if (url === wrongRpc) {
          map[url] = {
            url,
            latency: 5,
            status: "wrong_chain_id",
            observedChainId: 2,
            error: "Chain ID mismatch: expected 1, got 2",
          };
        } else {
          map[url] = { url, latency: 10, status: "ok" };
        }
      }
      return Promise.resolve(map);
    },
  };

  const selector = new RpcSelector(dataSource, cacheManager, latencyTester);
  const ranked = await selector.getRankedRpcList(chainId);

  assertEquals(ranked, [okRpc]);
});

Deno.test("RpcSelector: ignores cached fastest RPC not in data source", async () => {
  const chainId = 1;
  const staleRpc = "wss://stale.example/ws";
  const okRpc = "wss://ok.example/ws";

  const dataSource = {
    getRpcUrls: (_chainId: number) => [okRpc],
  };

  const cacheManager = new MemoryCacheManager();
  await cacheManager.updateChainCache(chainId, { [staleRpc]: { url: staleRpc, latency: 1, status: "ok" } }, staleRpc);

  const latencyTester = {
    testRpcUrls: (_chainId: number, urls: string[]): Promise<Record<string, LatencyTestResult>> => {
      const map: Record<string, LatencyTestResult> = {};
      for (const url of urls) {
        map[url] = { url, latency: 10, status: "ok" };
      }
      return Promise.resolve(map);
    },
  };

  const selector = new RpcSelector(dataSource, cacheManager, latencyTester);
  const ranked = await selector.getRankedRpcList(chainId);

  assertEquals(ranked, [okRpc]);
});

Deno.test("RpcSelector: skips deferred diagnostics while retaining cached recovery candidates", async () => {
  const chainId = 1;
  const deferredRpc = "https://deferred.example/rpc";
  const healthyRpc = "https://healthy.example/rpc";
  const dataSource = { getRpcUrls: () => [deferredRpc, healthyRpc] };
  const cacheManager = new MemoryCacheManager();
  const testedUrls: string[][] = [];

  await cacheManager.updateChainCache(
    chainId,
    {
      [deferredRpc]: { url: deferredRpc, latency: 1, status: "ok" },
      [healthyRpc]: { url: healthyRpc, latency: 20, status: "ok" },
    },
    null,
  );

  const latencyTester = {
    testRpcUrls: (_chainId: number, urls: string[]): Promise<Record<string, LatencyTestResult>> => {
      testedUrls.push(urls);
      return Promise.resolve({ [healthyRpc]: { url: healthyRpc, latency: 10, status: "ok" } });
    },
  };

  const selector = new RpcSelector(
    dataSource,
    cacheManager,
    latencyTester,
    undefined,
    (url) => url !== deferredRpc,
  );
  const ranked = await selector.getRankedRpcList(chainId);

  assertEquals(testedUrls, [[healthyRpc]]);
  assertEquals(ranked, [deferredRpc, healthyRpc]);
  const retainedMap = await cacheManager.getLatencyMap(chainId);
  assertEquals(retainedMap?.[deferredRpc], { url: deferredRpc, latency: 1, status: "ok" });
});

Deno.test("RpcSelector: excludes backed-off, half-open, and active-probe diagnostics while retaining cached candidates", async () => {
  const chainId = 1;
  const backedOffRpc = "https://backed-off.example/rpc";
  const halfOpenRpc = "https://half-open.example/rpc";
  const activeProbeRpc = "https://active-probe.example/rpc";
  const healthyRpc = "https://healthy.example/rpc";
  const dataSource = { getRpcUrls: () => [backedOffRpc, halfOpenRpc, activeProbeRpc, healthyRpc] };
  const cacheManager = new MemoryCacheManager();
  const testedUrls: string[][] = [];

  await cacheManager.updateChainCache(
    chainId,
    {
      [backedOffRpc]: { url: backedOffRpc, latency: 1, status: "ok" },
      [halfOpenRpc]: { url: halfOpenRpc, latency: 2, status: "ok" },
      [activeProbeRpc]: { url: activeProbeRpc, latency: 3, status: "ok" },
      [healthyRpc]: { url: healthyRpc, latency: 20, status: "ok" },
    },
    null,
  );

  const latencyTester = {
    testRpcUrls: (_chainId: number, urls: string[]): Promise<Record<string, LatencyTestResult>> => {
      testedUrls.push(urls);
      return Promise.resolve({ [healthyRpc]: { url: healthyRpc, latency: 10, status: "ok" } });
    },
  };

  const selector = new RpcSelector(
    dataSource,
    cacheManager,
    latencyTester,
    undefined,
    (url) => url === healthyRpc,
  );
  const ranked = await selector.getRankedRpcList(chainId);

  assertEquals(testedUrls, [[healthyRpc]]);
  assertEquals(ranked, [backedOffRpc, halfOpenRpc, activeProbeRpc, healthyRpc]);
  const retainedMap = await cacheManager.getLatencyMap(chainId);
  assertEquals(retainedMap?.[backedOffRpc], { url: backedOffRpc, latency: 1, status: "ok" });
  assertEquals(retainedMap?.[halfOpenRpc], { url: halfOpenRpc, latency: 2, status: "ok" });
  assertEquals(retainedMap?.[activeProbeRpc], { url: activeProbeRpc, latency: 3, status: "ok" });
});

Deno.test("RpcSelector: redacts RPC URLs from selector diagnostics", async () => {
  const chainId = 1;
  const rpcUrl = "https://user:super-secret@rpc.example/rpc?apiKey=very-secret";
  const diagnostics: unknown[][] = [];
  const dataSource = { getRpcUrls: () => [rpcUrl] };
  const cacheManager = new CacheManager({ disableCache: true });
  const latencyTester = {
    testRpcUrls: (): Promise<Record<string, LatencyTestResult>> =>
      Promise.resolve({ [rpcUrl]: { url: rpcUrl, latency: 10, status: "ok" } }),
  };

  const selector = new RpcSelector(dataSource, cacheManager, latencyTester, (...args) => diagnostics.push(args));
  await selector.getRankedRpcList(chainId);

  const logged = JSON.stringify(diagnostics);
  assertEquals(logged.includes(rpcUrl), false);
  assertEquals(logged.includes("super-secret"), false);
  assertEquals(logged.includes(getRpcEndpointId(rpcUrl)), true);
});

Deno.test("RpcSelector: redacts URLs in latency-test errors", async () => {
  const chainId = 1;
  const rpcUrl = "https://user:super-secret@rpc.example/rpc?apiKey=very-secret";
  const diagnostics: unknown[][] = [];
  const dataSource = { getRpcUrls: () => [rpcUrl] };
  const cacheManager = new CacheManager({ disableCache: true });
  const latencyTester = {
    testRpcUrls: (): Promise<Record<string, LatencyTestResult>> =>
      Promise.reject(new Error(`Latency probe failed for ${rpcUrl}`)),
  };

  const selector = new RpcSelector(dataSource, cacheManager, latencyTester, (...args) => diagnostics.push(args));
  await selector.getRankedRpcList(chainId);

  const logged = JSON.stringify(diagnostics);
  assertEquals(logged.includes(rpcUrl), false);
  assertEquals(logged.includes("super-secret"), false);
  assertEquals(logged.includes(getRpcEndpointId(rpcUrl)), true);
});

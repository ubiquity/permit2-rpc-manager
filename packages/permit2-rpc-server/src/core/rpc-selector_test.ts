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

Deno.test("RpcSelector: private diagnostics retain full status rank, eligibility and request-local lookup sharing", async () => {
  const urls = ["ok-slow", "syncing", "wrong-bytecode", "ok-fast", "wrong-chain", "network-error", "deferred-health"]
    .map((name) => `https://${name}.example/rpc`);
  const latencyMap: Record<string, LatencyTestResult> = {
    [urls[0]]: { url: urls[0], latency: 30, status: "ok" },
    [urls[1]]: { url: urls[1], latency: 1, status: "syncing" },
    [urls[2]]: { url: urls[2], latency: 2, status: "wrong_bytecode" },
    [urls[3]]: { url: urls[3], latency: 10, status: "ok" },
    [urls[4]]: { url: urls[4], latency: 0, status: "wrong_chain_id" },
    [urls[5]]: { url: urls[5], latency: Infinity, status: "network_error" },
    [urls[6]]: { url: urls[6], latency: 0, status: "ok" },
  };
  let lookups = 0;
  const selector = new RpcSelector(
    { getRpcUrls: () => urls },
    new MemoryCacheManager(),
    {
      testRpcUrls: () => {
        throw new Error("Front Worker must not execute HTTP diagnostics");
      },
    },
    undefined,
    (url) => url !== urls[6],
    true,
    (_chainId, eligible) => {
      lookups++;
      assertEquals(eligible, urls.slice(0, 6));
      return Promise.resolve({ lastTested: Date.now(), fastestRpc: urls[3], latencyMap, diagnosticsComplete: true });
    },
  );
  const ranked = [urls[3], urls[0], urls[2], urls[1], urls[6]];
  assertEquals(await Promise.all([selector.getRankedRpcList(1), selector.getRankedRpcList(1)]), [ranked, ranked]);
  assertEquals(lookups, 1);
  const deferredSelector = new RpcSelector(
    { getRpcUrls: () => urls },
    new MemoryCacheManager(),
    {
      testRpcUrls: () => {
        throw new Error("Health-deferred endpoints must not be probed");
      },
    },
    undefined,
    () => false,
    true,
    () => Promise.resolve({ lastTested: Date.now(), fastestRpc: null, latencyMap: {}, diagnosticsComplete: false }),
  );
  assertEquals(await deferredSelector.getRankedRpcList(1), urls);
});

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

Deno.test("RpcSelector: appends cached deferred recovery candidates after fresh diagnostics", async () => {
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
  assertEquals(ranked, [healthyRpc, deferredRpc]);
  const retainedMap = await cacheManager.getLatencyMap(chainId);
  assertEquals(retainedMap?.[deferredRpc], { url: deferredRpc, latency: 1, status: "ok" });
  assertEquals(await cacheManager.getFastestRpc(chainId), healthyRpc);
});

Deno.test("RpcSelector: retains uncached deferred recovery candidates after fresh diagnostics", async () => {
  const chainId = 1;
  const deferredRpc = "https://deferred.example/rpc";
  const healthyRpc = "https://healthy.example/rpc";
  const dataSource = { getRpcUrls: () => [deferredRpc, healthyRpc] };
  const cacheManager = new CacheManager({ disableCache: true });
  const testedUrls: string[][] = [];

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
  assertEquals(ranked, [healthyRpc, deferredRpc]);
  assertEquals(await cacheManager.getLatencyMap(chainId), null);
});

Deno.test("RpcSelector: excludes backed-off, half-open, active-probe, and circuit-open diagnostics while retaining cached candidates", async () => {
  const chainId = 1;
  const backedOffRpc = "https://backed-off.example/rpc";
  const halfOpenRpc = "https://half-open.example/rpc";
  const activeProbeRpc = "https://active-probe.example/rpc";
  const circuitOpenRpc = "https://circuit-open.example/rpc";
  const healthyRpc = "https://healthy.example/rpc";
  const dataSource = { getRpcUrls: () => [backedOffRpc, halfOpenRpc, activeProbeRpc, circuitOpenRpc, healthyRpc] };
  const cacheManager = new MemoryCacheManager();
  const testedUrls: string[][] = [];

  await cacheManager.updateChainCache(
    chainId,
    {
      [backedOffRpc]: { url: backedOffRpc, latency: 1, status: "ok" },
      [halfOpenRpc]: { url: halfOpenRpc, latency: 2, status: "ok" },
      [activeProbeRpc]: { url: activeProbeRpc, latency: 3, status: "ok" },
      [circuitOpenRpc]: { url: circuitOpenRpc, latency: 4, status: "ok" },
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
  assertEquals(ranked, [healthyRpc, backedOffRpc, halfOpenRpc, activeProbeRpc, circuitOpenRpc]);
  const retainedMap = await cacheManager.getLatencyMap(chainId);
  assertEquals(retainedMap?.[backedOffRpc], { url: backedOffRpc, latency: 1, status: "ok" });
  assertEquals(retainedMap?.[halfOpenRpc], { url: halfOpenRpc, latency: 2, status: "ok" });
  assertEquals(retainedMap?.[activeProbeRpc], { url: activeProbeRpc, latency: 3, status: "ok" });
  assertEquals(retainedMap?.[circuitOpenRpc], { url: circuitOpenRpc, latency: 4, status: "ok" });
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

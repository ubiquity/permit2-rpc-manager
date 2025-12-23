import { assertEquals } from "jsr:@std/assert@1";
import { CacheManager } from "../infra/cache-manager.ts";
import type { LatencyTestResult } from "../infra/latency-tester.ts";
import { RpcSelector } from "./rpc-selector.ts";

class MemoryCacheManager extends CacheManager {
  private store = new Map<number, { fastestRpc: string | null; latencyMap: Record<string, LatencyTestResult> }>();

  constructor() {
    super({ disableCache: true });
  }

  override async getFastestRpc(chainId: number): Promise<string | null> {
    return this.store.get(chainId)?.fastestRpc ?? null;
  }

  override async getLatencyMap(chainId: number): Promise<Record<string, LatencyTestResult> | null> {
    return this.store.get(chainId)?.latencyMap ?? null;
  }

  override async updateChainCache(chainId: number, latencyMap: Record<string, LatencyTestResult>, fastestRpc: string | null): Promise<void> {
    this.store.set(chainId, { fastestRpc, latencyMap });
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

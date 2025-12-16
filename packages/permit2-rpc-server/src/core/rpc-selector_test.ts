import { assertEquals } from "jsr:@std/assert@1";
import { CacheManager } from "../infra/cache-manager.ts";
import type { LatencyTestResult } from "../infra/latency-tester.ts";
import { RpcSelector } from "./rpc-selector.ts";

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

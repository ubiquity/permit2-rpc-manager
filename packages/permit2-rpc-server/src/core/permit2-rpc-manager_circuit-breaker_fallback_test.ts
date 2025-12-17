import assert from "node:assert/strict";
import { Permit2RpcManager } from "./permit2-rpc-manager.ts";

Deno.test("Emergency fallback does not bypass circuit breaker", async () => {
  const chainId = 1;
  const rpc1 = "https://rpc1.example";
  const rpc2 = "https://rpc2.example";

  const manager = new Permit2RpcManager({
    initialRpcData: { rpcs: { [String(chainId)]: [rpc1, rpc2] } },
    disableCache: true,
    logLevel: "none",
  });

  manager.rpcSelector.getRankedRpcList = () => Promise.resolve([rpc1, rpc2]);
  (manager as any).circuitBreaker.canRequest = () => false;

  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    return Promise.reject(new Error(`Unexpected fetch to ${url}`));
  }) as typeof fetch;

  try {
    await assert.rejects(
      manager.send(chainId, "eth_blockNumber"),
      /circuit breaker open/i,
    );
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

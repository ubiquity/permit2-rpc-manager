import assert from "node:assert/strict";
import { Permit2RpcManager } from "./permit2-rpc-manager.ts";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

Deno.test("METHOD_NOT_FOUND retries another RPC and caches capability", async () => {
  const chainId = 1;
  const method = "debug_traceTransaction";
  const params: unknown[] = ["0xdeadbeef"];

  const rpc1 = "https://rpc1.example";
  const rpc2 = "https://rpc2.example";

  const manager = new Permit2RpcManager({
    initialRpcData: { rpcs: { [String(chainId)]: [rpc1, rpc2] } },
    disableCache: true,
    logLevel: "none",
    capabilityTtlMs: 60_000,
  });

  manager.rpcSelector.getRankedRpcList = () => Promise.resolve([rpc1, rpc2]);
  (manager as any).rpcScorer.getRankedRpcs = (rpcs: string[]) => rpcs;

  const originalFetch = globalThis.fetch;
  const called: string[] = [];
  let phase = 0;

  globalThis.fetch = ((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    called.push(url);

    if (phase === 0) {
      if (url === rpc1) {
        return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }));
      }
      if (url === rpc2) {
        return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "ok-1" }));
      }
    }

    if (phase === 1) {
      if (url === rpc1) {
        return Promise.reject(new Error("rpc1 should have been filtered out for this method"));
      }
      if (url === rpc2) {
        return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 2, result: "ok-2" }));
      }
    }

    return Promise.reject(new Error(`Unexpected fetch to ${url}`));
  }) as typeof fetch;

  try {
    const result1 = await manager.send<string>(chainId, method, params);
    assert.equal(result1, "ok-1");

    assert.equal((manager as any).rpcMethodCapabilities.get(chainId, rpc1, method), "unsupported");

    // Force a deterministic start index; without capability filtering this would try rpc1 first again.
    (manager as any).rpcIndexMap.set(chainId, 0);
    phase = 1;

    const result2 = await manager.send<string>(chainId, method, params);
    assert.equal(result2, "ok-2");

    assert.deepEqual(called, [rpc1, rpc2, rpc2]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

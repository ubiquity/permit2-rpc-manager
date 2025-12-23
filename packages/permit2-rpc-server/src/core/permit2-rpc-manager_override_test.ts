import assert from "node:assert/strict";
import { Permit2RpcManager } from "./permit2-rpc-manager.ts";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

Deno.test("Overrides: tries override then fallback when allowed", async () => {
  const chainId = 1;
  const overrideRpc = "https://override.example";
  const fallbackRpc = "https://fallback.example";

  const originalOpenKv = Deno.openKv;
  Deno.openKv = (async () =>
    ({
      set: async () => {},
      close: () => {},
    }) as unknown as Deno.Kv) as typeof Deno.openKv;

  const manager = new Permit2RpcManager({
    initialRpcData: { rpcs: { [String(chainId)]: [overrideRpc, fallbackRpc] } },
    disableCache: true,
    logLevel: "none",
  });

  manager.rpcSelector.getRankedRpcList = () => Promise.resolve([overrideRpc, fallbackRpc]);
  (manager as any).rpcScorer.getRankedRpcs = (rpcs: string[]) => rpcs;

  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url === overrideRpc) {
      return Promise.reject(new Error("override down"));
    }
    if (url === fallbackRpc) {
      return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "ok" }));
    }
    return Promise.reject(new Error(`unexpected fetch to ${url}`));
  }) as typeof fetch;

  try {
    const result = await manager.send<string>(chainId, "eth_blockNumber", [], {
      rpcOverrides: [overrideRpc],
      allowFallback: true,
    });
    assert.equal(result, "ok");
    assert.deepEqual(calls, [overrideRpc, fallbackRpc]);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.openKv = originalOpenKv;
  }
});

Deno.test("Overrides: invalid params when no override matches and fallback disabled", async () => {
  const chainId = 1;
  const rpc1 = "https://rpc1.example";

  const manager = new Permit2RpcManager({
    initialRpcData: { rpcs: { [String(chainId)]: [rpc1] } },
    disableCache: true,
    logLevel: "none",
  });

  manager.rpcSelector.getRankedRpcList = () => Promise.resolve([rpc1]);

  await assert.rejects(
    () =>
      manager.send(chainId, "eth_blockNumber", [], {
        rpcOverrides: ["https://not-in-whitelist.example"],
        allowFallback: false,
      }),
    (err) => {
      if (!err || typeof err !== "object") return false;
      if (!("code" in err)) return false;
      return (err as { code: number }).code === -32602;
    },
  );
});

import assert from "node:assert/strict";
import { getRpcEndpointId } from "./rpc-endpoint-id.ts";
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

  const originalOpenKvDescriptor = Object.getOwnPropertyDescriptor(Deno, "openKv");
  if (!originalOpenKvDescriptor) {
    throw new Error("Deno.openKv descriptor is unavailable");
  }

  Object.defineProperty(Deno, "openKv", {
    configurable: originalOpenKvDescriptor.configurable,
    enumerable: originalOpenKvDescriptor.enumerable,
    writable: true,
    value: (() =>
      Promise.resolve({
        set: async () => {},
        delete: async () => {},
        close: () => {},
      } as unknown as Deno.Kv)) as typeof Deno.openKv,
  });

  const manager = new Permit2RpcManager({
    initialRpcData: { rpcs: { [String(chainId)]: [overrideRpc, fallbackRpc] } },
    disableCache: true,
    logLevel: "none",
    scoringV2: { enabled: false },
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
    Object.defineProperty(Deno, "openKv", originalOpenKvDescriptor);
  }
});

Deno.test("Overrides: invalid params when no override matches and fallback disabled", async () => {
  const chainId = 1;
  const rpc1 = "https://rpc1.example";
  const unavailableOverride = "https://user:secret@override.example/private?token=secret-token";

  const manager = new Permit2RpcManager({
    initialRpcData: { rpcs: { [String(chainId)]: [rpc1] } },
    disableCache: true,
    logLevel: "none",
  });

  manager.rpcSelector.getRankedRpcList = () => Promise.resolve([rpc1]);

  let error: unknown;
  try {
    await manager.send(chainId, "eth_blockNumber", [], {
      rpcOverrides: [unavailableOverride],
      allowFallback: false,
    });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error && typeof error === "object" && "code" in error);
  assert.equal((error as { code: number }).code, -32602);
  const serialized = JSON.stringify(error);
  assert.equal(serialized.includes("override.example"), false);
  assert.equal(serialized.includes("secret-token"), false);
  assert.match(serialized, new RegExp(getRpcEndpointId(unavailableOverride)));
});

Deno.test("Overrides: sequential execution keeps an override ahead of a higher-ranked fallback", async () => {
  const chainId = 1;
  const overrideRpc = "https://override.example";
  const fallbackRpc = "https://fallback.example";
  const manager = new Permit2RpcManager({
    initialRpcData: { rpcs: { [String(chainId)]: [fallbackRpc, overrideRpc] } },
    disableCache: true,
    logLevel: "none",
    scoringV2: { enabled: false },
  });
  manager.rpcSelector.getRankedRpcList = () => Promise.resolve([fallbackRpc, overrideRpc]);
  (manager as any).rpcScorer.getRankedRpcs = (rpcs: string[]) => rpcs;

  const originalOpenKvDescriptor = Object.getOwnPropertyDescriptor(Deno, "openKv");
  if (!originalOpenKvDescriptor) throw new Error("Deno.openKv descriptor is unavailable");
  Object.defineProperty(Deno, "openKv", {
    configurable: originalOpenKvDescriptor.configurable,
    enumerable: originalOpenKvDescriptor.enumerable,
    writable: true,
    value: (() =>
      Promise.resolve(
        { set: async () => {}, delete: async () => {}, close: () => {} } as unknown as Deno.Kv,
      )) as typeof Deno.openKv,
  });

  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url === overrideRpc) return Promise.reject(new Error("override down"));
    return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "fallback-result" }));
  }) as typeof fetch;

  try {
    assert.equal(
      await manager.send(chainId, "eth_blockNumber", [], { rpcOverrides: [overrideRpc], allowFallback: true }),
      "fallback-result",
    );
    assert.deepEqual(calls, [overrideRpc, fallbackRpc]);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(Deno, "openKv", originalOpenKvDescriptor);
  }
});

Deno.test("Overrides: disabled fallback never attempts a non-override RPC", async () => {
  const chainId = 1;
  const overrideRpc = "https://override.example";
  const fallbackRpc = "https://fallback.example";
  const manager = new Permit2RpcManager({
    initialRpcData: { rpcs: { [String(chainId)]: [fallbackRpc, overrideRpc] } },
    disableCache: true,
    logLevel: "none",
    scoringV2: { enabled: false },
  });
  manager.rpcSelector.getRankedRpcList = () => Promise.resolve([fallbackRpc, overrideRpc]);
  (manager as any).rpcScorer.getRankedRpcs = (rpcs: string[]) => rpcs;

  const originalOpenKvDescriptor = Object.getOwnPropertyDescriptor(Deno, "openKv");
  if (!originalOpenKvDescriptor) throw new Error("Deno.openKv descriptor is unavailable");
  Object.defineProperty(Deno, "openKv", {
    configurable: originalOpenKvDescriptor.configurable,
    enumerable: originalOpenKvDescriptor.enumerable,
    writable: true,
    value: (() =>
      Promise.resolve(
        { set: async () => {}, delete: async () => {}, close: () => {} } as unknown as Deno.Kv,
      )) as typeof Deno.openKv,
  });

  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url === overrideRpc) return Promise.reject(new Error("override down"));
    return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "unexpected fallback" }));
  }) as typeof fetch;

  try {
    await assert.rejects(() =>
      manager.send(chainId, "eth_blockNumber", [], { rpcOverrides: [overrideRpc], allowFallback: false })
    );
    assert.deepEqual(calls, [overrideRpc]);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(Deno, "openKv", originalOpenKvDescriptor);
  }
});

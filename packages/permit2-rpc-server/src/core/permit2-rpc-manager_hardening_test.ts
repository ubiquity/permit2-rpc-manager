import assert from "node:assert/strict";
import { getRpcEndpointId } from "./rpc-endpoint-id.ts";
import { Permit2RpcManager } from "./permit2-rpc-manager.ts";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function inputUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function installOpenKvMock(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(Deno, "openKv");
  if (!descriptor) throw new Error("Deno.openKv descriptor is unavailable");

  Object.defineProperty(Deno, "openKv", {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    writable: true,
    value: (() =>
      Promise.resolve({
        set: async () => {},
        delete: async () => {},
        close: () => {},
      } as unknown as Deno.Kv)) as typeof Deno.openKv,
  });

  return () => Object.defineProperty(Deno, "openKv", descriptor);
}

function createManager(
  rpcs: string[],
  options: ConstructorParameters<typeof Permit2RpcManager>[0] = {},
): Permit2RpcManager {
  const manager = new Permit2RpcManager({
    initialRpcData: { rpcs: { "1": rpcs } },
    disableCache: true,
    logLevel: "none",
    scoringV2: { enabled: false },
    ...options,
  });
  manager.rpcSelector.getRankedRpcList = () => Promise.resolve(rpcs);
  (manager as any).rpcScorer.getRankedRpcs = (candidates: string[]) => candidates;
  return manager;
}

for (const quotaCode of [-32004, -32005]) {
  Deno.test(`quota code ${quotaCode} fails over to a healthy endpoint`, async () => {
    const quotaRpc = "https://quota.example";
    const healthyRpc = "https://healthy.example";
    const manager = createManager([quotaRpc, healthyRpc]);
    const restoreOpenKv = installOpenKvMock();
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];

    globalThis.fetch = ((input) => {
      const url = inputUrl(input);
      calls.push(url);
      if (url === quotaRpc) {
        return Promise.resolve(
          jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: quotaCode, message: "quota exhausted" } }),
        );
      }
      return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "healthy-result" }));
    }) as typeof fetch;

    try {
      assert.equal(await manager.send(1, "eth_blockNumber"), "healthy-result");
      assert.deepEqual(calls, [quotaRpc, healthyRpc]);
    } finally {
      globalThis.fetch = originalFetch;
      restoreOpenKv();
    }
  });
}

Deno.test("invalid params and deterministic execution errors do not retry", async () => {
  const firstRpc = "https://first.example";
  const secondRpc = "https://second.example";
  const manager = createManager([firstRpc, secondRpc]);
  const originalFetch = globalThis.fetch;

  try {
    for (
      const error of [
        { code: -32602, message: "invalid params" },
        { code: 3, message: "execution reverted" },
      ]
    ) {
      const calls: string[] = [];
      (manager as any).rpcIndexMap.set(1, 0);
      globalThis.fetch = ((input) => {
        calls.push(inputUrl(input));
        return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, error }));
      }) as typeof fetch;

      await assert.rejects(() => manager.send(1, "eth_call", []));
      assert.deepEqual(calls, [firstRpc]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("a backed-off endpoint admits one recovery probe and resets after success", async () => {
  const rpc = "https://recover.example";
  const manager = createManager([rpc], {
    maxConsecutiveFailures: 3,
    backoffBaseMs: 5,
    maxBackoffMs: 10,
  });
  const restoreOpenKv = installOpenKvMock();
  const originalFetch = globalThis.fetch;
  const originalNowDescriptor = Object.getOwnPropertyDescriptor(Date, "now");
  if (!originalNowDescriptor) throw new Error("Date.now descriptor is unavailable");
  let now = 10_000;
  let phase: "initial-backoff" | "recovery" | "healthy" = "initial-backoff";
  let resolveRecovery!: (response: Response) => void;
  let signalRecoveryFetch!: () => void;
  const recoveryResponse = new Promise<Response>((resolve) => {
    resolveRecovery = resolve;
  });
  const recoveryFetchStarted = new Promise<void>((resolve) => {
    signalRecoveryFetch = resolve;
  });
  const calls: string[] = [];

  Object.defineProperty(Date, "now", { ...originalNowDescriptor, value: () => now });
  globalThis.fetch = ((input) => {
    calls.push(inputUrl(input));
    if (phase === "initial-backoff") {
      return Promise.resolve(
        jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32004, message: "quota exhausted" } }),
      );
    }
    if (phase === "recovery") {
      signalRecoveryFetch();
      return recoveryResponse;
    }
    return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "healthy" }));
  }) as typeof fetch;

  try {
    await assert.rejects(() => manager.send(1, "eth_blockNumber", ["initial"]));
    assert.equal(calls.length, 1);

    now = 10_004;
    await assert.rejects(() => manager.send(1, "eth_blockNumber", ["before-expiry"]));
    assert.equal(calls.length, 1, "backoff must block network traffic before expiry");

    now = 10_006;
    phase = "recovery";
    const firstRecovery = manager.send<string>(1, "eth_blockNumber", ["first-recovery"]);
    await recoveryFetchStarted;

    await assert.rejects(() => manager.send(1, "eth_blockNumber", ["second-recovery"]));
    assert.equal(calls.length, 2, "concurrent requests must not stampede the recovery probe");

    resolveRecovery(jsonResponse({ jsonrpc: "2.0", id: 1, result: "recovered" }));
    assert.equal(await firstRecovery, "recovered");

    const healthState = (manager as any).rpcHealthStates.get(rpc);
    assert.equal(healthState.consecutiveFailures, 0);
    assert.equal(healthState.lastFailureTime, 0);
    assert.equal(healthState.recoveryProbeInFlight, false);

    phase = "healthy";
    assert.equal(await manager.send(1, "eth_blockNumber", ["after-recovery"]), "healthy");
    assert.equal(calls.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(Date, "now", originalNowDescriptor);
    restoreOpenKv();
  }
});

Deno.test("health, logs, and exhausted errors use opaque endpoint diagnostics", async () => {
  const secretRpc = "https://user:super-secret@provider.example/private-path?token=super-token";
  const manager = createManager([secretRpc], { logLevel: "debug" });
  const restoreOpenKv = installOpenKvMock();
  const originalFetch = globalThis.fetch;
  const originalConsole = new Map<string, (...args: unknown[]) => void>();
  const diagnostics: unknown[][] = [];
  const levels = ["debug", "info", "warn", "error"];

  for (const level of levels) {
    const logger = (console as unknown as Record<string, (...args: unknown[]) => void>)[level];
    originalConsole.set(level, logger);
    (console as unknown as Record<string, (...args: unknown[]) => void>)[level] = (...args) => diagnostics.push(args);
  }

  globalThis.fetch = (() => Promise.reject(new Error(`upstream failed at ${secretRpc}`))) as typeof fetch;

  try {
    let error: unknown;
    try {
      await manager.send(1, "eth_blockNumber");
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    const serializedError = JSON.stringify({ message: error.message, data: (error as { data?: unknown }).data });
    const health = JSON.stringify(await manager.getHealthStatus());
    const logged = JSON.stringify(diagnostics);

    for (const diagnostic of [serializedError, health, logged]) {
      assert.equal(diagnostic.includes("super-secret"), false);
      assert.equal(diagnostic.includes("super-token"), false);
      assert.equal(diagnostic.includes("provider.example"), false);
      assert.equal(diagnostic.includes("private-path"), false);
    }

    assert.match(serializedError, new RegExp(getRpcEndpointId(secretRpc)));
    assert.match(health, new RegExp(getRpcEndpointId(secretRpc)));
    assert.match(logged, new RegExp(getRpcEndpointId(secretRpc)));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [level, logger] of originalConsole) {
      (console as unknown as Record<string, (...args: unknown[]) => void>)[level] = logger;
    }
    restoreOpenKv();
  }
});

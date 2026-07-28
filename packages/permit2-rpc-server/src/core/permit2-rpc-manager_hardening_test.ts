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

function markRpcHalfOpen(manager: Permit2RpcManager, rpcUrl: string): void {
  const now = Date.now();
  (manager as any).rpcHealthStates.set(rpcUrl, {
    consecutiveFailures: 1,
    lastFailureTime: now - 2,
    lastSuccessTime: 0,
    temporaryUnavailableUntil: now - 1,
    recoveryProbeInFlight: false,
    failureReasons: new Map(),
  });
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

for (const status of [400, 404]) {
  Deno.test(`non-JSON ${status} provider responses fail over`, async () => {
    const invalidJsonRpc = "https://invalid-json.example";
    const healthyRpc = "https://healthy-json.example";
    const manager = createManager([invalidJsonRpc, healthyRpc]);
    const restoreOpenKv = installOpenKvMock();
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];

    globalThis.fetch = ((input) => {
      const rpcUrl = inputUrl(input);
      calls.push(rpcUrl);
      if (rpcUrl === invalidJsonRpc) {
        return Promise.resolve(new Response("not JSON", { status, statusText: "Not Found" }));
      }
      return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "healthy-result" }));
    }) as typeof fetch;

    try {
      assert.equal(await manager.send(1, "eth_blockNumber"), "healthy-result");
      assert.deepEqual(calls, [invalidJsonRpc, healthyRpc]);
    } finally {
      globalThis.fetch = originalFetch;
      restoreOpenKv();
    }
  });
}

Deno.test("JSON-RPC parse errors returned by a provider preserve client-error handling", async () => {
  const firstRpc = "https://first.example";
  const secondRpc = "https://second.example";
  const manager = createManager([firstRpc, secondRpc]);
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = ((input) => {
    calls.push(inputUrl(input));
    return Promise.resolve(
      jsonResponse(
        { jsonrpc: "2.0", id: 1, error: { code: -32700, message: "parse error" } },
        { status: 400 },
      ),
    );
  }) as typeof fetch;

  try {
    await assert.rejects(() => manager.send(1, "eth_blockNumber"));
    assert.deepEqual(calls, [firstRpc]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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

    await assert.rejects(
      () => manager.send(1, "eth_blockNumber", ["second-recovery"]),
      /No RPC endpoints were available to attempt/,
    );
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

Deno.test("a failed recovery probe consumes its expired backoff window", async () => {
  const rpc = "https://recovering-window.example";
  const manager = createManager([rpc], { maxConsecutiveFailures: 3 });
  const restoreOpenKv = installOpenKvMock();
  const originalFetch = globalThis.fetch;
  const normalResolvers: Array<(response: Response) => void> = [];
  let phase: "recovery" | "normal" = "recovery";
  let normalFetches = 0;
  let signalSecondNormalFetch!: () => void;
  const secondNormalFetchStarted = new Promise<void>((resolve) => {
    signalSecondNormalFetch = resolve;
  });

  markRpcHalfOpen(manager, rpc);
  globalThis.fetch = (() => {
    if (phase === "recovery") {
      return Promise.reject(new TypeError("Failed to fetch"));
    }

    normalFetches++;
    if (normalFetches === 2) signalSecondNormalFetch();
    return new Promise<Response>((resolve) => normalResolvers.push(resolve));
  }) as typeof fetch;

  try {
    await assert.rejects(() => manager.send(1, "eth_blockNumber", ["recovery"]));

    const healthState = (manager as any).rpcHealthStates.get(rpc);
    assert.equal(healthState.temporaryUnavailableUntil, undefined);
    assert.equal(healthState.recoveryProbeInFlight, false);

    phase = "normal";
    const firstRequest = manager.send<string>(1, "eth_blockNumber", ["first"]);
    const secondRequest = manager.send<string>(1, "eth_blockNumber", ["second"]);
    const secondRequestOutcome = secondRequest.then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    const outcome = await Promise.race([
      secondNormalFetchStarted.then(() => "second_fetch" as const),
      secondRequestOutcome,
    ]);
    assert.equal(outcome, "second_fetch", "the second request must not be blocked by a stale half-open window");
    assert.equal(normalFetches, 2, "subsequent normal requests must not remain half-open serialized");

    for (const resolve of normalResolvers) {
      resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "healthy" }));
    }

    assert.equal(await firstRequest, "healthy");
    assert.equal(await secondRequest, "healthy");
  } finally {
    for (const resolve of normalResolvers) {
      resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "healthy" }));
    }
    globalThis.fetch = originalFetch;
    restoreOpenKv();
  }
});

Deno.test("consensus requests allow only one half-open recovery probe", async () => {
  const recoveringRpc = "https://recovering-consensus.example";
  const healthyRpc = "https://healthy-consensus.example";
  const manager = createManager([recoveringRpc, healthyRpc], {
    consensus: {
      enabled: true,
      methods: ["eth_blockNumber"],
      participants: 2,
      agreementThreshold: 1,
    },
  });
  const restoreOpenKv = installOpenKvMock();
  const originalFetch = globalThis.fetch;
  const recoveryResolvers: Array<(response: Response) => void> = [];
  let recoveringFetches = 0;
  let signalRecoveryFetch!: () => void;
  let signalSecondHealthyFetch!: () => void;
  const recoveryFetchStarted = new Promise<void>((resolve) => {
    signalRecoveryFetch = resolve;
  });
  const secondHealthyFetchStarted = new Promise<void>((resolve) => {
    signalSecondHealthyFetch = resolve;
  });
  const sendOptions = { rpcOverrides: [recoveringRpc, healthyRpc], allowFallback: false };

  markRpcHalfOpen(manager, recoveringRpc);
  globalThis.fetch = ((input, init) => {
    const rpcUrl = inputUrl(input);
    const request = JSON.parse(String(init?.body)) as { params?: unknown[] };

    if (rpcUrl === recoveringRpc) {
      recoveringFetches++;
      if (recoveringFetches === 1) signalRecoveryFetch();
      return new Promise<Response>((resolve) => recoveryResolvers.push(resolve));
    }

    if (request.params?.[0] === "second") signalSecondHealthyFetch();
    return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "ok" }));
  }) as typeof fetch;

  try {
    const firstRequest = manager.send<string>(1, "eth_blockNumber", ["first"], sendOptions);
    await recoveryFetchStarted;

    const secondRequest = manager.send<string>(1, "eth_blockNumber", ["second"], sendOptions);
    await secondHealthyFetchStarted;

    assert.equal(recoveringFetches, 1, "only one consensus request may probe a half-open endpoint");

    for (const resolve of recoveryResolvers) {
      resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "ok" }));
    }

    assert.equal(await firstRequest, "ok");
    assert.equal(await secondRequest, "ok");
    assert.equal((manager as any).rpcHealthStates.get(recoveringRpc).recoveryProbeInFlight, false);
  } finally {
    for (const resolve of recoveryResolvers) {
      resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "ok" }));
    }
    globalThis.fetch = originalFetch;
    restoreOpenKv();
  }
});

Deno.test("hedged requests allow only one half-open recovery probe", async () => {
  const recoveringRpc = "https://recovering-hedge.example";
  const healthyRpc = "https://healthy-hedge.example";
  const manager = createManager([recoveringRpc, healthyRpc], {
    hedge: { enabled: true, maxHedges: 1, delayMs: 0, minDelayMs: 0, maxDelayMs: 0 },
  });
  const restoreOpenKv = installOpenKvMock();
  const originalFetch = globalThis.fetch;
  const recoveryResolvers: Array<(response: Response) => void> = [];
  const healthyResolvers: Array<(response: Response) => void> = [];
  let recoveringFetches = 0;
  let signalRecoveryFetch!: () => void;
  let signalSecondPath!: () => void;
  const recoveryFetchStarted = new Promise<void>((resolve) => {
    signalRecoveryFetch = resolve;
  });
  const secondPathStarted = new Promise<void>((resolve) => {
    signalSecondPath = resolve;
  });
  const sendOptions = { rpcOverrides: [recoveringRpc, healthyRpc], allowFallback: false };

  markRpcHalfOpen(manager, recoveringRpc);
  globalThis.fetch = ((input, init) => {
    const rpcUrl = inputUrl(input);
    const request = JSON.parse(String(init?.body)) as { params?: unknown[] };

    if (rpcUrl === recoveringRpc) {
      recoveringFetches++;
      if (recoveringFetches === 1) {
        signalRecoveryFetch();
      } else {
        signalSecondPath();
      }
      return new Promise<Response>((resolve) => recoveryResolvers.push(resolve));
    }

    if (request.params?.[0] === "second") signalSecondPath();
    return new Promise<Response>((resolve) => healthyResolvers.push(resolve));
  }) as typeof fetch;

  try {
    const firstRequest = manager.send<string>(1, "eth_blockNumber", ["first"], sendOptions);
    await recoveryFetchStarted;

    const secondRequest = manager.send<string>(1, "eth_blockNumber", ["second"], sendOptions);
    await secondPathStarted;

    assert.equal(recoveringFetches, 1, "only one hedged request may probe a half-open endpoint");

    for (const resolve of recoveryResolvers) {
      resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "recovered" }));
    }
    assert.equal(await firstRequest, "recovered");

    for (const resolve of healthyResolvers) {
      resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "healthy" }));
    }
    assert.equal(await secondRequest, "healthy");
    assert.equal((manager as any).rpcHealthStates.get(recoveringRpc).recoveryProbeInFlight, false);
  } finally {
    for (const resolve of recoveryResolvers) {
      resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "recovered" }));
    }
    for (const resolve of healthyResolvers) {
      resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "healthy" }));
    }
    globalThis.fetch = originalFetch;
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

    const endpointId = getRpcEndpointId(secretRpc);
    assert.ok(serializedError.includes(endpointId));
    assert.ok(health.includes(endpointId));
    assert.ok(logged.includes(endpointId));
  } finally {
    globalThis.fetch = originalFetch;
    for (const [level, logger] of originalConsole) {
      (console as unknown as Record<string, (...args: unknown[]) => void>)[level] = logger;
    }
    restoreOpenKv();
  }
});

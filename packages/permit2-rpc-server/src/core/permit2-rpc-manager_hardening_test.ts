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

function installOpenKvSpy(): { calls: () => number; restore: () => void } {
  const descriptor = Object.getOwnPropertyDescriptor(Deno, "openKv");
  if (!descriptor) throw new Error("Deno.openKv descriptor is unavailable");

  let callCount = 0;
  Object.defineProperty(Deno, "openKv", {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    writable: true,
    value: (() => {
      callCount++;
      return Promise.resolve({ close: () => {} } as unknown as Deno.Kv);
    }) as typeof Deno.openKv,
  });

  return {
    calls: () => callCount,
    restore: () => Object.defineProperty(Deno, "openKv", descriptor),
  };
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
    failureReasons: new Map(),
  });
}

for (const httpStatus of [200, 400, 401, 403, 404, 408, 429, 500]) {
  for (const capabilityCode of [-32601, -32004]) {
    Deno.test(`method capability code ${capabilityCode} with HTTP ${httpStatus} fails over without endpoint penalties`, async () => {
      const unsupportedRpc = "https://unsupported.example";
      const healthyRpc = "https://healthy.example";
      const method = "debug_traceCall";
      const manager = createManager([unsupportedRpc, healthyRpc]);
      const originalFetch = globalThis.fetch;
      const calls: string[] = [];

      globalThis.fetch = ((input) => {
        const url = inputUrl(input);
        calls.push(url);
        if (url === unsupportedRpc) {
          return Promise.resolve(
            jsonResponse(
              { jsonrpc: "2.0", id: 1, error: { code: capabilityCode, message: "method unsupported" } },
              { status: httpStatus },
            ),
          );
        }
        return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "healthy-result" }));
      }) as typeof fetch;

      try {
        assert.equal(await manager.send(1, method), "healthy-result");
        assert.deepEqual(calls, [unsupportedRpc, healthyRpc]);
        assert.equal((manager as any).rpcMethodCapabilities.get(1, unsupportedRpc, method), "unsupported");
        assert.equal((manager as any).rpcHealthStates.get(unsupportedRpc).consecutiveFailures, 0);
        assert.equal((manager as any).circuitBreaker.getState(unsupportedRpc), "closed");
        const stats = (manager as any).rpcMetrics.getMethodStats(1, method, [unsupportedRpc]).get(unsupportedRpc);
        assert.equal(stats.requestsTotal, 0);
        assert.equal(stats.throttleRate, undefined);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  Deno.test(`limit-exceeded code -32005 with HTTP ${httpStatus} fails over and opens backoff`, async () => {
    const limitedRpc = "https://limited.example";
    const healthyRpc = "https://healthy.example";
    const manager = createManager([limitedRpc, healthyRpc]);
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];

    globalThis.fetch = ((input) => {
      const url = inputUrl(input);
      calls.push(url);
      if (url === limitedRpc) {
        return Promise.resolve(
          jsonResponse(
            { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "limit exceeded" } },
            { status: httpStatus },
          ),
        );
      }
      return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "healthy-result" }));
    }) as typeof fetch;

    try {
      assert.equal(await manager.send(1, "eth_blockNumber"), "healthy-result");
      assert.deepEqual(calls, [limitedRpc, healthyRpc]);
      const healthState = (manager as any).rpcHealthStates.get(limitedRpc);
      assert.equal(healthState.consecutiveFailures, 1);
      assert.ok(healthState.temporaryUnavailableUntil > Date.now());
      const stats = (manager as any).rpcMetrics.getMethodStats(1, "eth_blockNumber", [limitedRpc]).get(limitedRpc);
      assert.equal(stats.throttleRate, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

for (const status of [400, 404, 429]) {
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
      if (status === 429) {
        assert.ok((manager as any).rpcHealthStates.get(invalidJsonRpc).temporaryUnavailableUntil > Date.now());
      }
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

Deno.test("unknown decoded provider codes fall back to their HTTP wrapper", async () => {
  const unknownRpc = "https://unknown-code.example";
  const healthyRpc = "https://healthy-code.example";
  const manager = createManager([unknownRpc, healthyRpc]);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input) => {
    if (inputUrl(input) === unknownRpc) {
      return Promise.resolve(
        jsonResponse(
          { jsonrpc: "2.0", id: 1, error: { code: -32099, message: "unknown provider code" } },
          { status: 429 },
        ),
      );
    }
    return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "healthy-result" }));
  }) as typeof fetch;

  try {
    assert.equal(await manager.send(1, "eth_blockNumber"), "healthy-result");
    assert.ok((manager as any).rpcHealthStates.get(unknownRpc).temporaryUnavailableUntil > Date.now());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("JSON-parsable non-JSON-RPC response bodies fail over instead of succeeding with undefined", async () => {
  const malformedRpc = "https://malformed-envelope.example";
  const healthyRpc = "https://healthy-envelope.example";
  const manager = createManager([malformedRpc, healthyRpc]);
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = ((input) => {
    const rpcUrl = inputUrl(input);
    calls.push(rpcUrl);
    if (rpcUrl === malformedRpc) {
      return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, unexpected: "body" }));
    }
    return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "healthy-result" }));
  }) as typeof fetch;

  try {
    assert.equal(await manager.send(1, "eth_blockNumber"), "healthy-result");
    assert.deepEqual(calls, [malformedRpc, healthyRpc]);
    assert.equal((manager as any).rpcHealthStates.get(malformedRpc).consecutiveFailures, 1);
    assert.equal((manager as any).rpcMethodCapabilities.get(1, malformedRpc, "eth_blockNumber"), "unknown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("invalid params, invalid requests, and deterministic execution errors ignore contradictory HTTP wrappers", async () => {
  const firstRpc = "https://first.example";
  const secondRpc = "https://second.example";
  const manager = createManager([firstRpc, secondRpc]);
  const originalFetch = globalThis.fetch;

  try {
    for (
      const error of [
        { code: -32600, message: "invalid request" },
        { code: -32602, message: "invalid params" },
        { code: 3, message: "execution reverted" },
        { code: -32000, message: "execution reverted: deterministic contract failure" },
      ]
    ) {
      for (const status of [429, 500]) {
        const calls: string[] = [];
        (manager as any).rpcIndexMap.set(1, 0);
        globalThis.fetch = ((input) => {
          calls.push(inputUrl(input));
          return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, error }, { status }));
        }) as typeof fetch;

        await assert.rejects(() => manager.send(1, "eth_call", []));
        assert.deepEqual(calls, [firstRpc]);
        assert.equal((manager as any).rpcHealthStates.get(firstRpc).consecutiveFailures, 0);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("a successful fail-open capability probe clears its stale exclusion", async () => {
  const rpc = "https://capability-probe.example";
  const method = "debug_traceCall";
  const manager = createManager([rpc]);
  const originalFetch = globalThis.fetch;

  (manager as any).rpcMethodCapabilities.markUnsupported(1, rpc, method, "previous probe", 60_000);
  globalThis.fetch =
    (() => Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "supported" }))) as typeof fetch;

  try {
    assert.equal(await manager.send(1, method), "supported");
    assert.equal((manager as any).rpcMethodCapabilities.get(1, rpc, method), "unknown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("health tracking performs no Deno KV operations", async () => {
  const rpc = "https://no-kv.example";
  const manager = createManager([rpc]);
  const originalFetch = globalThis.fetch;
  const kvSpy = installOpenKvSpy();
  let phase: "fail" | "succeed" = "fail";

  globalThis.fetch = (() => {
    if (phase === "fail") {
      return Promise.resolve(
        jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "limit exceeded" } }),
      );
    }
    return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "healthy" }));
  }) as typeof fetch;

  try {
    await assert.rejects(() => manager.send(1, "eth_blockNumber", ["first"]));
    (manager as any).resetAllRpcHealthStates(1, [rpc]);
    phase = "succeed";
    assert.equal(await manager.send(1, "eth_blockNumber", ["second"]), "healthy");
    assert.equal(kvSpy.calls(), 0);
  } finally {
    globalThis.fetch = originalFetch;
    kvSpy.restore();
  }
});

Deno.test("a stale recovery lease cannot release a newer lease", () => {
  const rpc = "https://stale-lease.example";
  const manager = createManager([rpc]);
  markRpcHalfOpen(manager, rpc);

  const lease = (manager as any).acquireRpcAttempt(rpc);
  assert.equal(lease.kind, "recovery");
  const state = (manager as any).rpcHealthStates.get(rpc);
  const expiredBackoffUntil = state.temporaryUnavailableUntil;
  state.recoveryProbeToken = "newer-lease-token";

  (manager as any).releaseRpcAttempt(rpc, lease, "completed");

  assert.equal(state.recoveryProbeToken, "newer-lease-token");
  assert.equal(state.temporaryUnavailableUntil, expiredBackoffUntil);
});

Deno.test("recovery leases are exclusive per manager instance, not process-wide", async () => {
  const rpc = "https://per-instance.example";
  const first = createManager([rpc]);
  const second = createManager([rpc]);
  markRpcHalfOpen(first, rpc);
  markRpcHalfOpen(second, rpc);
  const originalFetch = globalThis.fetch;
  const resolvers: Array<(response: Response) => void> = [];
  let started = 0;
  let signalBothStarted!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    signalBothStarted = resolve;
  });

  globalThis.fetch = (() => {
    started++;
    if (started === 2) signalBothStarted();
    return new Promise<Response>((resolve) => resolvers.push(resolve));
  }) as typeof fetch;

  try {
    const firstRequest = first.send<string>(1, "eth_blockNumber", ["first"]);
    const secondRequest = second.send<string>(1, "eth_blockNumber", ["second"]);
    await bothStarted;
    assert.equal(started, 2);

    for (const resolve of resolvers) {
      resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "ok" }));
    }
    assert.equal(await firstRequest, "ok");
    assert.equal(await secondRequest, "ok");
  } finally {
    for (const resolve of resolvers) {
      resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "ok" }));
    }
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
        jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "limit exceeded" } }),
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
    assert.equal(healthState.recoveryProbeToken, undefined);

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
    assert.equal(healthState.recoveryProbeToken, undefined);

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
    assert.equal((manager as any).rpcHealthStates.get(recoveringRpc).recoveryProbeToken, undefined);
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
    assert.equal((manager as any).rpcHealthStates.get(recoveringRpc).recoveryProbeToken, undefined);
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

Deno.test("a cancelled hedge restores half-open eligibility for a foreground recovery", async () => {
  const recoveringRpc = "https://cancelled-recovery.example";
  const healthyRpc = "https://cancelled-healthy.example";
  const manager = createManager([recoveringRpc, healthyRpc], {
    hedge: { enabled: true, maxHedges: 1, delayMs: 0, minDelayMs: 0, maxDelayMs: 0 },
  });
  markRpcHalfOpen(manager, recoveringRpc);
  const expiredBackoffUntil = (manager as any).rpcHealthStates.get(recoveringRpc).temporaryUnavailableUntil;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = ((input, init) => {
    const rpcUrl = inputUrl(input);
    if (rpcUrl === recoveringRpc) {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "healthy" }));
  }) as typeof fetch;

  try {
    assert.equal(await manager.send(1, "eth_chainId", ["hedged"]), "healthy");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = (manager as any).rpcHealthStates.get(recoveringRpc);
    assert.equal(state.recoveryProbeToken, undefined);
    assert.equal(state.temporaryUnavailableUntil, expiredBackoffUntil);

    (manager as any).rpcIndexMap.set(1, 0);
    globalThis.fetch = ((input) => {
      assert.equal(inputUrl(input), recoveringRpc);
      return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "recovered" }));
    }) as typeof fetch;
    assert.equal(
      await manager.send(1, "eth_chainId", ["foreground"], { rpcOverrides: [recoveringRpc], allowFallback: false }),
      "recovered",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("consensus pre-acquires later candidates when an earlier recovery lease is busy", async () => {
  const busyRpc = "https://consensus-busy.example";
  const firstRpc = "https://consensus-first.example";
  const secondRpc = "https://consensus-second.example";
  const manager = createManager([busyRpc, firstRpc, secondRpc], {
    consensus: {
      enabled: true,
      methods: ["eth_blockNumber"],
      participants: 2,
      agreementThreshold: 1,
    },
  });
  markRpcHalfOpen(manager, busyRpc);
  (manager as any).rpcHealthStates.get(busyRpc).recoveryProbeToken = "already-probing";
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = ((input) => {
    calls.push(inputUrl(input));
    return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: 1, result: "0x1" }));
  }) as typeof fetch;

  try {
    assert.equal(await manager.send(1, "eth_blockNumber"), "0x1");
    assert.equal(calls.includes(busyRpc), false);
    assert.deepEqual(new Set(calls), new Set([firstRpc, secondRpc]));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("head sampling excludes backed-off, half-open, and actively probed endpoints", async () => {
  const backedOffRpc = "https://head-backed-off.example";
  const recoveringRpc = "https://head-recovering.example";
  const activeProbeRpc = "https://head-active-probe.example";
  const healthyRpc = "https://head-healthy.example";
  const manager = createManager([backedOffRpc, recoveringRpc, activeProbeRpc, healthyRpc], {
    headSampling: { enabled: true, sampleIntervalMs: 0, maxRpcsPerSample: 4 },
  });
  const now = Date.now();
  (manager as any).rpcHealthStates.set(backedOffRpc, {
    consecutiveFailures: 1,
    lastFailureTime: now - 1,
    lastSuccessTime: 0,
    temporaryUnavailableUntil: now + 60_000,
    failureReasons: new Map(),
  });
  markRpcHalfOpen(manager, recoveringRpc);
  markRpcHalfOpen(manager, activeProbeRpc);
  (manager as any).rpcHealthStates.get(activeProbeRpc).recoveryProbeToken = "active-probe";
  const originalFetch = globalThis.fetch;
  const headSampleUrls: string[] = [];

  globalThis.fetch = ((input, init) => {
    const request = JSON.parse(String(init?.body)) as { id?: unknown; method?: string };
    if (
      request.method === "eth_blockNumber" && typeof request.id === "string" && request.id.startsWith("head-tracker-")
    ) {
      headSampleUrls.push(inputUrl(input));
      return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: request.id, result: "0x10" }));
    }
    return Promise.resolve(jsonResponse({ jsonrpc: "2.0", id: request.id, result: "0x1" }));
  }) as typeof fetch;

  try {
    assert.equal(
      await manager.send(1, "eth_chainId", [], { rpcOverrides: [healthyRpc], allowFallback: false }),
      "0x1",
    );
    assert.deepEqual(headSampleUrls, [healthyRpc]);
  } finally {
    globalThis.fetch = originalFetch;
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

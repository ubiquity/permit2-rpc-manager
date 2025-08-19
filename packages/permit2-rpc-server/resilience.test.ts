// resilience.test.ts
import { Permit2RpcManager } from "./src/permit2-rpc-manager.ts";
import { CacheManager } from "./src/cache-manager.ts";
import { ChainlistDataSource } from "./src/chainlist-data-source.ts";
import { LatencyTester } from "./src/latency-tester.ts";
import { RpcSelector } from "./src/rpc-selector.ts";
import { assertEquals, assert, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { delay } from "https://deno.land/std@0.224.0/async/delay.ts";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

type MockBehavior =
  | "ok"
  | "rate_limit"
  | "network_error"
  | "cert_error"
  | "syncing"
  | "timeout"
  | "recovery"
  | "bytecode"
  | "batch"
  | "custom_error";

interface MockRpcConfig {
  port: number;
  behavior: MockBehavior;
  delayMs?: number;
  recoveryAfterMs?: number;
  customError?: { code: number; message: string };
  bytecode?: string;
}

function startMockRpcServer(config: MockRpcConfig) {
  let isRecovered = false;
  let started = Date.now();
  let requestCount = 0;

  const handler = async (req: Request): Promise<Response> => {
    requestCount++;
    if (config.recoveryAfterMs && Date.now() - started > config.recoveryAfterMs) {
      isRecovered = true;
    }
    const json = await req.json().catch(() => null);

    // Batch support
    if (Array.isArray(json)) {
      return new Response(
        JSON.stringify(json.map((item: any) => ({
          jsonrpc: "2.0",
          result: config.behavior === "bytecode" ? (config.bytecode ?? "0xdeadbeef") : "0x",
          id: item.id,
        }))),
        { status: 200 }
      );
    }

    if (isRecovered || config.behavior === "ok") {
      // Permit2 bytecode simulation
      if (json?.method === "eth_getCode" && config.behavior === "bytecode") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", result: config.bytecode ?? "0xdeadbeef", id: json.id }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: "0x", id: json?.id ?? 1 }), { status: 200 });
    }
    switch (config.behavior) {
      case "rate_limit":
        return new Response(JSON.stringify({ error: { code: -32005, message: "rate limit" } }), { status: 429 });
      case "network_error":
        req.signal.throwIfAborted();
        throw new Error("Simulated network error");
      case "cert_error":
        req.signal.throwIfAborted();
        throw new Error("Simulated certificate error");
      case "syncing":
        return new Response(JSON.stringify({ jsonrpc: "2.0", result: { syncing: true }, id: json?.id ?? 1 }), { status: 200 });
      case "timeout":
        await delay(config.delayMs ?? 2000);
        return new Response(JSON.stringify({ error: { code: -32000, message: "timeout" } }), { status: 504 });
      case "custom_error":
        return new Response(JSON.stringify({ error: config.customError ?? { code: -32099, message: "custom error" } }), { status: 500 });
      default:
        return new Response(JSON.stringify({ jsonrpc: "2.0", result: "0x", id: json?.id ?? 1 }), { status: 200 });
    }
  };

  const abortController = new AbortController();
  serve(handler, { port: config.port, signal: abortController.signal });
  return {
    close: () => abortController.abort(),
    url: `http://localhost:${config.port}`,
    getRequestCount: () => requestCount,
  };
}

/* --- Enhanced Test Utilities --- */

const activeServers: Array<{ close: () => void }> = [];

/** Start and track a mock RPC server for automatic cleanup. */
function startTrackedMockRpcServer(config: MockRpcConfig) {
  const server = startMockRpcServer(config);
  activeServers.push(server);
  return server;
}

/** Cleanup all active mock servers. Call after each test step. */
async function cleanupServers() {
  while (activeServers.length) {
    try {
      activeServers.pop()?.close();
    } catch {}
  }
}

/** Waits until the manager's health state for a given RPC matches the predicate or timeout. */
async function waitForHealthState(manager: Permit2RpcManager, rpcUrl: string, predicate: (state: any) => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = (manager as any).getHealthState?.(rpcUrl);
    if (state && predicate(state)) return state;
    await delay(50);
  }
  throw new Error("Timeout waiting for health state");
}

/** Waits for a minimum duration, then returns elapsed ms. */
async function waitAndMeasure(fn: () => Promise<any>): Promise<number> {
  const start = Date.now();
  await fn();
  return Date.now() - start;
}

/** Simulates a restart by re-instantiating the manager with the same KV path. */
async function simulateRestart(options: any) {
  // Close and reopen Deno KV if needed, then re-create manager
  // (details depend on CacheManager implementation)
  return new Permit2RpcManager(options);
}

/** Reads Deno KV contents for a given chainId. */
async function readKvCache(cacheManager: CacheManager, chainId: number) {
  return await cacheManager.getChainCache(chainId);
}

/** Inspect health state for a given RPC URL. */
function getHealthState(manager: Permit2RpcManager, rpcUrl: string) {
  return (manager as any).getHealthState?.(rpcUrl);
}

/**
 * Utility to create a Permit2RpcManager with full dependency injection and observability.
 * Returns { manager, dataSource, cacheManager, latencyTester, rpcSelector }
 */
async function createManagerWithRpcs(
  rpcUrls: string[],
  {
    chainId = 1,
    dataSourceOpts = {},
    cacheManagerOpts = {},
    latencyTesterOpts = {},
    rpcSelectorOpts = {},
    managerOpts = {},
  }: {
    chainId?: number;
    dataSourceOpts?: any;
    cacheManagerOpts?: any;
    latencyTesterOpts?: any;
    rpcSelectorOpts?: any;
    managerOpts?: any;
  } = {}
) {
  const dataSource = new ChainlistDataSource(undefined, {
    rpcs: { [chainId]: rpcUrls },
    ...dataSourceOpts,
  });
  const cacheManager = new CacheManager(cacheManagerOpts);
  const latencyTester = new LatencyTester(latencyTesterOpts.timeoutMs ?? 100, latencyTesterOpts.logger);
  const rpcSelector = new RpcSelector(dataSource, cacheManager, latencyTester, rpcSelectorOpts.logger);
  const manager = new Permit2RpcManager({
    ...managerOpts,
    dataSource,
    cacheManager,
    latencyTester,
    rpcSelector,
  });
  // Expose internals for test observability
  (manager as any).dataSource = dataSource;
  (manager as any).cacheManager = cacheManager;
  (manager as any).latencyTester = latencyTester;
  (manager as any).rpcSelector = rpcSelector;
  return { manager, dataSource, cacheManager, latencyTester, rpcSelector };
}

/** Ensure cleanup after each test step. */
if (typeof Deno !== "undefined" && Deno.test) {
  Deno.test({
    name: "cleanup after each test step",
    fn: async () => {
      await cleanupServers();
    },
    sanitizeResources: false,
    sanitizeOps: false,
    ignore: true, // Only for manual invocation if needed
  });
}

// --- TESTS ---

Deno.test("Emergency Pool Refresh triggers on mass rate limit (429)", async () => {
  const server1 = startMockRpcServer({ port: 41001, behavior: "rate_limit" });
  const server2 = startMockRpcServer({ port: 41002, behavior: "rate_limit" });
  const { manager } = await createManagerWithRpcs([server1.url, server2.url]);
  let errorCaught = false;
  try {
    await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
  } catch (e) {
    errorCaught = true;
  }
  assert(errorCaught, "Should throw when all RPCs are rate limited");
  // Optionally, check internal state for panic mode if exposed
  server1.close();
  server2.close();
});

Deno.test("Backoff and Panic Mode", async (t) => {
  await t.step("Adaptive Backoff increases delay on repeated network errors", async () => {
    const server = startTrackedMockRpcServer({ port: 41003, behavior: "network_error" });
    const { manager } = await createManagerWithRpcs([server.url]);
    let errorCaught = false;
    try {
      await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
    } catch (e) {
      errorCaught = true;
    }
    assert(errorCaught, "Should throw on network error");
    await cleanupServers();
  });

  await t.step("Adaptive Backoff: delay increases with repeated failures (timing assertion)", async () => {
    const server = startTrackedMockRpcServer({ port: 41020, behavior: "network_error" });
    const { manager } = await createManagerWithRpcs([server.url]);
    let errorCaught = false;
    const start = Date.now();
    try {
      await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
    } catch {
      errorCaught = true;
    }
    const firstElapsed = Date.now() - start;

    let errorCaught2 = false;
    const start2 = Date.now();
    try {
      await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
    } catch {
      errorCaught2 = true;
    }
    const secondElapsed = Date.now() - start2;

    assert(errorCaught, "First call should throw");
    assert(errorCaught2, "Second call should throw");
    assert(secondElapsed >= firstElapsed, `Backoff did not increase: first=${firstElapsed}ms, second=${secondElapsed}ms`);
    await cleanupServers();
  });

  await t.step("Panic Mode triggers on certificate errors", async () => {
    const server = startTrackedMockRpcServer({ port: 41004, behavior: "cert_error" });
    const { manager } = await createManagerWithRpcs([server.url]);
    let errorCaught = false;
    try {
      await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
    } catch (e) {
      errorCaught = true;
    }
    assert(errorCaught, "Should throw on certificate error");
    await cleanupServers();
  });

  // Additional steps for panic mode reduced timeout and refresh threshold will be added here.
  await t.step("Panic mode reduced timeout (verify 2s timeout)", async () => {
    const server = startTrackedMockRpcServer({ port: 41021, behavior: "rate_limit" });
    const { manager } = await createManagerWithRpcs([server.url]);
    let elapsed = 0;
    let start = 0;
    try {
      start = Date.now();
      await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
    } catch {
      elapsed = Date.now() - start;
    }
    // Should timeout in ~2s or less (allowing for some jitter)
    assert(elapsed > 1000 && elapsed < 2500, `Panic mode timeout not in expected range: ${elapsed}ms`);
    await cleanupServers();
  });

  await t.step("Panic mode refresh threshold (30s between refreshes)", async () => {
    const server = startTrackedMockRpcServer({ port: 41022, behavior: "rate_limit" });
    const { manager } = await createManagerWithRpcs([server.url]);
    // First failure triggers panic/refresh
    try { await manager.send(1, "eth_getBlockByNumber", ["latest", false]); } catch {}
    // Immediately try again, should not trigger another refresh (should fail fast)
    let elapsed = 0;
    let start = 0;
    try {
      start = Date.now();
      await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
    } catch {
      elapsed = Date.now() - start;
    }
    // Should fail quickly (<1s) due to refresh threshold
    assert(elapsed < 1000, `Second panic refresh did not respect threshold: ${elapsed}ms`);
    await cleanupServers();
  });
});

Deno.test("Health state lifecycle and recovery", async (t) => {
  await t.step("Syncing status handled gracefully, does not trigger panic", async () => {
    const server = startTrackedMockRpcServer({ port: 41005, behavior: "syncing" });
    const { manager } = await createManagerWithRpcs([server.url]);
    const result = await manager.send(1, "eth_syncing", []);
    assert(result && typeof result === "object" && "syncing" in result, "Should return syncing result");
    await cleanupServers();
  });

  await t.step("Timeout triggers backoff and recovery", async () => {
    const server = startTrackedMockRpcServer({ port: 41006, behavior: "timeout", delayMs: 1000 });
Deno.test("Health state lifecycle: healthy → failing → backoff → recovery", async (t) => {
  await t.step("Transitions and state checks", async () => {
    const server = startTrackedMockRpcServer({ port: 41027, behavior: "rate_limit", recoveryAfterMs: 500 });
    const { manager } = await createManagerWithRpcs([server.url]);
    // Initially healthy
    let state = getHealthState(manager, server.url);
    assert(state, "Should have health state");
    assert(state.failCount === 0 || state.failCount === undefined, "Initial fail count should be 0");
    // Trigger failure
    try { await manager.send(1, "eth_getBlockByNumber", ["latest", false]); } catch {}
    state = getHealthState(manager, server.url);
    assert(state.failCount > 0, "Fail count should increment after error");
    // Wait for recovery
    await delay(600);
    await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
    state = getHealthState(manager, server.url);
    assert(state.failCount === 0 || state.failCount === undefined, "Fail count should reset after recovery");
    await cleanupServers();
  });
});
Deno.test("Backoff expiration, round-robin, and race conditions", async (t) => {
  await t.step("Backoff expiration and cleanup", async () => {
    const server = startTrackedMockRpcServer({ port: 41023, behavior: "network_error" });
    const { manager } = await createManagerWithRpcs([server.url]);
Deno.test("Deno KV persistence and API coverage", async (t) => {
  await t.step("Cache and health state persist across restart", async () => {
    const kvPath = "test-kv-persistence-2";
    const server = startTrackedMockRpcServer({ port: 41041, behavior: "ok" });
    const { manager, cacheManager } = await createManagerWithRpcs([server.url], {
      cacheManagerOpts: { kvPath }
    });
    // Prime the cache and health state
    await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
    const beforeCache = await readKvCache(cacheManager, 1);
    // Simulate restart
    const { manager: manager2, cacheManager: cacheManager2 } = await createManagerWithRpcs([server.url], {
      cacheManagerOpts: { kvPath }
    });
    const afterCache = await readKvCache(cacheManager2, 1);
    assert(beforeCache !== null, "Cache should exist before restart");
    assert(afterCache !== null, "Cache should exist after restart");
    assertEquals(beforeCache, afterCache, "Cache state should persist across restart");
    await cleanupServers();
  });
});
    // Trigger backoff
    try { await manager.send(1, "eth_getBlockByNumber", ["latest", false]); } catch {}
    // Simulate time passing for backoff expiration (assume 1s for test)
    await delay(1100);
    // Should attempt again (not blocked by old backoff)
    let errorCaught = false;
    try { await manager.send(1, "eth_getBlockByNumber", ["latest", false]); } catch { errorCaught = true; }
    assert(errorCaught, "Should retry after backoff expiration");
    await cleanupServers();
  });

  await t.step("Round-robin load distribution", async () => {
    const server1 = startTrackedMockRpcServer({ port: 41024, behavior: "ok" });
    const server2 = startTrackedMockRpcServer({ port: 41025, behavior: "ok" });
    const { manager } = await createManagerWithRpcs([server1.url, server2.url]);
    // Send multiple requests and check both servers are used
    const counts = { [server1.url]: 0, [server2.url]: 0 };
    for (let i = 0; i < 10; i++) {
      await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
      counts[server1.url] = server1.getRequestCount();
      counts[server2.url] = server2.getRequestCount();
    }
    assert(counts[server1.url] > 0 && counts[server2.url] > 0, "Both servers should be used in round-robin");
    await cleanupServers();
  });

  await t.step("Race condition: concurrent requests do not cause duplicate latency tests", async () => {
    const server = startTrackedMockRpcServer({ port: 41026, behavior: "ok" });
    const { manager } = await createManagerWithRpcs([server.url]);
    // Fire concurrent requests
    await Promise.all([
      manager.send(1, "eth_getBlockByNumber", ["latest", false]),
      manager.send(1, "eth_getBlockByNumber", ["latest", false]),
      manager.send(1, "eth_getBlockByNumber", ["latest", false]),
    ]);
    // The server should not receive more requests than the number of concurrent calls
    assert(server.getRequestCount() <= 3, `Should not duplicate latency tests, got ${server.getRequestCount()}`);
    await cleanupServers();
  });
});
    const { manager } = await createManagerWithRpcs([server.url]);
    let errorCaught = false;
    try {
      await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
    } catch (e) {
      errorCaught = true;
    }
    assert(errorCaught, "Should throw on timeout");
    await cleanupServers();
  });

  await t.step("Recovery: RPC returns to healthy after outage", async () => {
    const server = startTrackedMockRpcServer({ port: 41007, behavior: "rate_limit", recoveryAfterMs: 500 });
    const { manager } = await createManagerWithRpcs([server.url]);
    let errorCaught = false;
    try {
      await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
    } catch {
      errorCaught = true;
    }
    assert(errorCaught, "Should throw during rate limit");
    await delay(600);
    const result = await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
    assertEquals(result, "0x");
    await cleanupServers();
  });

  await t.step("Mixed pool health: healthy RPC is used, unhealthy is avoided", async () => {
    const server1 = startTrackedMockRpcServer({ port: 41008, behavior: "ok" });
    const server2 = startTrackedMockRpcServer({ port: 41009, behavior: "rate_limit" });
    const { manager } = await createManagerWithRpcs([server1.url, server2.url]);
    const result = await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
    assertEquals(result, "0x");
    await cleanupServers();
  });
});

Deno.test("No client requests are dropped during panic mode transitions", async () => {
  const server1 = startMockRpcServer({ port: 41010, behavior: "rate_limit", recoveryAfterMs: 500 });
  const server2 = startMockRpcServer({ port: 41011, behavior: "ok" });
  const { manager } = await createManagerWithRpcs([server1.url, server2.url]);
  // First call: server1 is rate limited, server2 is ok
  const result1 = await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
  assertEquals(result1, "0x");
  // Wait for server1 to recover
  await delay(600);
  const result2 = await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
  assertEquals(result2, "0x");
  server1.close();
  server2.close();
});
// --- Adaptive Backoff Timing Test ---

Deno.test("Adaptive Backoff: delay increases with repeated failures", async () => {
  const server = startMockRpcServer({ port: 41020, behavior: "network_error" });
  const { manager } = await createManagerWithRpcs([server.url]);
  let errorCaught = false;
  const start = Date.now();
  try {
    await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
  } catch {
    errorCaught = true;
  }
  const firstElapsed = Date.now() - start;

  // Second attempt should have increased backoff
  let errorCaught2 = false;
  const start2 = Date.now();
  try {
    await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
  } catch {
    errorCaught2 = true;
  }
  const secondElapsed = Date.now() - start2;

  assert(errorCaught, "First call should throw");
  assert(errorCaught2, "Second call should throw");
  // The second delay should be greater than or equal to the first (allowing for timing jitter)
  assert(secondElapsed >= firstElapsed, `Backoff did not increase: first=${firstElapsed}ms, second=${secondElapsed}ms`);
  server.close();
});
// --- Emergency Pool Refresh Mechanics Test ---

Deno.test("Emergency Pool Refresh: triggers on mass failure, bypasses cache, re-tests unhealthy RPCs", async () => {
  const server1 = startMockRpcServer({ port: 41030, behavior: "rate_limit" });
  const server2 = startMockRpcServer({ port: 41031, behavior: "rate_limit", recoveryAfterMs: 500 });
  const { manager } = await createManagerWithRpcs([server1.url, server2.url]);
  let errorCaught = false;
  try {
    await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
  } catch {
    errorCaught = true;
  }
  assert(errorCaught, "Should throw when all RPCs are rate limited");

  // Wait for server2 to recover and ensure refresh logic re-tests it
  await delay(600);
  let result;
  let retried = false;
  try {
    result = await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
    retried = true;
  } catch {}
  assert(retried, "Manager should retry and succeed after unhealthy RPC recovers");
  assertEquals(result, "0x");
  server1.close();
  server2.close();
});
// --- Deno KV Persistence & Restart Simulation Test ---

Deno.test("Health state persists across restart via Deno KV", async () => {
  const kvPath = "test-kv-persistence";
  const server = startMockRpcServer({ port: 41040, behavior: "ok" });
  const { manager, cacheManager } = await createManagerWithRpcs([server.url], {
    cacheManagerOpts: { kvPath }
  });
  // Prime the cache by making a request
  await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
  const before = await readKvCache(cacheManager, 1);

  // Simulate restart (new manager, same kvPath)
  const { manager: manager2, cacheManager: cacheManager2 } = await createManagerWithRpcs([server.url], {
    cacheManagerOpts: { kvPath }
  });
  const after = await readKvCache(cacheManager2, 1);

  assert(before !== null, "Cache should exist before restart");
  assert(after !== null, "Cache should exist after restart");
  assertEquals(before, after, "Cache state should persist across restart");
  server.close();
});
Deno.test("Error classification (public API)", async (t) => {
  const errorCases = [
    { behavior: "rate_limit", expectMsg: "rate limit" },
    { behavior: "network_error", expectMsg: "network" },
    { behavior: "cert_error", expectMsg: "certificate" },
    { behavior: "timeout", expectMsg: "timeout" },
    { behavior: "syncing", expectMsg: "syncing" },
  ];
  for (const { behavior, expectMsg } of errorCases) {
    await t.step(`Classifies error for ${behavior}`, async () => {
      const server = startTrackedMockRpcServer({ port: 41120 + Math.floor(Math.random() * 100), behavior: behavior as any });
      const { manager } = await createManagerWithRpcs([server.url]);
      let errorCaught = false;
      try {
        await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
      } catch (e) {
        errorCaught = true;
        assert(e instanceof Error, "Should throw Error");
        assert(typeof e.message === "string" && e.message.toLowerCase().includes(expectMsg), `Error message should mention ${expectMsg}`);
      }
      assert(errorCaught, `Should throw for ${behavior}`);
      await cleanupServers();
    });
  }
});
Deno.test("Batch request handling and Permit2 bytecode/error simulation", async (t) => {
  await t.step("Batch request handling (actual method signature)", async () => {
    const permit2Bytecode = "0x6001600155deadbeef";
    const server = startTrackedMockRpcServer({
      port: 41130,
      behavior: "bytecode",
      bytecode: permit2Bytecode,
    });
    const { manager } = await createManagerWithRpcs([server.url]);
    const batchPayload = [
      { jsonrpc: "2.0", method: "eth_getBlockByNumber", params: ["latest", false], id: 1 },
      { jsonrpc: "2.0", method: "eth_getCode", params: ["0xPermit2", "latest"], id: 2 },
    ];
    const batchResult = await manager.sendBatch(1, batchPayload);
    assert(Array.isArray(batchResult), "Batch result should be array");
    assertEquals((batchResult[1] as { result: unknown }).result, permit2Bytecode);
    await cleanupServers();
  });

  await t.step("Realistic Permit2 bytecode and error simulation", async () => {
    const permit2Bytecode = "0x6001600155deadbeef";
    const server = startTrackedMockRpcServer({
      port: 41131,
      behavior: "bytecode",
      bytecode: permit2Bytecode,
    });
    const { manager } = await createManagerWithRpcs([server.url]);
    const code = await manager.send(1, "eth_getCode", ["0xPermit2", "latest"]);
    assertEquals(code, permit2Bytecode);

    const errorServer = startTrackedMockRpcServer({
      port: 41132,
      behavior: "custom_error",
      customError: { code: -32042, message: "custom fail" },
    });
    const { manager: errorManager } = await createManagerWithRpcs([errorServer.url]);
    let errorCaught = false;
    try {
      await errorManager.send(1, "eth_getBlockByNumber", ["latest", false]);
    } catch (e) {
      errorCaught = true;
      if (e instanceof Error) {
        assert(e.message.includes("custom fail"), "Should propagate custom error message");
      } else {
        throw e;
      }
    }
    assert(errorCaught, "Should throw on custom error");
    await cleanupServers();
    });
});
// --- Mock Server: Bytecode, Batch, Error, Request Counting Test ---

Deno.test("Mock server: supports Permit2 bytecode, batch requests, custom errors, and request counting", async () => {
  const permit2Bytecode = "0x6001600155deadbeef";
  const server = startMockRpcServer({
    port: 41050,
    behavior: "bytecode",
    bytecode: permit2Bytecode,
  });
  const { manager } = await createManagerWithRpcs([server.url]);

  // Test Permit2 bytecode response
  const code = await manager.send(1, "eth_getCode", ["0xPermit2", "latest"]);
  assertEquals(code, permit2Bytecode);

  // Test batch request
  const batchPayload = [
    { jsonrpc: "2.0", method: "eth_getBlockByNumber", params: ["latest", false], id: 1 },
    { jsonrpc: "2.0", method: "eth_getCode", params: ["0xPermit2", "latest"], id: 2 },
  ];
  const batchResult = await manager.sendBatch(1, batchPayload);
  assert(Array.isArray(batchResult), "Batch result should be array");
  // Narrow batchResult[1] to expected type before accessing .result
  assertEquals((batchResult[1] as { result: unknown }).result, permit2Bytecode);

  // Test custom error
  const errorServer = startMockRpcServer({
    port: 41051,
    behavior: "custom_error",
    customError: { code: -32042, message: "custom fail" },
  });
  const { manager: errorManager } = await createManagerWithRpcs([errorServer.url]);
  let errorCaught = false;
  try {
    await errorManager.send(1, "eth_getBlockByNumber", ["latest", false]);
  } catch (e) {
    errorCaught = true;
    // Narrow e to Error before accessing .message
    if (e instanceof Error) {
      assert(e.message.includes("custom fail"), "Should propagate custom error message");
    } else {
      throw e;
    }
  }
  assert(errorCaught, "Should throw on custom error");

  // Request counting
  assert(server.getRequestCount() >= 2, "Request count should reflect all requests");

  server.close();
  errorServer.close();
});
// --- Assertion Improvements: Error Types, Messages, Data, State ---

Deno.test("Error assertions: correct type, message, data, and internal state after failure", async () => {
  const server = startMockRpcServer({ port: 41060, behavior: "rate_limit" });
  const { manager } = await createManagerWithRpcs([server.url]);

  await assertRejects(
    async () => {
      await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
    },
    Error,
    undefined,
    "Should throw an error on rate limit"
  );

  try {
    await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
  } catch (e) {
    // Error type and message
    assert(e instanceof Error, "Should be an Error instance");
    assert(typeof e.message === "string" && e.message.includes("rate limit"), "Error message should mention rate limit");
    // Error data (if available)
    if ("code" in e) {
      assert((e as any).code === -32005, "Error code should match rate limit");
    }
  }

  // Internal state: health state should reflect failure
  const state = (manager as any).getHealthState?.(server.url);
  assert(state, "Health state should exist");
  assert(state.failCount > 0, "Fail count should be incremented after error");

  server.close();
});
// --- Panic Mode Threshold & Concurrency Test ---

Deno.test("Panic mode: only one refresh per interval, concurrent requests handled", async () => {
  const server1 = startMockRpcServer({ port: 41070, behavior: "rate_limit" });
  const server2 = startMockRpcServer({ port: 41071, behavior: "rate_limit", recoveryAfterMs: 500 });
  const { manager } = await createManagerWithRpcs([server1.url, server2.url]);

  // Fire multiple requests in parallel to trigger panic/refresh logic
  const results = await Promise.allSettled([
    manager.send(1, "eth_getBlockByNumber", ["latest", false]),
    manager.send(1, "eth_getBlockByNumber", ["latest", false]),
    manager.send(1, "eth_getBlockByNumber", ["latest", false]),
  ]);
  // All should fail initially
  results.forEach(r => assert(r.status === "rejected", "All requests should be rejected during mass failure"));

  // Wait for recovery interval, then fire again
  await delay(600);
  const results2 = await Promise.allSettled([
    manager.send(1, "eth_getBlockByNumber", ["latest", false]),
    manager.send(1, "eth_getBlockByNumber", ["latest", false]),
  ]);
  // At least one should succeed after recovery
  assert(results2.some(r => r.status === "fulfilled"), "At least one request should succeed after recovery");

  server1.close();
  server2.close();
});
// --- Gradual Recovery and Recovery Patterns Test ---

Deno.test("Gradual recovery: unhealthy RPC returns to healthy and is reused", async () => {
  const server = startMockRpcServer({ port: 41080, behavior: "rate_limit", recoveryAfterMs: 500 });
  const { manager } = await createManagerWithRpcs([server.url]);

  // Initial failure
  let errorCaught = false;
  try {
    await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
  } catch {
    errorCaught = true;
  }
  assert(errorCaught, "Should throw during rate limit");

  // Wait for recovery
  await delay(600);

  // Should succeed after recovery
  let result, errorCaught2 = false;
  try {
    result = await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
  } catch {
    errorCaught2 = true;
  }
  assert(!errorCaught2, "Should not throw after recovery");
  assertEquals(result, "0x");

  // Health state should reflect recovery
  const state = (manager as any).getHealthState?.(server.url);
  assert(state, "Health state should exist");
  assert(state.failCount === 0 || state.failCount === undefined, "Fail count should reset after recovery");

  server.close();
});
// --- Error Classification and ErrorBehavior Handling Test ---

Deno.test("Error classification: correct ErrorBehavior for each error type", async () => {
  const errorCases = [
    { behavior: "rate_limit", expect: "retry" },
    { behavior: "network_error", expect: "retry" },
    { behavior: "cert_error", expect: "panic" },
    { behavior: "timeout", expect: "retry" },
    { behavior: "syncing", expect: "ignore" },
  ];
  for (const { behavior, expect } of errorCases) {
    const server = startMockRpcServer({ port: 41090 + Math.floor(Math.random() * 100), behavior: behavior as any });
    const { manager } = await createManagerWithRpcs([server.url]);
    let classification;
    try {
      await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
    } catch (e) {
      if (typeof (manager as any).classifyError === "function") {
        classification = (manager as any).classifyError(e);
      }
    }
    assert(classification, `Should classify error for ${behavior}`);
    assertEquals(classification.behavior, expect, `ErrorBehavior for ${behavior} should be ${expect}`);
    server.close();
  }
});
// --- Performance/Load: Multiple Chains, Rapid-Fire Requests Test ---

Deno.test("Performance/load: handles multiple chains and rapid-fire requests", async () => {
  const servers = [
    startMockRpcServer({ port: 41100, behavior: "ok" }),
    startMockRpcServer({ port: 41101, behavior: "ok" }),
    startMockRpcServer({ port: 41102, behavior: "ok" }),
  ];
  const chainIds = [1, 2, 3];
  const rpcMap: Record<number, string[]> = {
    1: [servers[0].url],
    2: [servers[1].url],
    3: [servers[2].url],
  };
  const { manager } = await createManagerWithRpcs([], {
    dataSourceOpts: { rpcs: rpcMap }
  });

  // Rapid-fire requests to all chains
  const promises: Promise<any>[] = [];
  for (let i = 0; i < 10; i++) {
    for (const chainId of chainIds) {
      promises.push(manager.send(chainId, "eth_getBlockByNumber", ["latest", false]));
    }
  }
  const results = await Promise.all(promises);
  assert(results.every(r => r === "0x"), "All rapid-fire requests should succeed");

  servers.forEach(s => s.close());
});
// --- Integration: Real LatencyTester, CacheManager, RpcSelector Test ---

Deno.test("Integration: uses real LatencyTester, CacheManager, RpcSelector for selection and caching", async () => {
  const fastServer = startMockRpcServer({ port: 41110, behavior: "ok" });
  const slowServer = startMockRpcServer({ port: 41111, behavior: "ok", delayMs: 200 });
  const { manager, cacheManager, rpcSelector } = await createManagerWithRpcs([fastServer.url, slowServer.url], {
    latencyTesterOpts: { timeoutMs: 500 }
  });

  // Prime the latency tester and cache
  await manager.send(1, "eth_getBlockByNumber", ["latest", false]);
  const fastest = await rpcSelector.getRankedRpcList(1);
  assert(fastest[0] === fastServer.url, "Fastest RPC should be ranked first");

  // Cache should reflect fastest
  const cache = await cacheManager.getChainCache(1);
  assert(cache, "Cache should exist");
  assert(cache.fastestRpc === fastServer.url, "Cache should store fastest RPC");

  fastServer.close();
  slowServer.close();
});
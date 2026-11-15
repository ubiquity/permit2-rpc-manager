import { deepStrictEqual as assertEquals } from "node:assert/strict";
import PERMIT2_BYTECODE_PREFIX from "../fixtures/permit2-bytecode.ts";
import { LatencyTester } from "./latency-tester.ts";
import { WorkerTransport } from "./worker-transport.ts";

// Deno can exercise the HTTP transport without providing workerd's upgrade extension.
declare global {
  interface Response {
    readonly webSocket: (WebSocket & { accept(): void }) | null;
  }
}

const VALID_RESULTS: Record<string, unknown> = {
  eth_getCode: `${PERMIT2_BYTECODE_PREFIX}deadbeef`,
  eth_syncing: false,
  eth_chainId: "0x1",
};

// A slot is held until the response body finishes, not just until headers arrive.
function singleSlotTransport(overrides: Record<string, unknown> = {}) {
  const active = new Set<string>();
  const methods = new Map<string, string[]>();
  const bodies: Promise<void>[] = [];
  let rejections = 0;
  let maxActive = 0;
  const fetcher: typeof fetch = (input, init) => {
    const url = String(input);
    const request = JSON.parse(String(init?.body));
    methods.set(url, [...(methods.get(url) ?? []), request.method]);
    if (active.has(url)) {
      rejections++;
      return Promise.resolve(new Response(null, { status: 429 }));
    }
    active.add(url);
    maxActive = Math.max(maxActive, active.size);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodies.push(
          new Promise<void>((resolve) => {
            setTimeout(() => {
              const results = { ...VALID_RESULTS, ...overrides };
              controller.enqueue(new TextEncoder().encode(JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                result: results[request.method],
              })));
              controller.close();
              active.delete(url);
              resolve();
            }, 1);
          }),
        );
      },
    });
    return Promise.resolve(new Response(body, { headers: { "content-type": "application/json" } }));
  };
  return {
    fetcher,
    methods,
    settle: () => Promise.all(bodies),
    get rejections() {
      return rejections;
    },
    get maxActive() {
      return maxActive;
    },
  };
}

// Like the diagnostics object, drain every transport call even when a probe defers early.
function trackedDiagnostics(transport: WorkerTransport) {
  const pending: Promise<Response>[] = [];
  const fetcher: typeof fetch = (input, init) => {
    const call = transport.diagnosticFetch(input, init);
    pending.push(call);
    return call;
  };
  return { fetcher, settle: () => Promise.allSettled(pending) };
}

Deno.test("LatencyTester: single-slot endpoints pass while different endpoints run concurrently", async () => {
  const transport = singleSlotTransport();
  const tester = new LatencyTester(1000, undefined, { fetcher: transport.fetcher });
  const urls = ["https://first.invalid/rpc", "https://second.invalid/rpc"];
  const results = await tester.testRpcUrls(1, urls);
  await transport.settle();
  for (const url of urls) {
    assertEquals(results[url].status, "ok");
    assertEquals(transport.methods.get(url), ["eth_getCode", "eth_syncing", "eth_chainId"]);
  }
  assertEquals(transport.rejections, 0);
  assertEquals(transport.maxActive, 2);
});

for (
  const [method, value, status] of [
    ["eth_chainId", "0x2", "wrong_chain_id"],
    ["eth_getCode", "0x", "wrong_bytecode"],
    ["eth_syncing", { currentBlock: "0x1" }, "syncing"],
  ] as const
) {
  Deno.test(`LatencyTester: single-slot ${status} is still rejected`, async () => {
    const transport = singleSlotTransport({ [method]: value });
    const tester = new LatencyTester(1000, undefined, { fetcher: transport.fetcher });
    const url = "https://example.invalid/rpc";
    const results = await tester.testRpcUrls(1, [url]);
    await transport.settle();
    assertEquals(results[url].status, status);
    assertEquals(transport.rejections, 0);
    assertEquals(transport.methods.get(url), ["eth_getCode", "eth_syncing", "eth_chainId"]);
  });
}

Deno.test("LatencyTester: disabling chain validation still serializes the two required checks", async () => {
  const transport = singleSlotTransport();
  const tester = new LatencyTester(1000, undefined, { fetcher: transport.fetcher, validateChainId: false });
  const url = "https://example.invalid/rpc";
  const results = await tester.testRpcUrls(1, [url]);
  await transport.settle();
  assertEquals(results[url].status, "ok");
  assertEquals(transport.methods.get(url), ["eth_getCode", "eth_syncing"]);
  assertEquals(transport.rejections, 0);
});

Deno.test("LatencyTester: real HTTP admission failures remain http_error", async () => {
  const methods: string[] = [];
  const tester = new LatencyTester(1000, undefined, {
    fetcher: (_input, init) => {
      methods.push(JSON.parse(String(init?.body)).method);
      return Promise.resolve(new Response(null, { status: 429 }));
    },
  });
  const url = "https://example.invalid/rpc";
  const results = await tester.testRpcUrls(1, [url]);
  assertEquals(results[url].status, "http_error");
  assertEquals(results[url].latency, Infinity);
  assertEquals(methods, ["eth_getCode"]);
});

Deno.test("LatencyTester: a stalled body times out and a subsequent probe can succeed", async () => {
  let stall = true;
  let aborted = false;
  let calls = 0;
  const tester = new LatencyTester(20, undefined, {
    fetcher: (_input, init) => {
      calls++;
      if (!stall) {
        const request = JSON.parse(String(init?.body));
        return Promise.resolve(Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: VALID_RESULTS[request.method],
        }));
      }
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              const watchdog = setTimeout(() => controller.error(new Error("Body was not aborted")), 1000);
              init?.signal?.addEventListener("abort", () => {
                clearTimeout(watchdog);
                aborted = true;
                controller.error(init.signal?.reason);
              }, { once: true });
            },
          }),
        ),
      );
    },
  });
  const url = "https://example.invalid/rpc";
  const failed = await tester.testRpcUrls(1, [url]);
  assertEquals(failed[url].status, "timeout");
  assertEquals(aborted, true);
  assertEquals(calls, 1);
  stall = false;
  const recovered = await tester.testRpcUrls(1, [url]);
  assertEquals(recovered[url].status, "ok");
  assertEquals(calls, 4);
});

Deno.test("LatencyTester: Workers still batch all checks in one budgeted HTTP request", async () => {
  const methods: string[][] = [];
  const transport = new WorkerTransport((_input, init) => {
    const requests = JSON.parse(String(init?.body)) as Array<{ id: string; method: string }>;
    methods.push(requests.map((request) => request.method));
    return Promise.resolve(Response.json(
      requests.map((request) => ({
        jsonrpc: "2.0",
        id: request.id,
        result: VALID_RESULTS[request.method],
      })).reverse(),
    ));
  }, 1);
  const tester = new LatencyTester(1000, undefined, { fetcher: transport.diagnosticFetch, batchChecks: true });
  const url = "https://example.invalid/rpc";
  const results = await tester.testRpcUrls(1, [url]);
  assertEquals(results[url].status, "ok");
  assertEquals(methods, [["eth_getCode", "eth_syncing", "eth_chainId"]]);
  assertEquals(transport.totalUsed, 1);
});

for (const rejection of ["single-error", "per-item-errors"] as const) {
  Deno.test(`LatencyTester: Workers ${rejection} fallback honors a single admission slot`, async () => {
    const singles = singleSlotTransport();
    const transport = new WorkerTransport((input, init) => {
      const requests = JSON.parse(String(init?.body)) as Array<{ id: string }>;
      if (!Array.isArray(requests)) return singles.fetcher(input, init);
      const error = { code: -32600, message: "Batch unsupported" };
      return Promise.resolve(
        Response.json(
          rejection === "single-error"
            ? { jsonrpc: "2.0", id: null, error }
            : requests.map((request) => ({ jsonrpc: "2.0", id: request.id, error })),
        ),
      );
    }, 4);
    const tester = new LatencyTester(1000, undefined, { fetcher: transport.diagnosticFetch, batchChecks: true });
    const url = "https://example.invalid/rpc";
    const results = await tester.testRpcUrls(1, [url]);
    await singles.settle();
    assertEquals(results[url].status, "ok");
    assertEquals(singles.rejections, 0);
    assertEquals(singles.methods.get(url), ["eth_getCode", "eth_syncing", "eth_chainId"]);
    assertEquals(transport.totalUsed, 4);
  });
}

Deno.test("LatencyTester: serialized Workers fallback still defers when its budget is exhausted", async () => {
  const singles = singleSlotTransport();
  const transport = new WorkerTransport((input, init) => {
    if (!Array.isArray(JSON.parse(String(init?.body)))) return singles.fetcher(input, init);
    return Promise.resolve(Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600 } }));
  }, 3);
  const diagnostics = trackedDiagnostics(transport);
  const tester = new LatencyTester(1000, undefined, { fetcher: diagnostics.fetcher, batchChecks: true });
  const url = "https://example.invalid/rpc";
  const results = await tester.testRpcUrls(1, [url]);
  await diagnostics.settle();
  await singles.settle();
  assertEquals(results[url].status, "deferred");
  assertEquals(singles.rejections, 0);
  assertEquals(singles.methods.get(url), ["eth_getCode", "eth_syncing"]);
  assertEquals(transport.totalUsed, 3);
});

Deno.test("LatencyTester: batch-rejecting endpoints make complete-probe progress within a shared budget", async () => {
  const singles = singleSlotTransport();
  const transport = new WorkerTransport((input, init) => {
    if (!Array.isArray(JSON.parse(String(init?.body)))) return singles.fetcher(input, init);
    return Promise.resolve(Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600 } }));
  }, 8);
  const diagnostics = trackedDiagnostics(transport);
  const tester = new LatencyTester(1000, undefined, { fetcher: diagnostics.fetcher, batchChecks: true });
  const urls = Array.from({ length: 4 }, (_, index) => `https://rpc-${index}.invalid/rpc`);
  const results = await tester.testRpcUrls(1, urls);
  await diagnostics.settle();
  await singles.settle();
  assertEquals(Object.values(results).filter((result) => result.status === "ok").length, 1);
  assertEquals(Object.values(results).filter((result) => result.status === "deferred").length, 3);
  assertEquals(singles.rejections, 0);
  assertEquals(transport.totalUsed, 8);
});

import { assertEquals } from "jsr:@std/assert@1";
import { getRpcEndpointId } from "./rpc-endpoint-id.ts";
import { HeadTracker } from "./head-tracker.ts";
import { RpcMetricsRegistry } from "./rpc-metrics.ts";

Deno.test("HeadTracker: redacts RPC URLs from sampling diagnostics", async () => {
  const rpcUrl = "https://user:super-secret@rpc.example/rpc?apiKey=very-secret";
  const diagnostics: unknown[][] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error(`Head sample failed for ${rpcUrl}`))) as typeof fetch;

  try {
    const tracker = new HeadTracker(new RpcMetricsRegistry(), {
      logger: (...args) => diagnostics.push(args),
    });
    await tracker.maybeSampleHeads(1, [rpcUrl]);

    const logged = JSON.stringify(diagnostics);
    assertEquals(logged.includes(rpcUrl), false);
    assertEquals(logged.includes("super-secret"), false);
    assertEquals(logged.includes(getRpcEndpointId(rpcUrl)), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

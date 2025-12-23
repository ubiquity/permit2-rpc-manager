import { assertEquals } from "jsr:@std/assert@1";
import { RpcMethodCapabilities } from "./rpc-capabilities.ts";

function createClock(startMs = 0) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

Deno.test("RpcMethodCapabilities: unknown by default and filterSupported is no-op", () => {
  const clock = createClock();
  const caps = new RpcMethodCapabilities({ now: clock.now });

  assertEquals(caps.get(1, "https://a.example", "eth_getBalance"), "unknown");
  assertEquals(caps.filterSupported(1, "eth_getBalance", ["https://a.example", "https://b.example"]), ["https://a.example", "https://b.example"]);
});

Deno.test("RpcMethodCapabilities: markUnsupported excludes only that (chainId,rpcUrl,method) tuple", () => {
  const clock = createClock();
  const caps = new RpcMethodCapabilities({ now: clock.now });

  caps.markUnsupported(1, "https://a.example", "debug_traceCall", "method_not_found", 60_000);

  assertEquals(caps.get(1, "https://a.example", "debug_traceCall"), "unsupported");
  assertEquals(caps.get(1, "https://a.example", "eth_getBalance"), "unknown");
  assertEquals(caps.get(10, "https://a.example", "debug_traceCall"), "unknown");

  assertEquals(caps.filterSupported(1, "debug_traceCall", ["https://a.example", "https://b.example"]), ["https://b.example"]);
  assertEquals(caps.filterSupported(1, "eth_getBalance", ["https://a.example", "https://b.example"]), ["https://a.example", "https://b.example"]);
});

Deno.test("RpcMethodCapabilities: TTL expiry returns to unknown and stops filtering", () => {
  const clock = createClock();
  const caps = new RpcMethodCapabilities({ now: clock.now });

  caps.markUnsupported(1, "https://a.example", "debug_traceCall", "method_not_found", 1_000);
  assertEquals(caps.get(1, "https://a.example", "debug_traceCall"), "unsupported");

  clock.advance(1_001);
  assertEquals(caps.get(1, "https://a.example", "debug_traceCall"), "unknown");
  assertEquals(caps.filterSupported(1, "debug_traceCall", ["https://a.example", "https://b.example"]), ["https://a.example", "https://b.example"]);
});

Deno.test("RpcMethodCapabilities: repeated unsupported escalates TTL within strike window", () => {
  const clock = createClock();
  const caps = new RpcMethodCapabilities({ now: clock.now, strikeWindowMs: 10_000 });

  caps.markUnsupported(1, "https://a.example", "debug_traceCall", "method_not_found", 1_000);
  clock.advance(100);
  caps.markUnsupported(1, "https://a.example", "debug_traceCall", "method_not_found", 1_000);
  assertEquals(caps.get(1, "https://a.example", "debug_traceCall"), "unsupported");

  clock.advance(1_400);
  assertEquals(caps.get(1, "https://a.example", "debug_traceCall"), "unsupported");

  clock.advance(601);
  assertEquals(caps.get(1, "https://a.example", "debug_traceCall"), "unknown");
});

Deno.test("RpcMethodCapabilities: strike window expiry resets escalation", () => {
  const clock = createClock();
  const caps = new RpcMethodCapabilities({ now: clock.now, strikeWindowMs: 100 });

  caps.markUnsupported(1, "https://a.example", "debug_traceCall", "method_not_found", 1_000);
  clock.advance(200);
  caps.markUnsupported(1, "https://a.example", "debug_traceCall", "method_not_found", 1_000);

  clock.advance(1_001);
  assertEquals(caps.get(1, "https://a.example", "debug_traceCall"), "unknown");
});

Deno.test("RpcMethodCapabilities: markSupported clears unsupported entries", () => {
  const clock = createClock();
  const caps = new RpcMethodCapabilities({ now: clock.now });

  caps.markUnsupported(1, "https://a.example", "debug_traceCall", "method_not_found", 60_000);
  assertEquals(caps.get(1, "https://a.example", "debug_traceCall"), "unsupported");

  caps.markSupported(1, "https://a.example", "debug_traceCall");
  assertEquals(caps.get(1, "https://a.example", "debug_traceCall"), "unknown");
});

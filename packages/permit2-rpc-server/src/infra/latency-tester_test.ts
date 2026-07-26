import { assertEquals } from "jsr:@std/assert@1";
import { LatencyTester } from "./latency-tester.ts";
import PERMIT2_BYTECODE_PREFIX from "../fixtures/permit2-bytecode.ts";

function makeJsonRpcResponse(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

Deno.test("LatencyTester: eth_chainId mismatch returns wrong_chain_id", async () => {
  const realFetch = globalThis.fetch;

  try {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const method = String(body.method ?? "");
      let result: unknown;

      if (method === "eth_getCode") {
        result = `${PERMIT2_BYTECODE_PREFIX}deadbeef`;
      } else if (method === "eth_syncing") {
        result = false;
      } else if (method === "eth_chainId") {
        result = "0x2";
      } else {
        result = null;
      }

      return Promise.resolve(
        new Response(JSON.stringify(makeJsonRpcResponse(body.id, result)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }) as typeof fetch;

    const tester = new LatencyTester(250);
    const url = "https://example.invalid/rpc";
    const results = await tester.testRpcUrls(1, [url]);

    assertEquals(results[url]?.status, "wrong_chain_id");
    assertEquals(results[url]?.observedChainId, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

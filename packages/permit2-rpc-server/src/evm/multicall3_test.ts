import { assertEquals } from "jsr:@std/assert@1";
import type { JsonRpcRequest } from "../core/types.ts";
import { isMulticall3Request } from "./multicall3.ts";

const chainId = 100;
const baseCall = { to: "0x0000000000000000000000000000000000000000", data: "0x1234" };
const baseRequest: JsonRpcRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "eth_call",
  params: [baseCall, "latest"],
};

Deno.test("isMulticall3Request: accepts simple eth_call with only to/data", () => {
  assertEquals(isMulticall3Request(chainId, baseRequest), true);
});

Deno.test("isMulticall3Request: rejects eth_call with from set", () => {
  const withFrom = {
    ...baseRequest,
    params: [{ ...baseCall, from: "0x0000000000000000000000000000000000000001" }, "latest"],
  } satisfies JsonRpcRequest;
  assertEquals(isMulticall3Request(chainId, withFrom as JsonRpcRequest), false);
});

Deno.test("isMulticall3Request: rejects eth_call with extra params", () => {
  const withOverride = {
    ...baseRequest,
    params: [baseCall, "latest", { stateOverride: {} }],
  } satisfies JsonRpcRequest;
  assertEquals(isMulticall3Request(chainId, withOverride as JsonRpcRequest), false);
});

Deno.test("isMulticall3Request: rejects eth_call with value set", () => {
  const withValue = {
    ...baseRequest,
    params: [{ ...baseCall, value: "0x0" }, "latest"],
  } satisfies JsonRpcRequest;
  assertEquals(isMulticall3Request(chainId, withValue as JsonRpcRequest), false);
});

Deno.test("isMulticall3Request: accepts ID 0", () => {
  const idZeroRequest = { ...baseRequest, id: 0 } satisfies JsonRpcRequest;
  assertEquals(isMulticall3Request(chainId, idZeroRequest), true);
});

Deno.test("isMulticall3Request: rejects every sender-sensitive Permit2 selector", () => {
  for (const selector of ["0x30f28b7a", "0x6700a7c5", "0x32d88955", "0xbba8c6d5"]) {
    const permitCall = {
      ...baseRequest,
      params: [{ ...baseCall, data: `${selector}00` }, "latest"],
    } satisfies JsonRpcRequest;
    assertEquals(isMulticall3Request(chainId, permitCall as JsonRpcRequest), false, selector);
  }
});

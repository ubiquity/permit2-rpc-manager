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

Deno.test("isMulticall3Request: rejects sender-sensitive selectors", () => {
  const permitCall = {
    ...baseRequest,
    params: [{ ...baseCall, data: "0x30f28b7a00" }, "latest"],
  } satisfies JsonRpcRequest;
  assertEquals(isMulticall3Request(chainId, permitCall as JsonRpcRequest), false);
});

import { assertEquals } from "jsr:@std/assert@1";
import { isSafeToCache, isWriteMethod } from "./method-classifier.ts";

Deno.test("isWriteMethod: known write methods", () => {
  const writeMethods = [
    "eth_sendRawTransaction",
    "eth_sendTransaction",
    "eth_signTransaction",
    "eth_sign",
    "eth_signTypedData",
    "eth_signTypedData_v4",
    "personal_sign",
  ];

  for (const method of writeMethods) {
    assertEquals(isWriteMethod(method), true, `expected ${method} to be write`);
  }
});

Deno.test("isWriteMethod: known safe reads", () => {
  const readMethods = [
    "eth_call",
    "eth_chainId",
    "eth_getBalance",
    "eth_getLogs",
    "eth_blockNumber",
    "net_version",
    "web3_clientVersion",
  ];

  for (const method of readMethods) {
    assertEquals(isWriteMethod(method), false, `expected ${method} to be read`);
  }
});

Deno.test("isWriteMethod: filter methods are treated as write (unsafe to hedge)", () => {
  const unsafe = [
    "eth_newFilter",
    "eth_newBlockFilter",
    "eth_newPendingTransactionFilter",
    "eth_uninstallFilter",
    "eth_getFilterChanges",
    "eth_getFilterLogs",
  ];

  for (const method of unsafe) {
    assertEquals(isWriteMethod(method), true, `expected ${method} to be unsafe`);
  }
});

Deno.test("isWriteMethod: unknown methods default to conservative (do not hedge)", () => {
  assertEquals(isWriteMethod("debug_traceBlockByNumber"), true);
  assertEquals(isWriteMethod("trace_call"), true);
});

Deno.test("isSafeToCache: only trivial identity methods", () => {
  assertEquals(isSafeToCache("eth_chainId"), true);
  assertEquals(isSafeToCache("net_version"), true);
  assertEquals(isSafeToCache("eth_blockNumber"), false);
});

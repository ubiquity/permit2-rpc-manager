import { beforeAll, describe, expect, it } from "bun:test";
import type { JsonRpcResponse, Permit2RpcClient } from "./index";
import { createRpcClient } from "./index";
import process from "node:process";

// --- Test Configuration ---
// Read target URL from environment variable, default to deployed URL
const SERVER_BASE_URL = process.env.TEST_TARGET_URL ?? "https://permit2-rpc-proxy.deno.dev";
const LOCAL_SERVER_URL = "http://localhost:8000"; // Default local Deno port
const GNOSIS_CHAIN_ID = 100;
const WXDAI_CONTRACT = "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d"; // WXDAI on Gnosis
const HOLDER_ADDRESS = "0x054Ec26398549588F3c958719bD17CC1e6E97c3C";
const BALANCE_OF_DATA = `0x70a08231000000000000000000000000${HOLDER_ADDRESS.substring(2)}`;
// --- End Configuration ---

describe(`Permit2 RPC Client SDK (Target: ${SERVER_BASE_URL})`, () => {
  let client: Permit2RpcClient;

  beforeAll(() => {
    // Initialize client pointing to the server (local or deployed)
    client = createRpcClient({ baseUrl: SERVER_BASE_URL });
  });

  it("should create a client instance", () => {
    expect(client).toBeDefined();
    expect(client.request).toBeInstanceOf(Function);
  });

  it("should handle a single eth_blockNumber request", async () => {
    const response = await client.request(GNOSIS_CHAIN_ID, {
      jsonrpc: "2.0",
      method: "eth_blockNumber",
      params: [],
      id: 1,
    });

    console.log("Single eth_blockNumber response:", JSON.stringify(response));

    // Basic validation
    expect(response).toBeDefined();
    expect(Array.isArray(response)).toBe(false);
    const singleResponse = response as JsonRpcResponse;
    expect(singleResponse.jsonrpc).toBe("2.0");
    expect(singleResponse.id).toBe(1);
    expect(singleResponse.error).toBeUndefined();
    expect(singleResponse.result).toBeDefined();
    expect(typeof singleResponse.result).toBe("string"); // Block number is hex string
    expect((singleResponse.result as string).startsWith("0x")).toBe(true);
  });

  it("should handle a single eth_call request (WXDAI balance)", async () => {
    const response = await client.request(GNOSIS_CHAIN_ID, {
      jsonrpc: "2.0",
      method: "eth_call",
      params: [{ to: WXDAI_CONTRACT, data: BALANCE_OF_DATA }, "latest"],
      id: 2,
    });

    console.log("Single eth_call response:", JSON.stringify(response));

    expect(response).toBeDefined();
    expect(Array.isArray(response)).toBe(false);
    const singleResponse = response as JsonRpcResponse;
    expect(singleResponse.jsonrpc).toBe("2.0");
    expect(singleResponse.id).toBe(2);
    expect(singleResponse.error).toBeUndefined();
    expect(singleResponse.result).toBeDefined();
    expect(typeof singleResponse.result).toBe("string");
    // Check if it's the expected balance hex
    expect(singleResponse.result).toBe("0x000000000000000000000000000000000000000000000000d7d0401b76198000");
  });

  it("should handle a batch request", async () => {
    const response = await client.request(GNOSIS_CHAIN_ID, [
      { jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 10 },
      { jsonrpc: "2.0", method: "eth_chainId", params: [], id: 11 },
      {
        jsonrpc: "2.0",
        method: "eth_call",
        params: [{ to: WXDAI_CONTRACT, data: BALANCE_OF_DATA }, "latest"],
        id: 12,
      },
    ]);

    console.log("Batch response:", JSON.stringify(response));

    expect(response).toBeDefined();
    expect(Array.isArray(response)).toBe(true);
    const batchResponse = response as JsonRpcResponse[];
    expect(batchResponse.length).toBe(3);

    // Check first response (blockNumber)
    const res10 = batchResponse.find((r) => r.id === 10);
    expect(res10).toBeDefined();
    expect(res10?.jsonrpc).toBe("2.0");
    expect(res10?.error).toBeUndefined();
    expect(res10?.result).toBeDefined();
    expect(typeof res10?.result).toBe("string");
    expect((res10?.result as string).startsWith("0x")).toBe(true);

    // Check second response (chainId)
    const res11 = batchResponse.find((r) => r.id === 11);
    expect(res11).toBeDefined();
    expect(res11?.jsonrpc).toBe("2.0");
    expect(res11?.error).toBeUndefined();
    expect(res11?.result).toBe("0x64"); // Chain ID 100 in hex

    // Check third response (balance)
    const res12 = batchResponse.find((r) => r.id === 12);
    expect(res12).toBeDefined();
    expect(res12?.jsonrpc).toBe("2.0");
    expect(res12?.error).toBeUndefined();
    expect(res12?.result).toBe("0x000000000000000000000000000000000000000000000000d7d0401b76198000");
  });

  it("should handle errors in batch requests gracefully", async () => {
    const response = await client.request(GNOSIS_CHAIN_ID, [
      { jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 20 },
      { jsonrpc: "2.0", method: "invalid_method", params: [], id: 21 }, // Invalid method
      { jsonrpc: "2.0", method: "eth_chainId", params: [], id: 22 },
    ]);

    console.log("Batch error response:", JSON.stringify(response));

    expect(response).toBeDefined();
    expect(Array.isArray(response)).toBe(true);
    const batchResponse = response as JsonRpcResponse[];
    expect(batchResponse.length).toBe(3);

    // Check successful response
    const res20 = batchResponse.find((r) => r.id === 20);
    expect(res20).toBeDefined();
    expect(res20?.error).toBeUndefined();
    expect(res20?.result).toBeDefined();

    // Check error response
    const res21 = batchResponse.find((r) => r.id === 21);
    expect(res21).toBeDefined();
    expect(res21?.result).toBeUndefined();
    expect(res21?.error).toBeDefined();
    expect(res21?.error?.code).toBeDefined();
    expect(res21?.error?.message).toBeDefined();
    expect(res21?.error?.data).toBeDefined(); // Verify error data exists

    // Check successful response
    const res22 = batchResponse.find((r) => r.id === 22);
    expect(res22).toBeDefined();
    expect(res22?.error).toBeUndefined();
    expect(res22?.result).toBe("0x64");
  });

  it("should throw JSON-RPC errors with full structure", async () => {
    try {
      await client.request(GNOSIS_CHAIN_ID, {
        jsonrpc: "2.0",
        method: "invalid_method",
        params: [],
        id: 30,
      });
      const err = new Error("Method invalid_method did not throw as expected");
      (err as any).data = "No error thrown for invalid_method";
      throw err;
    } catch (error) {
      expect(error).toBeDefined();
      expect(typeof error === "object").toBe(true);
      expect(error).toBeInstanceOf(Error);
      const errorObj = error as any;
      expect(errorObj.message).toContain("Internal Server Error");
      expect("message" in errorObj).toBe(true);
      expect("data" in errorObj).toBe(true);
    }
  });

  it("should include revert reasons in error data", async () => {
    try {
      await client.request(GNOSIS_CHAIN_ID, {
        jsonrpc: "2.0",
        method: "eth_call",
        params: [{ to: "0x0000000000000000000000000000000000000000", data: "0x" }, "latest"],
        id: 31,
      });
      const err = new Error("Method eth_call did not throw as expected");
      (err as any).data = "No error thrown for eth_call";
      throw err;
    } catch (error) {
      expect(error).toBeDefined();
      expect(typeof error === "object").toBe(true);
      expect(error).toBeInstanceOf(Error);
      const errorObj = error as any;
      // This test should fail and include revert reason data
      expect(errorObj.message).toBeDefined();
      expect("message" in errorObj).toBe(true);
      expect("data" in errorObj).toBe(true);
      expect(typeof errorObj.data === "string").toBe(true);
    }
  });
});

import assert from "node:assert/strict";
import { createHandler, type RequestHandlerManager } from "./deno-server.ts";

Deno.test("HTTP batch responses preserve ordinary JSON-RPC ID 0", async () => {
  const calls: Array<{ chainId: number; method: string; params: unknown[] }> = [];
  const manager: RequestHandlerManager = {
    getHealthStatus: () => Promise.resolve({}),
    multicall3: () => Promise.resolve([]),
    send: <T = unknown>(chainId: number, method: string, params: unknown[] = []): Promise<T> => {
      calls.push({ chainId, method, params });
      return Promise.resolve({ method } as T);
    },
  };
  const handler = createHandler(manager);

  const response = await handler(
    new Request("http://localhost/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 0, method: "eth_chainId", params: [] },
        { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
      ]),
    }),
  );

  assert.equal(response.status, 200);
  const responses = await response.json();
  assert.ok(Array.isArray(responses));
  assert.deepEqual(
    responses.map((item) => item.id),
    [0, 1],
  );
  assert.deepEqual(responses, [
    { jsonrpc: "2.0", id: 0, result: { method: "eth_chainId" } },
    { jsonrpc: "2.0", id: 1, result: { method: "eth_blockNumber" } },
  ]);
  assert.deepEqual(calls, [
    { chainId: 1, method: "eth_chainId", params: [] },
    { chainId: 1, method: "eth_blockNumber", params: [] },
  ]);
});

Deno.test("HTTP batches execute null-ID notifications without returning them", async () => {
  const calls: Array<{ chainId: number; method: string; params: unknown[] }> = [];
  const manager: RequestHandlerManager = {
    getHealthStatus: () => Promise.resolve({}),
    multicall3: () => Promise.resolve([]),
    send: <T = unknown>(chainId: number, method: string, params: unknown[] = []): Promise<T> => {
      calls.push({ chainId, method, params });
      return Promise.resolve({ method } as T);
    },
  };

  const response = await createHandler(manager)(
    new Request("http://localhost/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: null, method: "eth_chainId", params: [] },
        { jsonrpc: "2.0", id: 0, method: "eth_blockNumber", params: [] },
      ]),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [
    { jsonrpc: "2.0", id: 0, result: { method: "eth_blockNumber" } },
  ]);
  assert.deepEqual(calls, [
    { chainId: 1, method: "eth_chainId", params: [] },
    { chainId: 1, method: "eth_blockNumber", params: [] },
  ]);
});

Deno.test("HTTP notifications execute directly and return no content", async () => {
  const calls: Array<{ chainId: number; method: string; params: unknown[] }> = [];
  let multicallCalls = 0;
  const manager: RequestHandlerManager = {
    getHealthStatus: () => Promise.resolve({}),
    multicall3: () => {
      multicallCalls++;
      return Promise.resolve([]);
    },
    send: <T = unknown>(chainId: number, method: string, params: unknown[] = []): Promise<T> => {
      calls.push({ chainId, method, params });
      return Promise.resolve("notification-result" as T);
    },
  };
  const handler = createHandler(manager);
  const notification = {
    jsonrpc: "2.0",
    id: null,
    method: "eth_call",
    params: [{ to: "0x0000000000000000000000000000000000000001", data: "0x" }, "latest"],
  };

  const batchResponse = await handler(
    new Request("http://localhost/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([notification]),
    }),
  );
  assert.equal(batchResponse.status, 204);
  assert.equal(await batchResponse.text(), "");

  const singleResponse = await handler(
    new Request("http://localhost/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(notification),
    }),
  );
  assert.equal(singleResponse.status, 204);
  assert.equal(await singleResponse.text(), "");
  assert.equal(multicallCalls, 0);
  assert.deepEqual(calls, [
    { chainId: 1, method: "eth_call", params: notification.params },
    { chainId: 1, method: "eth_call", params: notification.params },
  ]);
});

Deno.test("HTTP errors redact upstream credentials from message and data", async () => {
  const upstreamUrl = "https://rpc-user:rpc-password@rpc.example.test/v1?token=secret-query-token";
  const upstreamError = Object.assign(new Error(`Upstream request failed: ${upstreamUrl}`), {
    data: { endpoint: upstreamUrl },
  });
  const manager: RequestHandlerManager = {
    getHealthStatus: () => Promise.resolve({}),
    multicall3: () => Promise.resolve([]),
    send: <T = unknown>(): Promise<T> => Promise.reject(upstreamError),
  };

  const response = await createHandler(manager)(
    new Request("http://localhost/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    }),
  );

  assert.equal(response.status, 200);
  const serializedBody = await response.text();
  assert.doesNotMatch(serializedBody, /rpc\.example\.test/);
  assert.doesNotMatch(serializedBody, /rpc-user:rpc-password/);
  assert.doesNotMatch(serializedBody, /secret-query-token/);
  assert.match(serializedBody, /rpc-[0-9a-f]{16}/);
});

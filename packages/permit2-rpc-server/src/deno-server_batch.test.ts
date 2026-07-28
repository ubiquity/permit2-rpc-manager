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

Deno.test("HTTP batches preserve explicit null IDs as response-bearing requests", async () => {
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
    { jsonrpc: "2.0", id: null, result: { method: "eth_chainId" } },
    { jsonrpc: "2.0", id: 0, result: { method: "eth_blockNumber" } },
  ]);

  const singleResponse = await createHandler(manager)(
    new Request("http://localhost/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: null, method: "eth_gasPrice", params: [] }),
    }),
  );
  assert.equal(singleResponse.status, 200);
  assert.deepEqual(await singleResponse.json(), { jsonrpc: "2.0", id: null, result: { method: "eth_gasPrice" } });

  assert.deepEqual(calls, [
    { chainId: 1, method: "eth_chainId", params: [] },
    { chainId: 1, method: "eth_blockNumber", params: [] },
    { chainId: 1, method: "eth_gasPrice", params: [] },
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
  assert.equal(batchResponse.headers.get("access-control-allow-origin"), "*");
  assert.equal(batchResponse.headers.get("content-type"), null);

  const singleResponse = await handler(
    new Request("http://localhost/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(notification),
    }),
  );
  assert.equal(singleResponse.status, 204);
  assert.equal(await singleResponse.text(), "");
  assert.equal(singleResponse.headers.get("access-control-allow-origin"), "*");
  assert.equal(singleResponse.headers.get("content-type"), null);
  assert.equal(multicallCalls, 0);
  assert.deepEqual(calls, [
    { chainId: 1, method: "eth_call", params: notification.params },
    { chainId: 1, method: "eth_call", params: notification.params },
  ]);
});

Deno.test("HTTP JSON-RPC batches normalize params and isolate invalid elements", async () => {
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
        { jsonrpc: "2.0", id: 1, method: "eth_chainId" },
        { jsonrpc: "2.0", method: "eth_blockNumber", params: [] },
        { jsonrpc: "2.0", id: 3, method: "eth_getBalance", params: null },
        { jsonrpc: "2.0", id: 4, method: "eth_getBalance", params: { address: "0x1" } },
        { jsonrpc: "2.0", id: null, method: "eth_gasPrice", params: [] },
      ]),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [
    { jsonrpc: "2.0", id: 1, result: { method: "eth_chainId" } },
    { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: Not a valid JSON-RPC object." } },
    {
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32602, message: "Invalid params: Named parameters are not supported." },
    },
    { jsonrpc: "2.0", id: null, result: { method: "eth_gasPrice" } },
  ]);
  assert.deepEqual(calls, [
    { chainId: 1, method: "eth_chainId", params: [] },
    { chainId: 1, method: "eth_blockNumber", params: [] },
    { chainId: 1, method: "eth_gasPrice", params: [] },
  ]);

  const primitiveParamsResponse = await handler(
    new Request("http://localhost/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "eth_getBalance", params: 1 }),
    }),
  );
  assert.equal(primitiveParamsResponse.status, 200);
  assert.deepEqual(await primitiveParamsResponse.json(), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: "Invalid Request: Not a valid JSON-RPC object or batch." },
  });
});

Deno.test("HTTP empty batches return one invalid-request object", async () => {
  const manager: RequestHandlerManager = {
    getHealthStatus: () => Promise.resolve({}),
    multicall3: () => Promise.resolve([]),
    send: <T = unknown>(): Promise<T> => Promise.resolve(undefined as T),
  };

  const response = await createHandler(manager)(
    new Request("http://localhost/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([]),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: "Invalid Request: Received empty batch." },
  });
});

Deno.test("HTTP named-params notifications suppress responses", async () => {
  let sendCalls = 0;
  const manager: RequestHandlerManager = {
    getHealthStatus: () => Promise.resolve({}),
    multicall3: () => Promise.resolve([]),
    send: <T = unknown>(): Promise<T> => {
      sendCalls++;
      return Promise.resolve(undefined as T);
    },
  };

  const response = await createHandler(manager)(
    new Request("http://localhost/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: { address: "0x1" } }),
    }),
  );

  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(response.headers.get("content-type"), null);
  assert.equal(sendCalls, 0);
});

Deno.test("MCP dispatch accepts named object params before Ethereum JSON-RPC validation", async () => {
  let sendCalls = 0;
  const manager: RequestHandlerManager = {
    getHealthStatus: () => Promise.resolve({}),
    multicall3: () => Promise.resolve([]),
    send: <T = unknown>(): Promise<T> => {
      sendCalls++;
      return Promise.resolve(undefined as T);
    },
  };

  const response = await createHandler(manager)(
    new Request("http://localhost/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "mcp", method: "tools/list", params: {} }),
    }),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.id, "mcp");
  assert.ok(Array.isArray(body.result.tools));
  assert.equal(sendCalls, 0);
});

Deno.test("MCP-shaped objects still require a valid JSON-RPC envelope", async () => {
  const manager: RequestHandlerManager = {
    getHealthStatus: () => Promise.resolve({}),
    multicall3: () => Promise.resolve([]),
    send: <T = unknown>(): Promise<T> => Promise.resolve(undefined as T),
  };
  const handler = createHandler(manager);

  for (
    const requestBody of [
      { jsonrpc: "1.0", id: 1, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: true, method: "tools/list", params: {} },
      { method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: null },
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: 1 },
    ]
  ) {
    const response = await handler(
      new Request("http://localhost/1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request: Not a valid JSON-RPC object or batch." },
    });
  }
});

Deno.test("MCP notifications suppress responses while explicit null IDs remain response-bearing", async () => {
  const calls: Array<{ chainId: number; method: string; params: unknown[] }> = [];
  const manager: RequestHandlerManager = {
    getHealthStatus: () => Promise.resolve({}),
    multicall3: () => Promise.resolve([]),
    send: <T = unknown>(chainId: number, method: string, params: unknown[] = []): Promise<T> => {
      calls.push({ chainId, method, params });
      return Promise.resolve("0x1" as T);
    },
  };
  const handler = createHandler(manager);
  const mcpCall = {
    jsonrpc: "2.0",
    method: "tools/call",
    params: { name: "eth_chainId", arguments: {} },
  };

  const notificationResponse = await handler(
    new Request("http://localhost/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mcpCall),
    }),
  );

  assert.equal(notificationResponse.status, 204);
  assert.equal(await notificationResponse.text(), "");
  assert.equal(notificationResponse.headers.get("access-control-allow-origin"), "*");
  assert.equal(notificationResponse.headers.get("content-type"), null);
  assert.deepEqual(calls, [{ chainId: 1, method: "eth_chainId", params: [] }]);

  const explicitNullResponse = await handler(
    new Request("http://localhost/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...mcpCall, id: null }),
    }),
  );

  assert.equal(explicitNullResponse.status, 200);
  const body = await explicitNullResponse.json();
  assert.equal(body.id, null);
  assert.equal(body.result.content[0].text, '"0x1"');
  assert.deepEqual(calls, [
    { chainId: 1, method: "eth_chainId", params: [] },
    { chainId: 1, method: "eth_chainId", params: [] },
  ]);
});

Deno.test("HTTP multicall responses restore client IDs and input order", async () => {
  let multicallIds: Array<number | string | null> = [];
  const manager: RequestHandlerManager = {
    getHealthStatus: () => Promise.resolve({}),
    multicall3: (_chainId, requests) => {
      multicallIds = requests.map((request) => request.id);
      return Promise.resolve(
        [...requests].reverse().map((request) => ({
          jsonrpc: "2.0" as const,
          id: request.id,
          result: "multicall:" + request.id,
        })),
      );
    },
    send: <T = unknown>(_chainId: number, method: string): Promise<T> => {
      return Promise.resolve(("direct:" + method) as T);
    },
  };

  const response = await createHandler(manager)(
    new Request("http://localhost/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          jsonrpc: "2.0",
          id: "duplicate",
          method: "eth_call",
          params: [{ to: "0x0000000000000000000000000000000000000001", data: "0xaaaa" }, "latest"],
        },
        {
          jsonrpc: "2.0",
          id: null,
          method: "eth_call",
          params: [{ to: "0x0000000000000000000000000000000000000001", data: "0xaaaa" }, "latest"],
        },
        { jsonrpc: "2.0", id: "direct", method: "eth_chainId", params: [] },
        {
          jsonrpc: "2.0",
          id: "duplicate",
          method: "eth_call",
          params: [{ to: "0x0000000000000000000000000000000000000001", data: "0xbbbb" }, "latest"],
        },
      ]),
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(multicallIds, ["__uos_multicall_0", "__uos_multicall_1", "__uos_multicall_3"]);
  assert.deepEqual(await response.json(), [
    { jsonrpc: "2.0", id: "duplicate", result: "multicall:__uos_multicall_0" },
    { jsonrpc: "2.0", id: null, result: "multicall:__uos_multicall_1" },
    { jsonrpc: "2.0", id: "direct", result: "direct:eth_chainId" },
    { jsonrpc: "2.0", id: "duplicate", result: "multicall:__uos_multicall_3" },
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

Deno.test("HTTP JSON-RPC application errors use status 200 for single and batch requests", async () => {
  const upstreamError = Object.assign(new Error("limit exceeded"), {
    name: "JsonRpcError",
    code: -32005,
    httpStatus: 429,
  });
  const manager: RequestHandlerManager = {
    getHealthStatus: () => Promise.resolve({}),
    multicall3: () => Promise.resolve([]),
    send: <T = unknown>(): Promise<T> => Promise.reject(upstreamError),
  };
  const handler = createHandler(manager);

  const singleResponse = await handler(
    new Request("http://localhost/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    }),
  );
  assert.equal(singleResponse.status, 200);
  assert.equal((await singleResponse.json()).error.code, -32005);

  const batchResponse = await handler(
    new Request("http://localhost/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] }]),
    }),
  );
  assert.equal(batchResponse.status, 200);
  assert.equal((await batchResponse.json())[0].error.code, -32005);
});

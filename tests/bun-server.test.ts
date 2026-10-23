import { parseBooleanEnvValue } from "../packages/permit2-rpc-server/src/runtime.ts";
import { expect, test } from "bun:test";
import { startBunServer } from "../packages/permit2-rpc-server/src/bun-server.ts";

test("Bun listener serves assets, health, CORS and MCP without a Deno runtime", async () => {
  const server = startBunServer({ port: 0 });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    for (const path of ["/", "/app.css", "/app.js", "/logo.svg"]) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect((await response.text()).length).toBeGreaterThan(0);
    }
    const health = await (await fetch(`${origin}/health`)).json();
    expect(health.summary.totalChains).toBe(11);
    expect(health.summary.totalRpcs).toBe(157);
    const response = await fetch(origin, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });
    expect((await response.json()).result.protocolVersion).toBe("2025-06-18");
  } finally {
    await server.stop(true);
  }
});

test("Bun WebSocket adapter queues requests and relays binary frames", async () => {
  const previous = Bun.env.RPC_WSS_URL_1;
  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      if (server.upgrade(request)) return undefined;
      return new Response("upgrade expected", { status: 400 });
    },
    websocket: {
      message(socket, payload) {
        if (typeof payload !== "string") {
          socket.send(payload);
          return;
        }
        const request = JSON.parse(payload);
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x1" }));
      },
    },
  });
  Bun.env.RPC_WSS_URL_1 = `ws://127.0.0.1:${upstream.port}`;
  const server = startBunServer({ port: 0 });
  const client = new WebSocket(`ws://127.0.0.1:${server.port}/1`);
  client.binaryType = "arraybuffer";
  const next = () =>
    new Promise<MessageEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Bun WebSocket deadline")), 3000);
      client.addEventListener(
        "message",
        (event) => {
          clearTimeout(timer);
          resolve(event);
        },
        { once: true }
      );
    });
  try {
    await new Promise<void>((resolve, reject) => {
      client.onopen = () => resolve();
      client.onerror = () => reject(new Error("Bun WebSocket failed"));
    });
    const chain = next();
    client.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }));
    expect(JSON.parse((await chain).data).result).toBe("0x1");
    const binary = next();
    client.send(new Uint8Array([7, 8, 9]));
    expect([...new Uint8Array((await binary).data)]).toEqual([7, 8, 9]);
  } finally {
    client.close();
    await server.stop(true);
    await upstream.stop(true);
    if (previous === undefined) delete Bun.env.RPC_WSS_URL_1;
    else Bun.env.RPC_WSS_URL_1 = previous;
  }
});

test("parseBooleanEnvValue parses all supported true/false aliases and case/whitespace variants", () => {
  for (const val of ["1", "true", "yes", "y", "on", " TRUE ", "\tYes\n", "Y", "ON"]) {
    expect(parseBooleanEnvValue(val)).toBe(true);
  }
  for (const val of ["0", "false", "no", "n", "off", " FALSE ", "\tNo\n", "N", "  n  ", "OFF"]) {
    expect(parseBooleanEnvValue(val)).toBe(false);
  }
  expect(parseBooleanEnvValue(undefined)).toBeUndefined();
  expect(parseBooleanEnvValue(null)).toBeUndefined();
  expect(parseBooleanEnvValue("")).toBeUndefined();
  expect(parseBooleanEnvValue("maybe")).toBeUndefined();
});

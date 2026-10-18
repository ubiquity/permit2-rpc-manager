import { createHandler } from "./server.ts";
import { createRuntime } from "./runtime.ts";
import { SocketPeer } from "./infra/websocket.ts";
import type { ServerWebSocket } from "bun";

class BunSocketBridge extends EventTarget {
  private socket?: ServerWebSocket<{ bridge: BunSocketBridge }>;
  private pending: Array<string | ArrayBuffer | ArrayBufferView> = [];
  private closed = false;
  get readyState() {
    return this.closed ? 3 : 1;
  }
  bind(socket: ServerWebSocket<{ bridge: BunSocketBridge }>) {
    this.socket = socket;
    if (this.closed) {
      socket.close();
      return;
    }
    for (const message of this.pending.splice(0)) this.send(message);
    this.dispatchEvent(new Event("open"));
  }
  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (this.closed) return;
    if (!this.socket) {
      this.pending.push(data);
      return;
    }
    this.socket.send(data);
  }
  close(code?: number, reason?: string) {
    this.closed = true;
    this.socket?.close(code, reason);
  }
  message(data: unknown) {
    const payload = ArrayBuffer.isView(data)
      ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      : data;
    this.dispatchEvent(new MessageEvent("message", { data: payload }));
  }
  disconnected() {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
}

export function startBunServer(options: { port?: number; hostname?: string } = {}) {
  const pendingUpgrades = new WeakSet<Request>();
  const runtime = createRuntime((name) => Bun.env[name], {
    readStaticTextAsset: (name) => Bun.file(new URL(`../static/${name}`, import.meta.url)).text(),
    isNotFoundError: (error) => error instanceof Error && "code" in error && error.code === "ENOENT",
    upgradeWebSocket(request) {
      const bridge = new BunSocketBridge();
      if (!server.upgrade(request, { data: { bridge } })) throw new Error("WebSocket upgrade failed.");
      pendingUpgrades.add(request);
      return { socket: new SocketPeer(bridge), response: new Response(null, { status: 204 }) };
    },
  });
  const handler = createHandler(runtime.manager, runtime);
  const server = Bun.serve<{ bridge: BunSocketBridge }>({
    port: options.port ?? Number.parseInt(Bun.env.PORT ?? "8000", 10),
    hostname: options.hostname ?? "127.0.0.1",
    async fetch(request) {
      const response = await handler(request);
      if (pendingUpgrades.has(request)) return undefined;
      return response;
    },
    websocket: {
      open(socket) {
        socket.data.bridge.bind(socket);
      },
      message(socket, message) {
        socket.data.bridge.message(message);
      },
      close(socket) {
        socket.data.bridge.disconnected();
      },
    },
  });
  return server;
}

if (import.meta.main) startBunServer();

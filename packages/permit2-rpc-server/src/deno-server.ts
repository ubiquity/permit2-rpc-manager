/// <reference lib="deno.ns" />
import { createHandler as createPortableHandler, type RequestHandlerManager } from "./server.ts";
import { createRuntime } from "./runtime.ts";
import { SocketPeer } from "./infra/websocket.ts";
import { createDenoCacheStore } from "./infra/deno-cache-store.ts";
export type { RequestHandlerManager } from "./server.ts";

const runtime = createRuntime((name) => Deno.env.get(name), {
  cacheStore: createDenoCacheStore(),
  readStaticTextAsset: (name) => Deno.readTextFile(new URL(`../static/${name}`, import.meta.url)),
  isNotFoundError: (error) => error instanceof Deno.errors.NotFound,
  upgradeWebSocket(request) {
    const { socket, response } = Deno.upgradeWebSocket(request);
    return { socket: new SocketPeer(socket), response };
  },
});
export function createHandler(manager: RequestHandlerManager) {
  return createPortableHandler(manager, runtime);
}
if (import.meta.main) {
  const port = Number.parseInt(Deno.env.get("PORT") ?? "8000", 10);
  Deno.serve({ port }, createHandler(runtime.manager));
}

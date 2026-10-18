import { createHandler } from "./server.ts";
import { createRuntime, parseBooleanEnv } from "./runtime.ts";
import { SocketPeer } from "./infra/websocket.ts";
import { WorkerTransport } from "./infra/worker-transport.ts";
import { createHttpDiagnostics } from "./infra/worker-diagnostics-client.ts";
import type { RpcManagerState } from "./core/permit2-rpc-manager.ts";
import type { CacheData, CacheStore, ChainCache } from "./infra/cache-manager.ts";
import rpcWhitelist from "../rpc-whitelist.json" with { type: "json" };

export { HttpDiagnosticsObject } from "./infra/worker-diagnostics-object.ts";

// Only synchronous advisory maps/statistics are shared; no request, socket, store, or promise.
let advisoryState: RpcManagerState | undefined;

/** Advisory endpoint diagnostics only; no authoritative state or scheduler. */
function createCacheStore(version: string, transport: WorkerTransport): CacheStore {
  const keyFor = (key: string, chainId: number) =>
    new Request(`https://rpc.ubq.fi/__uos-worker-cache/${version}/${key}/${chainId}`);
  const loadChain = async (key: string, chainId: number): Promise<ChainCache | null> => {
    transport.countCacheCall();
    return await (await caches.default.match(keyFor(key, chainId)))?.json<ChainCache>() ?? null;
  };
  return {
    loadChain,
    async load(key) {
      const result: CacheData = {};
      // Health reads only the finite configured chain set; normal RPC reads one chain.
      await Promise.all(
        Object.keys(rpcWhitelist.rpcs).map(async (id) => {
          const value = await loadChain(key, Number(id));
          if (value) result[Number(id)] = value;
        }),
      );
      return result;
    },
    reserveWrite(key, chainId) {
      transport.reserveCacheWrite(keyFor(key, chainId).url);
    },
    async save(key, value, chainId) {
      const cacheKey = keyFor(key, chainId);
      transport.countCacheCall(cacheKey.url);
      await caches.default.put(
        cacheKey,
        Response.json(value[chainId], { headers: { "cache-control": "public, max-age=14400" } }),
      );
    },
  };
}

export default {
  async fetch(request, env, ctx) {
    const transport = new WorkerTransport();
    const configuration = new Map<string, unknown>(Object.entries(env));
    const validateChainId = parseBooleanEnv(configuration.get("RPC_VALIDATE_CHAIN_ID")) ?? true;
    const diagnostics = createHttpDiagnostics(
      env.HTTP_DIAGNOSTICS,
      env.VERSION_METADATA.id,
      typeof request.cf?.colo === "string" ? request.cf.colo : "local",
      transport,
      validateChainId,
      configuration.get("DISABLE_RPC_CACHE") === "true" || configuration.get("DISABLE_RPC_CACHE") === "1",
    );
    const runtime = createRuntime((name) => {
      const value = configuration.get(name);
      return typeof value === "string" ? value : undefined;
    }, {
      cacheStore: createCacheStore(env.VERSION_METADATA.id, transport),
      managerOptions: {
        cacheStore: diagnostics.store,
        diagnosticsResolver: diagnostics.resolver,
        state: advisoryState,
        fetcher: transport.fetch,
        diagnosticFetch: transport.diagnosticFetch,
        resumeDiagnostics: true,
      },
      async readStaticTextAsset(name) {
        const response = await env.ASSETS.fetch(new Request(new URL(`/${name}`, request.url)));
        if (!response.ok) throw new Error("Static asset not found.");
        return response.text();
      },
      isNotFoundError: (error) => error instanceof Error && error.message === "Static asset not found.",
      openWebSocket: (url, timeoutMs) => transport.openWebSocket(url, timeoutMs),
      upgradeWebSocket() {
        const pair = new WebSocketPair();
        pair[1].binaryType = "arraybuffer";
        pair[1].accept();
        return { socket: new SocketPeer(pair[1]), response: new Response(null, { status: 101, webSocket: pair[0] }) };
      },
      waitUntil: (promise) => ctx.waitUntil(promise),
    });
    advisoryState ??= runtime.manager.getState();
    const response = await createHandler(runtime.manager, runtime)(request);
    response.headers.set("x-uos-runtime", "cloudflare-workers");
    response.headers.set("x-uos-deployment-id", env.VERSION_METADATA.id);
    if (response.status !== 101) {
      response.headers.set("x-uos-external-subrequests", String(transport.used + transport.childUsed));
      response.headers.set("x-uos-front-subrequests", String(transport.used));
      response.headers.set("x-uos-child-subrequests", String(transport.childUsed));
      response.headers.set("x-uos-binding-subrequests", String(transport.bindingUsed));
      response.headers.set("x-uos-unverified-children", String(transport.unverifiedChildren));
      response.headers.set("x-uos-sql-rows-read", String(transport.sqlRowsRead));
      response.headers.set("x-uos-sql-rows-written", String(transport.sqlRowsWritten));
      response.headers.set("x-uos-diagnostics-wall-ms", String(transport.diagnosticsWallMs));
      response.headers.set("x-uos-diagnostic-request-ids", transport.diagnosticRequestIds.join(","));
      response.headers.set("x-uos-cache-subrequests", String(transport.cacheUsed));
      response.headers.set("x-uos-budget-subrequests", String(transport.totalUsed));
    }
    return response;
  },
} satisfies ExportedHandler<Env>;

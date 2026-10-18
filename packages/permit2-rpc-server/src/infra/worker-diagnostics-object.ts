import { DurableObject } from "cloudflare:workers";
import { ChainlistDataSource } from "../data/chainlist-data-source.ts";
import { RpcSelector } from "../core/rpc-selector.ts";
import { CacheManager, type CacheStore, type ChainCache } from "./cache-manager.ts";
import { LatencyTester, type LatencyTestResult } from "./latency-tester.ts";
import { WorkerTransport } from "./worker-transport.ts";
import { redactRpcDiagnostic } from "../core/rpc-endpoint-id.ts";

const dataSource = new ChainlistDataSource();
const TTL_MS = 4 * 60 * 60 * 1000;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;

export interface DiagnosticIdentity {
  requestId: string;
  version: string;
  chainId: number;
  validateChainId: boolean;
  timeoutMs: number;
  disableCache: boolean;
}

export interface DiagnosticRequest extends DiagnosticIdentity {
  eligibleIndices: number[];
  maxExternalCalls: number;
}

export interface DiagnosticReceipt {
  requestId: string;
  version: string;
  chainId: number;
  maxExternalCalls: number;
  externalCalls: number;
  snapshot: ChainCache | null;
  sqlRowsRead: number;
  sqlRowsWritten: number;
  activeWallMs: number;
  error?: { name: string; message: string; code: number };
}

interface SqlUsage {
  read: number;
  written: number;
}

/** Private advisory HTTP diagnostics only. No foreground payloads, sockets, alarms or background work. */
export class HttpDiagnosticsObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS diagnostics (fingerprint TEXT PRIMARY KEY, snapshot TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
  }

  #sql<T extends Record<string, SqlStorageValue>>(
    usage: SqlUsage,
    query: string,
    ...bindings: SqlStorageValue[]
  ): T[] {
    const cursor = this.ctx.storage.sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    usage.read += cursor.rowsRead;
    usage.written += cursor.rowsWritten;
    return rows;
  }

  #identity(request: DiagnosticIdentity, refresh: boolean): { urls: string[]; fingerprint: string } {
    if (!request || typeof request !== "object") throw new Error("Invalid diagnostic identity.");
    const allowed = ["requestId", "version", "chainId", "validateChainId", "timeoutMs", "disableCache"];
    if (refresh) allowed.push("eligibleIndices", "maxExternalCalls");
    if (
      Object.keys(request).some((key) => !allowed.includes(key)) ||
      typeof request.requestId !== "string" || typeof request.version !== "string" ||
      !/^[\da-f-]{36}$/i.test(request.requestId) || !/^[\da-f-]{36}$/i.test(request.version) ||
      !Number.isSafeInteger(request.chainId) || typeof request.validateChainId !== "boolean" ||
      typeof request.disableCache !== "boolean" ||
      !Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > 60000
    ) throw new Error("Invalid diagnostic identity.");
    const urls = dataSource.getRpcUrls(request.chainId);
    if (urls.length === 0) throw new Error("Unsupported diagnostic chain.");
    return {
      urls,
      fingerprint:
        `${request.version}:${request.chainId}:${request.validateChainId}:${request.timeoutMs}:permit2-sync-chain-v1`,
    };
  }

  #read(fingerprint: string, urls: string[], usage: SqlUsage): ChainCache | null {
    const row =
      this.#sql<{ snapshot: string }>(usage, "SELECT snapshot FROM diagnostics WHERE fingerprint = ?", fingerprint)[0];
    if (!row) return null;
    const snapshot = JSON.parse(row.snapshot) as ChainCache;
    if (Date.now() - snapshot.lastTested >= TTL_MS) return null;
    // JSON stores non-finite failed latencies as null; restore their original meaning.
    const latencyMap: Record<string, LatencyTestResult> = {};
    for (const url of urls) {
      const result = snapshot.latencyMap[url];
      if (result?.url === url) latencyMap[url] = { ...result, latency: result.latency ?? Infinity };
    }
    return { ...snapshot, latencyMap };
  }

  #reply(
    request: DiagnosticIdentity,
    usage: SqlUsage,
    started: number,
    snapshot: ChainCache | null,
  ): DiagnosticReceipt {
    return {
      requestId: request.requestId,
      version: request.version,
      chainId: request.chainId,
      maxExternalCalls: 0,
      externalCalls: 0,
      snapshot,
      sqlRowsRead: usage.read,
      sqlRowsWritten: usage.written,
      activeWallMs: Date.now() - started,
    };
  }

  readSnapshot(request: DiagnosticIdentity): DiagnosticReceipt {
    const started = Date.now(), usage = { read: 0, written: 0 };
    const { urls, fingerprint } = this.#identity(request, false);
    const reply = this.#reply(
      request,
      usage,
      started,
      request.disableCache ? null : this.#read(fingerprint, urls, usage),
    );
    this.#log("read", reply);
    return reply;
  }

  #log(operation: string, reply: DiagnosticReceipt): void {
    console.log(JSON.stringify({
      event: "http-diagnostics",
      operation,
      requestId: reply.requestId,
      version: reply.version,
      chainId: reply.chainId,
      externalCalls: reply.externalCalls,
      maxExternalCalls: reply.maxExternalCalls,
      sqlRowsRead: reply.sqlRowsRead,
      sqlRowsWritten: reply.sqlRowsWritten,
      activeWallMs: reply.activeWallMs,
      complete: reply.snapshot?.diagnosticsComplete ?? false,
    }));
  }

  async getOrRefresh(request: DiagnosticRequest): Promise<DiagnosticReceipt> {
    const started = Date.now(), usage = { read: 0, written: 0 };
    const { urls, fingerprint } = this.#identity(request, true);
    if (
      !Number.isInteger(request.maxExternalCalls) || request.maxExternalCalls < 0 || request.maxExternalCalls > 48 ||
      !Array.isArray(request.eligibleIndices) || request.eligibleIndices.length > urls.length ||
      new Set(request.eligibleIndices).size !== request.eligibleIndices.length ||
      request.eligibleIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= urls.length)
    ) throw new Error("Invalid diagnostic allowance or endpoint indices.");
    const eligible = new Set(request.eligibleIndices.map((index) => urls[index]));
    const transport = new WorkerTransport(undefined, request.maxExternalCalls);
    const pendingCalls: Promise<Response>[] = [];
    const diagnosticFetch: typeof fetch = (input, init) => {
      const pending = (async () => {
        const response = await transport.diagnosticFetch(input, init);
        const body = await response.arrayBuffer();
        return new Response(body.byteLength ? body : null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      })();
      pendingCalls.push(pending);
      return pending;
    };
    let saved: ChainCache | null = null;
    let storageFailure: DiagnosticReceipt["error"];
    const store: CacheStore = {
      load: () => Promise.resolve({}),
      loadChain: () => {
        const snapshot = request.disableCache ? null : this.#read(fingerprint, urls, usage);
        if (
          snapshot &&
          [...eligible].some((url) => !snapshot.latencyMap[url] || snapshot.latencyMap[url].status === "deferred")
        ) {
          snapshot.diagnosticsComplete = false;
        }
        saved = snapshot;
        return Promise.resolve(snapshot);
      },
      save: (_key, value) => {
        try {
          this.ctx.storage.transactionSync(() => {
            const incoming = value[request.chainId];
            const latest = request.disableCache ? null : this.#read(fingerprint, urls, usage);
            const latencyMap: Record<string, LatencyTestResult> = {};
            for (const url of urls) {
              const fresh = incoming.latencyMap[url], previous = latest?.latencyMap[url];
              const result = fresh?.status === "deferred" && previous && previous.status !== "deferred"
                ? previous
                : fresh ?? previous;
              if (result?.url === url) latencyMap[url] = result;
            }
            const updated: ChainCache = {
              latencyMap,
              fastestRpc: selector.rankResults(latencyMap, new Set(urls))[0] ?? null,
              diagnosticsComplete: urls.every((url) => latencyMap[url] && latencyMap[url].status !== "deferred"),
              lastTested: incoming.lastTested,
            };
            const encoded = JSON.stringify(updated);
            if (new TextEncoder().encode(encoded).byteLength > MAX_SNAPSHOT_BYTES) {
              throw new Error("Diagnostic snapshot exceeds its bounded storage size.");
            }
            if (!request.disableCache) {
              this.#sql(
                usage,
                "INSERT INTO diagnostics VALUES (?, ?, ?) ON CONFLICT(fingerprint) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at",
                fingerprint,
                encoded,
                Date.now(),
              );
              // Stable colo/chain objects retain the current and at most one other fingerprint.
              this.#sql(
                usage,
                "DELETE FROM diagnostics WHERE fingerprint <> ? AND fingerprint NOT IN (SELECT fingerprint FROM diagnostics WHERE fingerprint <> ? ORDER BY updated_at DESC LIMIT 1)",
                fingerprint,
                fingerprint,
              );
            }
            saved = updated;
          });
        } catch (error) {
          storageFailure = {
            name: "DiagnosticStorageError",
            message: redactRpcDiagnostic((error as Error).message),
            code: -32603,
          };
          throw error;
        }
        return Promise.resolve();
      },
    };
    const selector = new RpcSelector(
      dataSource,
      new CacheManager({ store }),
      new LatencyTester(request.timeoutMs, undefined, {
        validateChainId: request.validateChainId,
        fetcher: diagnosticFetch,
      }),
      undefined,
      (url) => eligible.has(url),
      true,
    );
    let failure: DiagnosticReceipt["error"];
    try {
      await selector.getRankedRpcList(request.chainId);
    } catch (error) {
      const value = error as Error & { code?: number };
      failure = { name: value.name, message: redactRpcDiagnostic(value.message), code: value.code ?? -32603 };
    }
    // A failed check can reject Promise.all before sibling headers, redirects or bodies finish.
    // Keep their existing abort signals active through buffering and settle all I/O before refunding calls.
    await Promise.allSettled(pendingCalls);
    const reply = this.#reply(request, usage, started, saved);
    if (!reply.snapshot && !storageFailure && !failure && eligible.size === 0) {
      // Match the selector's no-cache/all-health-deferred recovery path without inventing fresh diagnostics.
      reply.snapshot = { fastestRpc: null, latencyMap: {}, lastTested: Date.now(), diagnosticsComplete: false };
    }
    reply.maxExternalCalls = request.maxExternalCalls;
    reply.externalCalls = transport.used;
    if (storageFailure ?? failure) reply.error = storageFailure ?? failure;
    this.#log("refresh", reply);
    return reply;
  }
}

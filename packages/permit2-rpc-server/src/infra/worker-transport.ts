import { SocketPeer } from "./websocket.ts";

export class RpcBudgetExceeded extends Error {
  readonly code = -32005;
  constructor() {
    super("The Workers Free fetch and Cache API request budget is exhausted.");
    this.name = "RpcBudgetExceeded";
  }
}

/** One invocation owns its counters, pending batches, sockets, and promises. */
export class WorkerTransport {
  used = 0;
  cacheUsed = 0;
  private reservedCacheWrites = new Set<string>();
  private pending = new Map<
    string,
    Array<{ init: RequestInit; resolve: (response: Response) => void; reject: (error: unknown) => void }>
  >();

  constructor(
    private readonly nativeFetch: typeof fetch = (input, init) => fetch(input, init),
    private readonly limit = 50,
  ) {}

  get totalUsed(): number {
    return this.used + this.cacheUsed;
  }

  private checkBudget(): void {
    if (this.totalUsed + this.reservedCacheWrites.size >= this.limit) throw new RpcBudgetExceeded();
  }

  reserveCacheWrite(key: string): void {
    if (this.reservedCacheWrites.has(key)) return;
    this.checkBudget();
    this.reservedCacheWrites.add(key);
  }

  countCacheCall(writeKey?: string): void {
    if (!writeKey || !this.reservedCacheWrites.delete(writeKey)) this.checkBudget();
    this.cacheUsed++;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    let url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let options = { ...init, redirect: "manual" as const };
    for (let redirects = 0;; redirects++) {
      this.checkBudget();
      this.used++;
      const response = await this.nativeFetch(url, options);
      if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.has("location")) return response;
      if (redirects >= 20) {
        await response.body?.cancel();
        throw new Error("RPC redirect limit exceeded.");
      }
      const next = new URL(response.headers.get("location")!, url);
      const headers = new Headers(options.headers);
      if (new URL(url).origin !== next.origin) {
        headers.delete("authorization");
        headers.delete("cookie");
      }
      if (
        (response.status === 303 && options.method !== "HEAD") ||
        ([301, 302].includes(response.status) && options.method === "POST")
      ) {
        options = { ...options, method: "GET", body: undefined };
        headers.delete("content-type");
        headers.delete("content-length");
      }
      options.headers = headers;
      await response.body?.cancel();
      url = next.href;
    }
  };

  /** Coalesce the existing bytecode/sync/chain checks; retain single-call fallback. */
  readonly diagnosticFetch: typeof fetch = (input, init) => {
    const url = String(input);
    return new Promise<Response>((resolve, reject) => {
      const entries = this.pending.get(url);
      if (entries) {
        entries.push({ init: init ?? {}, resolve, reject });
        return;
      }
      const group = [{ init: init ?? {}, resolve, reject }];
      this.pending.set(url, group);
      queueMicrotask(() => {
        this.pending.delete(url);
        this.flushDiagnostics(url, group).catch((error) => {
          for (const entry of group) entry.reject(error);
        });
      });
    });
  };

  private async flushDiagnostics(
    url: string,
    entries: Array<{ init: RequestInit; resolve: (response: Response) => void; reject: (error: unknown) => void }>,
  ) {
    const requests = entries.map((entry) => JSON.parse(String(entry.init.body)) as { id: string });
    const response = await this.fetch(url, { ...entries[0].init, body: JSON.stringify(requests) });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const matched = Array.isArray(body) ? requests.map((request) => body.find((item) => item?.id === request.id)) : [];
    const batchRejected = matched.length > 0 && matched.every((item) => item?.error?.code === -32600);
    if (matched.length === requests.length && matched.every(Boolean) && !batchRejected) {
      for (const [index, entry] of entries.entries()) {
        entry.resolve(
          new Response(JSON.stringify(matched[index]), {
            status: response.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      try {
        entry.resolve(await this.fetch(url, entry.init));
      } catch (error) {
        entry.reject(error);
      }
    }));
  }

  async openWebSocket(url: string, timeoutMs: number): Promise<SocketPeer> {
    const response = await this.fetch(url.replace(/^ws:/, "http:").replace(/^wss:/, "https:"), {
      headers: { Upgrade: "websocket" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const socket = response.webSocket;
    if (response.status !== 101 || !socket) {
      await response.body?.cancel();
      throw new Error(`Upstream WebSocket upgrade failed (${response.status}).`);
    }
    socket.binaryType = "arraybuffer";
    socket.accept();
    return new SocketPeer(socket);
  }
}

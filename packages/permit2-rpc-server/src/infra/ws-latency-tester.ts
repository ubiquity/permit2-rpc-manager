/// <reference lib="deno.ns" />
import PERMIT2_BYTECODE_PREFIX from "../fixtures/permit2-bytecode.ts";
import type { LatencyTestResult } from "./latency-tester.ts";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: unknown[];
  id: number | string;
}

interface JsonRpcError {
  code: number;
  message: string;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

type LoggerFn = (level: "debug" | "info" | "warn" | "error", message: string, ...optionalParams: unknown[]) => void;

const DEFAULT_TIMEOUT_MS = 5000;
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

function normalizeWsMessageData(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return null;
}

function openWs(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error("WebSocket connection timed out"));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      ws.onopen = null;
      ws.onerror = null;
      ws.onclose = null;
    };

    ws.onopen = () => {
      cleanup();
      resolve(ws);
    };

    ws.onerror = () => {
      cleanup();
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error("WebSocket connection error"));
    };

    ws.onclose = () => {
      cleanup();
      reject(new Error("WebSocket closed before opening"));
    };
  });
}

class WsJsonRpcClient {
  private ws: WebSocket;
  private timeoutMs: number;
  private log: LoggerFn;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: JsonRpcResponse) => void; reject: (error: Error) => void }>();

  constructor(ws: WebSocket, timeoutMs: number, logger: LoggerFn) {
    this.ws = ws;
    this.timeoutMs = timeoutMs;
    this.log = logger;

    this.ws.onmessage = (event) => {
      const raw = normalizeWsMessageData((event as MessageEvent).data);
      if (!raw) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        this.log("debug", "WS JSON-RPC parse error", error);
        return;
      }
      if (!parsed || typeof parsed !== "object" || !("id" in parsed)) return;
      const id = Number((parsed as any).id);
      if (!Number.isFinite(id)) return;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      entry.resolve(parsed as JsonRpcResponse);
    };

    const failAll = (reason: string) => {
      const err = new Error(reason);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    };

    this.ws.onerror = () => failAll("WebSocket error");
    this.ws.onclose = () => failAll("WebSocket closed");
  }

  async call(method: string, params: unknown[] = []): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const requestBody: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      params,
      id,
    };

    const payload = JSON.stringify(requestBody);
    const responsePromise = new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    const timer = setTimeout(() => {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      entry.reject(new Error("JSON-RPC request timed out"));
    }, this.timeoutMs);

    try {
      this.ws.send(payload);
      return await responsePromise;
    } catch (error) {
      this.pending.delete(id);
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

export class WsLatencyTester {
  private timeoutMs: number;
  private log: LoggerFn;

  constructor(timeoutMs: number = DEFAULT_TIMEOUT_MS, logger?: LoggerFn) {
    this.timeoutMs = timeoutMs;
    this.log = logger || (() => {});
  }

  private async testSingleRpc(url: string): Promise<LatencyTestResult> {
    const startTime = Date.now();
    let ws: WebSocket | null = null;

    try {
      ws = await openWs(url, this.timeoutMs);
      const client = new WsJsonRpcClient(ws, this.timeoutMs, this.log);

      const [getCodeResponse, syncingResponse] = await Promise.all([client.call("eth_getCode", [PERMIT2_ADDRESS, "latest"]), client.call("eth_syncing", [])]);

      const latency = Date.now() - startTime;

      if (getCodeResponse?.error) {
        const errMsg = `eth_getCode RPC error ${getCodeResponse.error.code} - ${getCodeResponse.error.message}`;
        this.log("warn", `WS latency test failed for ${url}: ${errMsg}`);
        return { url, latency: Infinity, status: "rpc_error", error: errMsg };
      }
      if (syncingResponse?.error) {
        const errMsg = `eth_syncing RPC error ${syncingResponse.error.code} - ${syncingResponse.error.message}`;
        this.log("warn", `WS latency test failed for ${url}: ${errMsg}`);
        return { url, latency: Infinity, status: "rpc_error", error: errMsg };
      }

      if (syncingResponse?.result !== false) {
        const errMsg = `Node is not synced (eth_syncing returned ${JSON.stringify(syncingResponse?.result)})`;
        this.log("warn", `WS RPC ${url} is syncing: ${errMsg}`);
        return { url, latency, status: "syncing", error: errMsg };
      }

      if (typeof getCodeResponse?.result !== "string") {
        const errMsg = `Invalid bytecode response type: ${typeof getCodeResponse?.result}`;
        this.log("warn", `WS RPC ${url} returned invalid bytecode: ${errMsg}`);
        return { url, latency, status: "wrong_bytecode", error: errMsg };
      }

      this.log("debug", `\nExpected Permit2 prefix (first 100 chars): ${PERMIT2_BYTECODE_PREFIX.slice(0, 100)}`);
      this.log("debug", `Received bytecode (first 100 chars): ${getCodeResponse.result.slice(0, 100)}`);

      if (!getCodeResponse.result.startsWith(PERMIT2_BYTECODE_PREFIX)) {
        let commonPrefixLength = 0;
        while (
          commonPrefixLength < PERMIT2_BYTECODE_PREFIX.length &&
          commonPrefixLength < getCodeResponse.result.length &&
          PERMIT2_BYTECODE_PREFIX[commonPrefixLength] === getCodeResponse.result[commonPrefixLength]
        ) {
          commonPrefixLength++;
        }
        const errMsg = `Bytecode mismatch at position ${commonPrefixLength}`;
        this.log("warn", `WS RPC ${url} has incorrect bytecode: ${errMsg}`);
        return { url, latency, status: "wrong_bytecode", error: errMsg };
      }

      this.log("debug", `WS RPC ${url} passed all checks (${latency}ms)`);
      return { url, latency, status: "ok" };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const status = err.message.toLowerCase().includes("timed out") ? "timeout" : "network_error";
      const logLevel = status === "network_error" ? "debug" : "warn";
      this.log(logLevel, `WS latency test failed for ${url}: ${status} - ${err.message}`);
      return { url, latency: Infinity, status, error: err.message };
    } finally {
      try {
        ws?.close();
      } catch {
        // ignore
      }
    }
  }

  async testRpcUrls(_chainId: number, urls: string[]): Promise<Record<string, LatencyTestResult>> {
    if (!urls || urls.length === 0) return {};
    this.log("info", `Starting WS latency tests for ${urls.length} RPC URLs (incl. sync & bytecode check)...`);

    const results = await Promise.allSettled(urls.map((url) => this.testSingleRpc(url)));
    const resultMap: Record<string, LatencyTestResult> = {};

    results.forEach((result, index) => {
      const url = urls[index];
      if (url === undefined) {
        this.log("error", `Error: url at index ${index} is undefined during WS latency test processing.`);
        return;
      }
      if (result.status === "fulfilled") {
        resultMap[url] = result.value;
      } else {
        this.log("error", `Unexpected rejection during WS latency test promise for ${url}:`, result.reason);
        resultMap[url] = {
          url,
          latency: Infinity,
          status: "network_error",
          error: result.reason?.message || "Unknown rejection",
        };
      }
    });

    this.log("info", "WS latency tests completed.");
    return resultMap;
  }
}

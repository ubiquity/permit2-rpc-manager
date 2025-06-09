// import type { Address } from "viem"; // Removed - not used internally
class JsonRpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
    public httpStatus?: number
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}
import { CacheManager } from "./cache-manager.ts";
import { ChainlistDataSource } from "./chainlist-data-source.ts";
// import { readContract } from "./contract-utils.ts"; // Removed - not used internally
import { LatencyTester } from "./latency-tester.ts";
import { RpcSelector } from "./rpc-selector.ts";

// Uncommented JSON-RPC interfaces
interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: unknown[]; // Changed any[] to unknown[]
  id: number | string;
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown; // Changed any to unknown
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface Permit2RpcManagerOptions {
  cacheTtlMs?: number;
  latencyTimeoutMs?: number;
  requestTimeoutMs?: number;
  nodeCachePath?: string;
  localStorageKey?: string; // Used as KV key prefix
  logLevel?: "debug" | "info" | "warn" | "error" | "none";
  initialRpcData?: { rpcs: { [chainId: string]: string[] } };
  disableCache?: boolean; // Option to disable caching for testing
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_LOG_LEVEL = "warn";

const LOG_LEVEL_HIERARCHY: Record<NonNullable<Permit2RpcManagerOptions["logLevel"]>, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 4,
};

export class Permit2RpcManager {
  private dataSource: ChainlistDataSource;
  private cacheManager: CacheManager;
  private latencyTester: LatencyTester;
  public rpcSelector: RpcSelector;
  private requestTimeoutMs: number;
  private logLevel: NonNullable<Permit2RpcManagerOptions["logLevel"]>;
  private configuredLogLevelValue: number;
  private rpcIndexMap = new Map<number, number>(); // Map to track next RPC index per chain

  constructor(options: Permit2RpcManagerOptions = {}) {
    this.logLevel = options.logLevel ?? DEFAULT_LOG_LEVEL;
    this.configuredLogLevelValue = LOG_LEVEL_HIERARCHY[this.logLevel];
    const logger = this._log.bind(this);

    this.dataSource = new ChainlistDataSource(logger, options.initialRpcData);
    this.cacheManager = new CacheManager({
      cacheTtlMs: options.cacheTtlMs,
      localStorageKey: options.localStorageKey,
      logger: logger,
      disableCache: options.disableCache, // Pass disableCache option
    });
    this.latencyTester = new LatencyTester(options.latencyTimeoutMs, logger);
    this.rpcSelector = new RpcSelector(this.dataSource, this.cacheManager, this.latencyTester, logger);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private _log(level: "debug" | "info" | "warn" | "error", message: string, ...optionalParams: unknown[]): void {
    if (this.logLevel === "none") return;
    const messageLevelValue = LOG_LEVEL_HIERARCHY[level];
    if (messageLevelValue >= this.configuredLogLevelValue) {
      const logFn = console[level] || console.log;
      logFn(`[Permit2RPC:${level}] ${message}`, ...optionalParams);
    }
  }

  /**
   * Sends a JSON-RPC request, trying available RPCs in a round-robin fashion based on the ranked list.
   * Handles fallback by iterating through the list.
   */
  async send<T = unknown>(chainId: number, method: string, params: unknown[] = []): Promise<T> {
    const rankedRpcList = await this.rpcSelector.getRankedRpcList(chainId);

    if (rankedRpcList.length === 0) {
      this._log("error", `No available RPC endpoints found for chainId ${chainId}. Cannot send request.`);
      throw new Error(`No available RPC endpoints found for chainId ${chainId}.`);
    }

    // --- Round-Robin Start Index ---
    const currentIndex = this.rpcIndexMap.get(chainId) || 0;
    const startIndex = currentIndex % rankedRpcList.length;
    this.rpcIndexMap.set(chainId, (currentIndex + 1) % rankedRpcList.length);
    this._log(
      "debug",
      `Starting RPC attempt loop for chain ${chainId} at index ${startIndex} (of ${rankedRpcList.length}). Next call starts at index ${this.rpcIndexMap.get(
        chainId
      )}.`
    );
    // --- End Round-Robin ---

    let lastError: Error | null = null;

    for (let i = 0; i < rankedRpcList.length; i++) {
      const listIndex = (startIndex + i) % rankedRpcList.length;
      const rpcUrl = rankedRpcList[listIndex];

      if (!rpcUrl) continue;

      try {
        this._log("info", `Using RPC endpoint: ${rpcUrl} for chain ${chainId}, method: ${method}`);
        this._log("debug", `Attempt #${i + 1}: Trying RPC call to ${rpcUrl} for chain ${chainId}: ${method}`);
        const result = await this.executeRpcCall<T>(rpcUrl, method, params);
        this._log("debug", `RPC call successful for ${rpcUrl}`);
        return result;
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        lastError = error;

        // First, determine if this is a blockchain-specific error (which should not trigger failover)
        const isBlockchainError =
          error.message.includes("execution reverted") ||
          error.message.includes("transaction failed") ||
          error.message.includes("insufficient funds") ||
          error.message.includes("gas required exceeds allowance") ||
          error.message.includes("nonce too low") ||
          error.message.includes("replacement transaction underpriced") ||
          error.message.includes("invalid opcode") ||
          error.message.includes("invalid sender") ||
          error.message.includes("already known") ||
          error.message.includes("gas price too low");

        if (isBlockchainError) {
          // Don't retry blockchain-specific errors
          this._log("debug", `Not retrying blockchain error from ${rpcUrl}: ${error.message}`);
          throw error;
        }

        // Only retry on network/connectivity errors - pass through all HTTP errors
        const isRetryable =
          // Network/connectivity errors only
          error.name === "AbortError" ||
          error.message.includes("Failed to fetch") ||
          error.message.includes("Network error") ||
          error.message.includes("Unable to connect") ||
          error.message.includes("ETIMEDOUT") ||
          error.message.includes("ECONNRESET") ||
          error.message.includes("ECONNREFUSED") ||
          error.message.includes("ENOTFOUND") ||
          error.message.includes("DNS") ||
          error.message.includes("getaddrinfo") ||
          (error.message.includes("timeout") && !error.message.includes("HTTP"));

        if (!isRetryable) {
          this._log("debug", `Forwarding original RPC error from ${rpcUrl}: ${error.message}`);
          throw error;
        }

        // Improved error logging with error classification and RPC URL
        this._log("warn", `[RETRYABLE ERROR] RPC failed: ${rpcUrl} (chain ${chainId}, method: ${method})`);
        this._log("warn", `  Error details: ${error.message}`);
        this._log("debug", `  Full error:`, error);
        this._log("debug", `Trying next RPC in ranked list (attempt ${i+1}/${rankedRpcList.length})...`);
        continue;
      }
    }

    const errorMsg = lastError?.message || "Unknown error";
    this._log("error", `[EXHAUSTED] All ${rankedRpcList.length} available RPC endpoints failed for chainId ${chainId}. Last error: ${errorMsg}`);

    // If we've tried all RPCs and failed, create a more descriptive error
    const enhancedErrorMsg = `All RPC endpoints failed after ${rankedRpcList.length} attempts. Last error: ${errorMsg}`;

    if (lastError instanceof JsonRpcError) {
      // Keep original error code but enhance the message
      throw new JsonRpcError(lastError.code, enhancedErrorMsg, lastError.data);
    }

    // Use standard JSON-RPC internal error code
    throw new JsonRpcError(-32000, enhancedErrorMsg);
  }

  /**
   * Executes a single JSON-RPC call to the specified URL.
   */
  public async executeRpcCall<T = unknown>(url: string, method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    const requestBody: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      params,
      id: `rpc-call-${Date.now()}`,
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        // Log the failed RPC URL with the error
        this._log("error", `HTTP error from ${url}: ${response.status} ${response.statusText}`);
        // Create error with HTTP status preserved
        const httpError = new JsonRpcError(
          -32000,
          `HTTP error ${response.status} ${response.statusText}`,
          undefined,
          response.status
        );
        throw httpError;
      }
      // Wrap response parsing in try/catch to handle malformed JSON responses
      let responseData: JsonRpcResponse;
      try {
        responseData = await response.json();
      } catch (jsonError) {
        this._log("error", `Failed to parse JSON response from ${url}:`, jsonError);
        throw new Error(`Invalid JSON response from provider: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`);
      }

      // Validate response structure to avoid "Cannot use 'in' operator" errors
      if (!responseData || typeof responseData !== "object") {
        this._log("error", `Invalid response structure from ${url}:`, responseData);
        throw new Error(`Invalid response structure from provider: ${JSON.stringify(responseData)}`);
      }

      // Check for error response
      if (responseData.error) {
        // Validate error object structure
        const errorCode = typeof responseData.error === "object" && responseData.error !== null &&
                         "code" in responseData.error ? responseData.error.code : -32603;
        const errorMessage = typeof responseData.error === "object" && responseData.error !== null &&
                            "message" in responseData.error ? responseData.error.message :
                            (typeof responseData.error === "string" ? responseData.error : JSON.stringify(responseData.error));
        const errorData = typeof responseData.error === "object" && responseData.error !== null &&
                         "data" in responseData.error ? responseData.error.data : undefined;

        throw new JsonRpcError(errorCode, errorMessage, errorData);
      }

      // Safety check for undefined result
      if (responseData.result === undefined) {
        this._log("warn", `RPC response for ${method} had undefined result.`);
      }

      return responseData.result as unknown as T;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Request timed out after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    }
  }
}

// --- Example Usage Removed ---

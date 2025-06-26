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
  // Adaptive pool management options
  enableBadNetworkInvalidation?: boolean; // default: true
  eliminationThreshold?: number; // failures before elimination (default: 3)
  eliminationRetryMs?: number; // 1 hour default
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_LOG_LEVEL = "warn";
const MIN_VIABLE_RPCS = 1; // Hardcoded to simplify logic
const DEFAULT_ELIMINATION_THRESHOLD = 3;
const DEFAULT_ELIMINATION_RETRY_MS = 60 * 60 * 1000; // 1 hour

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
  // Adaptive pool management properties
  private enableBadNetworkInvalidation: boolean;
  private eliminationThreshold: number;
  private eliminationRetryMs: number;

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

    // Initialize adaptive pool management properties
    this.enableBadNetworkInvalidation = options.enableBadNetworkInvalidation ?? true;
    this.eliminationThreshold = options.eliminationThreshold ?? DEFAULT_ELIMINATION_THRESHOLD;
    this.eliminationRetryMs = options.eliminationRetryMs ?? DEFAULT_ELIMINATION_RETRY_MS;
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
   * Tracks RPC failures and decides whether to invalidate the RPC from cache
   * Returns true if the RPC should be invalidated
   */
  private async trackRpcFailure(chainId: number, rpcUrl: string): Promise<boolean> {
    if (!this.enableBadNetworkInvalidation) {
      return false;
    }

    try {
      const kv = await Deno.openKv();
      const failureKey = ["rpc_failures", chainId, rpcUrl];

      // Get current failure data
      const result = await kv.get<{
        consecutiveFailures: number;
        lastFailureTime: number;
        status: "healthy" | "eliminated";
      }>(failureKey);

      const currentTime = Date.now();
      const failureData = result.value || {
        consecutiveFailures: 0,
        lastFailureTime: 0,
        status: "healthy" as const
      };

      // Increment failure count
      failureData.consecutiveFailures++;
      failureData.lastFailureTime = currentTime;

      // Get total RPC count and healthy count for this chain
      const allRpcs = this.dataSource.getRpcUrls(chainId);
      const totalRpcs = allRpcs.length;

      // Get current health status from cache to count healthy RPCs
      const chainCache = await this.cacheManager.getChainCache(chainId);
      let healthyRpcs = totalRpcs; // Default to all if no cache

      if (chainCache?.latencyMap) {
        // Count RPCs that are not eliminated
        healthyRpcs = Object.values(chainCache.latencyMap).filter(
          result => {
            // Check for invalidation metadata
            const invalidated = (result as any)._invalidated;
            const healthStatus = (result as any)._healthStatus;
            return !invalidated || healthStatus !== "eliminated";
          }
        ).length;
      }

      // Decide on action based on pool size and failure count
      let shouldInvalidate = false;

      // Only eliminate if we have more than MIN_VIABLE_RPCS (1) healthy RPCs
      if (healthyRpcs > MIN_VIABLE_RPCS && failureData.consecutiveFailures >= this.eliminationThreshold) {
        failureData.status = "eliminated";
        shouldInvalidate = true;
        this._log("warn", `[POOL_MGMT] Eliminating RPC ${rpcUrl} (chain ${chainId}) - ${failureData.consecutiveFailures} consecutive failures. ${healthyRpcs - 1} healthy RPCs remain.`);
      }

      // Save updated failure data
      await kv.set(failureKey, failureData);

      // If we should invalidate, update the cache
      if (shouldInvalidate && failureData.status === "eliminated") {
        await this.cacheManager.invalidateRpcInCache(chainId, rpcUrl, failureData.status);
      }

      return shouldInvalidate;
    } catch (error) {
      this._log("error", `Failed to track RPC failure for ${rpcUrl}:`, error);
      return false;
    }
  }

  /**
   * Clears failure tracking for a successful RPC call
   */
  private async clearRpcFailures(chainId: number, rpcUrl: string): Promise<void> {
    if (!this.enableBadNetworkInvalidation) {
      return;
    }

    try {
      const kv = await Deno.openKv();
      const failureKey = ["rpc_failures", chainId, rpcUrl];
      await kv.delete(failureKey);
      this._log("debug", `Cleared failure tracking for ${rpcUrl} after successful call`);
    } catch (error) {
      this._log("error", `Failed to clear RPC failures for ${rpcUrl}:`, error);
    }
  }

  /**
   * Classifies error types for better logging
   */
  private classifyError(error: Error): string {
    const msg = error.message.toLowerCase();

    if (msg.includes("rate") || msg.includes("throttle") || msg.includes("429") || msg.includes("too many")) {
      return "RATE_LIMIT";
    }
    if (msg.includes("timeout") || msg.includes("timed out")) {
      return "TIMEOUT";
    }
    if (msg.includes("connection") || msg.includes("connect") || msg.includes("network")) {
      return "NETWORK";
    }
    if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504")) {
      return "SERVER_ERROR";
    }
    if (msg.includes("400") || msg.includes("bad request")) {
      return "BAD_REQUEST";
    }
    if (msg.includes("403") || msg.includes("forbidden")) {
      return "FORBIDDEN";
    }
    if (msg.includes("json") || error.name === "TypeError") {
      return "PARSE_ERROR";
    }
    return "GENERAL_ERROR";
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

        // Clear failure tracking for successful call
        await this.clearRpcFailures(chainId, rpcUrl);

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

        // Comprehensive retry logic for robustness
        const isRetryable =
          // JsonRpcError objects that preserve HTTP error status (from RPC provider issues)
          (error.name === "JsonRpcError" && 
           "httpStatus" in error && 
           typeof error.httpStatus === "number" && 
           error.httpStatus >= 500) ||

          // Network/connectivity errors
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
          error.message.includes("socket hang up") ||
          error.message.includes("EHOSTUNREACH") ||
          error.message.includes("ENETUNREACH") ||
          error.message.includes("EPIPE") ||

          // HTTP errors that are often transient
          error.message.includes("HTTP error 400") || // Bad Request - can be transient
          error.message.includes("HTTP error 403") || // Forbidden - often rate limiting
          error.message.includes("HTTP error 429") || // Too Many Requests
          error.message.includes("HTTP error 500") || // Internal Server Error
          error.message.includes("HTTP error 502") || // Bad Gateway
          error.message.includes("HTTP error 503") || // Service Unavailable
          error.message.includes("HTTP error 504") || // Gateway Timeout
          error.message.includes("HTTP error 520") || // Cloudflare errors
          error.message.includes("HTTP error 521") ||
          error.message.includes("HTTP error 522") ||
          error.message.includes("HTTP error 523") ||
          error.message.includes("HTTP error 524") ||

          // Rate limiting patterns (case-insensitive)
          error.message.toLowerCase().includes("rate limit") ||
          error.message.toLowerCase().includes("rate-limit") ||
          error.message.toLowerCase().includes("ratelimit") ||
          error.message.toLowerCase().includes("too many requests") ||
          error.message.toLowerCase().includes("throttle") ||
          error.message.toLowerCase().includes("exceeded") ||
          error.message.toLowerCase().includes("quota") ||
          error.message.toLowerCase().includes("capacity") ||
          error.message.toLowerCase().includes("limit reached") ||
          error.message.toLowerCase().includes("max requests") ||
          error.message.toLowerCase().includes("maximum requests") ||
          error.message.toLowerCase().includes("too many calls") ||
          error.message.toLowerCase().includes("slow down") ||

          // JSON parsing errors (often from overloaded servers)
          error.message.includes("Invalid JSON") ||
          error.message.includes("Unexpected token") ||
          error.message.includes("JSON.parse") ||
          error.message.includes("Failed to parse") ||

          // TypeErrors (often from malformed responses)
          error.name === "TypeError" ||

          // Generic timeout patterns
          (error.message.toLowerCase().includes("timeout") &&
           !error.message.includes("transaction")) || // Exclude transaction timeouts

          // Generic temporary/transient patterns
          error.message.toLowerCase().includes("temporarily") ||
          error.message.toLowerCase().includes("temporary") ||
          error.message.toLowerCase().includes("try again") ||
          error.message.toLowerCase().includes("retry") ||
          error.message.toLowerCase().includes("unavailable") ||
          error.message.toLowerCase().includes("busy") ||

          // Common RPC provider error messages that should be retried
          error.message.includes("Unable to perform request");

        if (!isRetryable) {
          this._log("info", `[NON-RETRYABLE] Forwarding error from ${rpcUrl}: ${error.message}`);
          throw error;
        }

        // Log retryable errors with classification
        const errorType = this.classifyError(error);
        this._log("warn", `[${errorType}] RPC failed: ${rpcUrl} (chain ${chainId}, method: ${method})`);
        this._log("warn", `  Error details: ${error.message}`);
        this._log("debug", `  Full error:`, error);

        // Track the failure for adaptive pool management
        await this.trackRpcFailure(chainId, rpcUrl);

        this._log("info", `  Attempting failover to next RPC (${i+1}/${rankedRpcList.length})...`);
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

        // Try to parse the response body to check if it's a valid JSON-RPC error
        // This handles cases where contract reverts return HTTP 500 but contain valid JSON-RPC errors
        let responseText: string;
        try {
          responseText = await response.text();
        } catch (textError) {
          // If we can't read the response body, treat as genuine HTTP error
          throw new JsonRpcError(
            -32000,
            `HTTP error ${response.status} ${response.statusText}`,
            undefined,
            response.status
          );
        }

        // Try to parse as JSON-RPC to see if it's a contract revert
        let parsedResponse: any;
        try {
          parsedResponse = JSON.parse(responseText);
        } catch (jsonError) {
          // If JSON parsing fails, it's a genuine HTTP error
          throw new JsonRpcError(
            -32000,
            `HTTP error ${response.status} ${response.statusText}`,
            undefined,
            response.status
          );
        }

        // Check if this is a valid JSON-RPC error response
        if (parsedResponse &&
            typeof parsedResponse === "object" &&
            parsedResponse.jsonrpc === "2.0" &&
            parsedResponse.error &&
            typeof parsedResponse.error === "object") {

          // For HTTP 5xx errors with JSON-RPC responses, preserve HTTP status for retry logic
          // These are typically RPC provider issues, not contract execution reverts
          if (response.status >= 500) {
            this._log("debug", `RPC provider error (HTTP ${response.status}) from ${url}: ${parsedResponse.error.message}`);
            throw new JsonRpcError(
              parsedResponse.error.code || -32603,
              parsedResponse.error.message || "RPC provider error",
              parsedResponse.error.data,
              response.status // Preserve HTTP status for retry logic
            );
          }

          // For other HTTP errors with JSON-RPC responses (likely contract reverts), use HTTP 200
          this._log("debug", `Contract revert detected from ${url}: ${parsedResponse.error.message}`);
          throw new JsonRpcError(
            parsedResponse.error.code || -32603,
            parsedResponse.error.message || "Contract execution reverted",
            parsedResponse.error.data
            // Note: No httpStatus provided, defaults to 200
          );
        }

        // If not a valid JSON-RPC response, treat as genuine HTTP error
        throw new JsonRpcError(
          -32000,
          `HTTP error ${response.status} ${response.statusText}`,
          undefined,
          response.status
        );
      }
      // For successful HTTP responses, parse the JSON
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

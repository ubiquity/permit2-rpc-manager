// import type { Address } from "viem"; // Removed - not used internally
import { CacheManager } from "./cache-manager.ts";
import { ChainlistDataSource } from "./chainlist-data-source.ts";
import { LatencyTester } from "./latency-tester.ts";
import { RpcSelector } from "./rpc-selector.ts";

// JSON-RPC error codes as per specification
const JSON_RPC_ERROR_CODES = {
  // Standard errors
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // Implementation-defined errors start at -32000
  IMPLEMENTATION_DEFINED_START: -32000,

  // Common provider-specific codes
  EXECUTION_REVERTED: 3,
  UNAUTHORIZED: -32001,
  ACTION_NOT_PERMITTED: -32002,
  EXECUTION_ERROR: -32003,
  QUOTA_EXCEEDED: -32004,
  REQUEST_LIMIT: -32005,
} as const;

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

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: unknown[];
  id: number | string;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// RPC health tracking
interface RpcHealthState {
  consecutiveFailures: number;
  lastFailureTime: number;
  lastSuccessTime: number;
  temporaryUnavailableUntil?: number;
  failureReasons: Map<string, number>; // reason -> count
}

// Error classification based on behavior, not strings
enum ErrorBehavior {
  RETRY_WITH_BACKOFF,    // Temporary issues (rate limits, timeouts)
  RETRY_DIFFERENT_RPC,   // Provider-specific issues
  DO_NOT_RETRY,          // Client errors (bad request, method not found)
  BLOCKCHAIN_ERROR,      // Execution errors (revert, insufficient funds)
}

interface ErrorClassification {
  behavior: ErrorBehavior;
  reason: string;
  isProviderIssue: boolean;
}

/**
 * Options for configuring the Permit2RpcManager.
 */
export interface Permit2RpcManagerOptions {
  cacheTtlMs?: number;
  latencyTimeoutMs?: number;
  requestTimeoutMs?: number;
  nodeCachePath?: string;
  localStorageKey?: string;
  logLevel?: "debug" | "info" | "warn" | "error" | "none";
  initialRpcData?: { rpcs: { [chainId: string]: string[] } };
  disableCache?: boolean;

  // Health management
  maxConsecutiveFailures?: number;
  backoffBaseMs?: number;
  maxBackoffMs?: number;
  healthCheckIntervalMs?: number;

  // Adaptive backoff config
  adaptiveBackoffMinAvailableRpcs?: number; // default: 3
  adaptiveBackoffPanicMinMs?: number; // default: 1000
  adaptiveBackoffPanicMaxMs?: number; // default: 2000

  /**
   * Enable or disable panic mode (emergency refresh logic).
   * When enabled, the manager will attempt a full pool refresh if all RPCs are unhealthy.
   * @default true
   */
  panicModeEnabled?: boolean;

  /**
   * Timeout in milliseconds for emergency refresh operations in panic mode.
   * Controls how long to wait for RPC responses during a panic mode refresh.
   * @default 2000
   */
  panicModeTimeoutMs?: number;

  /**
   * Minimum interval in milliseconds between forced pool refreshes in panic mode.
   * Prevents excessive refresh attempts when all RPCs are unhealthy.
   * @default 30000
   */
  panicModeRefreshThresholdMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_LOG_LEVEL = "warn";
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 60000;

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
  private options?: Permit2RpcManagerOptions;

  // Health tracking
  private rpcHealthStates = new Map<string, RpcHealthState>();
  private maxConsecutiveFailures: number;
  private backoffBaseMs: number;
  private maxBackoffMs: number;

  // Emergency refresh / panic mode config
  private panicModeEnabled: boolean;
  private panicModeTimeoutMs: number;
  private panicModeRefreshThresholdMs: number;

  // Round-robin tracking
  private rpcIndexMap = new Map<number, number>();

  constructor(options: Permit2RpcManagerOptions = {}) {
    this.options = options;
    this.logLevel = options.logLevel ?? DEFAULT_LOG_LEVEL;
    this.configuredLogLevelValue = LOG_LEVEL_HIERARCHY[this.logLevel];
    const logger = this._log.bind(this);

    this.dataSource = new ChainlistDataSource(logger, options.initialRpcData);
    this.cacheManager = new CacheManager({
      cacheTtlMs: options.cacheTtlMs,
      localStorageKey: options.localStorageKey,
      logger: logger,
      disableCache: options.disableCache,
    });
    this.latencyTester = new LatencyTester(options.latencyTimeoutMs, logger);
    this.rpcSelector = new RpcSelector(this.dataSource, this.cacheManager, this.latencyTester, logger);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

    // Emergency refresh / panic mode config
    this.panicModeEnabled = options.panicModeEnabled ?? true;
    this.panicModeTimeoutMs = options.panicModeTimeoutMs ?? 2000;
    this.panicModeRefreshThresholdMs = options.panicModeRefreshThresholdMs ?? 30000;
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
   * Classify errors based on their characteristics, not string parsing
   */
  private classifyError(error: Error): ErrorClassification {
    // Check JSON-RPC errors first (most structured)
    if (error instanceof JsonRpcError) {
      const { code, httpStatus } = error;

      // HTTP status takes precedence for network-level issues
      if (httpStatus) {
        if (httpStatus === 429) {
          return {
            behavior: ErrorBehavior.RETRY_WITH_BACKOFF,
            reason: "rate_limit",
            isProviderIssue: true
          };
        }

        if (httpStatus === 403) {
          // 403 with specific JSON-RPC codes indicates quota
          if (code === JSON_RPC_ERROR_CODES.QUOTA_EXCEEDED || code === JSON_RPC_ERROR_CODES.REQUEST_LIMIT) {
            return {
              behavior: ErrorBehavior.RETRY_WITH_BACKOFF,
              reason: "quota_exceeded",
              isProviderIssue: true
            };
          }
          // Other 403s might be auth issues
          return {
            behavior: ErrorBehavior.DO_NOT_RETRY,
            reason: "forbidden",
            isProviderIssue: false
          };
        }

        if (httpStatus >= 500 && httpStatus <= 599) {
          return {
            behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
            reason: "server_error",
            isProviderIssue: true
          };
        }

        if (httpStatus === 408) {
          return {
            behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
            reason: "timeout",
            isProviderIssue: true
          };
        }

        if (httpStatus >= 400 && httpStatus <= 499) {
          return {
            behavior: ErrorBehavior.DO_NOT_RETRY,
            reason: "client_error",
            isProviderIssue: false
          };
        }
      }

      // JSON-RPC error codes
      if (code === JSON_RPC_ERROR_CODES.EXECUTION_REVERTED) {
        return {
          behavior: ErrorBehavior.BLOCKCHAIN_ERROR,
          reason: "execution_reverted",
          isProviderIssue: false
        };
      }

      if (code >= JSON_RPC_ERROR_CODES.IMPLEMENTATION_DEFINED_START) {
        // Provider-specific errors
        if (code === JSON_RPC_ERROR_CODES.QUOTA_EXCEEDED || code === JSON_RPC_ERROR_CODES.REQUEST_LIMIT) {
          return {
            behavior: ErrorBehavior.RETRY_WITH_BACKOFF,
            reason: "quota_exceeded",
            isProviderIssue: true
          };
        }

        // Other implementation-defined errors are usually retryable
        return {
          behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
          reason: "provider_error",
          isProviderIssue: true
        };
      }

      // Standard JSON-RPC errors
      if (code <= -32000 && code >= -32768) {
        return {
          behavior: ErrorBehavior.DO_NOT_RETRY,
          reason: "json_rpc_error",
          isProviderIssue: false
        };
      }
    }

    // Network errors
    if (error.name === "AbortError") {
      return {
        behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
        reason: "timeout",
        isProviderIssue: true
      };
    }

    if (error.name === "TypeError" || error.message === "Failed to fetch") {
      return {
        behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
        reason: "network_error",
        isProviderIssue: true
      };
    }

    // Default: assume it's retryable
    return {
      behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
      reason: "unknown_error",
      isProviderIssue: true
    };
  }

  /**
   * Get or create health state for an RPC
   */
  private getHealthState(rpcUrl: string): RpcHealthState {
    const key = rpcUrl;
    let state = this.rpcHealthStates.get(key);

    if (!state) {
      state = {
        consecutiveFailures: 0,
        lastFailureTime: 0,
        lastSuccessTime: 0,
        failureReasons: new Map()
      };
      this.rpcHealthStates.set(key, state);
    }

    return state;
  }

  /**
   * Calculate backoff time for an RPC based on its failure count and pool health
    * @param consecutiveFailures Number of consecutive failures for this RPC
    * @param availableRpcCount Number of currently available RPCs in the pool
    */
   private calculateBackoffMs(
     consecutiveFailures: number,
     availableRpcCount?: number
   ): number {
     // Configurable thresholds
     const minAvailableRpcs = this.options?.adaptiveBackoffMinAvailableRpcs ?? 3;
     const panicBackoffMinMs = this.options?.adaptiveBackoffPanicMinMs ?? 1000;
     const panicBackoffMaxMs = this.options?.adaptiveBackoffPanicMaxMs ?? 2000;
     // If availableRpcCount is provided, apply adaptive logic
     if (typeof availableRpcCount === "number") {
       if (availableRpcCount === 0) {
         // Panic: no RPCs available, use minimal backoff (1-2s)
         return (
           panicBackoffMinMs +
           Math.floor(
             Math.random() * (panicBackoffMaxMs - panicBackoffMinMs + 1)
           )
         );
       }
       if (availableRpcCount < minAvailableRpcs) {
         // Danger: very few RPCs, reduce backoff by 75%
         const base = Math.min(
           this.backoffBaseMs * Math.pow(2, consecutiveFailures - 1),
           this.maxBackoffMs
         );
         return Math.max(Math.floor(base * 0.25), 250);
       }
     }
     // Normal: standard exponential backoff
     const backoff = Math.min(
       this.backoffBaseMs * Math.pow(2, consecutiveFailures - 1),
       this.maxBackoffMs
     );
     return backoff;
   }

  /**
   * Check if an RPC is currently available (not in backoff)
   */
  private isRpcAvailable(rpcUrl: string): boolean {
    const state = this.getHealthState(rpcUrl);

    if (state.temporaryUnavailableUntil) {
      const now = Date.now();
      if (now < state.temporaryUnavailableUntil) {
        return false;
      }
      // Backoff expired, clear it
      state.temporaryUnavailableUntil = undefined;
    }

    return state.consecutiveFailures < this.maxConsecutiveFailures;
  }

  /**
   * Record a successful RPC call
   */
  private async recordSuccess(chainId: number, rpcUrl: string): Promise<void> {
    const state = this.getHealthState(rpcUrl);

    state.consecutiveFailures = 0;
    state.lastSuccessTime = Date.now();
    state.temporaryUnavailableUntil = undefined;
    state.failureReasons.clear();

    this._log("debug", `[HEALTH] RPC ${rpcUrl} marked healthy`);

    // Update KV if we had failures before
    if (state.lastFailureTime > 0) {
      try {
        const kv = await Deno.openKv();
        const failureKey = ["rpc_failures", chainId, rpcUrl];
        await kv.delete(failureKey);
      } catch (error) {
        this._log("error", `Failed to clear RPC failures in KV:`, error);
      }
    }
  }

  /**
   * Record a failed RPC call
   */
  private async recordFailure(
    chainId: number,
    rpcUrl: string,
    classification: ErrorClassification
  ): Promise<void> {
    const state = this.getHealthState(rpcUrl);

    state.consecutiveFailures++;
    state.lastFailureTime = Date.now();

    // Track failure reasons
    const count = state.failureReasons.get(classification.reason) || 0;
    state.failureReasons.set(classification.reason, count + 1);

    // Apply backoff based on error behavior
    if (classification.behavior === ErrorBehavior.RETRY_WITH_BACKOFF) {
      // Adaptive backoff: count available RPCs (async)
      let availableRpcCount: number | undefined = undefined;
      if (typeof this.rpcSelector?.getAvailableRpcCount === "function") {
        try {
          availableRpcCount = await this.rpcSelector.getAvailableRpcCount();
        } catch {
          availableRpcCount = undefined;
        }
      }
      const backoffMs = this.calculateBackoffMs(
        state.consecutiveFailures,
        availableRpcCount
      );
      state.temporaryUnavailableUntil = Date.now() + backoffMs;

      this._log(
        "warn",
        `[HEALTH] RPC ${rpcUrl} entering backoff for ${backoffMs}ms due to ${classification.reason} ` +
          `(${state.consecutiveFailures} consecutive failures, available RPCs: ${availableRpcCount})`
      );
    } else if (state.consecutiveFailures >= this.maxConsecutiveFailures) {
      // Mark as unavailable for longer period
      state.temporaryUnavailableUntil = Date.now() + this.maxBackoffMs * 2;

      this._log("warn",
        `[HEALTH] RPC ${rpcUrl} marked unhealthy after ${state.consecutiveFailures} failures. ` +
        `Reasons: ${Array.from(state.failureReasons.entries()).map(([r, c]) => `${r}:${c}`).join(", ")}`
      );
    }

    // Persist to KV for recovery after restart
    try {
      const kv = await Deno.openKv();
      const failureKey = ["rpc_failures", chainId, rpcUrl];
      await kv.set(failureKey, {
        consecutiveFailures: state.consecutiveFailures,
        lastFailureTime: state.lastFailureTime,
        failureReasons: Object.fromEntries(state.failureReasons),
        temporaryUnavailableUntil: state.temporaryUnavailableUntil
      });
    } catch (error) {
      this._log("error", `Failed to persist RPC failure to KV:`, error);
    }
  }

  /**
   * Send a JSON-RPC request with intelligent failover
   */
  async send<T = unknown>(chainId: number, method: string, params: unknown[] = []): Promise<T> {
    let allRpcs = await this.rpcSelector.getRankedRpcList(chainId);

    // Filter available RPCs
    let availableRpcs = allRpcs.filter(rpc => this.isRpcAvailable(rpc));

    // Emergency Pool Refresh / Panic Mode
    if (
      this.panicModeEnabled &&
      availableRpcs.length === 0 &&
      allRpcs.length > 0
    ) {
      // Check last test time from cache
      this._log(
        "warn",
        `[EMERGENCY] All RPCs unhealthy for chain ${chainId}. Forcing full pool refresh in PANIC MODE (timeout ${this.panicModeTimeoutMs}ms)`
      );
      // Force refresh with panic mode timeout
      allRpcs = await this.rpcSelector.getRankedRpcList(
        chainId,
        true,
        this.panicModeTimeoutMs
      );
      availableRpcs = allRpcs.filter(rpc => this.isRpcAvailable(rpc));
    }

    if (availableRpcs.length === 0) {
      // Check if all are in backoff
      const backoffCount = allRpcs.filter(rpc => {
        const state = this.getHealthState(rpc);
        return state.temporaryUnavailableUntil && state.temporaryUnavailableUntil > Date.now();
      }).length;

      if (backoffCount > 0) {
        throw new Error(
          `All ${backoffCount} RPC endpoints are temporarily unavailable for chain ${chainId}. ` +
          `Please retry in a few seconds.`
        );
      }

      throw new Error(`No healthy RPC endpoints available for chain ${chainId}.`);
    }

    // Round-robin selection
    const currentIndex = this.rpcIndexMap.get(chainId) || 0;
    const startIndex = currentIndex % availableRpcs.length;
    this.rpcIndexMap.set(chainId, (currentIndex + 1) % availableRpcs.length);

    this._log(
      "debug",
      `[SEND] Chain ${chainId}: ${availableRpcs.length}/${allRpcs.length} RPCs available. ` +
        `Starting at index ${startIndex}.`
    );

    let lastError: Error | null = null;
    const attemptedRpcs: string[] = [];

    // Try each available RPC
    for (let i = 0; i < availableRpcs.length; i++) {
      const rpcIndex = (startIndex + i) % availableRpcs.length;
      const rpcUrl = availableRpcs[rpcIndex];

      attemptedRpcs.push(rpcUrl);

      try {
        this._log("info", `[SEND] Trying ${rpcUrl} for ${method} on chain ${chainId}`);

        const result = await this.executeRpcCall<T>(rpcUrl, method, params);

        // Success - record it and return
        await this.recordSuccess(chainId, rpcUrl);
        return result;

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Classify the error
        const classification = this.classifyError(lastError);

        this._log(
          "warn",
          `[SEND] RPC ${rpcUrl} failed: ${classification.reason} ` +
            `(behavior: ${ErrorBehavior[classification.behavior]})`
        );

        // Record the failure
        await this.recordFailure(chainId, rpcUrl, classification);

        // Decide if we should continue trying other RPCs
        switch (classification.behavior) {
          case ErrorBehavior.DO_NOT_RETRY:
          case ErrorBehavior.BLOCKCHAIN_ERROR:
            // These errors will be the same on all RPCs
            throw lastError;

          case ErrorBehavior.RETRY_WITH_BACKOFF:
          case ErrorBehavior.RETRY_DIFFERENT_RPC:
            // Continue to next RPC
            continue;
        }
      }
    }

    // All RPCs failed
    const errorMsg = lastError?.message || "Unknown error";
    throw new JsonRpcError(
      -32000,
      `All ${attemptedRpcs.length} RPC endpoints failed for chain ${chainId}. ` +
        `Attempted: [${attemptedRpcs.join(", ")}]. Last error: ${errorMsg}`,
      { attemptedRpcs, chainId }
    );
  }

  /**
   * Execute a single RPC call
   */
  public async executeRpcCall<T = unknown>(
    url: string,
    method: string,
    params: unknown[]
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    const requestBody: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      params,
      id: Date.now(),
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Parse response regardless of HTTP status
      let responseData: any;
      try {
        responseData = await response.json();
      } catch (jsonError) {
        throw new JsonRpcError(
          JSON_RPC_ERROR_CODES.PARSE_ERROR,
          `Invalid JSON response from provider`,
          undefined,
          response.status
        );
      }

      // Check for JSON-RPC error
      if (responseData.error) {
        throw new JsonRpcError(
          responseData.error.code || JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
          responseData.error.message || "RPC error",
          responseData.error.data,
          response.status
        );
      }

      // Check HTTP status after parsing (some providers return errors as 200 OK)
      if (!response.ok) {
        throw new JsonRpcError(
          JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
          `HTTP error ${response.status} ${response.statusText}`,
          undefined,
          response.status
        );
      }

      return responseData.result as T;

    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        throw new JsonRpcError(
          JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
          `Request timeout after ${this.requestTimeoutMs}ms`,
          undefined,
          408
        );
      }

      throw error;
    }
  }

  /**
   * Handle batch requests properly
   */
  async sendBatch<T = unknown>(
    chainId: number,
    requests: Array<{ method: string; params?: unknown[] }>
  ): Promise<T[]> {
    // For now, just send individual requests
    // TODO: Implement proper batch handling
    const results = await Promise.all(
      requests.map(req => this.send<T>(chainId, req.method, req.params || []))
    );
    return results;
  }
}

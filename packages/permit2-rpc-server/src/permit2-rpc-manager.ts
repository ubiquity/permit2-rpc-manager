// import type { Address } from "viem"; // Removed - not used internally
import { CacheManager } from "./cache-manager.ts";
import { ChainlistDataSource } from "./chainlist-data-source.ts";
import { LatencyTester } from "./latency-tester.ts";
import { RpcSelector } from "./rpc-selector.ts";
import {
  AdaptiveTimeout,
  CircuitBreaker,
  RequestDeduplicator,
  RpcScorer,
  SmartBatcher,
} from "./reliability-improvements.ts";

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
    public httpStatus?: number,
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
  RETRY_WITH_BACKOFF, // Temporary issues (rate limits, timeouts)
  RETRY_DIFFERENT_RPC, // Provider-specific issues
  DO_NOT_RETRY, // Client errors (bad request, method not found)
  BLOCKCHAIN_ERROR, // Execution errors (revert, insufficient funds)
}

interface ErrorClassification {
  behavior: ErrorBehavior;
  reason: string;
  isProviderIssue: boolean;
}

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

  // Health tracking
  private rpcHealthStates = new Map<string, RpcHealthState>();
  private maxConsecutiveFailures: number;
  private backoffBaseMs: number;
  private maxBackoffMs: number;

  // Round-robin tracking
  private rpcIndexMap = new Map<number, number>();

  // Reliability improvements
  private requestDeduplicator: RequestDeduplicator;
  private adaptiveTimeout: AdaptiveTimeout;
  private smartBatcher: SmartBatcher;
  private rpcScorer: RpcScorer;
  private circuitBreaker: CircuitBreaker;

  constructor(options: Permit2RpcManagerOptions = {}) {
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

    // Initialize reliability improvements
    this.requestDeduplicator = new RequestDeduplicator();
    this.adaptiveTimeout = new AdaptiveTimeout();
    this.smartBatcher = new SmartBatcher();
    this.rpcScorer = new RpcScorer();
    this.circuitBreaker = new CircuitBreaker();
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
            isProviderIssue: true,
          };
        }

        if (httpStatus === 403) {
          // 403 with specific JSON-RPC codes indicates quota
          if (code === JSON_RPC_ERROR_CODES.QUOTA_EXCEEDED || code === JSON_RPC_ERROR_CODES.REQUEST_LIMIT) {
            return {
              behavior: ErrorBehavior.RETRY_WITH_BACKOFF,
              reason: "quota_exceeded",
              isProviderIssue: true,
            };
          }
          // Other 403s might be auth issues
          return {
            behavior: ErrorBehavior.DO_NOT_RETRY,
            reason: "forbidden",
            isProviderIssue: false,
          };
        }

        if (httpStatus >= 500 && httpStatus <= 599) {
          return {
            behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
            reason: "server_error",
            isProviderIssue: true,
          };
        }

        if (httpStatus === 408) {
          return {
            behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
            reason: "timeout",
            isProviderIssue: true,
          };
        }

        if (httpStatus >= 400 && httpStatus <= 499) {
          return {
            behavior: ErrorBehavior.DO_NOT_RETRY,
            reason: "client_error",
            isProviderIssue: false,
          };
        }
      }

      // JSON-RPC error codes
      if (code === JSON_RPC_ERROR_CODES.EXECUTION_REVERTED) {
        return {
          behavior: ErrorBehavior.BLOCKCHAIN_ERROR,
          reason: "execution_reverted",
          isProviderIssue: false,
        };
      }

      if (code >= JSON_RPC_ERROR_CODES.IMPLEMENTATION_DEFINED_START) {
        // Provider-specific errors
        if (code === JSON_RPC_ERROR_CODES.QUOTA_EXCEEDED || code === JSON_RPC_ERROR_CODES.REQUEST_LIMIT) {
          return {
            behavior: ErrorBehavior.RETRY_WITH_BACKOFF,
            reason: "quota_exceeded",
            isProviderIssue: true,
          };
        }

        // Other implementation-defined errors are usually retryable
        return {
          behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
          reason: "provider_error",
          isProviderIssue: true,
        };
      }

      // Standard JSON-RPC errors
      if (code <= -32000 && code >= -32768) {
        return {
          behavior: ErrorBehavior.DO_NOT_RETRY,
          reason: "json_rpc_error",
          isProviderIssue: false,
        };
      }
    }

    // Network errors
    if (error.name === "AbortError") {
      return {
        behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
        reason: "timeout",
        isProviderIssue: true,
      };
    }

    if (error.name === "TypeError" || error.message === "Failed to fetch") {
      return {
        behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
        reason: "network_error",
        isProviderIssue: true,
      };
    }

    // Default: assume it's retryable
    return {
      behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
      reason: "unknown_error",
      isProviderIssue: true,
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
        failureReasons: new Map(),
      };
      this.rpcHealthStates.set(key, state);
    }

    return state;
  }

  /**
   * Calculate backoff time for an RPC based on its failure count
   */
  private calculateBackoffMs(consecutiveFailures: number): number {
    const backoff = Math.min(
      this.backoffBaseMs * Math.pow(2, consecutiveFailures - 1),
      this.maxBackoffMs,
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
    classification: ErrorClassification,
  ): Promise<void> {
    const state = this.getHealthState(rpcUrl);

    state.consecutiveFailures++;
    state.lastFailureTime = Date.now();

    // Track failure reasons
    const count = state.failureReasons.get(classification.reason) || 0;
    state.failureReasons.set(classification.reason, count + 1);

    // Apply backoff based on error behavior
    if (classification.behavior === ErrorBehavior.RETRY_WITH_BACKOFF) {
      const backoffMs = this.calculateBackoffMs(state.consecutiveFailures);
      state.temporaryUnavailableUntil = Date.now() + backoffMs;

      this._log(
        "warn",
        `[HEALTH] RPC ${rpcUrl} entering backoff for ${backoffMs}ms due to ${classification.reason} ` +
          `(${state.consecutiveFailures} consecutive failures)`,
      );
    } else if (state.consecutiveFailures >= this.maxConsecutiveFailures) {
      // Mark as unavailable for longer period
      state.temporaryUnavailableUntil = Date.now() + this.maxBackoffMs * 2;

      this._log(
        "warn",
        `[HEALTH] RPC ${rpcUrl} marked unhealthy after ${state.consecutiveFailures} failures. ` +
          `Reasons: ${Array.from(state.failureReasons.entries()).map(([r, c]) => `${r}:${c}`).join(", ")}`,
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
        temporaryUnavailableUntil: state.temporaryUnavailableUntil,
      });
    } catch (error) {
      this._log("error", `Failed to persist RPC failure to KV:`, error);
    }
  }

  /**
   * Send a JSON-RPC request with intelligent failover
   */
  send<T = unknown>(chainId: number, method: string, params: unknown[] = []): Promise<T> {
    // Use request deduplication for identical concurrent requests
    const deduplicationKey = RequestDeduplicator.generateKey(chainId, method, params);

    return this.requestDeduplicator.deduplicate(deduplicationKey, () => {
      return this._sendInternal<T>(chainId, method, params);
    });
  }

  /**
   * Internal send implementation (after deduplication)
   */
  private async _sendInternal<T = unknown>(chainId: number, method: string, params: unknown[]): Promise<T> {
    const allRpcs = await this.rpcSelector.getRankedRpcList(chainId);

    // Filter available RPCs using both health state and circuit breaker
    const availableRpcs = allRpcs.filter((rpc) => this.isRpcAvailable(rpc) && this.circuitBreaker.canRequest(rpc));

    // Use RPC scorer to rank available RPCs by performance
    const rankedRpcs = this.rpcScorer.getRankedRpcs(availableRpcs);

    if (rankedRpcs.length === 0) {
      // Check if all are in backoff
      const backoffCount = allRpcs.filter((rpc) => {
        const state = this.getHealthState(rpc);
        return state.temporaryUnavailableUntil && state.temporaryUnavailableUntil > Date.now();
      }).length;

      if (backoffCount > 0) {
        throw new Error(
          `All ${backoffCount} RPC endpoints are temporarily unavailable for chain ${chainId}. ` +
            `Please retry in a few seconds.`,
        );
      }

      // Emergency fallback: Reset all RPC health states and retry with full list
      this._log(
        "warn",
        `[EMERGENCY FALLBACK] No healthy RPCs available for chain ${chainId}. ` +
          `Resetting all RPC health states and retrying with full list.`,
      );

      // Reset all RPC health states for this chain
      await this.resetAllRpcHealthStates(chainId, allRpcs);

      // Re-filter available RPCs after reset
      const resetAvailableRpcs = allRpcs.filter((rpc) => this.isRpcAvailable(rpc));

      if (resetAvailableRpcs.length > 0) {
        // Continue with the reset RPCs - update rankedRpcs for the rest of the method
        rankedRpcs.length = 0;
        rankedRpcs.push(...this.rpcScorer.getRankedRpcs(resetAvailableRpcs));

        this._log(
          "info",
          `[EMERGENCY FALLBACK] Successfully reset ${resetAvailableRpcs.length} RPCs for chain ${chainId}`,
        );
      } else {
        // If still no RPCs available after reset, this is a configuration issue
        throw new Error(
          `No RPC endpoints configured or all endpoints are fundamentally unreachable for chain ${chainId}. ` +
            `Please check your RPC configuration.`,
        );
      }
    }

    // Round-robin selection from ranked RPCs
    const currentIndex = this.rpcIndexMap.get(chainId) || 0;
    const startIndex = currentIndex % rankedRpcs.length;
    this.rpcIndexMap.set(chainId, (currentIndex + 1) % rankedRpcs.length);

    this._log(
      "debug",
      `[SEND] Chain ${chainId}: ${rankedRpcs.length}/${allRpcs.length} RPCs available. ` +
        `Starting at index ${startIndex}.`,
    );

    let lastError: Error | null = null;
    const attemptedRpcs: string[] = [];

    // Try each available RPC
    for (let i = 0; i < rankedRpcs.length; i++) {
      const rpcIndex = (startIndex + i) % rankedRpcs.length;
      const rpcUrl = rankedRpcs[rpcIndex];

      attemptedRpcs.push(rpcUrl);

      try {
        this._log("info", `[SEND] Trying ${rpcUrl} for ${method} on chain ${chainId}`);

        const startTime = Date.now();
        const result = await this.executeRpcCall<T>(rpcUrl, method, params);
        const responseTime = Date.now() - startTime;

        // Record success metrics
        await this.recordSuccess(chainId, rpcUrl);
        this.rpcScorer.updateScore(rpcUrl, true, responseTime);
        this.circuitBreaker.recordResult(rpcUrl, true);
        this.adaptiveTimeout.recordResponseTime(rpcUrl, responseTime);

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Classify the error
        const classification = this.classifyError(lastError);

        this._log(
          "warn",
          `[SEND] RPC ${rpcUrl} failed: ${classification.reason} ` +
            `(behavior: ${ErrorBehavior[classification.behavior]})`,
        );

        // Decide if we should continue trying other RPCs
        switch (classification.behavior) {
          case ErrorBehavior.DO_NOT_RETRY:
          case ErrorBehavior.BLOCKCHAIN_ERROR:
            // These are client/request errors that will be the same on all RPCs
            // Don't record as failures to prevent cascading health issues
            this._log(
              "info",
              `[SEND] Error type ${ErrorBehavior[classification.behavior]} detected. ` +
                `Not recording as RPC failure to prevent cascade.`,
            );
            throw lastError;

          case ErrorBehavior.RETRY_WITH_BACKOFF:
          case ErrorBehavior.RETRY_DIFFERENT_RPC:
            // These are RPC-specific issues that should count toward health
            await this.recordFailure(chainId, rpcUrl, classification);
            this.rpcScorer.updateScore(rpcUrl, false);
            this.circuitBreaker.recordResult(rpcUrl, false);
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
      { attemptedRpcs, chainId },
    );
  }

  /**
   * Execute a single RPC call
   */
  public async executeRpcCall<T = unknown>(
    url: string,
    method: string,
    params: unknown[],
  ): Promise<T> {
    const controller = new AbortController();
    // Use adaptive timeout if available, otherwise default
    const timeout = this.adaptiveTimeout.getTimeout(url, this.requestTimeoutMs);
    const timeoutId = setTimeout(() => controller.abort(), timeout);

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
      } catch (_jsonError) {
        throw new JsonRpcError(
          JSON_RPC_ERROR_CODES.PARSE_ERROR,
          `Invalid JSON response from provider`,
          undefined,
          response.status,
        );
      }

      // Check for JSON-RPC error
      if (responseData.error) {
        throw new JsonRpcError(
          responseData.error.code || JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
          responseData.error.message || "RPC error",
          responseData.error.data,
          response.status,
        );
      }

      // Check HTTP status after parsing (some providers return errors as 200 OK)
      if (!response.ok) {
        throw new JsonRpcError(
          JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
          `HTTP error ${response.status} ${response.statusText}`,
          undefined,
          response.status,
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
          408,
        );
      }

      throw error;
    }
  }

  /**
   * Handle batch requests with smart batching
   */
  sendBatch<T = unknown>(
    chainId: number,
    requests: Array<{ method: string; params?: unknown[] }>,
  ): Promise<T[]> {
    // Use smart batcher to split large batches and avoid overwhelming RPCs
    return this.smartBatcher.processBatch(
      requests.map((req) => ({ method: req.method, params: req.params || [] })),
      async (batch) => {
        // Process each chunk with some parallelism but not all at once
        const results = await Promise.all(
          batch.map((req) => this.send<T>(chainId, req.method, req.params)),
        );
        return results;
      },
    );
  }

  /**
   * Emergency fallback: Reset all RPC health states for a given chain
   * This is called when no healthy RPCs are available to prevent permanent failures
   */
  private async resetAllRpcHealthStates(chainId: number, rpcUrls: string[]): Promise<void> {
    this._log("warn", `[HEALTH RESET] Resetting health states for ${rpcUrls.length} RPCs on chain ${chainId}`);

    for (const rpcUrl of rpcUrls) {
      // Use just the rpcUrl as key to match getHealthState
      const healthKey = rpcUrl;

      // Reset the in-memory health state
      this.rpcHealthStates.set(healthKey, {
        consecutiveFailures: 0,
        lastFailureTime: -1,
        lastSuccessTime: Date.now(),
        temporaryUnavailableUntil: -1,
        failureReasons: new Map(),
      });

      // Also clear from KV store to prevent persistence of bad state
      try {
        const kv = await Deno.openKv();
        const failureKey = ["rpc_failures", chainId, rpcUrl];
        await kv.delete(failureKey);

        this._log("debug", `[HEALTH RESET] Cleared KV state for ${rpcUrl}`);
      } catch (error) {
        this._log("error", `[HEALTH RESET] Failed to clear KV state for ${rpcUrl}:`, error);
      }
    }

    this._log("info", `[HEALTH RESET] Successfully reset health states for all RPCs on chain ${chainId}`);
  }

  /**
   * Get comprehensive health status of all RPCs across all chains
   * Returns JSON data suitable for health check endpoints
   */
  async getHealthStatus(): Promise<any> {
    const healthReport: any = {
      timestamp: new Date().toISOString(),
      chains: {},
      summary: {
        totalChains: 0,
        totalRpcs: 0,
        healthyRpcs: 0,
        degradedRpcs: 0,
        failedRpcs: 0,
        eliminatedRpcs: 0
      }
    };

    try {
      // Get cache data from CacheManager
      const cacheData = await this.cacheManager.getCacheState();
      
      // Get all available chains from data source
      const availableChains = this.dataSource.getAvailableChains();
      
      for (const chainId of availableChains) {
        const chainData: any = {
          chainId,
          rpcs: [],
          fastestRpc: null,
          totalRpcs: 0,
          healthyRpcs: 0,
          degradedRpcs: 0,
          failedRpcs: 0,
          eliminatedRpcs: 0
        };

        // Get RPCs for this chain
        const rpcUrls = this.dataSource.getRpcUrls(chainId);
        chainData.totalRpcs = rpcUrls.length;

        // Get cached latency data if available
        const chainCache = cacheData?.[chainId];
        if (chainCache?.latencyMap) {
          chainData.fastestRpc = chainCache.fastestRpc;
          chainData.lastTested = chainCache.lastTested;
        }

        // Process each RPC
        for (const rpcUrl of rpcUrls) {
          const rpcInfo: any = {
            url: rpcUrl,
            status: "unknown",
            healthy: false
          };

          // Get health state from memory
          const healthState = this.rpcHealthStates.get(rpcUrl);
          if (healthState) {
            rpcInfo.consecutiveFailures = healthState.consecutiveFailures;
            rpcInfo.lastFailureTime = healthState.lastFailureTime > 0 ? healthState.lastFailureTime : null;
            rpcInfo.lastSuccessTime = healthState.lastSuccessTime > 0 ? healthState.lastSuccessTime : null;
            
            // Check if eliminated
            if (healthState.consecutiveFailures >= this.maxConsecutiveFailures) {
              const backoffMs = Math.min(
                this.backoffBaseMs * Math.pow(2, healthState.consecutiveFailures - this.maxConsecutiveFailures),
                this.maxBackoffMs
              );
              const nextRetryTime = healthState.lastFailureTime + backoffMs;
              
              if (Date.now() < nextRetryTime) {
                rpcInfo.status = "eliminated";
                rpcInfo.nextRetryAt = nextRetryTime;
                chainData.eliminatedRpcs++;
              }
            }
          }

          // Get latency data from cache
          if (chainCache?.latencyMap?.[rpcUrl]) {
            const latencyData = chainCache.latencyMap[rpcUrl];
            rpcInfo.latency = latencyData.latency;
            rpcInfo.cacheStatus = latencyData.status;
            
            // Determine health based on cache status
            if (latencyData.status === "ok" && !rpcInfo.status) {
              rpcInfo.status = "healthy";
              rpcInfo.healthy = true;
              chainData.healthyRpcs++;
            } else if (["syncing", "wrong_bytecode"].includes(latencyData.status) && !rpcInfo.status) {
              rpcInfo.status = "degraded";
              chainData.degradedRpcs++;
            } else if (!rpcInfo.status) {
              rpcInfo.status = "failed";
              chainData.failedRpcs++;
            }
          } else if (rpcInfo.status === "unknown") {
            // No cache data and not eliminated
            if (healthState && healthState.consecutiveFailures > 0) {
              rpcInfo.status = "failed";
              chainData.failedRpcs++;
            }
          }

          chainData.rpcs.push(rpcInfo);
        }

        healthReport.chains[chainId] = chainData;
        healthReport.summary.totalChains++;
        healthReport.summary.totalRpcs += chainData.totalRpcs;
        healthReport.summary.healthyRpcs += chainData.healthyRpcs;
        healthReport.summary.degradedRpcs += chainData.degradedRpcs;
        healthReport.summary.failedRpcs += chainData.failedRpcs;
        healthReport.summary.eliminatedRpcs += chainData.eliminatedRpcs;
      }

      // Add system info
      healthReport.system = {
        cacheEnabled: !this.cacheManager.isDisabled(),
        logLevel: this.logLevel,
        maxConsecutiveFailures: this.maxConsecutiveFailures,
        backoffBaseMs: this.backoffBaseMs,
        maxBackoffMs: this.maxBackoffMs
      };

    } catch (error) {
      this._log("error", "Failed to generate health status:", error);
      throw error;
    }

    return healthReport;
  }
}

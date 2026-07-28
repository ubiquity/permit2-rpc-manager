import { CacheManager } from "../infra/cache-manager.ts";
import { decodeFunctionResult, encodeFunctionData } from "npm:viem@2.9.30";
import { ChainlistDataSource } from "../data/chainlist-data-source.ts";
import { LatencyTester } from "../infra/latency-tester.ts";
import { RpcSelector } from "./rpc-selector.ts";
import { AdaptiveTimeout, RequestDeduplicator, RpcScorer, SmartBatcher } from "./reliability-improvements.ts";
import { getMulticall3Address, multicall3Abi, Multicall3Request } from "../evm/multicall3.ts";
import { CircuitBreakerV2 } from "./circuit-breaker-v2.ts";
import { RpcMethodCapabilities } from "./rpc-capabilities.ts";
import { RpcMetricsRegistry } from "./rpc-metrics.ts";
import { RpcScorerV2 } from "./rpc-scoring-v2.ts";
import type { ScoringConfig } from "./rpc-scoring-v2.ts";
import { HeadTracker } from "./head-tracker.ts";
import { HEDGE_ABORT_REASON, HedgedNonRetryableError, HedgedRequester } from "./hedged-requester.ts";
import type { HedgeConfig } from "./hedged-requester.ts";
import { isWriteMethod } from "./method-classifier.ts";
import { ConsensusExecutor } from "./consensus.ts";
import type { ConsensusConfig, ConsensusOptions } from "./consensus.ts";
import { getRpcEndpointId, redactRpcDiagnostic } from "./rpc-endpoint-id.ts";

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
  IMPLEMENTATION_DEFINED_END: -32099,

  // Common provider-specific codes
  EXECUTION_REVERTED: 3,
  UNAUTHORIZED: -32001,
  ACTION_NOT_PERMITTED: -32002,
  EXECUTION_ERROR: -32003,
  QUOTA_EXCEEDED: -32004,
  REQUEST_LIMIT: -32005,
} as const;

type SendOptions = {
  rpcOverrides?: string[];
  allowFallback?: boolean;
};

const normalizeRpcUrl = (value: string): string => value.trim().replace(/\/$/, "");

const normalizeRpcList = (values: string[] | undefined): string[] => {
  if (!values || values.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of values) {
    const normalized = normalizeRpcUrl(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

class JsonRpcError extends Error {
  public data?: unknown;
  public httpStatus?: number;

  constructor(
    public code: number,
    message: string,
    data?: unknown,
    httpStatus?: number,
  ) {
    super(redactRpcDiagnostic(message));
    this.name = "JsonRpcError";
    this.data = redactRpcDiagnostic(data);
    this.httpStatus = httpStatus;
  }
}

/** An upstream response body could not be decoded as JSON. */
class InvalidJsonResponseError extends JsonRpcError {
  constructor(httpStatus?: number) {
    super(
      JSON_RPC_ERROR_CODES.PARSE_ERROR,
      "Invalid JSON response from provider",
      undefined,
      httpStatus,
    );
    this.name = "InvalidJsonResponseError";
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
  recoveryProbeInFlight?: boolean;
  failureReasons: Map<string, number>; // reason -> count
}

interface RpcAttemptLease {
  recoveryProbe: boolean;
}

class RpcAttemptUnavailableError extends Error {
  constructor() {
    super("RPC recovery probe already in flight");
    this.name = "RpcAttemptUnavailableError";
  }
}

// Error classification based on behavior, not strings
enum ErrorBehavior {
  RETRY_WITH_BACKOFF, // Temporary issues (rate limits, timeouts)
  RETRY_DIFFERENT_RPC, // Provider-specific issues
  DO_NOT_RETRY, // Client errors (bad request, invalid params)
  BLOCKCHAIN_ERROR, // Execution errors (revert, insufficient funds)
}

interface ErrorClassification {
  behavior: ErrorBehavior;
  reason: string;
  isProviderIssue: boolean;
}

type ScoringV2Options = Partial<ScoringConfig> & { enabled?: boolean };
type HedgeOptions = Partial<HedgeConfig>;

interface HeadSamplingConfig {
  enabled?: boolean;
  sampleIntervalMs?: number;
  maxRpcsPerSample?: number;
  timeoutMs?: number;
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
  validateChainId?: boolean;

  // Health management
  maxConsecutiveFailures?: number;
  backoffBaseMs?: number;
  maxBackoffMs?: number;
  healthCheckIntervalMs?: number;

  // Capability tracking
  capabilityTtlMs?: number;

  scoringV2?: ScoringV2Options;

  hedge?: HedgeOptions;
  headSampling?: HeadSamplingConfig;
  consensus?: ConsensusOptions;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_LOG_LEVEL = "warn";
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 60000;
const DEFAULT_CAPABILITY_TTL_MS = 10 * 60_000;
const DEFAULT_HEDGE_DELAY_MS = 50;
const DEFAULT_HEDGE_MAX_HEDGES = 1;
const DEFAULT_HEDGE_MIN_DELAY_MS = 10;
const DEFAULT_HEDGE_MAX_DELAY_MS = 250;

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
  private validateChainId: boolean;

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
  private circuitBreaker: CircuitBreakerV2;
  private rpcMethodCapabilities: RpcMethodCapabilities;
  private capabilityTtlMs: number;
  private rpcMetrics: RpcMetricsRegistry;
  private rpcScorerV2: RpcScorerV2;
  private scoringV2Enabled: boolean;
  private hedgedRequester: HedgedRequester;
  private hedgeConfig:
    & Required<Pick<HedgeConfig, "enabled" | "maxHedges" | "delayMs">>
    & Pick<HedgeConfig, "quantile" | "minDelayMs" | "maxDelayMs">;
  private headTracker: HeadTracker;
  private headSampling: Required<
    Pick<HeadSamplingConfig, "enabled" | "sampleIntervalMs" | "maxRpcsPerSample" | "timeoutMs">
  >;
  private consensusExecutor: ConsensusExecutor;
  private consensus: ConsensusConfig;

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
    this.validateChainId = options.validateChainId ?? true;
    this.latencyTester = new LatencyTester(options.latencyTimeoutMs, logger, { validateChainId: this.validateChainId });
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
    this.circuitBreaker = new CircuitBreakerV2();
    this.rpcMethodCapabilities = new RpcMethodCapabilities();
    this.capabilityTtlMs = options.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS;

    const scoringV2Options = options.scoringV2 ?? {};
    this.scoringV2Enabled = scoringV2Options.enabled ?? true;
    const { enabled: _enabled, ...scoringConfig } = scoringV2Options;
    this.rpcMetrics = new RpcMetricsRegistry();
    this.rpcScorerV2 = new RpcScorerV2(this.rpcMetrics, scoringConfig);

    const hedgeOptions = options.hedge ?? {};
    this.hedgeConfig = {
      enabled: hedgeOptions.enabled ?? false,
      maxHedges: Math.max(0, hedgeOptions.maxHedges ?? DEFAULT_HEDGE_MAX_HEDGES),
      delayMs: Math.max(0, hedgeOptions.delayMs ?? DEFAULT_HEDGE_DELAY_MS),
      quantile: hedgeOptions.quantile,
      minDelayMs: hedgeOptions.minDelayMs ?? DEFAULT_HEDGE_MIN_DELAY_MS,
      maxDelayMs: hedgeOptions.maxDelayMs ?? DEFAULT_HEDGE_MAX_DELAY_MS,
    };
    this.hedgedRequester = new HedgedRequester();

    const headSampling = options.headSampling ?? {};
    this.headSampling = {
      enabled: headSampling.enabled ?? false,
      sampleIntervalMs: Math.max(0, headSampling.sampleIntervalMs ?? 60_000),
      maxRpcsPerSample: Math.max(1, headSampling.maxRpcsPerSample ?? 5),
      timeoutMs: Math.max(250, headSampling.timeoutMs ?? 2000),
    };
    this.headTracker = new HeadTracker(this.rpcMetrics, {
      sampleIntervalMs: this.headSampling.sampleIntervalMs,
      maxRpcsPerSample: this.headSampling.maxRpcsPerSample,
      timeoutMs: this.headSampling.timeoutMs,
      logger,
    });

    const consensusOptions = options.consensus ?? {};
    this.consensus = {
      enabled: consensusOptions.enabled ?? false,
      methods: (consensusOptions.methods ?? []).map((m) => m.trim().toLowerCase()).filter((m) => m.length > 0),
      participants: Math.max(1, consensusOptions.participants ?? 3),
      agreementThreshold: Math.max(1, consensusOptions.agreementThreshold ?? 2),
      preferNonEmpty: consensusOptions.preferNonEmpty ?? false,
    };
    this.consensusExecutor = new ConsensusExecutor(this.rpcMetrics);
  }

  private _log(level: "debug" | "info" | "warn" | "error", message: string, ...optionalParams: unknown[]): void {
    if (this.logLevel === "none") return;
    const messageLevelValue = LOG_LEVEL_HIERARCHY[level];
    if (messageLevelValue >= this.configuredLogLevelValue) {
      const logFn = console[level] || console.log;
      logFn(
        `[Permit2RPC:${level}] ${redactRpcDiagnostic(message)}`,
        ...optionalParams.map((value) => redactRpcDiagnostic(value)),
      );
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

        if (httpStatus === 401) {
          // Unauthorized (missing/invalid credentials) for this upstream; try a different RPC.
          return {
            behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
            reason: "unauthorized",
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
          // Other 403s are usually upstream permission/billing issues; try a different RPC.
          return {
            behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
            reason: "forbidden",
            isProviderIssue: true,
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
          // The HTTP status is client-facing, but a body we could not decode
          // cannot establish that the caller made a bad JSON-RPC request.
          if (error instanceof InvalidJsonResponseError) {
            return {
              behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
              reason: "invalid_json_response",
              isProviderIssue: true,
            };
          }

          return {
            behavior: ErrorBehavior.DO_NOT_RETRY,
            reason: "client_error",
            isProviderIssue: false,
          };
        }
      }

      // A non-JSON response with no HTTP error status is still an upstream
      // failure. A provider-supplied JSON-RPC parse error remains subject to
      // the normal JSON-RPC error classification below.
      if (error instanceof InvalidJsonResponseError) {
        return {
          behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
          reason: "invalid_json_response",
          isProviderIssue: true,
        };
      }

      // JSON-RPC error codes
      if (code === JSON_RPC_ERROR_CODES.INVALID_REQUEST || code === JSON_RPC_ERROR_CODES.INVALID_PARAMS) {
        return {
          behavior: ErrorBehavior.DO_NOT_RETRY,
          reason: code === JSON_RPC_ERROR_CODES.INVALID_PARAMS ? "invalid_params" : "invalid_request",
          isProviderIssue: false,
        };
      }

      if (code === JSON_RPC_ERROR_CODES.EXECUTION_REVERTED) {
        return {
          behavior: ErrorBehavior.BLOCKCHAIN_ERROR,
          reason: "execution_reverted",
          isProviderIssue: false,
        };
      }

      if (code === JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND) {
        return {
          behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
          reason: "method_not_found",
          isProviderIssue: true,
        };
      }

      if (code === JSON_RPC_ERROR_CODES.INTERNAL_ERROR) {
        return {
          behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
          reason: "internal_error",
          isProviderIssue: true,
        };
      }

      if (code === JSON_RPC_ERROR_CODES.QUOTA_EXCEEDED || code === JSON_RPC_ERROR_CODES.REQUEST_LIMIT) {
        return {
          behavior: ErrorBehavior.RETRY_WITH_BACKOFF,
          reason: "quota_exceeded",
          isProviderIssue: true,
        };
      }

      if (
        code <= JSON_RPC_ERROR_CODES.IMPLEMENTATION_DEFINED_START &&
        code >= JSON_RPC_ERROR_CODES.IMPLEMENTATION_DEFINED_END
      ) {
        // Other implementation-defined errors are usually retryable
        return {
          behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
          reason: "provider_error",
          isProviderIssue: true,
        };
      }

      // Standard JSON-RPC errors (default: client-side)
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
    const backoff = Math.min(this.backoffBaseMs * Math.pow(2, consecutiveFailures - 1), this.maxBackoffMs);
    return backoff;
  }

  /**
   * Check if an RPC is currently available (not in backoff)
   */
  private isRpcAvailable(rpcUrl: string): boolean {
    const state = this.getHealthState(rpcUrl);

    if (typeof state.temporaryUnavailableUntil === "number" && Date.now() < state.temporaryUnavailableUntil) {
      return false;
    }

    // Endpoints become candidates after their backoff; the attempt lease below
    // admits only one recovery probe for that completed backoff window.
    return true;
  }

  /**
   * Acquires the single half-open probe permitted for an endpoint after backoff.
   */
  private acquireRpcAttempt(rpcUrl: string): RpcAttemptLease | null {
    const state = this.getHealthState(rpcUrl);
    const backoffUntil = state.temporaryUnavailableUntil;

    // The expired backoff marker is consumed when a recovery probe begins, so
    // this guard must be independent of that marker while the probe is active.
    if (state.recoveryProbeInFlight) {
      return null;
    }

    if (typeof backoffUntil === "number" && Date.now() < backoffUntil) {
      return null;
    }

    // A completed backoff window is half-open: exactly one request may test
    // the endpoint, regardless of how many failures started that backoff.
    if (typeof backoffUntil === "number" && backoffUntil > 0) {
      state.recoveryProbeInFlight = true;
      state.temporaryUnavailableUntil = undefined;
      this._log("debug", `[HEALTH] Admitting recovery probe for ${getRpcEndpointId(rpcUrl)}`);
      return { recoveryProbe: true };
    }

    return { recoveryProbe: false };
  }

  private releaseRpcAttempt(rpcUrl: string, lease: RpcAttemptLease): void {
    if (!lease.recoveryProbe) return;

    const state = this.getHealthState(rpcUrl);
    state.recoveryProbeInFlight = false;
  }

  /**
   * Record a successful RPC call
   */
  private async recordSuccess(chainId: number, rpcUrl: string): Promise<void> {
    const state = this.getHealthState(rpcUrl);
    const hadFailures = state.lastFailureTime > 0;

    state.consecutiveFailures = 0;
    state.lastFailureTime = 0;
    state.lastSuccessTime = Date.now();
    state.temporaryUnavailableUntil = undefined;
    state.recoveryProbeInFlight = false;
    state.failureReasons.clear();

    this._log("debug", `[HEALTH] RPC ${getRpcEndpointId(rpcUrl)} marked healthy`);

    // Update KV if we had failures before
    if (hadFailures) {
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
  private async recordFailure(chainId: number, rpcUrl: string, classification: ErrorClassification): Promise<void> {
    const state = this.getHealthState(rpcUrl);

    state.consecutiveFailures++;
    state.lastFailureTime = Date.now();
    state.recoveryProbeInFlight = false;

    // Track failure reasons
    const count = state.failureReasons.get(classification.reason) || 0;
    state.failureReasons.set(classification.reason, count + 1);

    // Apply backoff based on error behavior
    if (classification.behavior === ErrorBehavior.RETRY_WITH_BACKOFF) {
      const backoffMs = this.calculateBackoffMs(state.consecutiveFailures);
      state.temporaryUnavailableUntil = Date.now() + backoffMs;

      this._log(
        "warn",
        `[HEALTH] RPC ${
          getRpcEndpointId(rpcUrl)
        } entering backoff for ${backoffMs}ms due to ${classification.reason} ` +
          `(${state.consecutiveFailures} consecutive failures)`,
      );
    } else if (state.consecutiveFailures >= this.maxConsecutiveFailures) {
      // Mark as unavailable for longer period
      state.temporaryUnavailableUntil = Date.now() + this.maxBackoffMs * 2;

      this._log(
        "warn",
        `[HEALTH] RPC ${getRpcEndpointId(rpcUrl)} marked unhealthy after ${state.consecutiveFailures} failures. ` +
          `Reasons: ${
            Array.from(state.failureReasons.entries())
              .map(([r, c]) => `${r}:${c}`)
              .join(", ")
          }`,
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

  private allRpcsFailedError(chainId: number, attemptedRpcs: string[], lastError: Error | null): JsonRpcError {
    const attemptedRpcIds = attemptedRpcs.map((rpcUrl) => getRpcEndpointId(rpcUrl));
    if (attemptedRpcIds.length === 0) {
      return new JsonRpcError(
        -32000,
        `No RPC endpoints were available to attempt for chain ${chainId}. Please retry in a few seconds.`,
        { attemptedRpcIds, chainId },
      );
    }

    const errorMsg = redactRpcDiagnostic(lastError?.message || "Unknown error");

    return new JsonRpcError(
      -32000,
      `All ${attemptedRpcIds.length} RPC endpoints failed for chain ${chainId}. ` +
        `Attempted: [${attemptedRpcIds.join(", ")}]. Last error: ${errorMsg}`,
      { attemptedRpcIds, chainId },
    );
  }

  /**
   * Send a JSON-RPC request with intelligent failover
   */
  send<T = unknown>(chainId: number, method: string, params: unknown[] = [], options?: SendOptions): Promise<T> {
    const normalizedOverrides = normalizeRpcList(options?.rpcOverrides);
    const allowFallback = Boolean(options?.allowFallback);
    const overrideKey = normalizedOverrides.length > 0
      ? `|override=${normalizedOverrides.join(",")}|fallback=${allowFallback ? "1" : "0"}`
      : "";

    // Use request deduplication for identical concurrent requests
    const deduplicationKey = `${RequestDeduplicator.generateKey(chainId, method, params)}${overrideKey}`;

    return this.requestDeduplicator.deduplicate(deduplicationKey, () => {
      return this._sendInternal<T>(chainId, method, params, {
        rpcOverrides: normalizedOverrides,
        allowFallback,
      });
    });
  }

  /**
   * Internal send implementation (after deduplication)
   */
  private async _sendInternal<T = unknown>(
    chainId: number,
    method: string,
    params: unknown[],
    options?: SendOptions,
  ): Promise<T> {
    const allRpcs = await this.rpcSelector.getRankedRpcList(chainId);
    const rpcByNormalized = new Map(allRpcs.map((rpc) => [normalizeRpcUrl(rpc), rpc]));
    const overrideRequested = options?.rpcOverrides && options.rpcOverrides.length > 0;
    const overrideCandidates = normalizeRpcList(options?.rpcOverrides)
      .map((rpc) => rpcByNormalized.get(rpc))
      .filter((rpc): rpc is string => typeof rpc === "string");
    const allowFallback = Boolean(options?.allowFallback);

    // Filter available RPCs using both health state and circuit breaker
    const availableRpcs = allRpcs.filter((rpc) => this.isRpcAvailable(rpc) && this.circuitBreaker.canRequest(rpc));
    const availableRpcSet = new Set(availableRpcs);
    const healthyOverrides = overrideCandidates.filter((rpc) => availableRpcSet.has(rpc));

    if (this.headSampling.enabled) {
      try {
        await this.headTracker.maybeSampleHeads(chainId, availableRpcs);
      } catch (error) {
        this._log("debug", `[HEAD] Head sampling failed for chain ${chainId}`, error);
      }
    }

    const getCandidates = (rpcs: string[]): string[] => {
      const capabilityFiltered = this.rpcMethodCapabilities.filterSupported(chainId, method, rpcs);
      if (capabilityFiltered.length > 0) return capabilityFiltered;

      if (rpcs.length > 0) {
        this._log(
          "debug",
          `[CAPABILITIES] All candidate RPCs are marked unsupported for ${method} on chain ${chainId}; ` +
            `proceeding without capability filtering.`,
        );
      }

      return rpcs;
    };

    const rankCandidates = (candidates: string[]): string[] => {
      if (!this.scoringV2Enabled) return this.rpcScorer.getRankedRpcs(candidates);
      return this.rpcScorerV2.rank(chainId, method, candidates);
    };

    // Use scoring to rank available RPCs by performance
    let rankedRpcs = rankCandidates(getCandidates(availableRpcs));
    const hasOverride = healthyOverrides.length > 0;
    const overrideSet = new Set(healthyOverrides);

    if (overrideRequested && !hasOverride) {
      const message = overrideCandidates.length > 0
        ? "Override RPCs are currently unavailable (health checks or circuit breaker)."
        : "No override RPCs matched the configured whitelist.";
      if (!allowFallback) {
        throw new JsonRpcError(JSON_RPC_ERROR_CODES.INVALID_PARAMS, message, {
          chainId,
          providedRpcIds: (options?.rpcOverrides ?? []).map((rpcUrl) => getRpcEndpointId(rpcUrl)),
        });
      }
      this._log("warn", `[SEND] ${message} Falling back to default selection for chain ${chainId}.`);
    }

    if (!hasOverride && rankedRpcs.length === 0) {
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

      const circuitBlockedCount = allRpcs.filter((rpc) => !this.circuitBreaker.canRequest(rpc)).length;
      if (allRpcs.length > 0 && circuitBlockedCount === allRpcs.length) {
        throw new Error(
          `All ${circuitBlockedCount} RPC endpoints are temporarily unavailable for chain ${chainId} ` +
            `(circuit breaker open). Please retry in a few seconds.`,
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
      const resetAvailableRpcs = allRpcs.filter((rpc) =>
        this.isRpcAvailable(rpc) && this.circuitBreaker.canRequest(rpc)
      );

      if (resetAvailableRpcs.length > 0) {
        // Continue with the reset RPCs - update rankedRpcs for the rest of the method
        rankedRpcs = rankCandidates(getCandidates(resetAvailableRpcs));

        this._log(
          "info",
          `[EMERGENCY FALLBACK] Found ${resetAvailableRpcs.length} available RPCs for chain ${chainId} after reset`,
        );
      } else {
        // If still no RPCs available after reset, this is a configuration issue
        throw new Error(
          `No RPC endpoints configured or all endpoints are fundamentally unreachable for chain ${chainId}. ` +
            `Please check your RPC configuration.`,
        );
      }
    }

    let orderedRpcs: string[] = [];
    let startIndex = 0;

    if (hasOverride) {
      const fallbackPool = allowFallback ? availableRpcs.filter((rpc) => !overrideSet.has(rpc)) : [];
      const rankedFallback = fallbackPool.length > 0 ? rankCandidates(getCandidates(fallbackPool)) : [];
      orderedRpcs = [...healthyOverrides, ...rankedFallback];
      this._log(
        "info",
        `[SEND] Using override RPCs for chain ${chainId}. ` +
          `Overrides=${healthyOverrides.length}, allowFallback=${allowFallback}, fallbackCount=${rankedFallback.length}.`,
        { overrides: healthyOverrides, fallback: rankedFallback },
      );
    } else {
      // Round-robin selection from ranked RPCs
      const currentIndex = this.rpcIndexMap.get(chainId) || 0;
      startIndex = currentIndex % rankedRpcs.length;
      this.rpcIndexMap.set(chainId, (currentIndex + 1) % rankedRpcs.length);

      this._log(
        "debug",
        `[SEND] Chain ${chainId}: ${rankedRpcs.length}/${allRpcs.length} RPCs available. ` +
          `Starting at index ${startIndex}.`,
      );

      orderedRpcs = rankedRpcs.slice(startIndex).concat(rankedRpcs.slice(0, startIndex));
    }

    if (orderedRpcs.length === 0) {
      throw new JsonRpcError(JSON_RPC_ERROR_CODES.INTERNAL_ERROR, `No RPC endpoints available for chain ${chainId}.`, {
        chainId,
      });
    }

    let lastError: Error | null = null;
    const attemptedRpcs: string[] = [];

    const normalizedMethod = method.trim().toLowerCase();

    const consensusEnabled = this.consensus.enabled && !isWriteMethod(method) &&
      this.consensus.methods.includes(normalizedMethod) && orderedRpcs.length > 1;

    if (consensusEnabled) {
      try {
        return await this.consensusExecutor.execute<T>(
          chainId,
          method,
          orderedRpcs,
          async (rpcUrl) => {
            const attemptLease = this.acquireRpcAttempt(rpcUrl);
            if (!attemptLease) {
              throw new RpcAttemptUnavailableError();
            }

            attemptedRpcs.push(rpcUrl);
            this._log("info", `[SEND] (consensus) Trying ${rpcUrl} for ${method} on chain ${chainId}`);

            const startTime = Date.now();
            try {
              const result = await this.executeRpcCall<T>(rpcUrl, method, params);
              const responseTime = Date.now() - startTime;

              await this.recordSuccess(chainId, rpcUrl);
              this.rpcMetrics.recordSuccess({ chainId, rpcUrl, method }, responseTime);
              this.rpcScorer.updateScore(rpcUrl, true, responseTime);
              this.circuitBreaker.recordResult(rpcUrl, undefined, true);
              this.adaptiveTimeout.recordResponseTime(rpcUrl, responseTime);

              return result;
            } catch (error) {
              const err = error instanceof Error ? error : new Error(String(error));
              lastError = err;

              if (err instanceof JsonRpcError && err.code === JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND) {
                this.rpcMethodCapabilities.markUnsupported(chainId, rpcUrl, method, err.message, this.capabilityTtlMs);
              }

              const classification = this.classifyError(err);
              const circuitClassification = classification.reason === "method_not_found"
                ? { ...classification, isProviderIssue: false }
                : classification;

              this._log(
                "warn",
                `[SEND] RPC ${rpcUrl} failed: ${classification.reason} ` +
                  `(behavior: ${ErrorBehavior[classification.behavior]})`,
              );

              if (
                classification.behavior === ErrorBehavior.DO_NOT_RETRY ||
                classification.behavior === ErrorBehavior.BLOCKCHAIN_ERROR
              ) {
                this.circuitBreaker.recordResult(rpcUrl, circuitClassification, false);
                throw err;
              }

              this.rpcMetrics.recordFailure({ chainId, rpcUrl, method }, classification);
              if (classification.reason !== "method_not_found") {
                await this.recordFailure(chainId, rpcUrl, classification);
                this.rpcScorer.updateScore(rpcUrl, false);
              }
              this.circuitBreaker.recordResult(rpcUrl, circuitClassification, false);
              throw err;
            } finally {
              this.releaseRpcAttempt(rpcUrl, attemptLease);
            }
          },
          this.consensus,
        );
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const classification = this.classifyError(err);

        if (
          classification.behavior === ErrorBehavior.DO_NOT_RETRY ||
          classification.behavior === ErrorBehavior.BLOCKCHAIN_ERROR
        ) {
          throw err;
        }

        throw this.allRpcsFailedError(chainId, attemptedRpcs, lastError ?? err);
      }
    }

    const hedgingEnabled = this.hedgeConfig.enabled && !isWriteMethod(method) && orderedRpcs.length > 1;

    if (hedgingEnabled) {
      const computeDelayMs = (): number => {
        const baseDelayMs = this.hedgeConfig.delayMs;
        const minDelayMs = this.hedgeConfig.minDelayMs ?? DEFAULT_HEDGE_MIN_DELAY_MS;
        const maxDelayMs = this.hedgeConfig.maxDelayMs ?? DEFAULT_HEDGE_MAX_DELAY_MS;

        if (typeof this.hedgeConfig.quantile !== "number") {
          return Math.max(minDelayMs, Math.min(maxDelayMs, Math.round(baseDelayMs)));
        }

        const quantileKey = String(this.hedgeConfig.quantile);
        const stats = this.rpcMetrics.getMethodStats(chainId, method, orderedRpcs);
        const quantiles: number[] = [];
        for (const rpcUrl of orderedRpcs) {
          const q = stats.get(rpcUrl)?.latencyQuantiles?.[quantileKey];
          if (typeof q === "number" && Number.isFinite(q) && q >= 0) quantiles.push(q);
        }
        quantiles.sort((a, b) => a - b);
        const baseline = quantiles.length > 0 ? quantiles[Math.floor(quantiles.length / 2)] : 0;
        const delay = baseline + baseDelayMs;
        return Math.max(minDelayMs, Math.min(maxDelayMs, Math.round(delay)));
      };

      const hedgeDelayMs = computeDelayMs();

      try {
        return await this.hedgedRequester.execute<T>(
          orderedRpcs,
          async (rpcUrl, signal) => {
            const attemptLease = this.acquireRpcAttempt(rpcUrl);
            if (!attemptLease) {
              throw new RpcAttemptUnavailableError();
            }

            attemptedRpcs.push(rpcUrl);
            this._log("info", `[SEND] (hedged) Trying ${rpcUrl} for ${method} on chain ${chainId}`);

            const startTime = Date.now();
            try {
              const result = await this.executeRpcCall<T>(rpcUrl, method, params, { signal });
              const responseTime = Date.now() - startTime;

              await this.recordSuccess(chainId, rpcUrl);
              this.rpcMetrics.recordSuccess({ chainId, rpcUrl, method }, responseTime);
              this.rpcScorer.updateScore(rpcUrl, true, responseTime);
              this.circuitBreaker.recordResult(rpcUrl, undefined, true);
              this.adaptiveTimeout.recordResponseTime(rpcUrl, responseTime);

              return result;
            } catch (error) {
              const err = error instanceof Error ? error : new Error(String(error));

              if (signal.aborted && signal.reason === HEDGE_ABORT_REASON) {
                throw err;
              }

              lastError = err;

              if (err instanceof JsonRpcError && err.code === JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND) {
                this.rpcMethodCapabilities.markUnsupported(chainId, rpcUrl, method, err.message, this.capabilityTtlMs);
              }

              const classification = this.classifyError(err);
              const circuitClassification = classification.reason === "method_not_found"
                ? { ...classification, isProviderIssue: false }
                : classification;

              this._log(
                "warn",
                `[SEND] RPC ${rpcUrl} failed: ${classification.reason} ` +
                  `(behavior: ${ErrorBehavior[classification.behavior]})`,
              );

              if (
                classification.behavior === ErrorBehavior.DO_NOT_RETRY ||
                classification.behavior === ErrorBehavior.BLOCKCHAIN_ERROR
              ) {
                this.circuitBreaker.recordResult(rpcUrl, circuitClassification, false);
                this._log(
                  "info",
                  `[SEND] Error type ${ErrorBehavior[classification.behavior]} detected. ` +
                    `Not recording as RPC failure to prevent cascade.`,
                );
                throw new HedgedNonRetryableError(err);
              }

              this.rpcMetrics.recordFailure({ chainId, rpcUrl, method }, classification);
              if (classification.reason !== "method_not_found") {
                await this.recordFailure(chainId, rpcUrl, classification);
                this.rpcScorer.updateScore(rpcUrl, false);
              }
              this.circuitBreaker.recordResult(rpcUrl, circuitClassification, false);

              throw err;
            } finally {
              this.releaseRpcAttempt(rpcUrl, attemptLease);
            }
          },
          { maxHedges: this.hedgeConfig.maxHedges, delayMs: hedgeDelayMs },
        );
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const classification = this.classifyError(err);

        if (
          classification.behavior === ErrorBehavior.DO_NOT_RETRY ||
          classification.behavior === ErrorBehavior.BLOCKCHAIN_ERROR
        ) {
          throw err;
        }

        throw this.allRpcsFailedError(chainId, attemptedRpcs, lastError ?? err);
      }
    }

    // Try the ordered candidate list. This keeps supported override ordering
    // authoritative for ordinary sequential execution.
    for (const rpcUrl of orderedRpcs) {
      const attemptLease = this.acquireRpcAttempt(rpcUrl);
      if (!attemptLease) continue;

      attemptedRpcs.push(rpcUrl);

      try {
        this._log("info", `[SEND] Trying ${rpcUrl} for ${method} on chain ${chainId}`);

        const startTime = Date.now();
        const result = await this.executeRpcCall<T>(rpcUrl, method, params);
        const responseTime = Date.now() - startTime;

        // Record success metrics
        await this.recordSuccess(chainId, rpcUrl);
        this.rpcMetrics.recordSuccess({ chainId, rpcUrl, method }, responseTime);
        this.rpcScorer.updateScore(rpcUrl, true, responseTime);
        this.circuitBreaker.recordResult(rpcUrl, undefined, true);
        this.adaptiveTimeout.recordResponseTime(rpcUrl, responseTime);

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (lastError instanceof JsonRpcError && lastError.code === JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND) {
          this.rpcMethodCapabilities.markUnsupported(chainId, rpcUrl, method, lastError.message, this.capabilityTtlMs);
        }

        // Classify the error
        const classification = this.classifyError(lastError);
        const circuitClassification = classification.reason === "method_not_found"
          ? { ...classification, isProviderIssue: false }
          : classification;

        this._log(
          "warn",
          `[SEND] RPC ${rpcUrl} failed: ${classification.reason} ` +
            `(behavior: ${ErrorBehavior[classification.behavior]})`,
        );

        // Decide if we should continue trying other RPCs
        switch (classification.behavior) {
          case ErrorBehavior.DO_NOT_RETRY:
          case ErrorBehavior.BLOCKCHAIN_ERROR:
            this.circuitBreaker.recordResult(rpcUrl, circuitClassification, false);
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
            this.rpcMetrics.recordFailure({ chainId, rpcUrl, method }, classification);
            if (classification.reason !== "method_not_found") {
              // These are RPC-specific issues that should count toward health
              await this.recordFailure(chainId, rpcUrl, classification);
              this.rpcScorer.updateScore(rpcUrl, false);
            }
            this.circuitBreaker.recordResult(rpcUrl, circuitClassification, false);
            // Continue to next RPC
            continue;
        }
      } finally {
        this.releaseRpcAttempt(rpcUrl, attemptLease);
      }
    }

    // All RPCs failed
    throw this.allRpcsFailedError(chainId, attemptedRpcs, lastError);
  }

  /**
   * Execute a single RPC call
   */
  public async executeRpcCall<T = unknown>(
    url: string,
    method: string,
    params: unknown[],
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const controller = new AbortController();
    // Use adaptive timeout if available, otherwise default
    const timeout = this.adaptiveTimeout.getTimeout(url, this.requestTimeoutMs);
    const timeoutId = setTimeout(() => controller.abort("timeout"), timeout);

    const externalSignal = options.signal;
    const abortListener = () => {
      try {
        controller.abort(externalSignal?.reason);
      } catch {
        controller.abort();
      }
    };

    if (externalSignal) {
      if (externalSignal.aborted) {
        abortListener();
      } else {
        externalSignal.addEventListener("abort", abortListener, { once: true });
      }
    }

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
      if (externalSignal) externalSignal.removeEventListener("abort", abortListener);

      // Parse response regardless of HTTP status
      let responseData: any;
      try {
        responseData = await response.json();
      } catch (_jsonError) {
        throw new InvalidJsonResponseError(response.status);
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
      if (externalSignal) externalSignal.removeEventListener("abort", abortListener);

      if (error instanceof Error && error.name === "AbortError") {
        if (controller.signal.reason === HEDGE_ABORT_REASON) {
          throw error;
        }
        if (controller.signal.reason && controller.signal.reason !== "timeout") {
          throw error;
        }
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
  sendBatch<T = unknown>(chainId: number, requests: Array<{ method: string; params?: unknown[] }>): Promise<T[]> {
    // Use smart batcher to split large batches and avoid overwhelming RPCs
    return this.smartBatcher.processBatch(
      requests.map((req) => ({ method: req.method, params: req.params || [] })),
      async (batch) => {
        // Process each chunk with some parallelism but not all at once
        const results = await Promise.all(batch.map((req) => this.send<T>(chainId, req.method, req.params)));
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
        temporaryUnavailableUntil: undefined,
        recoveryProbeInFlight: false,
        failureReasons: new Map(),
      });

      // Also clear from KV store to prevent persistence of bad state
      try {
        const kv = await Deno.openKv();
        const failureKey = ["rpc_failures", chainId, rpcUrl];
        await kv.delete(failureKey);

        this._log("debug", `[HEALTH RESET] Cleared KV state for ${getRpcEndpointId(rpcUrl)}`);
      } catch (error) {
        this._log("error", `[HEALTH RESET] Failed to clear KV state for ${getRpcEndpointId(rpcUrl)}:`, error);
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
        eliminatedRpcs: 0,
        wrongChainIdRpcs: 0,
      },
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
          eliminatedRpcs: 0,
          wrongChainIdRpcs: 0,
        };

        // Get RPCs for this chain
        const rpcUrls = this.dataSource.getRpcUrls(chainId);
        chainData.totalRpcs = rpcUrls.length;

        // Get cached latency data if available
        const chainCache = cacheData?.[chainId];
        if (chainCache?.latencyMap) {
          chainData.fastestRpc = chainCache.fastestRpc ? getRpcEndpointId(chainCache.fastestRpc) : null;
          chainData.lastTested = chainCache.lastTested;
        }

        // Process each RPC
        for (const rpcUrl of rpcUrls) {
          const rpcInfo: any = {
            endpointId: getRpcEndpointId(rpcUrl),
            status: "unknown",
            healthy: false,
          };

          // Get health state from memory
          const healthState = this.rpcHealthStates.get(rpcUrl);
          if (healthState) {
            rpcInfo.consecutiveFailures = healthState.consecutiveFailures;
            rpcInfo.lastFailureTime = healthState.lastFailureTime > 0 ? healthState.lastFailureTime : null;
            rpcInfo.lastSuccessTime = healthState.lastSuccessTime > 0 ? healthState.lastSuccessTime : null;
            rpcInfo.recoveryProbeInFlight = Boolean(healthState.recoveryProbeInFlight);

            // Check if eliminated
            if (healthState.consecutiveFailures >= this.maxConsecutiveFailures) {
              const nextRetryTime = healthState.temporaryUnavailableUntil;

              if (typeof nextRetryTime === "number" && Date.now() < nextRetryTime) {
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
            if (latencyData.status === "wrong_chain_id") {
              chainData.wrongChainIdRpcs++;
            }

            if (rpcInfo.status === "unknown") {
              if (latencyData.status === "ok") {
                rpcInfo.status = "healthy";
                rpcInfo.healthy = true;
                chainData.healthyRpcs++;
              } else if (["syncing", "wrong_bytecode"].includes(latencyData.status)) {
                rpcInfo.status = "degraded";
                chainData.degradedRpcs++;
              } else if (latencyData.status === "wrong_chain_id") {
                rpcInfo.status = "wrong_chain_id";
                chainData.failedRpcs++;
              } else {
                rpcInfo.status = "failed";
                chainData.failedRpcs++;
              }
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
        healthReport.summary.wrongChainIdRpcs += chainData.wrongChainIdRpcs;
      }

      // Add system info
      healthReport.system = {
        cacheEnabled: !this.cacheManager.isDisabled(),
        logLevel: this.logLevel,
        maxConsecutiveFailures: this.maxConsecutiveFailures,
        backoffBaseMs: this.backoffBaseMs,
        maxBackoffMs: this.maxBackoffMs,
        validateChainId: this.validateChainId,
        scoringV2Enabled: this.scoringV2Enabled,
        hedge: this.hedgeConfig,
        headSampling: this.headSampling,
        consensus: {
          enabled: this.consensus.enabled,
          participants: this.consensus.participants,
          agreementThreshold: this.consensus.agreementThreshold,
          methodCount: this.consensus.methods.length,
        },
      };
    } catch (error) {
      this._log("error", "Failed to generate health status:", error);
      throw error;
    }

    return healthReport;
  }

  /**
   * Perform a Multicall3 batch of read-only eth_call requests.
   */
  async multicall3(
    chainId: number,
    requests: Multicall3Request[],
    blockTag: string | number = "latest",
    options?: SendOptions,
  ): Promise<JsonRpcResponse[]> {
    if (requests.length === 0) {
      return [];
    }

    try {
      for (const c of requests) {
        if (!c.params[0].to.startsWith("0x") || c.params[0].to.length !== 42) {
          throw new Error(`multicall3: invalid 'to' address ${c.params[0].to}`);
        }
        if (!c.params[0].data.startsWith("0x")) {
          throw new Error("multicall3: call data must be 0x-prefixed hex");
        }
      }

      const uniqueRequests = requests.filter(
        (req, index, self) =>
          index ===
            self.findIndex(
              (r) =>
                r.params[0].to.toLowerCase() === req.params[0].to.toLowerCase() &&
                r.params[0].data.toLowerCase() === req.params[0].data.toLowerCase(),
            ),
      );

      this._log(
        "info",
        `Performing multicall3 with ${uniqueRequests.length} unique calls for ${requests.length} requests on chain ${chainId} with block tag '${blockTag}'`,
      );

      const viemCalls = uniqueRequests.map((c) => ({
        target: c.params[0].to as `0x${string}`,
        allowFailure: true, // Always allow failure to get per-call success status
        callData: c.params[0].data as `0x${string}`,
      }));

      const calldata = encodeFunctionData({
        abi: multicall3Abi,
        functionName: "aggregate3",
        args: [viemCalls],
      });

      // Perform single eth_call to multicall contract
      const resultHex = await this.send<string>(
        chainId,
        "eth_call",
        [
          {
            to: getMulticall3Address(chainId),
            data: calldata,
          },
          blockTag,
        ],
        options,
      );

      const decodedResult = decodeFunctionResult({
        abi: multicall3Abi,
        functionName: "aggregate3",
        data: resultHex as `0x${string}`,
      });

      const uniqueResponses = decodedResult.map((res, idx) => {
        if (res.success) {
          return {
            jsonrpc: "2.0",
            id: uniqueRequests[idx].id,
            result: res.returnData,
          };
        } else {
          return {
            jsonrpc: "2.0",
            id: uniqueRequests[idx].id,
            error: {
              code: -32603,
              message: "Call failed",
            },
          };
        }
      }) as JsonRpcResponse[];

      const duplicatedResponses = requests
        .filter((req) => !uniqueRequests.map((r) => r.id).includes(req.id))
        .map((req) => {
          const requestIndex = uniqueRequests.findIndex(
            (r) =>
              r.params[0].to.toLowerCase() === req.params[0].to.toLowerCase() &&
              r.params[0].data.toLowerCase() === req.params[0].data.toLowerCase(),
          );
          const response = structuredClone(uniqueResponses[requestIndex]);
          response.id = req.id;
          return response;
        }) as JsonRpcResponse[];

      return [...uniqueResponses, ...duplicatedResponses];
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      this._log("error", `Error processing multicall3 batch for chain ${chainId}:`, error);

      const code = error.name === "JsonRpcError" && "code" in error && typeof error.code === "number"
        ? error.code
        : -32603;
      const data = "data" in error ? error.data : undefined;

      return requests.map((req) => ({
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code,
          message: redactRpcDiagnostic(error.message),
          data: redactRpcDiagnostic(data),
        },
      }));
    }
  }
}

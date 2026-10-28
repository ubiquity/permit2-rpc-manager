import { CacheManager, type CacheStore } from "./infra/cache-manager.ts";
import { Permit2RpcManager, type Permit2RpcManagerOptions } from "./core/permit2-rpc-manager.ts";
import { RpcSelector } from "./core/rpc-selector.ts";
import { ChainlistWsDataSource } from "./data/chainlist-ws-data-source.ts";
import { WsLatencyTester } from "./infra/ws-latency-tester.ts";
import { openWebSocket, type SocketPeer } from "./infra/websocket.ts";
import { redactRpcDiagnostic } from "./core/rpc-endpoint-id.ts";
import rpcWhitelist from "../rpc-whitelist.json" with { type: "json" };

export interface RuntimeOptions {
  cacheStore?: CacheStore;
  managerOptions?: Permit2RpcManagerOptions;
  readStaticTextAsset(fileName: string): Promise<string>;
  isNotFoundError(error: unknown): boolean;
  upgradeWebSocket(request: Request): { socket: SocketPeer; response: Response };
  openWebSocket?: (url: string, timeoutMs: number) => Promise<SocketPeer>;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export function parseBooleanEnvValue(raw: unknown): boolean | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(value)) return true;
  if (["0", "false", "no", "n", "off"].includes(value)) return false;
  return undefined;
}

export function createRuntime(env: (name: string) => string | undefined, options: RuntimeOptions) {
  // Check environment variable to potentially disable cache
  const disableCacheEnv = env("DISABLE_RPC_CACHE");
  const shouldDisableCache = disableCacheEnv === "true" || disableCacheEnv === "1";

  if (shouldDisableCache) {
    console.warn("RPC Caching is DISABLED via DISABLE_RPC_CACHE environment variable.");
  }

  function parseBoolEnv(name: string): boolean | undefined {
    return parseBooleanEnvValue(env(name));
  }

  function parseIntEnv(name: string): number | undefined {
    const raw = env(name);
    if (raw === undefined) return undefined;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  function parseFloatEnv(name: string): number | undefined {
    const raw = env(name);
    if (raw === undefined) return undefined;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  function parseCsvEnv(name: string): string[] | undefined {
    const raw = env(name);
    if (raw === undefined) return undefined;
    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    return parts.length > 0 ? parts : undefined;
  }

  function parseLogLevelEnv(name: string): Permit2RpcManagerOptions["logLevel"] | undefined {
    const raw = env(name);
    if (!raw) return undefined;
    const normalized = raw.trim().toLowerCase();
    if (
      normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error" ||
      normalized === "none"
    ) {
      return normalized as Permit2RpcManagerOptions["logLevel"];
    }
    return undefined;
  }

  function buildPermit2RpcManagerOptionsFromEnv(
    initialRpcData: Permit2RpcManagerOptions["initialRpcData"],
    disableCache: boolean,
  ): Permit2RpcManagerOptions {
    const scoringV2: NonNullable<Permit2RpcManagerOptions["scoringV2"]> = {};
    const scoringV2Enabled = parseBoolEnv("RPC_SCORING_V2_ENABLED");
    if (scoringV2Enabled !== undefined) scoringV2.enabled = scoringV2Enabled;
    const scoringLatencyQuantile = parseFloatEnv("RPC_SCORING_V2_LATENCY_QUANTILE");
    if (scoringLatencyQuantile !== undefined) scoringV2.latencyQuantile = scoringLatencyQuantile;
    const scoringMinSamples = parseIntEnv("RPC_SCORING_V2_MIN_SAMPLES");
    if (scoringMinSamples !== undefined) scoringV2.minSamplesForConfidence = scoringMinSamples;
    const scoringEmaPrevWeight = parseFloatEnv("RPC_SCORING_V2_EMA_PREV_WEIGHT");
    if (scoringEmaPrevWeight !== undefined) scoringV2.emaPrevWeight = scoringEmaPrevWeight;
    const scoringWLatency = parseFloatEnv("RPC_SCORING_V2_W_LATENCY");
    if (scoringWLatency !== undefined) scoringV2.wLatency = scoringWLatency;
    const scoringWError = parseFloatEnv("RPC_SCORING_V2_W_ERROR");
    if (scoringWError !== undefined) scoringV2.wError = scoringWError;
    const scoringWThrottle = parseFloatEnv("RPC_SCORING_V2_W_THROTTLE");
    if (scoringWThrottle !== undefined) scoringV2.wThrottle = scoringWThrottle;
    const scoringWHeadLag = parseFloatEnv("RPC_SCORING_V2_W_HEAD_LAG");
    if (scoringWHeadLag !== undefined) scoringV2.wHeadLag = scoringWHeadLag;
    const scoringWMisbehavior = parseFloatEnv("RPC_SCORING_V2_W_MISBEHAVIOR");
    if (scoringWMisbehavior !== undefined) scoringV2.wMisbehavior = scoringWMisbehavior;

    const hedge: NonNullable<Permit2RpcManagerOptions["hedge"]> = {};
    const hedgeEnabled = parseBoolEnv("RPC_HEDGE_ENABLED");
    if (hedgeEnabled !== undefined) hedge.enabled = hedgeEnabled;
    const hedgeMaxHedges = parseIntEnv("RPC_HEDGE_MAX_HEDGES");
    if (hedgeMaxHedges !== undefined) hedge.maxHedges = hedgeMaxHedges;
    const hedgeDelayMs = parseIntEnv("RPC_HEDGE_DELAY_MS");
    if (hedgeDelayMs !== undefined) hedge.delayMs = hedgeDelayMs;
    const hedgeQuantile = parseFloatEnv("RPC_HEDGE_QUANTILE");
    if (hedgeQuantile !== undefined) hedge.quantile = hedgeQuantile;
    const hedgeMinDelayMs = parseIntEnv("RPC_HEDGE_MIN_DELAY_MS");
    if (hedgeMinDelayMs !== undefined) hedge.minDelayMs = hedgeMinDelayMs;
    const hedgeMaxDelayMs = parseIntEnv("RPC_HEDGE_MAX_DELAY_MS");
    if (hedgeMaxDelayMs !== undefined) hedge.maxDelayMs = hedgeMaxDelayMs;

    const headSampling: NonNullable<Permit2RpcManagerOptions["headSampling"]> = {};
    const headSamplingEnabled = parseBoolEnv("RPC_HEAD_SAMPLING_ENABLED");
    if (headSamplingEnabled !== undefined) headSampling.enabled = headSamplingEnabled;
    const headSampleIntervalMs = parseIntEnv("RPC_HEAD_SAMPLING_INTERVAL_MS");
    if (headSampleIntervalMs !== undefined) headSampling.sampleIntervalMs = headSampleIntervalMs;
    const headMaxRpcs = parseIntEnv("RPC_HEAD_SAMPLING_MAX_RPCS");
    if (headMaxRpcs !== undefined) headSampling.maxRpcsPerSample = headMaxRpcs;
    const headTimeoutMs = parseIntEnv("RPC_HEAD_SAMPLING_TIMEOUT_MS");
    if (headTimeoutMs !== undefined) headSampling.timeoutMs = headTimeoutMs;

    const consensus: NonNullable<Permit2RpcManagerOptions["consensus"]> = {};
    const consensusEnabled = parseBoolEnv("RPC_CONSENSUS_ENABLED");
    if (consensusEnabled !== undefined) consensus.enabled = consensusEnabled;
    const consensusMethods = parseCsvEnv("RPC_CONSENSUS_METHODS");
    if (consensusMethods !== undefined) consensus.methods = consensusMethods;
    const consensusParticipants = parseIntEnv("RPC_CONSENSUS_PARTICIPANTS");
    if (consensusParticipants !== undefined) consensus.participants = consensusParticipants;
    const consensusThreshold = parseIntEnv("RPC_CONSENSUS_THRESHOLD");
    if (consensusThreshold !== undefined) consensus.agreementThreshold = consensusThreshold;
    const consensusPreferNonEmpty = parseBoolEnv("RPC_CONSENSUS_PREFER_NON_EMPTY");
    if (consensusPreferNonEmpty !== undefined) consensus.preferNonEmpty = consensusPreferNonEmpty;

    const logLevel = parseLogLevelEnv("RPC_LOG_LEVEL") ?? parseLogLevelEnv("LOG_LEVEL");

    return {
      initialRpcData,
      disableCache,
      validateChainId: parseBoolEnv("RPC_VALIDATE_CHAIN_ID"),
      capabilityTtlMs: parseIntEnv("RPC_CAPABILITY_TTL_MS"),
      logLevel,
      scoringV2: Object.keys(scoringV2).length > 0 ? scoringV2 : undefined,
      hedge: Object.keys(hedge).length > 0 ? hedge : undefined,
      headSampling: Object.keys(headSampling).length > 0 ? headSampling : undefined,
      consensus: Object.keys(consensus).length > 0 ? consensus : undefined,
      // TODO: Configure other CacheManager options like TTL if needed
    };
  }

  // Instantiate Permit2RpcManager, passing initial data and cache option.
  const manager = new Permit2RpcManager({
    ...buildPermit2RpcManagerOptionsFromEnv(rpcWhitelist, shouldDisableCache),
    ...options.managerOptions,
    cacheStore: options.managerOptions?.cacheStore ?? options.cacheStore,
  });

  type WsLogLevel = "debug" | "info" | "warn" | "error";
  const wsLogger = (level: WsLogLevel, message: string, ...optionalParams: unknown[]) => {
    if (level === "debug" || level === "info") return;
    const logFn = console[level] || console.log;
    logFn(
      `[Permit2WSS:${level}] ${redactRpcDiagnostic(message)}`,
      ...optionalParams.map((optionalParam) => redactRpcDiagnostic(optionalParam)),
    );
  };

  const wsCandidateLimitRaw = Number.parseInt(env("WS_CANDIDATE_LIMIT") ?? "25", 10);
  const wsCandidateLimit = Number.isFinite(wsCandidateLimitRaw) && wsCandidateLimitRaw > 0 ? wsCandidateLimitRaw : 25;
  const wsDataSource = new ChainlistWsDataSource(wsLogger, rpcWhitelist, {
    candidateLimit: wsCandidateLimit,
    deriveFromHttp: env("WS_DERIVE_FROM_HTTP"),
  });
  const wsCacheManager = new CacheManager({
    localStorageKey: "permit2RpcManagerWsCache",
    logger: wsLogger,
    disableCache: shouldDisableCache,
    store: options.cacheStore,
  });
  const wsLatencyTesterTimeoutMsRaw = Number.parseInt(env("WS_LATENCY_TIMEOUT_MS") ?? "5000", 10);
  const wsLatencyTesterTimeoutMs = Number.isFinite(wsLatencyTesterTimeoutMsRaw) && wsLatencyTesterTimeoutMsRaw > 0
    ? wsLatencyTesterTimeoutMsRaw
    : 5000;
  const wsLatencyTester = new WsLatencyTester(wsLatencyTesterTimeoutMs, wsLogger, options.openWebSocket);
  const wsSelector = new RpcSelector(wsDataSource, wsCacheManager, wsLatencyTester, wsLogger);

  function deriveWsUrl(url: string): string | undefined {
    const trimmed = url.trim().replace(/\/$/, "");
    if (trimmed.includes("${")) return undefined;
    if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
    if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
    if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
    return undefined;
  }

  function getWsOverrideCandidates(chainId: number): string[] {
    const candidates: string[] = [];

    const chainSpecific = env(`RPC_WSS_URL_${chainId}`);
    if (chainSpecific) candidates.push(chainSpecific);

    if (chainId === 1) {
      const eth = env("ETH_WSS_URL");
      if (eth) candidates.push(eth);
    }

    const global = env("RPC_WSS_URL");
    if (global) candidates.push(global);

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      const derived = deriveWsUrl(candidate);
      if (!derived) continue;
      if (seen.has(derived)) continue;
      seen.add(derived);
      deduped.push(derived);
    }

    return deduped;
  }

  const connect = options.openWebSocket ?? openWebSocket;
  return {
    manager,
    env,
    wsSelector,
    wsCacheManager,
    wsLogger,
    getWsOverrideCandidates,
    readStaticTextAsset: options.readStaticTextAsset,
    isNotFoundError: options.isNotFoundError,
    upgradeWebSocket: options.upgradeWebSocket,
    openWebSocket: connect,
    waitUntil: options.waitUntil ?? ((promise: Promise<unknown>) => {
      promise.catch((error) => wsLogger("error", "WebSocket connection failed", error));
    }),
    async connectFirstWebSocket(urls: string[], timeoutMs: number): Promise<SocketPeer> {
      let lastError: unknown;
      for (const url of urls) {
        try {
          return await connect(url, timeoutMs);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new Error("No upstream WebSocket candidates available.");
    },
  };
}
export type RpcRuntime = ReturnType<typeof createRuntime>;

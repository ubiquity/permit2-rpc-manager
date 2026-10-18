import { getRpcEndpointId, redactRpcDiagnostic } from "../core/rpc-endpoint-id.ts";
import type { LatencyTestResult } from "./latency-tester.ts";

// Define a logger type
type LoggerFn = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  ...optionalParams: unknown[] // Changed any[] to unknown[]
) => void;

// Define the structure for cached data per chain
export interface ChainCache {
  diagnosticsComplete?: boolean;
  fastestRpc: string | null;
  latencyMap: Record<string, LatencyTestResult>;
  lastTested: number;
}

// Define the overall cache structure
export type CacheData = Record<number, ChainCache>;

export interface CacheStore {
  load(key: string): Promise<CacheData | null>;
  loadChain?(key: string, chainId: number): Promise<ChainCache | null>;
  reserveWrite?(key: string, chainId: number): void;
  save(key: string, value: CacheData, chainId: number): Promise<void>;
}

// KV Optimization: Increased from 1 hour to 4 hours to reduce cache writes by 75%
// This reduces cache update frequency from ~264/day to ~66/day across all chains
const DEFAULT_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours (was 1 hour)
const DEFAULT_LOCAL_STORAGE_KEY = "permit2RpcManagerCache";

// Options for CacheManager constructor
interface CacheManagerOptions {
  store?: CacheStore;
  cacheTtlMs?: number;
  // nodeCachePath is no longer used in this base class
  localStorageKey?: string; // Used as KV key prefix
  logger?: LoggerFn;
  disableCache?: boolean; // Option to disable caching for testing
}

/**
 * CacheManager primarily for browser environments using localStorage.
 * Node.js file caching is handled separately in cache-manager.node.ts.
 */
export class CacheManager {
  private cache: CacheData = {};
  private cacheLoaded = false;
  private cacheLoading?: Promise<void>;
  private loadedChains = new Set<number>();
  private chainLoads = new Map<number, Promise<void>>();
  private cacheKey: string; // Used as KV key prefix/identifier
  // nodeCachePath removed
  private cacheTtlMs: number;
  private log: LoggerFn;
  // Deno KV instance placeholder
  private cacheStore?: CacheStore;
  private disabled: boolean; // Cache disabled flag

  constructor(options: CacheManagerOptions = {}) {
    this.cacheStore = options.store;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    // Keep option name localStorageKey for now, but use it as KV key
    this.cacheKey = options.localStorageKey ?? DEFAULT_LOCAL_STORAGE_KEY;
    this.log = options.logger || (() => {});
    this.disabled = options.disableCache ?? false;
    if (this.disabled) {
      this.log("warn", "CacheManager: Caching is DISABLED via options.");
    }
    // No Node path determination needed here
  }

  private async loadCache(): Promise<void> {
    if (this.disabled || this.cacheLoaded) return;
    this.cacheLoading ??= (async () => {
      try {
        await Promise.all(this.chainLoads.values());
        this.cache = { ...await this.cacheStore?.load(this.cacheKey) ?? {}, ...this.cache };
      } catch (error) {
        this.log("error", "CacheManager: Cache read failed", redactRpcDiagnostic(error));
        this.cache = {};
      }
      this.cacheLoaded = true;
    })();
    await this.cacheLoading;
  }

  private async loadChainCache(chainId: number): Promise<void> {
    if (this.disabled || this.cacheLoaded || this.loadedChains.has(chainId)) return;
    if (this.cacheLoading) {
      await this.cacheLoading;
      return;
    }
    const loadChain = this.cacheStore?.loadChain?.bind(this.cacheStore);
    if (!loadChain) {
      await this.loadCache();
      return;
    }
    let loading = this.chainLoads.get(chainId);
    if (!loading) {
      loading = (async () => {
        try {
          const value = await loadChain(this.cacheKey, chainId);
          if (value) this.cache[chainId] = value;
        } catch (error) {
          this.log("error", "CacheManager: Chain cache read failed", redactRpcDiagnostic(error));
        }
        this.loadedChains.add(chainId);
      })();
      this.chainLoads.set(chainId, loading);
    }
    await loading;
  }

  reserveChainUpdate(chainId: number): void {
    if (!this.disabled) this.cacheStore?.reserveWrite?.(this.cacheKey, chainId);
  }

  private async saveCache(chainId: number): Promise<void> {
    if (this.disabled || (!this.cacheLoaded && !this.loadedChains.has(chainId))) return;
    try {
      await this.cacheStore?.save(this.cacheKey, this.cache, chainId);
    } catch (error) {
      this.log("error", "CacheManager: Cache write failed", redactRpcDiagnostic(error));
    }
  }

  async getDiagnosticsProgress(chainId: number): Promise<ChainCache | null> {
    const chain = await this.getRawChainCache(chainId);
    return chain?.diagnosticsComplete === false && Date.now() - chain.lastTested < this.cacheTtlMs ? chain : null;
  }

  // Internal helper remains largely the same, relies on loadCache
  private async getRawChainCache(chainId: number): Promise<ChainCache | null> {
    await this.loadChainCache(chainId);
    return this.cache[chainId] ?? null;
  }

  // Public methods need to check the disabled flag
  async getChainCache(chainId: number): Promise<ChainCache | null> {
    if (this.disabled) {
      this.log("debug", `CacheManager: Caching disabled, forcing cache miss for chainId ${chainId}`);
      return null; // Always return null (cache miss) if disabled
    }
    const chainCache = await this.getRawChainCache(chainId);
    if (
      chainCache && chainCache.diagnosticsComplete !== false && Date.now() - chainCache.lastTested < this.cacheTtlMs
    ) {
      return chainCache;
    }
    this.log("debug", `CacheManager: Cache miss or expired for chainId ${chainId}`);
    return null;
  }

  async updateChainCache(
    chainId: number,
    latencyMap: Record<string, LatencyTestResult>,
    fastestRpc: string | null,
    diagnosticsComplete = true,
  ): Promise<void> {
    if (this.disabled) {
      this.log("debug", `CacheManager: Caching disabled, skipping cache update for chainId ${chainId}`);
      return; // Do nothing if disabled
    }
    await this.loadChainCache(chainId); // Ensure loaded before update
    this.log("debug", `CacheManager: Updating cache for chainId ${chainId}`, {
      fastestRpc: fastestRpc ? getRpcEndpointId(fastestRpc) : null,
      latencyMapCount: Object.keys(latencyMap || {}).length,
    });
    this.cache[chainId] = {
      fastestRpc,
      diagnosticsComplete,
      latencyMap: latencyMap || {},
      lastTested: Date.now(),
    };
    await this.saveCache(chainId);
  }

  async getFastestRpc(chainId: number): Promise<string | null> {
    const chainCache = await this.getChainCache(chainId);
    return chainCache?.fastestRpc ?? null;
  }

  async getLatencyMap(chainId: number): Promise<Record<string, LatencyTestResult> | null> {
    const chainCache = await this.getRawChainCache(chainId);
    return chainCache?.latencyMap ?? null;
  }

  /**
   * Invalidates a specific RPC in the cache by marking it with a special status
   * This allows the RPC selector to filter it out while preserving the cache structure
   */
  async invalidateRpcInCache(chainId: number, rpcUrl: string, healthStatus: "eliminated"): Promise<void> {
    if (this.disabled) {
      this.log("debug", `CacheManager: Caching disabled, skipping RPC invalidation for ${getRpcEndpointId(rpcUrl)}`);
      return;
    }

    await this.loadChainCache(chainId);
    const chainCache = this.cache[chainId];

    if (!chainCache || !chainCache.latencyMap[rpcUrl]) {
      this.log("warn", `CacheManager: Cannot invalidate RPC ${getRpcEndpointId(rpcUrl)} - not found in cache`);
      return;
    }

    // Add invalidation metadata to the cached result
    // We'll store this information separately to avoid type conflicts
    const invalidatedResult = {
      ...chainCache.latencyMap[rpcUrl],
      _invalidated: true,
      _healthStatus: healthStatus,
      _invalidatedAt: Date.now(),
      _nextRetryAt: Date.now() + 60 * 60 * 1000, // 1 hour for eliminated RPCs
    };

    chainCache.latencyMap[rpcUrl] = invalidatedResult as LatencyTestResult & {
      _invalidated?: boolean;
      _healthStatus?: "eliminated";
      _invalidatedAt?: number;
      _nextRetryAt?: number;
    };

    // If this was the fastest RPC, clear it so selector will recalculate
    if (chainCache.fastestRpc === rpcUrl) {
      chainCache.fastestRpc = null;
      this.log("info", `CacheManager: Cleared fastest RPC for chain ${chainId} as it was invalidated`);
    }

    await this.saveCache(chainId);
    this.log("info", `CacheManager: Marked RPC ${getRpcEndpointId(rpcUrl)} as ${healthStatus} in cache`);
  }

  /**
   * Get the current cache state
   * Returns the raw cache data for health monitoring
   */
  async getCacheState(): Promise<CacheData> {
    if (!this.cacheLoaded) {
      await this.loadCache();
    }
    return this.cache;
  }

  /**
   * Check if cache is disabled
   */
  isDisabled(): boolean {
    return this.disabled;
  }
}

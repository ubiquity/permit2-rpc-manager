import { CacheManager } from "../infra/cache-manager.ts";
import { LatencyTestResult } from "../infra/latency-tester.ts";
import { getRpcEndpointId, redactRpcDiagnostic } from "./rpc-endpoint-id.ts";

// Define a logger type
type LoggerFn = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  ...optionalParams: unknown[] // Changed any[] to unknown[]
) => void;

type RpcDataSourceLike = {
  getRpcUrls(chainId: number): string[];
};

// Define acceptable statuses for selection
const ACCEPTABLE_STATUSES: LatencyTestResult["status"][] = ["ok", "wrong_bytecode", "syncing"];

type LatencyTesterLike = {
  testRpcUrls(chainId: number, urls: string[]): Promise<Record<string, LatencyTestResult>>;
};

export class RpcSelector {
  private dataSource: RpcDataSourceLike;
  private cacheManager: CacheManager;
  private latencyTester: LatencyTesterLike;
  private log: LoggerFn;
  private ongoingLatencyTests = new Map<number, Promise<Record<string, LatencyTestResult>>>();

  constructor(
    dataSource: RpcDataSourceLike,
    cacheManager: CacheManager,
    latencyTester: LatencyTesterLike,
    logger?: LoggerFn,
    private readonly isDiagnosticEligible: (url: string) => boolean = () => true,
  ) {
    this.dataSource = dataSource;
    this.cacheManager = cacheManager;
    this.latencyTester = latencyTester;
    this.log = logger || (() => {});
  }

  /**
   * Gets a ranked list of available RPC URLs for the given chain ID.
   * Fetches from cache or performs latency tests if needed.
   * Filters out RPCs with error statuses.
   * Sorts the remaining RPCs by status priority (ok > wrong_bytecode > syncing) and then by latency.
   * Ensures only one latency test runs concurrently per chain ID.
   *
   * @param chainId - The chain ID.
   * @returns A promise that resolves to a sorted array of usable RPC URLs.
   */
  async getRankedRpcList(chainId: number): Promise<string[]> {
    const rpcUrls = this.dataSource.getRpcUrls(chainId);
    if (rpcUrls.length === 0) {
      this.log("warn", `No RPC URLs found for chain ${chainId} in data source.`);
      return [];
    }

    const allowedUrls = new Set(rpcUrls);
    const deferredUrls = new Set(rpcUrls.filter((url) => !this.isDiagnosticEligible(url)));
    const diagnosticUrls = rpcUrls.filter((url) => !deferredUrls.has(url));
    const diagnosticUrlSet = new Set(diagnosticUrls);

    let latencyMap = await this.cacheManager.getLatencyMap(chainId);
    // Use const as this variable is not reassigned before the next block
    const fastestCachedRpc = await this.cacheManager.getFastestRpc(chainId);
    const fastestIsAllowed = fastestCachedRpc ? allowedUrls.has(fastestCachedRpc) : false;

    // If cache is invalid (no map or fastest RPC doesn't match map status), re-test
    if (
      !latencyMap ||
      !fastestCachedRpc ||
      !latencyMap[fastestCachedRpc] ||
      !fastestIsAllowed ||
      !ACCEPTABLE_STATUSES.includes(latencyMap[fastestCachedRpc].status)
    ) {
      if (fastestCachedRpc && latencyMap) {
        this.log(
          "info",
          `Cached fastest RPC ${
            getRpcEndpointId(fastestCachedRpc)
          } for chain ${chainId} is no longer valid or missing in map. Re-testing.`,
        );
      } else {
        this.log("info", `No valid cache for chain ${chainId}. Performing latency tests...`);
      }

      if (diagnosticUrls.length === 0) {
        this.log("debug", `All RPC diagnostics are deferred for chain ${chainId}; retaining cached results.`);
        // A first request can create a half-open health state before selector
        // cache data exists. Return the source list so foreground recovery can
        // still acquire the lease; it will perform its own health filtering.
        if (!latencyMap) return rpcUrls;
      }

      // --- Latency Test Locking ---
      let testPromise = this.ongoingLatencyTests.get(chainId);
      if (diagnosticUrls.length > 0 && testPromise) {
        this.log("debug", `Latency test already in progress for chain ${chainId}, awaiting result...`);
        latencyMap = this.mergeLatencyMaps(await testPromise, latencyMap, allowedUrls, deferredUrls);
      } else if (diagnosticUrls.length > 0) {
        // Create the promise, store it, run the test, then remove it
        testPromise = this.latencyTester.testRpcUrls(chainId, diagnosticUrls);
        this.ongoingLatencyTests.set(chainId, testPromise);
        this.log("debug", `Initiated latency test for chain ${chainId}.`);

        try {
          latencyMap = this.mergeLatencyMaps(await testPromise, latencyMap, allowedUrls, deferredUrls);
          // Find the new fastest based on the fresh test results
          const newFastest = this._findFastestInMap(latencyMap, diagnosticUrlSet);
          await this.cacheManager.updateChainCache(chainId, latencyMap, newFastest?.url ?? null);
          if (newFastest) {
            this.log(
              "info",
              `Selected fastest RPC for chain ${chainId}: ${
                getRpcEndpointId(newFastest.url)
              } (${newFastest.latency}ms, status: ${newFastest.status})`,
            );
          } else {
            this.log(
              "warn",
              `No responsive RPCs found meeting criteria (${
                ACCEPTABLE_STATUSES.join(" > ")
              }) for chain ${chainId} after testing.`,
            );
          }
        } catch (error) {
          this.log("error", `Latency test failed for chain ${chainId}`, redactRpcDiagnostic(error));
          latencyMap = {}; // Set empty map on error
        } finally {
          this.ongoingLatencyTests.delete(chainId); // Remove promise once done
          this.log("debug", `Latency test finished for chain ${chainId}.`);
        }
      }
      // --- End Latency Test Locking ---
    } else {
      this.log("debug", `Using valid cached latency map for chain ${chainId}.`);
    }

    // Filter and sort the results from the (potentially updated) latency map
    const rankedList = this._rankResults(latencyMap, diagnosticUrlSet);
    const rankedUrls = new Set(rankedList);

    for (const url of rpcUrls) {
      if (deferredUrls.has(url) && !rankedUrls.has(url)) {
        rankedList.push(url);
        rankedUrls.add(url);
      }
    }

    this.log("debug", `Ranked RPC list for chain ${chainId}:`, redactRpcDiagnostic(rankedList));
    return rankedList;
  }

  /**
   * Helper to find the single best RPC from a latency map based on status and latency.
   */
  private _findFastestInMap(
    latencyMap: Record<string, LatencyTestResult> | null,
    allowedUrls: Set<string>,
  ): LatencyTestResult | null {
    if (!latencyMap) return null;

    let bestResult: LatencyTestResult | null = null;

    for (const status of ACCEPTABLE_STATUSES) {
      let fastestForStatus: LatencyTestResult | null = null;
      for (const url in latencyMap) {
        const result = latencyMap[url];
        if (result?.status === status && allowedUrls.has(result.url)) {
          if (!fastestForStatus || result.latency < fastestForStatus.latency) {
            fastestForStatus = result;
          }
        }
      }
      if (fastestForStatus) {
        bestResult = fastestForStatus;
        break; // Found the best according to status priority
      }
    }
    return bestResult;
  }

  /**
   * Fresh diagnostics replace only the endpoints they were allowed to probe.
   * Cached entries for health-deferred URLs remain available to foreground
   * traffic once the manager admits their recovery lease.
   */
  private mergeLatencyMaps(
    freshResults: Record<string, LatencyTestResult>,
    cachedResults: Record<string, LatencyTestResult> | null,
    allowedUrls: Set<string>,
    deferredUrls: Set<string>,
  ): Record<string, LatencyTestResult> {
    const merged: Record<string, LatencyTestResult> = {};

    for (const [url, result] of Object.entries(cachedResults ?? {})) {
      if (allowedUrls.has(url) && deferredUrls.has(url) && result?.url === url) {
        merged[url] = result;
      }
    }

    for (const [url, result] of Object.entries(freshResults)) {
      if (allowedUrls.has(url) && result?.url === url) {
        merged[url] = result;
      }
    }

    return merged;
  }

  /**
   * Helper to filter and rank RPC results based on status and latency.
   * Also considers invalidation metadata from adaptive pool management.
   */
  private _rankResults(latencyMap: Record<string, LatencyTestResult> | null, allowedUrls: Set<string>): string[] {
    if (!latencyMap) return [];

    // Filter results: exclude eliminated RPCs, include acceptable statuses
    const validResults = Object.values(latencyMap).filter((result) => {
      if (!result || !ACCEPTABLE_STATUSES.includes(result.status)) {
        return false;
      }

      if (!allowedUrls.has(result.url)) {
        return false;
      }

      // Check for invalidation metadata
      const invalidated = (result as any)._invalidated;
      const healthStatus = (result as any)._healthStatus;
      const nextRetryAt = (result as any)._nextRetryAt;

      // Exclude eliminated RPCs completely
      if (invalidated && healthStatus === "eliminated") {
        // Check if it's time to retry
        if (nextRetryAt && Date.now() >= nextRetryAt) {
          this.log("debug", `RPC ${getRpcEndpointId(result.url)} eligible for retry after elimination period`);
          // Allow retry by including it
          return true;
        }
        this.log("debug", `Excluding eliminated RPC: ${getRpcEndpointId(result.url)}`);
        return false;
      }

      return true;
    });

    // Sort by: status priority, then latency
    validResults.sort((a, b) => {
      // Sort by test status priority
      const statusA = ACCEPTABLE_STATUSES.indexOf(a.status);
      const statusB = ACCEPTABLE_STATUSES.indexOf(b.status);
      if (statusA !== statusB) {
        return statusA - statusB; // Lower index (better status) comes first
      }

      // Then sort by latency
      return a.latency - b.latency; // Lower latency comes first
    });

    return validResults.map((result) => result.url);
  }

  // --- Deprecated Methods (to be removed or kept for internal use if needed) ---
  // async findFastestRpc(chainId: number): Promise<string | null> { ... }
  // async findNextFastestRpc(chainId: number): Promise<string | null> { ... }
}

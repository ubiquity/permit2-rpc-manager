/**
 * Batch utilities for intelligent request batching and load balancing
 */

export interface BatchConfig {
  // Size limits
  maxPayloadBytes: number;    // Max bytes per batch
  maxComputeUnits: number;    // Max compute units per batch
  maxRequests: number;        // Absolute max requests per batch
  minBatchSize: number;       // Min requests to justify batching

  // Method compute unit weights (approximate)
  methodWeights: Record<string, number>;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: unknown[];
}

export interface BatchSplitResult {
  batches: JsonRpcRequest[][];
  strategy: 'single' | 'batch' | 'split';
  estimatedCU: number[];
  estimatedBytes: number[];
}

// Default configuration based on common RPC provider limits
export const DEFAULT_BATCH_CONFIG: BatchConfig = {
  maxPayloadBytes: 1_000_000,    // 1MB (safe for most providers)
  maxComputeUnits: 10_000,       // Conservative CU limit
  maxRequests: 50,               // Max requests per batch
  minBatchSize: 5,               // Min to justify batching

  methodWeights: {
    // Cheap methods
    'eth_blockNumber': 10,
    'eth_chainId': 10,
    'net_version': 10,
    'eth_protocolVersion': 10,
    'eth_syncing': 10,
    'eth_coinbase': 10,
    'eth_mining': 10,
    'eth_hashrate': 10,
    'eth_gasPrice': 10,
    'eth_accounts': 10,
    'web3_clientVersion': 10,
    'web3_sha3': 10,
    'net_peerCount': 10,
    'net_listening': 10,

    // Medium cost methods
    'eth_getBalance': 15,
    'eth_getStorageAt': 20,
    'eth_getTransactionCount': 15,
    'eth_getBlockTransactionCountByHash': 15,
    'eth_getBlockTransactionCountByNumber': 15,
    'eth_getUncleCountByBlockHash': 15,
    'eth_getUncleCountByBlockNumber': 15,
    'eth_getCode': 20,
    'eth_sign': 20,
    'eth_signTransaction': 20,
    'eth_sendTransaction': 50,
    'eth_sendRawTransaction': 30,
    'eth_getTransactionByHash': 30,
    'eth_getTransactionByBlockHashAndIndex': 30,
    'eth_getTransactionByBlockNumberAndIndex': 30,
    'eth_getTransactionReceipt': 30,
    'eth_getUncleByBlockHashAndIndex': 30,
    'eth_getUncleByBlockNumberAndIndex': 30,
    'eth_newFilter': 50,
    'eth_newBlockFilter': 20,
    'eth_newPendingTransactionFilter': 20,
    'eth_uninstallFilter': 10,
    'eth_getFilterChanges': 50,
    'eth_getFilterLogs': 100,
    'eth_getWork': 20,
    'eth_submitWork': 20,
    'eth_submitHashrate': 20,

    // High cost methods
    'eth_call': 100,           // Can vary wildly
    'eth_estimateGas': 200,    // Often expensive
    'eth_getLogs': 300,        // Can be very expensive
    'eth_getBlockByHash': 100,
    'eth_getBlockByNumber': 100,
    'eth_getBlockReceipts': 500,

    // Debug/trace methods (very expensive)
    'debug_traceTransaction': 1000,
    'debug_storageRangeAt': 500,
    'trace_call': 1000,
    'trace_callMany': 2000,
    'trace_rawTransaction': 1000,
    'trace_replayBlockTransactions': 2000,
    'trace_replayTransaction': 1000,
    'trace_transaction': 1000,
    'trace_get': 500,
    'trace_block': 2000,
    'trace_filter': 1000,

    // Default for unknown methods
    'default': 100,
  }
};

/**
 * Split requests into optimal batches based on compute units and payload size
 */
export function splitIntoBatches(
  requests: JsonRpcRequest[],
  config: BatchConfig = DEFAULT_BATCH_CONFIG
): BatchSplitResult {
  if (requests.length === 0) {
    return {
      batches: [],
      strategy: 'single',
      estimatedCU: [],
      estimatedBytes: []
    };
  }

  // For small request counts, don't batch
  if (requests.length < config.minBatchSize) {
    return {
      batches: requests.map(r => [r]),
      strategy: 'single',
      estimatedCU: requests.map(r => getMethodWeight(r.method, config)),
      estimatedBytes: requests.map(r => estimateRequestSize(r))
    };
  }

  const batches: JsonRpcRequest[][] = [];
  const estimatedCU: number[] = [];
  const estimatedBytes: number[] = [];

  let currentBatch: JsonRpcRequest[] = [];
  let currentBytes = 0;
  let currentCU = 0;

  for (const request of requests) {
    const requestBytes = estimateRequestSize(request);
    const requestCU = getMethodWeight(request.method, config);

    // Check if adding this request would exceed any limit
    const wouldExceedLimits = currentBatch.length > 0 && (
      currentBytes + requestBytes > config.maxPayloadBytes ||
      currentCU + requestCU > config.maxComputeUnits ||
      currentBatch.length >= config.maxRequests
    );

    if (wouldExceedLimits) {
      // Save current batch
      batches.push(currentBatch);
      estimatedCU.push(currentCU);
      estimatedBytes.push(currentBytes);

      // Start new batch
      currentBatch = [request];
      currentBytes = requestBytes;
      currentCU = requestCU;
    } else {
      // Add to current batch
      currentBatch.push(request);
      currentBytes += requestBytes;
      currentCU += requestCU;
    }
  }

  // Don't forget the last batch
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
    estimatedCU.push(currentCU);
    estimatedBytes.push(currentBytes);
  }

  // Determine strategy based on result
  let strategy: 'single' | 'batch' | 'split';
  if (batches.length === 1 && batches[0].length === requests.length) {
    strategy = 'batch'; // All requests fit in one batch
  } else if (batches.every(b => b.length === 1)) {
    strategy = 'single'; // Each request in its own batch
  } else {
    strategy = 'split'; // Mixed batching
  }

  return { batches, strategy, estimatedCU, estimatedBytes };
}

/**
 * Get compute unit weight for a method
 */
function getMethodWeight(method: string, config: BatchConfig): number {
  return config.methodWeights[method] || config.methodWeights.default || 100;
}

/**
 * Estimate the size of a JSON-RPC request in bytes
 */
function estimateRequestSize(request: JsonRpcRequest): number {
  // Quick estimation without full serialization
  let size = 50; // Base overhead for JSON-RPC structure

  size += request.method.length;
  size += request.id ? String(request.id).length : 4; // 'null'

  if (request.params) {
    // Rough estimation of params size
    const paramsStr = JSON.stringify(request.params);
    size += paramsStr.length;
  }

  return size;
}

/**
 * Distribute batches across available RPCs using round-robin
 */
export function distributeBatches<T>(
  batches: T[],
  rpcUrls: string[]
): Map<string, T[]> {
  const distribution = new Map<string, T[]>();

  if (rpcUrls.length === 0 || batches.length === 0) {
    return distribution;
  }

  // Initialize map
  for (const rpc of rpcUrls) {
    distribution.set(rpc, []);
  }

  // Round-robin distribution
  batches.forEach((batch, index) => {
    const rpc = rpcUrls[index % rpcUrls.length];
    distribution.get(rpc)!.push(batch);
  });

  return distribution;
}

/**
 * Performance tracking for adaptive batch sizing
 */
export interface BatchPerformanceMetrics {
  rpcUrl: string;
  batchSize: number;
  successRate: number;
  avgLatencyMs: number;
  lastRateLimitTime?: Date;
  totalRequests: number;
  successfulRequests: number;
  totalLatencyMs: number;
}

export class BatchPerformanceTracker {
  private metrics = new Map<string, Map<number, BatchPerformanceMetrics>>();

  recordResult(
    rpcUrl: string,
    batchSize: number,
    success: boolean,
    latencyMs: number,
    rateLimited: boolean = false
  ): void {
    if (!this.metrics.has(rpcUrl)) {
      this.metrics.set(rpcUrl, new Map());
    }

    const rpcMetrics = this.metrics.get(rpcUrl)!;

    if (!rpcMetrics.has(batchSize)) {
      rpcMetrics.set(batchSize, {
        rpcUrl,
        batchSize,
        successRate: 0,
        avgLatencyMs: 0,
        totalRequests: 0,
        successfulRequests: 0,
        totalLatencyMs: 0,
      });
    }

    const metric = rpcMetrics.get(batchSize)!;

    metric.totalRequests++;
    metric.totalLatencyMs += latencyMs;

    if (success) {
      metric.successfulRequests++;
    }

    if (rateLimited) {
      metric.lastRateLimitTime = new Date();
    }

    // Update computed fields
    metric.successRate = metric.successfulRequests / metric.totalRequests;
    metric.avgLatencyMs = metric.totalLatencyMs / metric.totalRequests;
  }

  getOptimalBatchSize(rpcUrl: string, targetSuccessRate: number = 0.95): number {
    const rpcMetrics = this.metrics.get(rpcUrl);

    if (!rpcMetrics || rpcMetrics.size === 0) {
      return 10; // Conservative default
    }

    let optimalSize = 10;
    let bestScore = 0;

    for (const [size, metric] of rpcMetrics) {
      // Skip if success rate is too low
      if (metric.successRate < targetSuccessRate) {
        continue;
      }

      // Skip if recently rate limited
      if (metric.lastRateLimitTime) {
        const timeSinceLimit = Date.now() - metric.lastRateLimitTime.getTime();
        if (timeSinceLimit < 300_000) { // 5 minutes
          continue;
        }
      }

      // Score based on throughput (requests/second)
      const throughput = (size * 1000) / metric.avgLatencyMs;
      const score = throughput * metric.successRate;

      if (score > bestScore) {
        bestScore = score;
        optimalSize = size;
      }
    }

    return optimalSize;
  }

  getMetrics(rpcUrl: string): Map<number, BatchPerformanceMetrics> | undefined {
    return this.metrics.get(rpcUrl);
  }
}

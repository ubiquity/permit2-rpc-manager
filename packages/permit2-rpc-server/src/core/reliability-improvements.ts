/**
 * Reliability improvements for Permit2 RPC Manager
 * Based on production testing results
 */

// Priority 1: Request deduplication for concurrent identical requests
export class RequestDeduplicator {
  private pendingRequests = new Map<string, Promise<unknown>>();

  /**
   * Deduplicates identical concurrent requests
   */
  deduplicate<T>(
    key: string,
    requestFn: () => Promise<T>,
  ): Promise<T> {
    // Check if identical request is already in progress
    const pending = this.pendingRequests.get(key) as Promise<T> | undefined;
    if (pending) {
      return pending;
    }

    // Create new request and store promise
    const promise = requestFn().finally(() => {
      // Clean up after completion
      this.pendingRequests.delete(key);
    });

    this.pendingRequests.set(key, promise);
    return promise;
  }

  /**
   * Generate cache key for request deduplication
   */
  static generateKey(chainId: number, method: string, params: unknown[]): string {
    return `${chainId}:${method}:${JSON.stringify(params)}`;
  }
}

// Priority 2: Adaptive timeout based on response times
export class AdaptiveTimeout {
  private responseTimeHistory = new Map<string, number[]>();
  private readonly maxHistorySize = 100;
  private readonly percentile = 0.95; // Use 95th percentile for timeout

  /**
   * Record response time for an RPC
   */
  recordResponseTime(rpcUrl: string, timeMs: number): void {
    const history = this.responseTimeHistory.get(rpcUrl) || [];
    history.push(timeMs);

    // Keep only recent history
    if (history.length > this.maxHistorySize) {
      history.shift();
    }

    this.responseTimeHistory.set(rpcUrl, history);
  }

  /**
   * Calculate adaptive timeout for an RPC
   */
  getTimeout(rpcUrl: string, defaultTimeoutMs: number): number {
    const history = this.responseTimeHistory.get(rpcUrl);

    if (!history || history.length < 10) {
      return defaultTimeoutMs;
    }

    // Calculate 95th percentile with bounds checking
    const sorted = [...history].sort((a, b) => a - b);
    const index = Math.max(0, Math.min(Math.ceil(sorted.length * this.percentile) - 1, sorted.length - 1));
    const p95 = sorted[index];

    // Add 50% buffer to 95th percentile, but cap at 2x default
    const adaptiveTimeout = Math.min(p95 * 1.5, defaultTimeoutMs * 2);

    return Math.max(adaptiveTimeout, 1000); // Minimum 1 second
  }

  /**
   * Get statistics for monitoring
   */
  getStats(rpcUrl: string): { avg: number; p95: number; samples: number } | null {
    const history = this.responseTimeHistory.get(rpcUrl);

    if (!history || history.length === 0) {
      return null;
    }

    const sorted = [...history].sort((a, b) => a - b);
    const avg = history.reduce((a, b) => a + b, 0) / history.length;
    const p95Index = Math.max(0, Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1));

    return {
      avg: Math.round(avg),
      p95: sorted[p95Index],
      samples: history.length,
    };
  }
}

// Priority 3: Smart batching to avoid overwhelming RPCs
export class SmartBatcher {
  private readonly maxBatchSize = 10; // Limit batch size per RPC
  private readonly batchDelayMs = 50; // Delay between batches

  /**
   * Split large batches into smaller chunks
   */
  async processBatch<T>(
    items: Array<{ method: string; params: unknown[] }>,
    processor: (batch: typeof items) => Promise<T[]>,
  ): Promise<T[]> {
    const results: T[] = [];

    // Process in chunks
    for (let i = 0; i < items.length; i += this.maxBatchSize) {
      const chunk = items.slice(i, i + this.maxBatchSize);
      const chunkResults = await processor(chunk);
      results.push(...chunkResults);

      // Add delay between chunks to avoid rate limiting
      if (i + this.maxBatchSize < items.length) {
        await new Promise((resolve) => setTimeout(resolve, this.batchDelayMs));
      }
    }

    return results;
  }
}

// Priority 4: Enhanced RPC scoring with decay
interface RpcScore {
  successRate: number;
  avgLatency: number;
  recentLatencies: number[];
  failures: number;
  successes: number;
  lastUpdate: number;
}

export class RpcScorer {
  private scores = new Map<string, RpcScore>();
  private readonly decayFactor = 0.95; // Decay old scores
  private readonly minSamples = 5; // Minimum samples before scoring
  private readonly LATENCY_NORMALIZATION_FACTOR = 1000; // Normalize latency to 0-1 range (1000ms = 1.0)

  /**
   * Update RPC score based on result
   */
  updateScore(rpcUrl: string, success: boolean, latencyMs?: number): void {
    const now = Date.now();
    let score = this.scores.get(rpcUrl);

    if (!score) {
      score = {
        successRate: 1.0,
        avgLatency: 0,
        recentLatencies: [],
        failures: 0,
        successes: 0,
        lastUpdate: now,
      };
    }

    // Apply time decay to historical counters
    const timeSinceUpdate = now - score.lastUpdate;
    const decayPeriods = timeSinceUpdate / (60 * 1000); // Decay every minute
    const decay = Math.pow(this.decayFactor, decayPeriods);

    // Apply decay to historical data before adding new result
    score.successes = score.successes * decay;
    score.failures = score.failures * decay;

    // Update counters with new result
    if (success) {
      score.successes++;
      if (latencyMs !== undefined) {
        score.recentLatencies.push(latencyMs);
        if (score.recentLatencies.length > 20) {
          score.recentLatencies.shift();
        }
      }
    } else {
      score.failures++;
    }

    // Calculate new success rate from decayed counters
    const totalAttempts = score.successes + score.failures;
    if (totalAttempts > 0) {
      score.successRate = score.successes / totalAttempts;
    }

    // Update average latency
    if (score.recentLatencies.length > 0) {
      score.avgLatency = score.recentLatencies.reduce((a, b) => a + b, 0) / score.recentLatencies.length;
    }

    score.lastUpdate = now;
    this.scores.set(rpcUrl, score);
  }

  /**
   * Get composite score for RPC selection
   */
  getScore(rpcUrl: string): number {
    const score = this.scores.get(rpcUrl);

    if (!score || score.successes + score.failures < this.minSamples) {
      return 0.5; // Neutral score for new RPCs
    }

    // Composite score: 70% success rate, 30% latency (normalized)
    const latencyScore = score.avgLatency > 0 ? this.LATENCY_NORMALIZATION_FACTOR / score.avgLatency : 0;
    return score.successRate * 0.7 + Math.min(latencyScore, 1.0) * 0.3;
  }

  /**
   * Get ranked list of RPCs by score
   */
  getRankedRpcs(rpcs: string[]): string[] {
    return rpcs.sort((a, b) => this.getScore(b) - this.getScore(a));
  }
}

// Priority 5: Circuit breaker for failing RPCs
enum CircuitState {
  CLOSED = "closed",
  OPEN = "open",
  HALF_OPEN = "half_open",
}

interface CircuitInfo {
  state: CircuitState;
  failures: number;
  lastFailure: number;
  halfOpenTests: number;
}

export class CircuitBreaker {
  private states = new Map<string, CircuitInfo>();
  private readonly threshold = 5; // Failures to open circuit
  private readonly timeout = 60000; // Reset timeout (1 minute)
  private readonly halfOpenTestLimit = 3; // Test requests in half-open state

  /**
   * Check if circuit allows request
   */
  canRequest(rpcUrl: string): boolean {
    const circuit = this.states.get(rpcUrl);

    if (!circuit) {
      return true; // No circuit = closed
    }

    const now = Date.now();

    switch (circuit.state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN:
        // Check if timeout expired
        if (now - circuit.lastFailure > this.timeout) {
          // Move to half-open
          circuit.state = CircuitState.HALF_OPEN;
          circuit.halfOpenTests = 0;
          this.states.set(rpcUrl, circuit);
          return true;
        }
        return false;

      case CircuitState.HALF_OPEN:
        // Allow limited tests
        if (circuit.halfOpenTests < this.halfOpenTestLimit) {
          // Note: Increment happens in recordResult, not here
          return true;
        }
        return false;
    }
  }

  /**
   * Record request result
   */
  recordResult(rpcUrl: string, success: boolean): void {
    let circuit = this.states.get(rpcUrl) || {
      state: CircuitState.CLOSED,
      failures: 0,
      lastFailure: 0,
      halfOpenTests: 0,
    };

    if (success) {
      if (circuit.state === CircuitState.HALF_OPEN) {
        circuit.halfOpenTests++;
        // Success in half-open, check if we should close circuit
        if (circuit.halfOpenTests >= this.halfOpenTestLimit) {
          // Enough successful tests, close circuit
          circuit = {
            state: CircuitState.CLOSED,
            failures: 0,
            lastFailure: 0,
            halfOpenTests: 0,
          };
        }
      } else if (circuit.state === CircuitState.CLOSED) {
        // Reset failure count on success
        circuit.failures = 0;
      }
    } else {
      circuit.failures++;
      circuit.lastFailure = Date.now();

      if (circuit.state === CircuitState.HALF_OPEN) {
        // Failure in half-open, reopen circuit immediately
        circuit.state = CircuitState.OPEN;
        circuit.halfOpenTests = 0;
      } else if (circuit.state === CircuitState.CLOSED && circuit.failures >= this.threshold) {
        // Too many failures, open circuit
        circuit.state = CircuitState.OPEN;
      }
    }

    this.states.set(rpcUrl, circuit);
  }

  /**
   * Get circuit state for monitoring
   */
  getState(rpcUrl: string): string {
    const circuit = this.states.get(rpcUrl);
    return circuit?.state || CircuitState.CLOSED;
  }
}

// Export all improvements
export const ReliabilityImprovements = {
  RequestDeduplicator,
  AdaptiveTimeout,
  SmartBatcher,
  RpcScorer,
  CircuitBreaker,
};

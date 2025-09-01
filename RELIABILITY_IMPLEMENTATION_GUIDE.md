# Reliability Enhancement Implementation Guide

## Executive Summary

This document provides a comprehensive implementation guide for enhancing the reliability of the Permit2 RPC Manager proxy service. Based on production stress testing analysis, we've identified critical failure patterns and designed targeted solutions to eliminate client-side errors during high-load scenarios.

## Current Issues Analysis

### 1. Error Patterns Observed

From production logs analysis (2025-08-31), the following critical issues were identified:

#### a. JSON-RPC Internal Errors (-32603)
- **Frequency**: ~10% of requests during peak load
- **Current Behavior**: Immediately marked as `DO_NOT_RETRY`, causing client failures
- **Root Cause**: Transient internal RPC issues that could succeed on retry
- **Impact**: Client sees intermittent failures even when subsequent requests work

#### b. Rate Limiting Cascades
- **Example**: `gnosis.api.onfinality.io` entering exponential backoff (1s → 2s → 4s → 8s)
- **Current Behavior**: Aggressive backoff removes RPCs from rotation quickly
- **Impact**: Reduces available RPC pool, increasing load on remaining endpoints

#### c. Timeout Handling
- **Example**: `rpc.poolz.finance` timing out under load
- **Current Behavior**: Fixed timeout of 30s for all RPCs
- **Impact**: Slow RPCs cause unnecessary delays and failures

#### d. Batch Request Failures
- **Observation**: Single item failure in batch causes entire batch to fail
- **Current Behavior**: No partial retry mechanism
- **Impact**: Large batch requests have high failure probability

### 2. Reliability Gaps

1. **No request-level retry logic** - Fails fast on first error
2. **Binary RPC classification** - Either works or doesn't, no gradual degradation
3. **No method-specific RPC selection** - Some RPCs better for specific methods
4. **Missing partial batch recovery** - All-or-nothing batch processing
5. **No predictive failure avoidance** - Reactive rather than proactive

## Implementation Plan

### Phase 1: Core Retry Mechanism (Priority: CRITICAL)

#### 1.1 Request-Level Retry Budget

**File**: `packages/permit2-rpc-server/src/permit2-rpc-manager.ts`

```typescript
interface RetryContext {
  budget: number;           // Total retries allowed (default: 3)
  attemptCount: number;     // Current attempt number
  rpcAttempts: Map<string, number>; // Attempts per RPC
  errors: Error[];          // Error history for debugging
}

class Permit2RpcManager {
  private readonly DEFAULT_RETRY_BUDGET = 3;
  private readonly MAX_RETRIES_PER_RPC = 2;
  
  private async _sendInternal<T = unknown>(
    chainId: number, 
    method: string, 
    params: unknown[]
  ): Promise<T> {
    const retryContext: RetryContext = {
      budget: this.DEFAULT_RETRY_BUDGET,
      attemptCount: 0,
      rpcAttempts: new Map(),
      errors: []
    };
    
    return this._sendWithRetry<T>(chainId, method, params, retryContext);
  }
  
  private async _sendWithRetry<T>(
    chainId: number,
    method: string, 
    params: unknown[],
    context: RetryContext
  ): Promise<T> {
    while (context.budget > 0) {
      const rpc = await this.selectNextRpc(chainId, context);
      
      try {
        const result = await this.executeRpcCallWithRetry<T>(
          rpc, method, params, context
        );
        return result;
      } catch (error) {
        context.errors.push(error);
        context.budget--;
        
        if (context.budget === 0) {
          throw this.createAggregateError(context);
        }
      }
    }
  }
}
```

#### 1.2 Enhanced Error Classification

**File**: `packages/permit2-rpc-server/src/error-classifier.ts`

```typescript
enum ErrorBehavior {
  RETRY_SAME_RPC,      // Transient errors (retry with backoff)
  RETRY_DIFFERENT_RPC, // Provider issues (switch RPC)
  DO_NOT_RETRY,        // Client errors (fail fast)
  BLOCKCHAIN_ERROR     // Execution errors
}

interface ErrorClassification {
  behavior: ErrorBehavior;
  reason: string;
  retryDelay?: number;    // Suggested delay before retry
  isTransient: boolean;   // Can succeed on retry
  severity: 'low' | 'medium' | 'high' | 'critical';
}

class EnhancedErrorClassifier {
  classify(error: Error, attemptCount: number): ErrorClassification {
    // JSON-RPC Internal Error (-32603)
    if (error.code === -32603) {
      // First attempt: retry same RPC with short delay
      if (attemptCount === 1) {
        return {
          behavior: ErrorBehavior.RETRY_SAME_RPC,
          reason: 'transient_internal_error',
          retryDelay: 100, // 100ms delay
          isTransient: true,
          severity: 'low'
        };
      }
      // Second attempt: try different RPC
      return {
        behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
        reason: 'persistent_internal_error',
        isTransient: true,
        severity: 'medium'
      };
    }
    
    // Rate limiting (429 or specific codes)
    if (error.code === 429 || error.message.includes('rate')) {
      return {
        behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
        reason: 'rate_limit',
        retryDelay: 1000, // Immediate switch to different RPC
        isTransient: true,
        severity: 'medium'
      };
    }
    
    // Network timeouts
    if (error.name === 'AbortError' || error.code === 'ETIMEDOUT') {
      return {
        behavior: attemptCount === 1 
          ? ErrorBehavior.RETRY_SAME_RPC 
          : ErrorBehavior.RETRY_DIFFERENT_RPC,
        reason: 'timeout',
        retryDelay: 0, // Immediate retry
        isTransient: true,
        severity: 'low'
      };
    }
    
    // Add more classifications...
  }
}
```

### Phase 2: Smart RPC Selection (Priority: HIGH)

#### 2.1 Method-Aware RPC Scoring

**File**: `packages/permit2-rpc-server/src/method-aware-scorer.ts`

```typescript
interface MethodStats {
  successCount: number;
  failureCount: number;
  avgResponseTime: number;
  lastSuccess: number;
  lastFailure: number;
}

class MethodAwareRpcScorer {
  // Track performance per RPC per method
  private methodStats = new Map<string, Map<string, MethodStats>>();
  
  getOptimalRpc(
    rpcs: string[], 
    method: string,
    context: RequestContext
  ): string {
    // Score each RPC based on method-specific performance
    const scores = rpcs.map(rpc => ({
      rpc,
      score: this.calculateScore(rpc, method, context)
    }));
    
    // Sort by score and return best
    scores.sort((a, b) => b.score - a.score);
    return scores[0].rpc;
  }
  
  private calculateScore(
    rpc: string, 
    method: string,
    context: RequestContext
  ): number {
    const stats = this.getMethodStats(rpc, method);
    
    // Weighted scoring algorithm
    let score = 100;
    
    // Success rate (40% weight)
    const successRate = stats.successCount / 
      (stats.successCount + stats.failureCount || 1);
    score *= (0.4 * successRate);
    
    // Response time (30% weight)
    const timeScore = Math.max(0, 1 - (stats.avgResponseTime / 5000));
    score *= (0.3 * timeScore);
    
    // Recency (20% weight)
    const recencyScore = this.calculateRecency(stats);
    score *= (0.2 * recencyScore);
    
    // Penalty for recent failures (10% weight)
    if (stats.lastFailure > stats.lastSuccess) {
      score *= 0.9;
    }
    
    return score;
  }
}
```

#### 2.2 Predictive Failure Avoidance

**File**: `packages/permit2-rpc-server/src/predictive-health.ts`

```typescript
class PredictiveHealthMonitor {
  private readonly DEGRADATION_THRESHOLD = 0.7;
  private healthTrends = new Map<string, HealthTrend>();
  
  interface HealthTrend {
    samples: number[];
    trend: 'improving' | 'stable' | 'degrading';
    predictedFailureTime?: number;
  }
  
  shouldAvoidRpc(rpc: string): boolean {
    const trend = this.healthTrends.get(rpc);
    
    if (!trend) return false;
    
    // Avoid if degrading and below threshold
    if (trend.trend === 'degrading') {
      const currentHealth = trend.samples[trend.samples.length - 1];
      return currentHealth < this.DEGRADATION_THRESHOLD;
    }
    
    // Avoid if failure predicted within 30 seconds
    if (trend.predictedFailureTime) {
      return trend.predictedFailureTime - Date.now() < 30000;
    }
    
    return false;
  }
  
  updateHealth(rpc: string, success: boolean, responseTime: number) {
    const trend = this.healthTrends.get(rpc) || {
      samples: [],
      trend: 'stable'
    };
    
    // Calculate health score (0-1)
    const healthScore = success 
      ? Math.min(1, 2000 / responseTime)  // Good if < 2s
      : 0;
    
    trend.samples.push(healthScore);
    
    // Keep last 100 samples
    if (trend.samples.length > 100) {
      trend.samples.shift();
    }
    
    // Calculate trend
    trend.trend = this.calculateTrend(trend.samples);
    
    // Predict failure if degrading
    if (trend.trend === 'degrading') {
      trend.predictedFailureTime = this.predictFailure(trend.samples);
    }
    
    this.healthTrends.set(rpc, trend);
  }
}
```

### Phase 3: Batch Request Resilience (Priority: HIGH)

#### 3.1 Partial Batch Recovery

**File**: `packages/permit2-rpc-server/src/batch-handler.ts`

```typescript
interface BatchResult {
  successful: Map<number, any>;
  failed: Map<number, Error>;
  partiallyCompleted: boolean;
}

class ResilientBatchHandler {
  async processBatch(
    requests: JsonRpcRequest[],
    context: BatchContext
  ): Promise<JsonRpcResponse[]> {
    const result: BatchResult = {
      successful: new Map(),
      failed: new Map(),
      partiallyCompleted: false
    };
    
    // First attempt: try full batch
    try {
      const responses = await this.sendBatchToRpc(requests, context.primaryRpc);
      return responses;
    } catch (batchError) {
      // Batch failed, switch to item-by-item processing
      return this.processIndividually(requests, result, context);
    }
  }
  
  private async processIndividually(
    requests: JsonRpcRequest[],
    result: BatchResult,
    context: BatchContext
  ): Promise<JsonRpcResponse[]> {
    const responses: JsonRpcResponse[] = [];
    
    // Process each request with its own retry logic
    const promises = requests.map(async (req, index) => {
      try {
        // Try with primary RPC first
        const response = await this.processSingleRequest(req, context);
        result.successful.set(index, response);
        return response;
      } catch (error) {
        // Try with backup RPCs
        for (const backupRpc of context.backupRpcs) {
          try {
            const response = await this.processSingleWithRpc(req, backupRpc);
            result.successful.set(index, response);
            return response;
          } catch (backupError) {
            continue;
          }
        }
        
        // All attempts failed
        result.failed.set(index, error);
        return this.createErrorResponse(req, error);
      }
    });
    
    return Promise.all(promises);
  }
}
```

### Phase 4: Connection Optimization (Priority: MEDIUM)

#### 4.1 Connection Pooling

**File**: `packages/permit2-rpc-server/src/connection-pool.ts`

```typescript
class ConnectionPool {
  private pools = new Map<string, HttpAgent>();
  private readonly MAX_SOCKETS = 10;
  private readonly KEEP_ALIVE_TIMEOUT = 60000; // 1 minute
  
  getAgent(rpcUrl: string): HttpAgent {
    if (!this.pools.has(rpcUrl)) {
      const agent = new HttpAgent({
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: this.MAX_SOCKETS,
        maxFreeSockets: 2,
        timeout: this.KEEP_ALIVE_TIMEOUT
      });
      
      this.pools.set(rpcUrl, agent);
    }
    
    return this.pools.get(rpcUrl)!;
  }
  
  async executeWithPool<T>(
    rpcUrl: string,
    request: JsonRpcRequest
  ): Promise<T> {
    const agent = this.getAgent(rpcUrl);
    
    return fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      agent, // Use persistent connection
      keepalive: true
    });
  }
}
```

### Phase 5: Graceful Degradation (Priority: MEDIUM)

#### 5.1 Request Queue with Backpressure

**File**: `packages/permit2-rpc-server/src/request-queue.ts`

```typescript
class RequestQueue {
  private queue: QueuedRequest[] = [];
  private processing = false;
  private readonly MAX_QUEUE_SIZE = 1000;
  private readonly PROCESS_BATCH_SIZE = 10;
  
  async enqueue<T>(
    request: Request,
    priority: 'low' | 'normal' | 'high' = 'normal'
  ): Promise<T> {
    // Check queue size
    if (this.queue.length >= this.MAX_QUEUE_SIZE) {
      throw new Error('Service temporarily overloaded, please retry');
    }
    
    return new Promise((resolve, reject) => {
      const queuedRequest: QueuedRequest = {
        request,
        priority,
        timestamp: Date.now(),
        resolve,
        reject
      };
      
      // Add to queue based on priority
      this.insertByPriority(queuedRequest);
      
      // Start processing if not already running
      if (!this.processing) {
        this.processQueue();
      }
    });
  }
  
  private async processQueue() {
    this.processing = true;
    
    while (this.queue.length > 0) {
      // Process batch of requests
      const batch = this.queue.splice(0, this.PROCESS_BATCH_SIZE);
      
      await Promise.all(
        batch.map(req => this.processRequest(req))
      );
      
      // Small delay to prevent overwhelming RPCs
      await this.delay(100);
    }
    
    this.processing = false;
  }
}
```

## Testing Strategy

### 1. Unit Tests

Each new component should have comprehensive unit tests:

```typescript
// Example test for EnhancedErrorClassifier
describe('EnhancedErrorClassifier', () => {
  it('should retry -32603 errors on same RPC first', () => {
    const classifier = new EnhancedErrorClassifier();
    const error = new JsonRpcError(-32603, 'Internal error');
    
    const classification = classifier.classify(error, 1);
    
    expect(classification.behavior).toBe(ErrorBehavior.RETRY_SAME_RPC);
    expect(classification.retryDelay).toBe(100);
  });
  
  it('should switch RPC on second -32603 attempt', () => {
    const classifier = new EnhancedErrorClassifier();
    const error = new JsonRpcError(-32603, 'Internal error');
    
    const classification = classifier.classify(error, 2);
    
    expect(classification.behavior).toBe(ErrorBehavior.RETRY_DIFFERENT_RPC);
  });
});
```

### 2. Integration Tests

Simulate production scenarios:

```typescript
describe('Reliability Integration Tests', () => {
  it('should handle intermittent RPC failures', async () => {
    // Mock RPC that fails 50% of requests
    const mockRpc = createIntermittentRpc(0.5);
    
    const manager = new Permit2RpcManager({
      rpcs: { '1': [mockRpc] }
    });
    
    // Should eventually succeed despite failures
    const result = await manager.send(1, 'eth_blockNumber');
    expect(result).toBeDefined();
  });
  
  it('should recover from partial batch failures', async () => {
    // Mock RPC that fails specific items
    const mockRpc = createSelectiveFailureRpc([2, 5]);
    
    const batch = createBatchRequest(10);
    const results = await manager.sendBatch(1, batch);
    
    // All items should have responses
    expect(results).toHaveLength(10);
    expect(results.filter(r => r.error)).toHaveLength(0);
  });
});
```

### 3. Load Testing

Stress test with production-like load:

```bash
# Load test script
npm run test:load -- \
  --concurrent=100 \
  --duration=300 \
  --failure-rate=0.1 \
  --validate-no-client-errors
```

## Rollout Plan

### Phase 1: Core Retry (Week 1)
1. Implement retry budget system
2. Deploy to staging
3. Test with synthetic load
4. Monitor for 24 hours
5. Deploy to production with feature flag

### Phase 2: Smart Selection (Week 2)
1. Implement method-aware scoring
2. A/B test in production (10% traffic)
3. Compare error rates
4. Gradual rollout to 100%

### Phase 3: Batch Resilience (Week 3)
1. Implement partial batch recovery
2. Test with large batch workloads
3. Deploy with monitoring
4. Tune retry parameters based on metrics

### Phase 4: Optimization (Week 4)
1. Enable connection pooling
2. Implement request queue
3. Load test full system
4. Final production deployment

## Monitoring & Metrics

### Key Metrics to Track

1. **Error Rate by Type**
   - `-32603` errors per minute
   - Rate limit hits per RPC
   - Timeout frequency

2. **Retry Effectiveness**
   - Success rate after retry
   - Average retries per request
   - Retry budget exhaustion rate

3. **RPC Health**
   - Per-RPC success rate
   - Per-method success rate
   - Response time percentiles (p50, p95, p99)

4. **System Performance**
   - Total request latency
   - Queue depth
   - Connection pool utilization

### Alert Thresholds

```yaml
alerts:
  - name: high_error_rate
    condition: error_rate > 1%
    severity: warning
    
  - name: retry_budget_exhaustion
    condition: exhaustion_rate > 5%
    severity: critical
    
  - name: all_rpcs_failing
    condition: available_rpcs == 0
    severity: critical
```

## Configuration Recommendations

```typescript
// Recommended production configuration
const config: ReliabilityConfig = {
  // Retry settings
  retryBudget: 3,
  maxRetriesPerRpc: 2,
  retryDelayMs: 100,
  
  // Timeout settings
  defaultTimeoutMs: 10000,
  adaptiveTimeoutEnabled: true,
  timeoutPercentile: 95,
  
  // Health monitoring
  healthCheckIntervalMs: 30000,
  maxConsecutiveFailures: 3,
  backoffMultiplier: 2,
  maxBackoffMs: 30000,
  
  // Batch processing
  batchPartialRetryEnabled: true,
  maxBatchRetryItems: 100,
  
  // Connection pooling
  connectionPoolEnabled: true,
  maxSocketsPerRpc: 10,
  keepAliveTimeoutMs: 60000,
  
  // Queue management
  queueEnabled: true,
  maxQueueSize: 1000,
  queueProcessBatchSize: 10
};
```

## Success Criteria

The implementation will be considered successful when:

1. **Zero client-visible errors** during normal operation (< 100 req/s)
2. **< 0.1% error rate** during peak load (1000 req/s)
3. **< 500ms p95 latency** for single requests
4. **< 1s p95 latency** for batch requests (25 items)
5. **Automatic recovery** from RPC failures within 10 seconds
6. **No cascade failures** when individual RPCs fail

## Appendix

### A. Error Code Reference

| Code | Description | Current Behavior | Proposed Behavior |
|------|-------------|------------------|-------------------|
| -32603 | Internal error | DO_NOT_RETRY | RETRY_SAME_RPC then RETRY_DIFFERENT_RPC |
| -32005 | Rate limit | RETRY_WITH_BACKOFF | RETRY_DIFFERENT_RPC immediately |
| 429 | HTTP rate limit | RETRY_WITH_BACKOFF | RETRY_DIFFERENT_RPC immediately |
| -32000 | Provider error | RETRY_DIFFERENT_RPC | Context-dependent retry |
| 3 | Execution reverted | BLOCKCHAIN_ERROR | DO_NOT_RETRY |

### B. RPC Performance Baseline

Based on production analysis:

| RPC Provider | Success Rate | Avg Response Time | Rate Limit |
|--------------|--------------|-------------------|------------|
| api.zan.top | 90% | 250ms | Unknown |
| gnosis.api.onfinality.io | 95% | 150ms | 100 req/s |
| rpc.poolz.finance | 85% | 500ms | None |

### C. Implementation Checklist

- [ ] Implement retry budget system
- [ ] Add enhanced error classification
- [ ] Create method-aware RPC scorer
- [ ] Implement partial batch recovery
- [ ] Add connection pooling
- [ ] Create request queue with backpressure
- [ ] Add predictive health monitoring
- [ ] Write comprehensive unit tests
- [ ] Create integration test suite
- [ ] Set up monitoring dashboards
- [ ] Document configuration options
- [ ] Create runbook for operations

## Contact

For questions about this implementation guide:
- Technical Lead: [Your Name]
- Architecture Review: [Reviewer Name]
- Implementation Team: [Team Name]

Last Updated: 2025-08-31
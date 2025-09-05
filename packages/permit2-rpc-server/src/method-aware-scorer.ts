export interface MethodStats {
  successCount: number;
  failureCount: number;
  avgResponseTime: number;
  lastSuccess: number;
  lastFailure: number;
  p95ResponseTime: number;
  responseTimes: number[]; // Keep last N response times for percentile calculation
}

export interface RequestContext {
  priority?: "low" | "normal" | "high";
  expectedResponseTime?: number;
  retryCount?: number;
}

export class MethodAwareRpcScorer {
  // Track performance per RPC per method
  private methodStats = new Map<string, Map<string, MethodStats>>();
  private readonly MAX_RESPONSE_TIME_SAMPLES = 100;
  private readonly RECENCY_WINDOW_MS = 60000; // 1 minute

  getOptimalRpc(
    rpcs: string[],
    method: string,
    context: RequestContext = {},
  ): string {
    if (rpcs.length === 0) {
      throw new Error("No RPCs available");
    }

    if (rpcs.length === 1) {
      return rpcs[0];
    }

    // Score each RPC based on method-specific performance
    const scores = rpcs.map((rpc) => ({
      rpc,
      score: this.calculateScore(rpc, method, context),
    }));

    // Sort by score (higher is better) and return best
    scores.sort((a, b) => b.score - a.score);

    // Add some randomization for top performers to distribute load
    const topScore = scores[0].score;
    const topPerformers = scores.filter((s) => s.score >= topScore * 0.95);

    if (topPerformers.length > 1 && context.priority !== "high") {
      // Randomly select from top performers for load distribution
      const randomIndex = Math.floor(Math.random() * topPerformers.length);
      return topPerformers[randomIndex].rpc;
    }

    return scores[0].rpc;
  }

  private calculateScore(
    rpc: string,
    method: string,
    context: RequestContext,
  ): number {
    const stats = this.getMethodStats(rpc, method);

    // No stats yet - use neutral score with small random factor for distribution
    if (stats.successCount === 0 && stats.failureCount === 0) {
      return 50 + Math.random() * 10; // Neutral score
    }

    let score = 0;

    // Success rate (40% weight) - most important factor
    const totalCalls = stats.successCount + stats.failureCount;
    const successRate = stats.successCount / totalCalls;
    score += 40 * successRate;

    // Response time (30% weight)
    if (stats.avgResponseTime > 0) {
      // Score decreases as response time increases
      // Better scaling: 30 for <100ms, 25 for 500ms, 15 for 1s, 10 for 2s, 3 for 5s+
      let timeScore: number;
      if (stats.avgResponseTime <= 100) {
        timeScore = 30;
      } else if (stats.avgResponseTime <= 500) {
        timeScore = 30 - (stats.avgResponseTime - 100) * (5 / 400); // Linear drop from 30 to 25
      } else if (stats.avgResponseTime <= 1000) {
        timeScore = 25 - (stats.avgResponseTime - 500) * (10 / 500); // Linear drop from 25 to 15
      } else if (stats.avgResponseTime <= 2000) {
        timeScore = 15 - (stats.avgResponseTime - 1000) * (5 / 1000); // Linear drop from 15 to 10
      } else if (stats.avgResponseTime <= 5000) {
        timeScore = 10 - (stats.avgResponseTime - 2000) * (7 / 3000); // Linear drop from 10 to 3
      } else {
        timeScore = 3; // Minimum for very slow responses
      }

      score += timeScore;

      // Penalize high p95 (indicates inconsistency)
      if (stats.p95ResponseTime > stats.avgResponseTime * 2) {
        score *= 0.9;
      }
    }

    // Recency (20% weight) - prefer recently successful RPCs
    const now = Date.now();
    if (stats.lastSuccess > 0) {
      const timeSinceSuccess = now - stats.lastSuccess;
      const recencyScore = Math.max(0, 1 - (timeSinceSuccess / this.RECENCY_WINDOW_MS));
      score += 20 * recencyScore;
    } else {
      score += 2; // Small penalty for never successful
    }

    // Consistency bonus (10% weight)
    if (totalCalls >= 10) {
      const consistencyScore = successRate >= 0.95 ? 1 : successRate;
      score += 10 * consistencyScore;
    }

    // Context-based adjustments
    if (context.priority === "high") {
      // For high priority, heavily favor reliability over speed
      score *= successRate; // Double weight on success rate
    }

    if (context.expectedResponseTime && stats.avgResponseTime > 0) {
      // Penalize if significantly slower than expected
      if (stats.avgResponseTime > context.expectedResponseTime * 1.5) {
        score *= 0.8;
      }
    }

    // Penalty for recent failures
    if (
      stats.lastFailure > stats.lastSuccess &&
      now - stats.lastFailure < 5000
    ) { // Failed in last 5 seconds
      score *= 0.7;
    }

    // Boost for consistent recent performance
    if (
      stats.successCount >= 5 && successRate === 1 &&
      now - stats.lastSuccess < 10000
    ) { // Perfect recent record
      score *= 1.2;
    }

    return Math.max(0, Math.min(100, score));
  }

  getMethodStats(rpc: string, method: string): MethodStats {
    if (!this.methodStats.has(rpc)) {
      this.methodStats.set(rpc, new Map());
    }

    const rpcStats = this.methodStats.get(rpc)!;

    if (!rpcStats.has(method)) {
      rpcStats.set(method, {
        successCount: 0,
        failureCount: 0,
        avgResponseTime: 0,
        lastSuccess: 0,
        lastFailure: 0,
        p95ResponseTime: 0,
        responseTimes: [],
      });
    }

    return rpcStats.get(method)!;
  }

  recordSuccess(
    rpc: string,
    method: string,
    responseTime: number,
  ): void {
    const stats = this.getMethodStats(rpc, method);

    stats.successCount++;
    stats.lastSuccess = Date.now();

    // Update response times
    stats.responseTimes.push(responseTime);
    if (stats.responseTimes.length > this.MAX_RESPONSE_TIME_SAMPLES) {
      stats.responseTimes.shift();
    }

    // Recalculate averages
    this.updateResponseTimeStats(stats);
  }

  recordFailure(
    rpc: string,
    method: string,
    _errorType?: string,
  ): void {
    const stats = this.getMethodStats(rpc, method);

    stats.failureCount++;
    stats.lastFailure = Date.now();

    // Optionally track error types for more intelligent scoring
    // Could be extended to track specific error patterns
  }

  private updateResponseTimeStats(stats: MethodStats): void {
    if (stats.responseTimes.length === 0) {
      return;
    }

    // Calculate average
    const sum = stats.responseTimes.reduce((a, b) => a + b, 0);
    stats.avgResponseTime = sum / stats.responseTimes.length;

    // Calculate p95
    const sorted = [...stats.responseTimes].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    stats.p95ResponseTime = sorted[p95Index] || stats.avgResponseTime;
  }

  /**
   * Get performance report for a specific method across all RPCs
   */
  getMethodReport(method: string): Map<string, MethodStats> {
    const report = new Map<string, MethodStats>();

    for (const [rpc, methods] of this.methodStats.entries()) {
      const stats = methods.get(method);
      if (stats) {
        report.set(rpc, stats);
      }
    }

    return report;
  }

  /**
   * Clear old stats to prevent memory growth
   */
  pruneOldStats(maxAgeMs: number = 3600000): void { // Default 1 hour
    const now = Date.now();

    for (const [rpc, methods] of this.methodStats.entries()) {
      for (const [method, stats] of methods.entries()) {
        const lastActivity = Math.max(stats.lastSuccess, stats.lastFailure);

        if (lastActivity > 0 && now - lastActivity > maxAgeMs) {
          methods.delete(method);
        }
      }

      // Remove RPC entry if no methods left
      if (methods.size === 0) {
        this.methodStats.delete(rpc);
      }
    }
  }

  /**
   * Export stats for persistence
   */
  exportStats(): string {
    const exportData: any = {};

    for (const [rpc, methods] of this.methodStats.entries()) {
      exportData[rpc] = {};
      for (const [method, stats] of methods.entries()) {
        // Don't export full response time arrays to save space
        exportData[rpc][method] = {
          ...stats,
          responseTimes: undefined,
        };
      }
    }

    return JSON.stringify(exportData);
  }

  /**
   * Import stats from persistence
   */
  importStats(data: string): void {
    try {
      const importData = JSON.parse(data);

      for (const [rpc, methods] of Object.entries(importData)) {
        for (const [method, stats] of Object.entries(methods as any)) {
          const methodStats = stats as MethodStats;
          // Restore with empty response times array
          methodStats.responseTimes = [];

          if (!this.methodStats.has(rpc)) {
            this.methodStats.set(rpc, new Map());
          }

          this.methodStats.get(rpc)!.set(method, methodStats);
        }
      }
    } catch (error) {
      console.error("Failed to import method stats:", error);
    }
  }
}

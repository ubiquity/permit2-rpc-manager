export interface HealthTrend {
  samples: number[];
  trend: "improving" | "stable" | "degrading";
  predictedFailureTime?: number;
  avgHealth: number;
  volatility: number;
}

export class PredictiveHealthMonitor {
  private readonly DEGRADATION_THRESHOLD = 0.7;
  private readonly CRITICAL_THRESHOLD = 0.3;
  private readonly MAX_SAMPLES = 100;
  private readonly MIN_SAMPLES_FOR_TREND = 5;
  private readonly PREDICTION_WINDOW_MS = 60000; // 1 minute

  private healthTrends = new Map<string, HealthTrend>();
  private failurePatterns = new Map<string, Array<{ timestamp: number; type: string }>>();

  /**
   * Check if an RPC should be avoided based on predictive analysis
   */
  shouldAvoidRpc(rpc: string): boolean {
    const trend = this.healthTrends.get(rpc);

    if (!trend || trend.samples.length < this.MIN_SAMPLES_FOR_TREND) {
      return false; // Not enough data
    }

    // Avoid if currently unhealthy
    const currentHealth = this.getCurrentHealth(trend);
    if (currentHealth < this.CRITICAL_THRESHOLD) {
      return true;
    }

    // Avoid if degrading rapidly
    if (trend.trend === "degrading") {
      // Check degradation rate
      const degradationRate = this.calculateDegradationRate(trend);
      if (degradationRate > 0.1) { // Losing >10% health per sample
        return true;
      }

      // Avoid if below threshold and still degrading
      if (currentHealth < this.DEGRADATION_THRESHOLD) {
        return true;
      }
    }

    // Avoid if failure predicted within prediction window
    if (trend.predictedFailureTime) {
      const timeToFailure = trend.predictedFailureTime - Date.now();
      if (timeToFailure > 0 && timeToFailure < this.PREDICTION_WINDOW_MS) {
        return true;
      }
    }

    // Check for repeating failure patterns
    if (this.hasRepeatingFailurePattern(rpc)) {
      return true;
    }

    return false;
  }

  /**
   * Update health based on request outcome
   */
  updateHealth(
    rpc: string,
    success: boolean,
    responseTime: number,
    errorType?: string,
  ): void {
    const trend = this.healthTrends.get(rpc) || {
      samples: [],
      trend: "stable",
      avgHealth: 1,
      volatility: 0,
    };

    // Calculate health score (0-1)
    let healthScore: number;
    if (success) {
      // Good health if response time is reasonable
      // Excellent: <500ms = 1.0
      // Good: <2s = 0.8
      // Acceptable: <5s = 0.6
      // Poor: >5s = 0.4
      if (responseTime < 500) {
        healthScore = 1.0;
      } else if (responseTime < 2000) {
        healthScore = 0.8;
      } else if (responseTime < 5000) {
        healthScore = 0.6;
      } else {
        healthScore = 0.4;
      }
    } else {
      // Failed request
      healthScore = 0;

      // Track failure pattern
      if (errorType) {
        this.recordFailurePattern(rpc, errorType);
      }
    }

    // Add new sample
    trend.samples.push(healthScore);

    // Keep only recent samples
    if (trend.samples.length > this.MAX_SAMPLES) {
      trend.samples.shift();
    }

    // Update statistics
    this.updateTrendStatistics(trend);

    // Calculate trend
    trend.trend = this.calculateTrend(trend.samples);

    // Predict failure if degrading
    if (trend.trend === "degrading") {
      trend.predictedFailureTime = this.predictFailure(trend);
    } else {
      trend.predictedFailureTime = undefined;
    }

    this.healthTrends.set(rpc, trend);
  }

  private getCurrentHealth(trend: HealthTrend): number {
    if (trend.samples.length === 0) {
      return 1; // Assume healthy if no data
    }
    return trend.samples[trend.samples.length - 1];
  }

  private calculateDegradationRate(trend: HealthTrend): number {
    if (trend.samples.length < 2) {
      return 0;
    }

    // Calculate average change over last 5 samples
    const recentSamples = trend.samples.slice(-5);
    if (recentSamples.length < 2) {
      return 0;
    }

    let totalChange = 0;
    for (let i = 1; i < recentSamples.length; i++) {
      totalChange += recentSamples[i - 1] - recentSamples[i];
    }

    return totalChange / (recentSamples.length - 1);
  }

  private updateTrendStatistics(trend: HealthTrend): void {
    if (trend.samples.length === 0) {
      return;
    }

    // Calculate average health
    const sum = trend.samples.reduce((a, b) => a + b, 0);
    trend.avgHealth = sum / trend.samples.length;

    // Calculate volatility (standard deviation)
    const squaredDiffs = trend.samples.map((s) => Math.pow(s - trend.avgHealth, 2));
    const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / trend.samples.length;
    trend.volatility = Math.sqrt(avgSquaredDiff);
  }

  private calculateTrend(samples: number[]): "improving" | "stable" | "degrading" {
    if (samples.length < this.MIN_SAMPLES_FOR_TREND) {
      return "stable";
    }

    // Use linear regression to determine trend
    const n = Math.min(samples.length, 20); // Use last 20 samples max
    const recentSamples = samples.slice(-n);

    // Calculate linear regression slope
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

    for (let i = 0; i < recentSamples.length; i++) {
      sumX += i;
      sumY += recentSamples[i];
      sumXY += i * recentSamples[i];
      sumX2 += i * i;
    }

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

    // Determine trend based on slope
    if (slope > 0.01) {
      return "improving";
    } else if (slope < -0.01) {
      return "degrading";
    } else {
      return "stable";
    }
  }

  private predictFailure(trend: HealthTrend): number | undefined {
    if (trend.samples.length < this.MIN_SAMPLES_FOR_TREND) {
      return undefined;
    }

    // Use exponential smoothing to predict future values
    const alpha = 0.3; // Smoothing factor
    let forecast = trend.samples[0];

    // Apply exponential smoothing
    for (let i = 1; i < trend.samples.length; i++) {
      forecast = alpha * trend.samples[i] + (1 - alpha) * forecast;
    }

    // Calculate rate of change
    const recentSamples = trend.samples.slice(-10);
    const avgRecentChange = this.calculateAverageChange(recentSamples);

    if (avgRecentChange >= 0) {
      return undefined; // Not degrading
    }

    // Estimate time to failure (when health reaches 0)
    const currentHealth = forecast;
    const samplesUntilFailure = currentHealth / Math.abs(avgRecentChange);

    // Assume each sample represents ~1 second (adjust based on actual sampling rate)
    const estimatedTimeToFailure = samplesUntilFailure * 1000;

    // Only predict if failure is within reasonable timeframe
    if (estimatedTimeToFailure > 0 && estimatedTimeToFailure < 300000) { // 5 minutes
      return Date.now() + estimatedTimeToFailure;
    }

    return undefined;
  }

  private calculateAverageChange(samples: number[]): number {
    if (samples.length < 2) {
      return 0;
    }

    let totalChange = 0;
    for (let i = 1; i < samples.length; i++) {
      totalChange += samples[i] - samples[i - 1];
    }

    return totalChange / (samples.length - 1);
  }

  private recordFailurePattern(rpc: string, errorType: string): void {
    if (!this.failurePatterns.has(rpc)) {
      this.failurePatterns.set(rpc, []);
    }

    const patterns = this.failurePatterns.get(rpc)!;
    patterns.push({
      timestamp: Date.now(),
      type: errorType,
    });

    // Keep only recent failures (last hour)
    const oneHourAgo = Date.now() - 3600000;
    const recentPatterns = patterns.filter((p) => p.timestamp > oneHourAgo);
    this.failurePatterns.set(rpc, recentPatterns);
  }

  private hasRepeatingFailurePattern(rpc: string): boolean {
    const patterns = this.failurePatterns.get(rpc);
    if (!patterns || patterns.length < 3) {
      return false;
    }

    // Check for repeated failures of same type in short time
    const recentWindow = Date.now() - 60000; // Last minute
    const recentFailures = patterns.filter((p) => p.timestamp > recentWindow);

    if (recentFailures.length >= 3) {
      // Check if same error type is repeating
      const typeCounts = new Map<string, number>();
      for (const failure of recentFailures) {
        typeCounts.set(failure.type, (typeCounts.get(failure.type) || 0) + 1);
      }

      // If any error type appears 3+ times, it's a pattern
      for (const count of typeCounts.values()) {
        if (count >= 3) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get health report for all monitored RPCs
   */
  getHealthReport(): Map<string, {
    health: number;
    trend: string;
    volatility: number;
    predictedFailure?: number;
    shouldAvoid: boolean;
  }> {
    const report = new Map();

    for (const [rpc, trend] of this.healthTrends.entries()) {
      report.set(rpc, {
        health: this.getCurrentHealth(trend),
        trend: trend.trend,
        volatility: trend.volatility,
        predictedFailure: trend.predictedFailureTime,
        shouldAvoid: this.shouldAvoidRpc(rpc),
      });
    }

    return report;
  }

  /**
   * Clear old data to prevent memory growth
   */
  pruneOldData(): void {
    const oneHourAgo = Date.now() - 3600000;

    // Clear old failure patterns
    for (const [rpc, patterns] of this.failurePatterns.entries()) {
      const recentPatterns = patterns.filter((p) => p.timestamp > oneHourAgo);
      if (recentPatterns.length === 0) {
        this.failurePatterns.delete(rpc);
      } else {
        this.failurePatterns.set(rpc, recentPatterns);
      }
    }

    // Clear stale health trends (no updates in last hour)
    // Note: We keep the trend data itself as it's valuable historical info
  }
}

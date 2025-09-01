export interface RetryContext {
  budget: number;                        // Total retries allowed
  attemptCount: number;                  // Current attempt number
  rpcAttempts: Map<string, number>;      // Attempts per RPC
  errors: Array<{                        // Error history for debugging
    rpc: string;
    error: Error;
    classification: string;
    timestamp: number;
  }>;
  startTime: number;                     // Request start time
  lastRpcUrl?: string;                   // Last attempted RPC
}

export class RetryManager {
  private readonly DEFAULT_RETRY_BUDGET = 3;
  private readonly MAX_RETRIES_PER_RPC = 2;
  private readonly MAX_TOTAL_TIME_MS = 30000; // 30 seconds max total time

  createContext(retryBudget?: number): RetryContext {
    return {
      budget: retryBudget ?? this.DEFAULT_RETRY_BUDGET,
      attemptCount: 0,
      rpcAttempts: new Map(),
      errors: [],
      startTime: Date.now()
    };
  }

  canRetry(context: RetryContext): boolean {
    // Check budget
    if (context.budget <= 0) {
      return false;
    }

    // Check total time
    if (Date.now() - context.startTime > this.MAX_TOTAL_TIME_MS) {
      return false;
    }

    return true;
  }

  canRetryRpc(context: RetryContext, rpcUrl: string): boolean {
    const attempts = context.rpcAttempts.get(rpcUrl) || 0;
    return attempts < this.MAX_RETRIES_PER_RPC;
  }

  recordAttempt(context: RetryContext, rpcUrl: string): void {
    context.attemptCount++;
    context.lastRpcUrl = rpcUrl;
    
    const currentAttempts = context.rpcAttempts.get(rpcUrl) || 0;
    context.rpcAttempts.set(rpcUrl, currentAttempts + 1);
  }

  recordError(
    context: RetryContext, 
    rpcUrl: string, 
    error: Error, 
    classification: string
  ): void {
    context.errors.push({
      rpc: rpcUrl,
      error,
      classification,
      timestamp: Date.now()
    });
    context.budget--;
  }

  createAggregateError(context: RetryContext): Error {
    const errorMessages = context.errors.map(e => 
      `[${e.rpc}]: ${e.classification} - ${e.error.message}`
    ).join('; ');

    const error = new Error(
      `All retry attempts exhausted. Tried ${context.attemptCount} times across ` +
      `${context.rpcAttempts.size} RPCs. Errors: ${errorMessages}`
    );

    // Attach context for debugging
    (error as any).retryContext = context;
    
    return error;
  }

  /**
   * Get summary of retry attempts for logging
   */
  getSummary(context: RetryContext): string {
    const rpcSummary = Array.from(context.rpcAttempts.entries())
      .map(([rpc, count]) => `${rpc}:${count}`)
      .join(', ');
    
    const errorSummary = context.errors
      .map(e => e.classification)
      .reduce((acc, classification) => {
        acc[classification] = (acc[classification] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

    const errorStr = Object.entries(errorSummary)
      .map(([type, count]) => `${type}:${count}`)
      .join(', ');

    return `Attempts: ${context.attemptCount}, RPCs: [${rpcSummary}], Errors: [${errorStr}]`;
  }
}
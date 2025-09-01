export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: unknown[];
  id: number | string;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface BatchContext {
  chainId: number;
  primaryRpc: string;
  backupRpcs: string[];
  maxRetries: number;
  timeout: number;
}

export interface BatchResult {
  successful: Map<number, JsonRpcResponse>;
  failed: Map<number, Error>;
  partiallyCompleted: boolean;
  totalRequests: number;
  successCount: number;
  failureCount: number;
  retriedCount: number;
}

export type RpcExecutor = (rpc: string, request: JsonRpcRequest) => Promise<JsonRpcResponse>;

export class ResilientBatchHandler {
  private readonly MAX_BATCH_SIZE = 100;
  private readonly MAX_PARALLEL_REQUESTS = 10;
  private readonly INDIVIDUAL_REQUEST_TIMEOUT = 5000;

  constructor(
    private executor: RpcExecutor,
    private logger: (level: "debug" | "info" | "warn" | "error", message: string, ...args: any[]) => void = console.log,
  ) {}

  /**
   * Process a batch of requests with resilience and partial recovery
   */
  async processBatch(
    requests: JsonRpcRequest[],
    context: BatchContext,
  ): Promise<JsonRpcResponse[]> {
    const result: BatchResult = {
      successful: new Map(),
      failed: new Map(),
      partiallyCompleted: false,
      totalRequests: requests.length,
      successCount: 0,
      failureCount: 0,
      retriedCount: 0,
    };

    // Validate batch size
    if (requests.length > this.MAX_BATCH_SIZE) {
      // Split into smaller batches
      return this.processLargeBatch(requests, context);
    }

    // First attempt: try full batch with primary RPC
    try {
      this.logger("debug", `[BATCH] Attempting full batch of ${requests.length} requests with primary RPC`);
      const responses = await this.sendBatchToRpc(requests, context.primaryRpc, context.timeout);

      // Check if all succeeded
      const failures = this.extractFailures(responses);
      if (failures.length === 0) {
        this.logger("info", `[BATCH] Full batch succeeded with primary RPC`);
        return responses;
      }

      // Partial failure - process failed items individually
      this.logger("warn", `[BATCH] Batch partially failed: ${failures.length}/${requests.length} failed`);
      result.partiallyCompleted = true;

      // Store successful responses
      responses.forEach((response, index) => {
        if (!response.error) {
          result.successful.set(index, response);
          result.successCount++;
        }
      });

      // Retry failed requests
      return this.processWithPartialRecovery(requests, responses, result, context);
    } catch (batchError: any) {
      // Complete batch failure - switch to individual processing
      this.logger("warn", `[BATCH] Full batch failed: ${batchError.message}. Switching to individual processing`);
      return this.processIndividually(requests, result, context);
    }
  }

  /**
   * Process large batch by splitting into smaller chunks
   */
  private async processLargeBatch(
    requests: JsonRpcRequest[],
    context: BatchContext,
  ): Promise<JsonRpcResponse[]> {
    const chunks: JsonRpcRequest[][] = [];

    // Split into chunks
    for (let i = 0; i < requests.length; i += this.MAX_BATCH_SIZE) {
      chunks.push(requests.slice(i, i + this.MAX_BATCH_SIZE));
    }

    this.logger("info", `[BATCH] Processing large batch of ${requests.length} requests in ${chunks.length} chunks`);

    // Process chunks in parallel (limited concurrency)
    const results: JsonRpcResponse[] = [];

    for (let i = 0; i < chunks.length; i += this.MAX_PARALLEL_REQUESTS) {
      const chunkBatch = chunks.slice(i, i + this.MAX_PARALLEL_REQUESTS);

      const chunkResults = await Promise.all(
        chunkBatch.map((chunk) => this.processBatch(chunk, context)),
      );

      // Flatten results
      for (const chunkResult of chunkResults) {
        results.push(...chunkResult);
      }
    }

    return results;
  }

  /**
   * Send batch request to specific RPC
   */
  private async sendBatchToRpc(
    requests: JsonRpcRequest[],
    rpcUrl: string,
    timeout: number,
  ): Promise<JsonRpcResponse[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requests),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      // Ensure we have array response
      if (!Array.isArray(data)) {
        throw new Error("Invalid batch response: expected array");
      }

      return data;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Process requests with partial recovery
   */
  private async processWithPartialRecovery(
    requests: JsonRpcRequest[],
    initialResponses: JsonRpcResponse[],
    result: BatchResult,
    context: BatchContext,
  ): Promise<JsonRpcResponse[]> {
    const finalResponses = [...initialResponses];
    const failedIndices: number[] = [];

    // Identify failed requests
    initialResponses.forEach((response, index) => {
      if (response.error) {
        failedIndices.push(index);
      }
    });

    if (failedIndices.length === 0) {
      return finalResponses;
    }

    this.logger("info", `[BATCH] Retrying ${failedIndices.length} failed requests`);

    // Retry failed requests with backup RPCs
    const retryPromises = failedIndices.map(async (index) => {
      const request = requests[index];

      // Try each backup RPC
      for (const backupRpc of context.backupRpcs) {
        try {
          const response = await this.processSingleWithRpc(request, backupRpc);

          if (!response.error) {
            finalResponses[index] = response;
            result.successful.set(index, response);
            result.successCount++;
            result.retriedCount++;

            this.logger("debug", `[BATCH] Request ${index} succeeded with backup RPC`);
            return;
          }
        } catch (_error) {
          // Try next backup RPC
          continue;
        }
      }

      // All retries failed
      result.failed.set(index, new Error(`All retry attempts failed for request ${index}`));
      result.failureCount++;
    });

    await Promise.all(retryPromises);

    this.logger(
      "info",
      `[BATCH] Partial recovery complete: ${result.successCount}/${result.totalRequests} succeeded, ` +
        `${result.retriedCount} recovered through retry`,
    );

    return finalResponses;
  }

  /**
   * Process each request individually when batch fails
   */
  private async processIndividually(
    requests: JsonRpcRequest[],
    result: BatchResult,
    context: BatchContext,
  ): Promise<JsonRpcResponse[]> {
    this.logger("info", `[BATCH] Processing ${requests.length} requests individually`);

    // Limit concurrent individual requests
    const responses: JsonRpcResponse[] = new Array(requests.length);

    // Process in chunks to avoid overwhelming the system
    for (let i = 0; i < requests.length; i += this.MAX_PARALLEL_REQUESTS) {
      const chunk = requests.slice(i, i + this.MAX_PARALLEL_REQUESTS);
      // const chunkIndices = Array.from({ length: chunk.length }, (_, idx) => i + idx);

      const chunkPromises = chunk.map(async (req, chunkIdx) => {
        const globalIdx = i + chunkIdx;

        try {
          // Try primary RPC first
          let response = await this.processSingleWithRpc(req, context.primaryRpc);

          if (response.error && context.backupRpcs.length > 0) {
            // Try backup RPCs
            for (const backupRpc of context.backupRpcs) {
              try {
                response = await this.processSingleWithRpc(req, backupRpc);
                if (!response.error) {
                  result.retriedCount++;
                  break;
                }
              } catch (_error) {
                // Continue to next backup
              }
            }
          }

          responses[globalIdx] = response;

          if (!response.error) {
            result.successful.set(globalIdx, response);
            result.successCount++;
          } else {
            result.failed.set(globalIdx, new Error(response.error.message));
            result.failureCount++;
          }
        } catch (error: any) {
          // Create error response
          responses[globalIdx] = this.createErrorResponse(req, error);
          result.failed.set(globalIdx, error);
          result.failureCount++;
        }
      });

      await Promise.all(chunkPromises);
    }

    result.partiallyCompleted = result.successCount > 0 && result.failureCount > 0;

    this.logger(
      "info",
      `[BATCH] Individual processing complete: ${result.successCount}/${result.totalRequests} succeeded`,
    );

    return responses;
  }

  /**
   * Process single request with specific RPC
   */
  private processSingleWithRpc(
    request: JsonRpcRequest,
    rpcUrl: string,
  ): Promise<JsonRpcResponse> {
    return this.executor(rpcUrl, request);
  }

  /**
   * Extract failed responses from batch
   */
  private extractFailures(responses: JsonRpcResponse[]): JsonRpcResponse[] {
    return responses.filter((r) => r.error !== undefined);
  }

  /**
   * Create error response for failed request
   */
  private createErrorResponse(request: JsonRpcRequest, error: Error): JsonRpcResponse {
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32000,
        message: error.message || "Request failed",
        data: { originalError: error.toString() },
      },
    };
  }

  /**
   * Analyze batch failure patterns
   */
  analyzeBatchFailure(result: BatchResult): {
    recoveryRate: number;
    failureRate: number;
    partialSuccess: boolean;
    recommendation: string;
  } {
    const recoveryRate = result.retriedCount / result.failureCount;
    const failureRate = result.failureCount / result.totalRequests;

    let recommendation = "";

    if (failureRate > 0.5) {
      recommendation = "High failure rate detected. Consider reducing batch size or checking RPC health.";
    } else if (recoveryRate < 0.5 && result.failureCount > 0) {
      recommendation = "Low recovery rate. Consider adding more backup RPCs.";
    } else if (result.partiallyCompleted) {
      recommendation = "Partial batch completion. Individual request processing recommended for critical operations.";
    } else {
      recommendation = "Batch processing successful.";
    }

    return {
      recoveryRate,
      failureRate,
      partialSuccess: result.partiallyCompleted,
      recommendation,
    };
  }
}

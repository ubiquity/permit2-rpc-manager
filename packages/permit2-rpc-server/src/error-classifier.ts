// JSON-RPC error codes as per specification
const JSON_RPC_ERROR_CODES = {
  // Standard errors
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // Implementation-defined errors start at -32000
  IMPLEMENTATION_DEFINED_START: -32000,

  // Common provider-specific codes
  EXECUTION_REVERTED: 3,
  UNAUTHORIZED: -32001,
  ACTION_NOT_PERMITTED: -32002,
  EXECUTION_ERROR: -32003,
  QUOTA_EXCEEDED: -32004,
  REQUEST_LIMIT: -32005,
} as const;

export enum ErrorBehavior {
  RETRY_SAME_RPC, // Transient errors (retry with backoff)
  RETRY_DIFFERENT_RPC, // Provider issues (switch RPC)
  DO_NOT_RETRY, // Client errors (fail fast)
  BLOCKCHAIN_ERROR, // Execution errors
}

export interface ErrorClassification {
  behavior: ErrorBehavior;
  reason: string;
  retryDelay?: number; // Suggested delay before retry
  isTransient: boolean; // Can succeed on retry
  severity: "low" | "medium" | "high" | "critical";
}

export class EnhancedErrorClassifier {
  classify(error: any, attemptCount: number): ErrorClassification {
    // JSON-RPC Internal Error (-32603)
    if (error.code === JSON_RPC_ERROR_CODES.INTERNAL_ERROR) {
      // First attempt: retry same RPC with short delay
      if (attemptCount === 1) {
        return {
          behavior: ErrorBehavior.RETRY_SAME_RPC,
          reason: "transient_internal_error",
          retryDelay: 100, // 100ms delay
          isTransient: true,
          severity: "low",
        };
      }
      // Second attempt: try different RPC
      return {
        behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
        reason: "persistent_internal_error",
        isTransient: true,
        severity: "medium",
      };
    }

    // Rate limiting (429 or specific codes)
    if (
      error.code === 429 || error.httpStatus === 429 ||
      error.code === JSON_RPC_ERROR_CODES.QUOTA_EXCEEDED ||
      error.code === JSON_RPC_ERROR_CODES.REQUEST_LIMIT ||
      (error.message && error.message.toLowerCase().includes("rate"))
    ) {
      return {
        behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
        reason: "rate_limit",
        retryDelay: 1000, // Immediate switch to different RPC
        isTransient: true,
        severity: "medium",
      };
    }

    // Network timeouts
    if (
      error.name === "AbortError" || error.code === "ETIMEDOUT" ||
      (error.message && error.message.includes("timeout"))
    ) {
      return {
        behavior: attemptCount === 1 ? ErrorBehavior.RETRY_SAME_RPC : ErrorBehavior.RETRY_DIFFERENT_RPC,
        reason: "timeout",
        retryDelay: 0, // Immediate retry
        isTransient: true,
        severity: "low",
      };
    }

    // Server errors (5xx)
    if (error.httpStatus >= 500 && error.httpStatus <= 599) {
      return {
        behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
        reason: "server_error",
        retryDelay: 500,
        isTransient: true,
        severity: "high",
      };
    }

    // Network errors
    if (
      error.name === "TypeError" || error.message === "Failed to fetch" ||
      error.code === "ECONNREFUSED" || error.code === "ECONNRESET"
    ) {
      return {
        behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
        reason: "network_error",
        retryDelay: 0,
        isTransient: true,
        severity: "medium",
      };
    }

    // Execution reverted (blockchain error)
    if (error.code === JSON_RPC_ERROR_CODES.EXECUTION_REVERTED) {
      return {
        behavior: ErrorBehavior.BLOCKCHAIN_ERROR,
        reason: "execution_reverted",
        isTransient: false,
        severity: "critical",
      };
    }

    // Client errors (4xx except 429)
    if (error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 429) {
      return {
        behavior: ErrorBehavior.DO_NOT_RETRY,
        reason: "client_error",
        isTransient: false,
        severity: "high",
      };
    }

    // Block range limit errors - specific handling for eth_getLogs
    if (
      error.code === JSON_RPC_ERROR_CODES.INVALID_PARAMS &&
      error.message &&
      /range|limit|block range is too large|exceeds maximum|too many blocks|query returned more than/i.test(error.message)
    ) {
      return {
        behavior: ErrorBehavior.DO_NOT_RETRY,
        reason: "block_range_limit_exceeded",
        isTransient: false,
        severity: "high",
      };
    }

    // Invalid params, method not found, etc.
    if (
      error.code === JSON_RPC_ERROR_CODES.INVALID_PARAMS ||
      error.code === JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND ||
      error.code === JSON_RPC_ERROR_CODES.INVALID_REQUEST
    ) {
      return {
        behavior: ErrorBehavior.DO_NOT_RETRY,
        reason: "invalid_request",
        isTransient: false,
        severity: "critical",
      };
    }

    // Parse errors
    if (error.code === JSON_RPC_ERROR_CODES.PARSE_ERROR) {
      // Could be a transient issue with malformed response
      if (attemptCount === 1) {
        return {
          behavior: ErrorBehavior.RETRY_SAME_RPC,
          reason: "parse_error",
          retryDelay: 100,
          isTransient: true,
          severity: "medium",
        };
      }
      return {
        behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
        reason: "persistent_parse_error",
        isTransient: true,
        severity: "high",
      };
    }

    // Unauthorized / forbidden
    if (
      error.code === JSON_RPC_ERROR_CODES.UNAUTHORIZED ||
      error.code === JSON_RPC_ERROR_CODES.ACTION_NOT_PERMITTED ||
      error.httpStatus === 401 || error.httpStatus === 403
    ) {
      // Could be API key issue, try different RPC
      return {
        behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
        reason: "authorization_error",
        retryDelay: 0,
        isTransient: true,
        severity: "medium",
      };
    }

    // Default: assume it's retryable with different RPC
    return {
      behavior: ErrorBehavior.RETRY_DIFFERENT_RPC,
      reason: "unknown_error",
      retryDelay: 100,
      isTransient: true,
      severity: "low",
    };
  }

  /**
   * Check if an error should trigger immediate failover
   */
  shouldFailoverImmediately(classification: ErrorClassification): boolean {
    return classification.behavior === ErrorBehavior.RETRY_DIFFERENT_RPC &&
      classification.severity !== "low";
  }

  /**
   * Check if an error indicates the RPC is unhealthy
   */
  isRpcUnhealthy(classification: ErrorClassification): boolean {
    return classification.severity === "high" ||
      classification.severity === "critical" ||
      classification.reason === "server_error";
  }

  /**
   * Get suggested wait time before retry
   */
  getRetryDelay(classification: ErrorClassification, attemptCount: number): number {
    if (classification.retryDelay !== undefined) {
      // Apply exponential backoff to the base delay
      return Math.min(
        classification.retryDelay * Math.pow(1.5, attemptCount - 1),
        30000, // Max 30 seconds
      );
    }

    // Default delays based on behavior
    switch (classification.behavior) {
      case ErrorBehavior.RETRY_SAME_RPC:
        return 100 * attemptCount; // Linear increase
      case ErrorBehavior.RETRY_DIFFERENT_RPC:
        return 0; // Switch immediately
      default:
        return 0; // No retry
    }
  }
}

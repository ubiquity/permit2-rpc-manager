# Complete RPC Failover System Rewrite

## Overview

The RPC failover system has been completely rewritten from scratch to address fundamental architectural flaws in the previous implementation.

## Problems with Previous Approach

1. **String Parsing Hell**: The old system relied on fragile string matching to classify errors
2. **Naive Error Handling**: No structured approach to different error types
3. **Poor State Management**: Mix of in-memory and KV storage without clear strategy
4. **No Intelligent Retry Logic**: All errors treated the same way

## New Architecture

### 1. Structured Error Classification

Instead of parsing error message strings, we now use a proper classification system:

```typescript
enum ErrorBehavior {
  RETRY_WITH_BACKOFF,    // Rate limits, quota errors
  RETRY_DIFFERENT_RPC,   // Server errors, timeouts
  DO_NOT_RETRY,          // Client errors, bad requests
  BLOCKCHAIN_ERROR,      // Execution reverts, insufficient funds
}
```

### 2. Standards-Based Error Detection

The system now properly uses:
- **JSON-RPC error codes** as defined in the specification
- **HTTP status codes** for network-level issues
- **Provider-specific codes** (e.g., -32004 for quota exceeded)

```typescript
// JSON-RPC error codes
const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  IMPLEMENTATION_DEFINED_START: -32000,
  EXECUTION_REVERTED: 3,
  QUOTA_EXCEEDED: -32004,
  REQUEST_LIMIT: -32005,
};
```

### 3. Intelligent Health Tracking

Each RPC maintains a health state with:
- Consecutive failure count
- Failure reasons with counts
- Exponential backoff timing
- Last success/failure timestamps

```typescript
interface RpcHealthState {
  consecutiveFailures: number;
  lastFailureTime: number;
  lastSuccessTime: number;
  temporaryUnavailableUntil?: number;
  failureReasons: Map<string, number>;
}
```

### 4. Exponential Backoff

Rate-limited RPCs use exponential backoff instead of fixed cooldowns:
- Base: 1 second
- Max: 60 seconds
- Formula: `min(base * 2^(failures-1), max)`

This ensures RPCs recover quickly from transient issues but stay unavailable longer for persistent problems.

### 5. Error Classification Logic

The classification is deterministic and based on concrete signals:

```typescript
// HTTP 429 → Rate limit (backoff)
// HTTP 403 + code -32004 → Quota exceeded (backoff)
// HTTP 403 + other → Forbidden (don't retry)
// HTTP 5xx → Server error (try different RPC)
// HTTP 408 → Timeout (try different RPC)
// HTTP 4xx → Client error (don't retry)
// Code 3 → Execution reverted (blockchain error)
```

## Key Improvements

1. **No String Parsing**: Zero reliance on error message content
2. **Predictable Behavior**: Clear rules for each error type
3. **Self-Healing**: Automatic recovery with exponential backoff
4. **Better Diagnostics**: Track failure reasons and patterns
5. **Proper Batch Support**: Foundation for true batch request handling

## Configuration

```typescript
export interface Permit2RpcManagerOptions {
  // Health management
  maxConsecutiveFailures?: number;  // Default: 3
  backoffBaseMs?: number;           // Default: 1000ms
  maxBackoffMs?: number;            // Default: 60000ms
}
```

## Example Behavior

1. **Rate Limit (429 or -32004)**:
   - First failure: 1s backoff
   - Second failure: 2s backoff
   - Third failure: 4s backoff
   - Continues exponentially up to 60s

2. **Server Error (5xx)**:
   - Immediately tries next RPC
   - After 3 consecutive failures: marked unhealthy

3. **Client Error (4xx, except 403/408/429)**:
   - Returns error immediately
   - No retry attempted

4. **Blockchain Error (reverts)**:
   - Returns error immediately
   - Would be same on all RPCs

## Future Enhancements

1. **True Batch Support**: Send multiple requests in single HTTP call
2. **Circuit Breaker Pattern**: Fail fast when RPC is known bad
3. **Adaptive Timeouts**: Adjust timeout based on method complexity
4. **Health Checks**: Periodic background health verification
5. **Metrics Collection**: Track success rates, latencies, error distributions

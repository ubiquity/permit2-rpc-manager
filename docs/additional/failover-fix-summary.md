# Failover Fix Summary - June 27, 2025

## Problem
The RPC failover mechanism was intermittently failing with "no matched providers found" errors. Investigation revealed that the retry logic wasn't working due to missing `httpStatus` in error objects.

## Root Causes

### 1. Missing httpStatus Preservation
The `executeRpcCall` method wasn't preserving HTTP status codes in several error paths:
- JSON parsing errors on successful HTTP responses
- Timeout errors
- HTTP 5xx errors with JSON-RPC responses

This caused errors like:
```javascript
{
  code: 19,
  data: undefined,
  httpStatus: undefined,  // <-- Missing!
  name: "JsonRpcError"
}
```

### 2. Brittle String-Based Retry Logic
The retry logic was parsing error message strings to determine if an error was retryable. This was:
- Fragile and prone to false negatives
- Difficult to maintain
- Missing critical errors like "Unable to perform request"

### 3. Poor Error Visibility
When all RPCs failed, the error message didn't show which RPCs were attempted, making debugging difficult.

## Solutions Implemented

### 1. Fixed httpStatus Preservation
- **Always** preserve HTTP status in JsonRpcError, regardless of response type
- Set appropriate HTTP status for all error types:
  - Timeout errors: 408 (Request Timeout)
  - JSON parsing errors: 200 (if HTTP was successful)
  - All HTTP errors: Original status code

### 2. Simplified Retry Logic
Replaced string parsing with structured logic:
```typescript
// New approach: Use HTTP status when available
if (error instanceof JsonRpcError && "httpStatus" in error && typeof error.httpStatus === "number") {
  const status = error.httpStatus;
  isRetryable = 
    status === 408 || // Request Timeout
    status === 429 || // Too Many Requests
    status >= 500 && status <= 599; // Server errors
} else {
  // Network errors without HTTP status
  isRetryable = 
    error.name === "AbortError" ||
    error.name === "TypeError" ||
    (error instanceof Error && (
      error.message.includes("Failed to fetch") ||
      error.message.includes("Network") ||
      error.message.includes("Unable to")
    ));
}
```

### 3. Enhanced Error Messages
- Track all attempted RPCs during failover
- Include attempted RPCs in final error message
- Add diagnostic information to error data

Example enhanced error:
```
All 5 RPC endpoints failed. Attempted: [https://eth.llamarpc.com, https://1rpc.io/eth, ...]. Last error: Unable to perform request
```

## Additional Tools Created

### KV Cache Inspector Script
Created `scripts/inspect-kv-cache.ts` to diagnose cache state:
- Shows eliminated RPCs and their retry timers
- Displays failure counts and health status
- Lists top healthy RPCs by latency

## Benefits

1. **Proper Failover**: Errors with HTTP 5xx status now correctly trigger retry
2. **Reduced Brittleness**: No more string parsing for common error patterns
3. **Better Debugging**: Clear visibility into which RPCs were attempted
4. **JSON-RPC Compliance**: Maintains proper HTTP status handling

## Recommendations

1. **Monitor Logs**: Watch for `[POOL_MGMT]` entries showing RPC eliminations
2. **Regular Cache Inspection**: Use the KV inspector script to check RPC health
3. **Consider Tuning**: Adjust `eliminationThreshold` if RPCs are eliminated too aggressively

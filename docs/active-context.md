# Active Context

## Recent Work: Critical RPC Failover Fix - June 27, 2025

### Problem
The RPC failover mechanism was intermittently failing with "no matched providers found" errors, particularly affecting chain 100 (Gnosis). Client applications were receiving these errors even though multiple healthy RPCs were available in the pool.

### Root Cause
Investigation revealed that the retry logic wasn't working because `httpStatus` was undefined in error objects, preventing proper identification of retryable errors:

```javascript
{
  code: 19,
  data: undefined,
  httpStatus: undefined,  // <-- This was the problem!
  name: "JsonRpcError"
}
```

### Solution Implemented

#### 1. Fixed httpStatus Preservation
Modified `executeRpcCall` to **always** preserve HTTP status codes:
- Timeout errors now set `httpStatus: 408`
- JSON parsing errors on successful HTTP set `httpStatus: 200`
- All HTTP errors preserve the original status code
- JSON-RPC errors from HTTP 5xx responses now preserve the status

#### 2. Simplified Retry Logic
Replaced brittle string parsing with structured logic:
```typescript
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

#### 3. Enhanced Error Visibility
- Track all attempted RPCs during failover
- Include attempted RPCs in error messages
- Add diagnostic data to error objects

### Tools Created
- `scripts/inspect-kv-cache.ts` - Diagnostic script to inspect KV cache and RPC health status
- `docs/additional/failover-fix-summary.md` - Detailed documentation of the fix

### Next Steps
- Deploy the fix to production
- Monitor logs for improved failover behavior
- Run KV cache inspection to check current RPC health status
- Consider adjusting `eliminationThreshold` if needed

## Previous Work: Adaptive RPC Pool Management

### Implementation
Built on top of the generic error handling, we've added an adaptive pool management system that automatically tracks RPC failures and adjusts the available RPC pool.

### Key Features
1. **Failure Tracking**: Uses Deno KV to track consecutive failures per RPC endpoint
2. **Health States**: RPCs can be healthy or eliminated
3. **Adaptive Behavior**: Eliminate bad RPCs after 3 failures (only if >1 healthy RPC remains)
4. **Auto-Recovery**: Eliminated RPCs retry after 1 hour
5. **Cache Invalidation**: Bad RPCs are marked in cache with metadata

### Implementation Details
- **permit2-rpc-manager.ts**: Added failure tracking methods and configuration options
- **cache-manager.ts**: Added `invalidateRpcInCache` method to mark RPCs with health status
- **rpc-selector.ts**: Updated ranking to filter eliminated RPCs from the pool

### Configuration
```typescript
{
  enableBadNetworkInvalidation: true,  // Enable the feature
  eliminationThreshold: 3,            // Failures before elimination (only if >1 healthy RPC remains)
  eliminationRetryMs: 3600000,        // 1 hour retry for eliminated RPCs
}
```

### Benefits
- Self-healing: Automatically removes bad RPCs
- Resilient: Maintains minimum viable pool
- Transparent: Clear logging with [POOL_MGMT] prefix
- Configurable: All thresholds can be customized

See `docs/additional/adaptive-pool-management.md` for full documentation.

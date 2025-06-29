# Active Context

## Recent Work: Complete RPC Failover System Rewrite - June 30, 2025

### Problem
The `chore/blind-optimizations` branch introduced problematic changes that fundamentally broke the RPC failover system:
1. **String parsing for error detection** - Fragile and unreliable
2. **Poor failover logic** - Kept selecting bad providers
3. **No batch request handling** - Failed to properly handle batch RPC requests
4. **Rate limit errors** - System couldn't gracefully handle rate limits from providers like Tenderly

### Root Cause Analysis
The entire approach was architecturally flawed:
- Parsing error message strings to detect error types is inherently fragile
- No structured approach to different error behaviors
- Mixed state management without clear strategy
- All errors treated the same way regardless of type

### Solution: Complete Rewrite

#### 1. Structured Error Classification
Replaced string parsing with proper error classification based on behavior:
```typescript
enum ErrorBehavior {
  RETRY_WITH_BACKOFF,    // Rate limits, quota errors
  RETRY_DIFFERENT_RPC,   // Server errors, timeouts
  DO_NOT_RETRY,          // Client errors, bad requests
  BLOCKCHAIN_ERROR,      // Execution reverts
}
```

#### 2. Standards-Based Detection
Now uses concrete signals instead of string parsing:
- JSON-RPC error codes (e.g., -32004 for quota exceeded)
- HTTP status codes (e.g., 429 for rate limit, 403 for forbidden)
- Provider-specific error codes

#### 3. Intelligent Health Tracking
Each RPC maintains comprehensive health state:
```typescript
interface RpcHealthState {
  consecutiveFailures: number;
  lastFailureTime: number;
  lastSuccessTime: number;
  temporaryUnavailableUntil?: number;
  failureReasons: Map<string, number>;
}
```

#### 4. Exponential Backoff
Replaced fixed cooldowns with exponential backoff:
- Base: 1 second
- Max: 60 seconds
- Formula: `min(base * 2^(failures-1), max)`

### Key Improvements
1. **Zero String Parsing** - All classification based on structured data
2. **Predictable Behavior** - Clear rules for each error type
3. **Self-Healing** - Automatic recovery with exponential backoff
4. **Better Diagnostics** - Track failure reasons and patterns
5. **Foundation for Batch Support** - Architecture ready for true batch handling

### Benefits
- **Reliable Rate Limit Handling**: Tenderly quota errors now properly trigger backoff
- **Intelligent Failover**: System correctly identifies retryable vs non-retryable errors
- **Graceful Degradation**: RPCs recover automatically after transient issues
- **Clear Visibility**: Structured logging shows exactly why failures occur

### Files Changed
- `packages/permit2-rpc-server/src/permit2-rpc-manager.ts` - Complete rewrite
- `docs/additional/robust-failover-rewrite.md` - Architecture documentation
- `scripts/test-rate-limit-handling.ts` - Updated test script

### Next Steps
- Deploy the rewritten system
- Monitor for improved reliability
- Implement true batch request support
- Add circuit breaker pattern for faster failure detection

## Previous Work: Critical RPC Failover Fix - June 27, 2025

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
- `docs/additional/robust-failover-fix.md` - Documentation of the rate limit handling improvements

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
  rateLimitCooldownMs: 300000,        // 5 minute cooldown for rate-limited RPCs (NEW)
}
```

### Benefits
- Self-healing: Automatically removes bad RPCs
- Resilient: Maintains minimum viable pool
- Transparent: Clear logging with [POOL_MGMT] and [COOLDOWN] prefixes
- Configurable: All thresholds can be customized

See `docs/additional/adaptive-pool-management.md` and `docs/additional/robust-failover-fix.md` for full documentation.

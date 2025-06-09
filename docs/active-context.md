# Active Context

## Recent Work: Generic Error Handling for RPC Manager

### Problem
- HTTP 400 errors were being reported but investigation showed no current RPCs returning 400
- The server was transforming upstream RPC errors, converting HTTP 400 to HTTP 500
- Error handling was trying to interpret and categorize errors instead of passing them through

### Solution Implemented
Created a generic, transparent error handling mechanism:

1. **permit2-rpc-manager.ts**:
   - Added `httpStatus` field to JsonRpcError to preserve HTTP status codes
   - Changed retry logic to ONLY retry network/connectivity errors
   - Removed all HTTP status code interpretation (400, 403, 429, 500, etc.)
   - Pass through all HTTP errors exactly as received from upstream RPCs

2. **deno-server.ts**:
   - Pass through HTTP status codes from JsonRpcError when available
   - Removed VM error interpretation logic
   - Consistent error handling for both single and batch requests
   - Server returns whatever status code the RPC manager provides

### Key Design Principle
The RPC manager now acts as a true transparent load balancer:
- It only adds value through failover and load distribution
- It doesn't interpret or transform upstream errors
- All RPC responses (success or error) pass through unchanged

### Next Steps
- Monitor logs to see which RPC returns errors with improved logging
- Deep dive on KV self-healing mechanism (see `docs/additional/kv-self-healing-investigation.md`)
- Consider adding RPC health monitoring to detect problematic endpoints

### Testing Tools Created
- `scripts/test-network-100-endpoints.ts` - Direct RPC endpoint testing
- `scripts/test-server-endpoint.ts` - Server endpoint testing
- `scripts/clear-kv-cache.ts` - KV cache clearing utility

## Current Focus: Adaptive RPC Pool Management

### Latest Implementation
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

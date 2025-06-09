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

## Current Focus
The generic error handling is complete. The system now transparently passes through all upstream RPC errors without interpretation, making it easier to diagnose issues and maintain the service as a true load balancer.

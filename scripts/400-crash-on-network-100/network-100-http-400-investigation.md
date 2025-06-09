# Network 100 HTTP 400 Error Investigation

## Summary

An HTTP 400 error was reported for network 100 (Gnosis) with the following error:
```
gcp-us-west2
Error processing single request (id: 44, method: eth_call) for chain 100: Error: HTTP error 400 Bad Request
```

## Investigation Results

### 1. Direct RPC Testing
Tested all 12 network 100 RPC endpoints with the exact payload that caused the error:
- **11/12 endpoints succeeded** (HTTP 200)
- **0 endpoints returned HTTP 400**
- **1 endpoint failed** with HTTP 500 (gnosis.drpc.org)

### 2. Server Testing
- Production server (https://rpc.ubq.fi/100) successfully processed the same request
- No HTTP 400 errors reproduced

## Root Cause Analysis

The HTTP 400 error was NOT from any current network 100 RPC endpoint. Possible causes:

1. **Cached Bad RPC**: An RPC that was previously in the whitelist but has been removed
2. **Temporary Issue**: The RPC had a temporary problem that has since been resolved
3. **Stale Cache**: The server may have cached a bad RPC selection from before

## Actions Taken

1. **Enhanced Error Handling** (permit2-rpc-manager.ts):
   - Added HTTP 400 to retryable errors list
   - Improved error logging to include the failing RPC URL
   - Added more detailed error information in logs

2. **Created Test Scripts**:
   - `test-network-100-endpoints.ts`: Tests all network 100 RPCs directly
   - `test-server-endpoint.ts`: Tests the permit2-rpc-manager server
   - `clear-kv-cache.ts`: Utility to clear Deno KV cache

## Recommendations

1. **Monitor Logs**: With improved logging, future HTTP 400 errors will show which RPC is failing
2. **Clear Cache if Needed**: Run `deno run scripts/clear-kv-cache.ts` if the issue persists
3. **Regular RPC Health Checks**: Consider implementing periodic health checks for all RPCs
4. **Remove Problematic RPCs**: If an RPC consistently returns errors, remove it from the whitelist

## Test Results

Full test results saved to: `network-100-test-results.json`

### Working RPCs (sorted by latency):
1. gnosis-rpc.publicnode.com - 422ms
2. endpoints.omniatech.io - 490ms
3. rpc.ap-southeast-1.gateway.fm - 532ms
4. gnosis.api.onfinality.io - 606ms
5. gnosis.oat.farm - 607ms
6. 1rpc.io/gnosis - 610ms
7. gnosis-pokt.nodies.app - 684ms
8. gnosis-mainnet.public.blastapi.io - 858ms
9. 0xrpc.io/gno - 1012ms
10. rpc.gnosischain.com - 1097ms
11. rpc.gnosis.gateway.fm - 1243ms

### Failed RPC:
- gnosis.drpc.org - HTTP 500 (not 400)

# Adaptive RPC Pool Management

## Overview

The permit2-rpc-server now includes an adaptive pool management system that automatically tracks RPC failures and adjusts the available RPC pool based on performance. This feature helps maintain service reliability by:

1. Tracking consecutive failures per RPC endpoint
2. Temporarily removing consistently failing RPCs from the pool
3. Adapting behavior based on pool size to maintain minimum viable options
4. Automatically retrying eliminated RPCs after a cooldown period

## How It Works

### Failure Tracking

- Each RPC failure is tracked using Deno KV with the key pattern: `["rpc_failures", chainId, rpcUrl]`
- Consecutive failures increment a counter
- Successful calls reset the failure counter
- Failure data includes timestamp and health status

### Health States

RPCs can be in one of two health states:

1. **Healthy** (default) - RPC is functioning normally
2. **Eliminated** - RPC has too many failures and is removed from rotation

### Adaptive Behavior

The system ensures at least one RPC remains available:

```typescript
if (healthyRpcs > 1 && failures >= eliminationThreshold) {
  // More than one healthy RPC - can afford to eliminate bad ones
  → ELIMINATE
}
// Otherwise, keep the RPC active even with failures
// to maintain service availability
```

### Configuration Options

```typescript
export interface Permit2RpcManagerOptions {
  // Existing options...

  // Adaptive pool management options
  enableBadNetworkInvalidation?: boolean; // default: true
  eliminationThreshold?: number;          // default: 3 failures
  eliminationRetryMs?: number;            // default: 1 hour
}
```

### RPC Selection Priority

The RPC selector now considers health status when ranking RPCs:

1. **Healthy** RPCs with status "ok"
2. **Healthy** RPCs with status "wrong_bytecode"
3. **Healthy** RPCs with status "syncing"
4. **Eliminated** RPCs are excluded (unless retry time reached)

Within each status category, RPCs are sorted by latency.

## Implementation Details

### Cache Invalidation

When an RPC is eliminated:

1. The cache entry is updated with invalidation metadata:
   ```typescript
   {
     ...originalResult,
     _invalidated: true,
     _healthStatus: "eliminated",
     _invalidatedAt: timestamp,
     _nextRetryAt: timestamp + retryInterval
   }
   ```

2. If the invalidated RPC was the "fastest" for that chain, it's cleared to force recalculation

3. The RPC selector filters out eliminated RPCs from the pool

### Error Classification

The system classifies errors to better understand failure patterns:

- `RATE_LIMIT` - Rate limiting errors (429, "too many requests")
- `TIMEOUT` - Request timeouts
- `NETWORK` - Connection failures
- `SERVER_ERROR` - 5xx errors
- `BAD_REQUEST` - 400 errors
- `FORBIDDEN` - 403 errors
- `PARSE_ERROR` - JSON parsing failures
- `GENERAL_ERROR` - Other errors

### Logging

The system provides detailed logging for pool management decisions:

```
[POOL_MGMT] Eliminating RPC https://bad-rpc.example (chain 100) - 3 consecutive failures. 4 healthy RPCs remain.
```

## Benefits

1. **Self-Healing** - Automatically removes bad RPCs without manual intervention
2. **Adaptive** - Behavior changes based on available alternatives
3. **Resilient** - Maintains minimum viable pool even with failures
4. **Transparent** - Clear logging of all pool management decisions
5. **Configurable** - All thresholds and timeouts can be customized

## Example Scenario

1. Chain 100 has 5 RPCs configured
2. One RPC starts returning HTTP 400 errors
3. After 3 consecutive failures, it's eliminated (4 healthy remain)
4. Three more RPCs start having issues and are eliminated
5. The last RPC continues to fail but is never eliminated
6. System maintains service using the single remaining RPC
7. Eliminated RPCs are retried after 1 hour
8. If they recover, failure tracking is cleared and they rejoin the pool

## Panic Mode and Emergency Pool Refresh

When all RPCs in the pool are eliminated or marked unhealthy, the system triggers an **Emergency Pool Refresh**. If no healthy RPCs are found, the manager enters **panic mode**:
- All requests are rejected with a clear error.
- The system periodically re-tests all endpoints at a configurable interval (`panicModeRetryMs`).
- Panic mode exits automatically when a healthy RPC is detected.

### Configuring Panic Mode Timeout

- The interval between panic mode re-tests is set via the `panicModeRetryMs` option.
- Shorter intervals enable faster recovery but may increase load; longer intervals reduce resource usage but may delay recovery.

## Monitoring

To monitor the adaptive pool management:

1. Check logs for `[POOL_MGMT]` entries
2. Monitor the failure tracking in Deno KV:
   ```typescript
   const kv = await Deno.openKv();
   const failures = kv.list({ prefix: ["rpc_failures"] });
   ```
3. Observe RPC selection patterns in debug logs

## Future Enhancements

Potential improvements to consider:

1. Exponential backoff for retry intervals
2. Different thresholds per error type
3. Health status persistence across server restarts
4. Metrics export for monitoring systems
5. Automatic health checks for eliminated RPCs

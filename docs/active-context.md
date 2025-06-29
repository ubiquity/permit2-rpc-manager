# Active Context

## Current Focus: Batch Reliability Improvements - June 30, 2025

### Recent Production Issues
User reported batch reliability problems:
1. "i think your batch idea isnt very reliable can you review?"
2. "i had a dropped request at 10s in my client"
3. Large batch requests (98, 336 calls) failing with 403 errors
4. "Invalid JSON response from provider" errors when RPCs return HTML error pages

### Root Causes Identified
1. **Fixed Timeout Values**: 10s base timeout insufficient for large batches
2. **Poor Error Handling**: No graceful handling of non-JSON error responses (HTML)
3. **No Batch Retry Logic**: Failed batches not automatically split and retried
4. **Static Configuration**: Same batch limits for all RPCs despite varying capabilities

### Implemented Solutions (June 30, 2025)

1. **Dynamic Timeout Calculation**
   - Base timeout + 200ms per request
   - Capped at 60 seconds maximum
   - Scales appropriately with batch size

2. **Robust Error Parsing**
   - Gracefully handles non-JSON responses
   - Extracts error details from HTML pages
   - Maps HTTP status codes to appropriate JSON-RPC errors
   - Special handling for 403 (rate limit), 413 (payload too large), 429 (too many requests)

3. **Automatic Batch Splitting**
   - Detects batch size issues (403/413 errors)
   - Automatically splits failed batches in half
   - Retries smaller batches in parallel
   - Recursive splitting if needed

4. **Pre-flight Validation**
   - Validates batch configuration before processing
   - Handles oversized single requests appropriately
   - Better error messages for configuration issues

### Testing
Run `scripts/test-batch-reliability.ts` to verify:
- ✅ Small batches (10 requests) work correctly
- ✅ Medium batches (50 requests) handle properly
- ✅ Large batches (100+ requests) split automatically
- ✅ Timeout behavior scales with batch size
- ✅ Error messages include helpful debugging info

### Key Files Modified
1. `packages/permit2-rpc-server/src/permit2-rpc-manager.ts`
   - Added `calculateBatchTimeout()` for dynamic timeouts
   - Enhanced `executeBatchCall()` with non-JSON error handling
   - Updated `executeBatchWithFailover()` with automatic splitting

2. `packages/permit2-rpc-server/src/batch-utilities.ts`
   - Added `validateBatchConfig()` for pre-flight checks
   - Enhanced `splitIntoBatches()` to handle oversized requests

3. Created `scripts/test-batch-reliability.ts`
   - Comprehensive test suite for batch reliability
   - Tests various batch sizes and error conditions

4. Created `docs/additional/batch-reliability-issues.md`
   - Detailed analysis of production issues
   - Implementation priority guide

### Next Steps
1. Deploy updated main branch to production
2. Monitor batch request success rates
3. Consider implementing per-RPC adaptive limits (lower priority)
4. Add metrics collection for batch performance

### Previous Context (Failover System)
The failover system improvements are already in main branch:
- ✅ Structured error classification
- ✅ Intelligent health tracking with backoff
- ✅ Proper rate limit handling
- ✅ No permanent blacklisting

### Configuration Options
Key parameters for tuning:
- `requestTimeoutMs`: Base timeout (default 10000ms)
- `DEFAULT_TIMEOUT_PER_REQUEST_MS`: Additional timeout per request (200ms)
- `MAX_BATCH_TIMEOUT_MS`: Maximum timeout cap (60000ms)
- `batchConfig.maxRequests`: Max requests per batch (default 50)
- `batchConfig.maxPayloadBytes`: Max payload size (default 1MB)

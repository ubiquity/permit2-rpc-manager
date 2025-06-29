# Active Context

## Current Focus: RPC Failover System Analysis - June 30, 2025

### Problem Statement
The `chore/blind-optimizations` branch introduced breaking changes that caused:
1. Rate limit errors not being handled gracefully (especially Tenderly)
2. Failover system selecting bad providers repeatedly
3. Batch RPC requests failing with incorrect retry counts
4. Overall system reliability dropping to ~95% from expected 100%

### Solution
The main branch already contains the complete fix for all these issues. No revert needed - just deploy main branch.

### Key Improvements in Main Branch

1. **Structured Error Classification**
   - Errors classified by behavior, not string parsing
   - Different handling for rate limits, server errors, client errors, and blockchain errors
   - Robust against provider message variations

2. **Intelligent Health Tracking**
   - Temporary backoff with exponential increase
   - RPCs can recover after cooldown period
   - No permanent blacklisting

3. **Full Batch Support**
   - Intelligent batch splitting based on RPC capabilities
   - Load distribution across multiple RPCs
   - Proper batch-level failover

4. **Specific Rate Limit Handling**
   - HTTP 429 triggers backoff
   - Tenderly's 403 with code -32004 properly handled
   - Prevents cascade failures

### Testing
Run `scripts/test-failover-system.ts` to verify:
- ✅ Failover from rate-limited to healthy RPCs
- ✅ Batch requests with proper failover
- ✅ Recovery after backoff periods
- ✅ Load distribution

### Next Steps
1. Deploy main branch to production
2. Monitor error rates - should see immediate improvement
3. Consider adjusting backoff parameters if needed:
   - `backoffBaseMs`: Starting backoff (default 1000ms)
   - `maxBackoffMs`: Maximum backoff (default 60000ms)
   - `maxConsecutiveFailures`: Failures before marking unhealthy (default 3)

### Recent Work
- Created comprehensive error classification system
- Implemented intelligent batch handling with `batch-utilities.ts`
- Added health tracking with temporary backoff
- Fixed Tenderly-specific error handling
- Created test suite to verify failover behavior

# Robust Error Handling Implementation

## Overview
The RPC manager now implements comprehensive retry logic to handle transient errors gracefully by failing over to other RPCs in the pool.

## Retryable Errors

### Network/Connectivity Errors
- Connection refused, reset, timeouts
- DNS failures
- Network unreachable
- Socket errors

### HTTP Status Codes (Transient)
- **400 Bad Request** - Can be transient (as experienced in production)
- **403 Forbidden** - Often disguised rate limiting
- **429 Too Many Requests** - Explicit rate limiting
- **500 Internal Server Error** - Temporary server issues
- **502 Bad Gateway** - Proxy/gateway issues
- **503 Service Unavailable** - Temporary unavailability
- **504 Gateway Timeout** - Gateway timeout
- **520-524** - Cloudflare errors

### Rate Limiting Patterns
The system detects various rate limiting messages:
- "rate limit", "rate-limit", "ratelimit"
- "too many requests", "too many calls"
- "throttle", "exceeded", "quota"
- "capacity", "limit reached"
- "max requests", "slow down"

### Other Transient Errors
- JSON parsing errors (malformed responses from overloaded servers)
- TypeErrors (unexpected response formats)
- Generic timeout patterns
- Temporary/busy/unavailable messages

## Non-Retryable Errors (Fail Fast)

### Blockchain-Specific Errors
- Execution reverted
- Transaction failed
- Insufficient funds
- Gas errors
- Nonce issues
- Invalid opcodes

### Authentication Errors
- 401 Unauthorized
- Invalid credentials

## Error Classification
Errors are now classified for better logging:
- `RATE_LIMIT` - Rate limiting errors
- `TIMEOUT` - Timeout errors
- `NETWORK` - Network connectivity issues
- `SERVER_ERROR` - 5xx errors
- `BAD_REQUEST` - 400 errors
- `FORBIDDEN` - 403 errors
- `PARSE_ERROR` - JSON/Type errors
- `GENERAL_ERROR` - Other errors

## Benefits
1. **Resilience**: System continues working even when individual RPCs have issues
2. **Transparency**: HTTP status codes pass through unchanged
3. **Debugging**: Clear logs show which RPC failed and why
4. **Performance**: Round-robin distribution prevents overloading single RPCs
5. **Failover**: Automatic failover to healthy RPCs

## Example Log Output
```
[RATE_LIMIT] RPC failed: https://example-rpc.com (chain 100, method: eth_call)
  Error details: HTTP error 429 Too Many Requests
  Attempting failover to next RPC (1/5)...

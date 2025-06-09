# KV Self-Healing Investigation

## TODO: Deep Dive on KV Self-Healing Mechanism

The user mentioned that the KV cache is designed to be self-healing. We should investigate:

1. **Current Implementation**
   - How does the cache detect bad entries?
   - What triggers cache invalidation?
   - How does it recover from stale/bad data?

2. **Potential Issues**
   - Could a cached bad RPC selection persist?
   - What's the TTL on cache entries?
   - How does it handle RPCs that were removed from the whitelist?

3. **Improvements to Consider**
   - Should we validate cached RPCs against the current whitelist?
   - Should we add health checks before using cached selections?
   - Should we add cache versioning tied to whitelist updates?

## Related Files
- `packages/permit2-rpc-server/src/cache-manager.ts`
- `packages/permit2-rpc-server/src/rpc-selector.ts`

# Permit2 RPC Upstream Failover E2E - Handoff

Date: 2025-12-23  
Owner repo: `/Users/nv/repos/ubiquity/permit2-rpc-manager`  
Test harness repo: `/Users/nv/repos/ubiquity/deno-deploy-workflow/lib/pay.ubq.fi`

## Goal

Prove that the local proxy supports per-request upstream selection and failover, using real Permit2 claim transactions against each whitelisted upstream RPC on Gnosis (chain 100). Capture logs that show:

- Forced upstream selection per request via headers.
- Successful failover to a different upstream when the chosen provider fails.
- End-to-end broadcast (tx hash + receipt or timeout) recorded in Supabase.

## Why This Matters

Production UI failures were intermittent and upstream-specific. The proxy previously returned `-32603 Internal JSON-RPC error` without failover. When the selector rotates to a healthier provider, the UI “self-fixes”. This E2E test validates:

1) The proxy can be instructed to use specific upstream(s).  
2) Failover works when that upstream fails.  
3) The full Permit2 claim flow works end-to-end through the proxy.  

## Important Context

### Recent server changes (branch `feat/select-upstream-rpc`)

Files touched in `/Users/nv/repos/ubiquity/permit2-rpc-manager`:
- `packages/permit2-rpc-server/src/core/permit2-rpc-manager.ts`
- `packages/permit2-rpc-server/src/deno-server.ts`
- `packages/permit2-rpc-server/src/evm/multicall3.ts`
- `packages/permit2-rpc-server/deno.jsonc`
- New: `packages/permit2-rpc-server/src/cli/permit-claim-e2e.ts`
- New: `packages/permit2-rpc-server/src/evm/multicall3_test.ts`

Key behavior:
- Override headers:
  - `x-ubq-rpc-candidates` (comma-separated list)
  - `x-ubq-rpc-url` (single URL)
  - `x-ubq-rpc-fallback` (true/false)
- Proxy logs overrides and includes them in request dedupe.
- Multicall excludes Permit2 selectors (sender-sensitive) and rejects `eth_call` with extra params.

### E2E harness in pay.ubq.fi

Script:  
`/Users/nv/repos/ubiquity/deno-deploy-workflow/lib/pay.ubq.fi/scripts/permit2-test-upstream-rpcs.ts`

Features:
- `--start-proxy` starts the local proxy.
- `--proxy-root` points to `permit2-rpc-manager`.
- `--proxy-port` and `--proxy-log-level` control the proxy.
- When proxy is enabled, claims go through `http://127.0.0.1:<port>/<chainId>` with:
  - `x-ubq-rpc-candidates: <upstream>`
  - `x-ubq-rpc-fallback: true` (unless disabled)
- Uses existing unclaimed permits if `--use-existing`.
- Records tx hash to Supabase after broadcast by default.

## Environment Requirements

The E2E script depends on:

### Required in env file
Use this env file (already configured by user):
`/Users/nv/repos/ubiquity/permit2-rpc-manager/packages/permit2-rpc-server/.env`

Expected keys:
- `SUPABASE_URL` (must be a full https URL)
- `SUPABASE_ANON_KEY` or `SUPABASE_SERVICE_ROLE_KEY`
- `BENEFICIARY_PRIVATE_KEY` (for claim signer)

### RPC base URL
The permit tools use `RPC_URL` or `VITE_RPC_URL` to query Permit2 nonce bitmaps.
Set it if needed, otherwise default is `https://rpc.ubq.fi`.

## Known Blocker Encountered

DNS resolution is broken on this machine:
- `scutil --dns` -> “No DNS configuration available”
- `curl -I https://rpc.ubq.fi` -> DNS failure
- Supabase host can’t resolve, so no permits are fetched

You must fix DNS before running the test.

## How to Run the E2E Test (Proxy + Failover)

Once DNS is fixed, run:

```bash
cd /Users/nv/repos/ubiquity/deno-deploy-workflow/lib/pay.ubq.fi

deno run -A --env-file=/Users/nv/repos/ubiquity/permit2-rpc-manager/packages/permit2-rpc-server/.env \
  scripts/permit2-test-upstream-rpcs.ts \
  --whitelist /Users/nv/repos/ubiquity/permit2-rpc-manager/packages/permit2-rpc-server/rpc-whitelist.json \
  --chain-id 100 \
  --beneficiary 0x4007CE2083c7F3E18097aeB3A39bb8eC149a341d \
  --use-existing \
  --count 1 \
  --execute \
  --pretty \
  --out /tmp/permit2-provider-e2e.json \
  --start-proxy \
  --proxy-root /Users/nv/repos/ubiquity/permit2-rpc-manager \
  --proxy-port 8010 \
  --proxy-log-level debug \
  --proxy-timeout-ms 30000 | tee /tmp/permit2-provider-e2e-run.log
```

Artifacts:
- `/tmp/permit2-provider-e2e.json` (summary)
- `/tmp/permit2-provider-e2e-run.log` (stdout + proxy logs)
- Temp per-provider logs are in the output dir printed by the script (seed/claim logs).

## Expected Logs / Proof of Failover

Look for proxy logs like:
- “Received RPC override headers for chain 100: <url> (allowFallback=true)”
- “Using override RPCs for chain 100. Overrides=1, allowFallback=true, fallbackCount=…”
- Error for first RPC, then subsequent attempt with fallback RPC

In summary output:
- For each provider, `result.claim.ok=true`
- For failed providers, warnings like `receiptTimeouts=1`

## If Failover Is Not Observed

Possible causes:
1) Error classification treats upstream error as `DO_NOT_RETRY` (e.g., -32603).
2) Proxy considered override as the only candidate due to `--proxy-no-fallback` or header missing.
3) Circuit breaker or backoff on all available RPCs.

What to try:
- Ensure `x-ubq-rpc-fallback: true` is passed (default behavior).
- Add more verbose logging: `--proxy-log-level debug`
- Target known failing providers (e.g., drpc, omnia, onfinality).

## Useful Commands

Check whitelist:
```bash
cat /Users/nv/repos/ubiquity/permit2-rpc-manager/packages/permit2-rpc-server/rpc-whitelist.json | jq '.rpcs["100"] | length'
```

Check proxy health:
```bash
curl http://127.0.0.1:8010/health
```

## Root Cause Recap (Working Theory)

- Some upstreams fail Permit2 calls with `-32603` or 5xx/429.
- Proxy doesn’t fail over on `-32603`, so a bad upstream causes user-visible failure.
- When the selector rotates to a healthy upstream, the UI “fixes itself.”
- Multicall aggregation of Permit2 calls can also corrupt `msg.sender`, causing provider-dependent reverts.

## Next Steps

1) Fix DNS and rerun the E2E test above.
2) Capture logs showing override + fallback behavior.
3) If fallback doesn’t occur, adjust error classification for `-32603` to retry on different RPC for read methods.
4) Summarize the results in the draft PR (issue #19).


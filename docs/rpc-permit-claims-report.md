# Permit2 Claim Failures - RPC Provider Investigation Report

Date: 2025-12-23
Repo: /Users/nv/repos/ubiquity/permit2-rpc-manager

## Executive Summary

Permit2 claims on pay.ubq.fi intermittently failed with "Internal JSON-RPC error" and no on-chain transaction. Investigation shows the failures are upstream-dependent: some RPC providers successfully handle the Permit2 read/write flow, while others respond with -32603 or timing out. The proxy currently treats -32603 as a non-retryable error, which prevents failover. Additionally, Permit2 calls are sender-sensitive and can be corrupted if they are aggregated through Multicall3 or if the request is altered; some upstreams are more strict about this than others. Production "self-recovery" is consistent with the selector rotating to a healthier upstream.

This report documents the observed failures, E2E results across upstreams, and the most likely failure modes that explain why some upstreams work and some do not.

## Symptoms Observed

- UI error: ContractFunctionExecutionError for `permitTransferFrom` / `batchPermitTransferFrom`, revert reason "Internal JSON-RPC error".
- Chain: 100 (Gnosis).
- No transaction hash appears on-chain when the error occurs.
- Errors include MetaMask `Method not supported` for `eth_signTransaction` (not supported by some providers) and `Internal JSON-RPC error` for send/estimate.

Representative call details:

- Permit2 contract: `0xd635918A75356D133d5840eE5c9ED070302C9C60`
- Function: `permitTransferFrom` / `batchPermitTransferFrom`
- Sender: beneficiary address (0x4007CE2083c7F3E18097aeB3A39bb8eC149a341d)

## Evidence and Investigation

### E2E Provider Tests (pay.ubq.fi toolchain)

Tooling used: `scripts/permit2-test-upstream-rpcs.ts` with `--execute` and existing test permits.
Goal: broadcast one permit claim per upstream provider, on chain 100.

Summary of upstream results (from latest run):

- Success:
  - https://rpc.gnosischain.com
  - https://gnosis-public.nodies.app
  - https://rpc.gnosis.gateway.fm
  - https://rpc.ap-southeast-1.gateway.fm
  - https://gnosis-rpc.publicnode.com
  - https://1rpc.io/gnosis
  - https://0xrpc.io/gno
  - https://gnosis.oat.farm
- Failures:
  - OnFinality: HTTP 429
  - drpc: HTTP 500
  - Omnia: HTTP 502
  - Tatum: receipt timeout
  - Pocket: receipt timeout

These results show the Permit2 claim path itself is valid and succeeds on multiple upstreams, but fails on specific providers.

### Request Shape Sensitivity

Permit2 `permitTransferFrom` and `batchPermitTransferFrom` are sender-sensitive. Any proxy optimization that changes `msg.sender` or the call envelope can make the same data revert. Examples:

- Aggregating via Multicall3 changes `msg.sender` to the multicall contract.
- Including `from`, `value`, or state overrides in `eth_call` changes behavior across providers.

Some upstreams tolerate these differences while others return `-32603 Internal JSON-RPC error`.

### Proxy Error Classification and Failover

The proxy classifies JSON-RPC errors; in particular, -32603 is treated as `DO_NOT_RETRY`, which prevents failover. If a selected upstream returns -32603 during `eth_call` or `eth_estimateGas`, the proxy stops and returns the error to the client even if other upstreams could handle the request.

This matches observed behavior: production began working again without deploy when the selector later rotated to a healthier upstream.

## Root Cause Analysis

Most probable root cause:

- Upstream-specific failures (HTTP 429/500/502 or -32603) combined with no failover for -32603 cause user-visible claim failures.

Likely contributing factor:

- Sender-sensitive Permit2 calls were eligible for multicall aggregation. If aggregated, the call semantics change and can revert or return provider-specific internal errors.

Why production "self-fixed" without deploy:

- Upstream scoring/health changed, and the selector moved to a working provider. This masks the underlying issue but does not resolve it.

## Changes Implemented in permit2-rpc-manager (branch feat/select-upstream-rpc)

These changes are intended to make the issue debuggable and to avoid multicall corruption for sender-sensitive calls:

- Add per-request upstream selection overrides via headers:
  - `x-ubq-rpc-candidates`, `x-ubq-rpc-url`, `x-ubq-rpc-fallback`
- Include overrides in dedupe key and logs; allow fallback to normal selection if requested.
- Pass override selection through multicall path.
- Tighten multicall eligibility:
  - Reject calls with extra fields (from/value/state overrides).
  - Exclude Permit2 selectors (permitTransferFrom/batchPermitTransferFrom + witness variants).
- Add log level override via `RPC_LOG_LEVEL` / `LOG_LEVEL`.

## Recommendations

1. Update error classification for -32603:

   - Treat -32603 as `RETRY_DIFFERENT_RPC` for `eth_call` and `eth_estimateGas`, or
   - Use conditional retry for Permit2 selectors only, to avoid retrying real client errors.

2. Improve request safety:

   - Keep the multicall exclusions for Permit2 selectors.
   - Only aggregate `eth_call` requests with strict `to` + `data` keys.

3. Add E2E coverage:

   - Run one real claim per upstream provider using the local proxy and override headers.
   - Record tx hash in the database immediately after broadcast to prevent reuse.

4. Observability:
   - Log the selected upstream per request, and surface it in error responses for debugging.

## Open Questions

- Which upstream RPC was selected during the failing production window?
- Are any upstreams intentionally blocking Permit2 calls or limiting gas estimation?
- Should the proxy penalize -32603 in scoring to reduce selection probability?

## Appendix: Example UI Error (Excerpt)

ContractFunctionExecutionError:

- function: `permitTransferFrom` / `batchPermitTransferFrom`
- reason: "Internal JSON-RPC error"
- chain: 100
- sender: 0x4007CE2083c7F3E18097aeB3A39bb8eC149a341d

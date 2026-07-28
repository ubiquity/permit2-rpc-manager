# RPC Routing & Reliability v2 (eRPC-inspired)

> **Status: historical design baseline.** This document describes the broad
> reliability design implemented in commit `4887736`. It is not the current
> implementation roadmap. See
> [`erpc-upstream-delta-a698f1d4-to-8459b053.md`](./erpc-upstream-delta-a698f1d4-to-8459b053.md)
> for the 202-commit upstream audit and current product-fit conclusion: retain the
> Permit2-specific Multicall3 optimization, implement only the small targeted
> hardening fixes with direct operational value, and defer broader routing,
> JSON-RPC, KV, hedging, head, and consensus redesigns until justified by production
> evidence.

## Summary

This document specifies a set of **advanced performance/reliability strategies** to implement in the Permit2 RPC proxy, inspired by patterns observed in `erpc/erpc` (as a reference implementation) but designed for our existing Deno/TypeScript codebase.

Key themes:

- **Correctness first**: validate upstream chain identity so we never serve wrong-chain results.
- **Capability-aware routing**: treat method support as provider-specific; dynamically exclude RPCs that don’t support a method.
- **Tail-latency reduction**: use hedged requests for safe/read methods.
- **Smarter routing**: score RPCs using quantiles, error/throttle rates, and chain-head/finality lag; smooth scores to prevent flapping.
- **Explicit failsafe policies**: circuit-break only on “provider is bad” classes; optional lightweight consensus for integrity.

This spec is intentionally detailed and includes code landmarks (file paths + identifiers) to anchor implementation work.

## Non-goals

- Do **not** integrate the eRPC “public endpoints feed” into our whitelist pipeline (already evaluated as low value).
- Do **not** add any runtime dependency on eRPC’s Go code (we only reference it for ideas).
- Do **not** change the external API surface of the proxy (request/response shape, routes) beyond additive observability.

## Current Architecture (Landmarks)

### Request routing

- Orchestrator: `packages/permit2-rpc-server/src/core/permit2-rpc-manager.ts`
  - `Permit2RpcManager.send()`
  - `Permit2RpcManager._sendInternal()`
  - `Permit2RpcManager.executeRpcCall()`
  - `Permit2RpcManager.classifyError()`
  - Health tracking: `getHealthState()`, `recordFailure()`, `recordSuccess()`
- RPC selection: `packages/permit2-rpc-server/src/core/rpc-selector.ts`
  - `RpcSelector.getRankedRpcList()`
- Endpoint verification: `packages/permit2-rpc-server/src/infra/latency-tester.ts`
  - `LatencyTester.testRpcUrls()`
  - `LatencyTester.testSingleRpc()`
  - Validates `eth_getCode(PERMIT2_ADDRESS)` + `eth_syncing` only
- Cache: `packages/permit2-rpc-server/src/infra/cache-manager.ts`
  - `CacheManager.updateChainCache()`
  - `CacheManager.invalidateRpcInCache()` (used for WS failover in `deno-server.ts`)
- Existing reliability helpers: `packages/permit2-rpc-server/src/core/reliability-improvements.ts`
  - `RequestDeduplicator`, `AdaptiveTimeout`, `SmartBatcher`, `RpcScorer`, `CircuitBreaker`

### Server entrypoints

- HTTP + health endpoint: `packages/permit2-rpc-server/src/deno-server.ts`
  - `/health` uses `Permit2RpcManager.getHealthStatus()`
  - WS proxy uses `RpcSelector` + `CacheManager.invalidateRpcInCache()` for elimination

## Reference Patterns from eRPC (for inspiration only)

eRPC landmarks (submodule at `lib/erpc`):

- Chain identity validation at bootstrap: `lib/erpc/upstream/upstream.go`
  - `(*Upstream).detectFeatures()` validates `eth_chainId`
- Dynamic method ignore on `METHOD_NOT_FOUND`: `lib/erpc/upstream/upstream.go`
  - `(*Upstream).IgnoreMethod(method string)`
- Quantile + confidence-weighted + EMA scoring: `lib/erpc/upstream/registry.go`
  - `(*UpstreamsRegistry).RefreshUpstreamNetworkMethodScores()`
- Failsafe policies (retry/circuit-break/hedge/consensus): `lib/erpc/upstream/failsafe.go`
  - `createRetryPolicy`, `createCircuitBreakerPolicy`, `createHedgePolicy`, `createConsensusPolicy`

We will translate these concepts into idiomatic TypeScript modules that plug into `Permit2RpcManager`.

---

## Desired Behavior (High-level)

Given `chainId`, `method`, `params`:

1. **Candidate list**: start from `RpcSelector.getRankedRpcList(chainId)` (latency-tested, cached).
2. **Hard correctness filters**:
   - Remove endpoints that fail chain identity validation (`eth_chainId` mismatch).
3. **Capability filter**:
   - Remove endpoints that are known to not support `method` (e.g. `-32601 METHOD_NOT_FOUND` observed recently).
4. **Scoring + ordering**:
   - Rank candidates for this `(chainId, method)` using quantile latency + error/throttle rates + head lag (and optional misbehavior).
   - Apply smoothing to prevent rapid reordering (flapping).
5. **Execution policy**:
   - For **write** methods: single upstream at a time; no hedging; minimal retries.
   - For **read** methods: optional hedging (send to 2nd/3rd upstream after a delay) to cut p99 latency.
6. **Feedback loops**:
   - Update per-RPC metrics after each attempt (latency, errors, throttle, head lag samples).
   - Update capability map on `METHOD_NOT_FOUND`.
   - Open circuit breaker only for provider-fault classes (5xx/auth/billing/syncing-empty), not for caller errors.

---

## Work Items (Detailed Spec)

### 1) Chain Identity Validation (eth_chainId)

#### Problem

Our current verification (`LatencyTester.testSingleRpc`) checks Permit2 bytecode via `eth_getCode(PERMIT2_ADDRESS)` and `eth_syncing`. Permit2 is deployed at the same address across many EVM chains, so **bytecode match does not imply correct chain**.

#### Requirements

- When the proxy is serving `/{chainId}`, we must only use upstreams that return the same `eth_chainId`.
- Mismatched chain ID must cause the endpoint to be excluded from `RpcSelector` rankings and be visible in `/health` output.

#### Implementation Plan

1. **Extend the latency test contract**
   - Update `packages/permit2-rpc-server/src/infra/latency-tester.ts`:
     - Change `testRpcUrls(urls: string[])` → `testRpcUrls(chainId: number, urls: string[])`.
     - Change `testSingleRpc(url: string)` → `testSingleRpc(chainId: number, url: string)`.
     - Add an additional concurrent call to `eth_chainId` alongside existing calls.
2. **Add a new status**
   - Extend `LatencyTestStatus` to include `wrong_chain_id` (or similar).
   - If `eth_chainId` response parses to a number that doesn’t match `chainId`, return `{ status: "wrong_chain_id", latency, error }`.
3. **Filter in selector**
   - Update `packages/permit2-rpc-server/src/core/rpc-selector.ts`:
     - Remove `wrong_chain_id` from acceptable statuses (do not include it in `ACCEPTABLE_STATUSES`).
4. **Cache shape**
   - No schema changes needed (cache stores the `LatencyTestResult` object), but the union type expands.
5. **Tests**
   - Add/extend Deno tests to mock fetch behavior:
     - `eth_chainId` mismatch returns `wrong_chain_id`.
     - `RpcSelector.getRankedRpcList()` never returns those endpoints.

#### Optional Hardening

- Validate `net_version` matches `chainId` as a secondary cross-check (helps with providers returning malformed chainId).
- Record the observed `chainId` as metadata in the `LatencyTestResult` for debugging.

---

### 2) Method Capability Tracking (Dynamic “Ignore Unsupported Methods”)

#### Problem

Different RPC vendors vary in method support (e.g., tracing, debug methods, finality tags). Today, `Permit2RpcManager.classifyError()` groups **all** “standard JSON-RPC errors” (`-32768..-32000`) into `DO_NOT_RETRY`, which means `-32601 METHOD_NOT_FOUND` hard-fails even if other RPCs support the method.

#### Requirements

- Treat `-32601 METHOD_NOT_FOUND` as a _provider capability issue_, not a client error.
- Dynamically learn and cache “RPC X does not support method Y” and avoid using it for that method for a TTL.
- Ensure this behavior is per `chainId` + `rpcUrl` + `method`.

#### New Module

Add `packages/permit2-rpc-server/src/core/rpc-capabilities.ts`:

- `export type CapabilityStatus = "supported" | "unsupported" | "unknown";`
- `export class RpcMethodCapabilities { ... }`
  - Storage key: `(chainId, rpcUrl, method)`
  - Methods:
    - `get(chainId, rpcUrl, method): CapabilityStatus`
    - `markUnsupported(chainId, rpcUrl, method, reason, ttlMs): void`
    - `markSupported(chainId, rpcUrl, method): void` (optional)
    - `filterSupported(chainId, method, rpcUrls): string[]`

Persistence options:

- **Phase 1 (in-memory)**: store in memory with timestamps (good enough per isolate).
- **Phase 2 (KV-backed)**: store in Deno KV with TTL for cross-restart stability. Reuse the pattern from `Permit2RpcManager.recordFailure()` which already persists.

#### Integration Points (Landmarks)

1. Update `packages/permit2-rpc-server/src/core/permit2-rpc-manager.ts`:
   - In `classifyError()`:
     - Special-case `JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND` (`-32601`) → return `{ behavior: RETRY_DIFFERENT_RPC, reason: "method_not_found", isProviderIssue: true }`.
   - In `_sendInternal()` error handling `catch`:
     - When `lastError instanceof JsonRpcError && lastError.code === METHOD_NOT_FOUND`, call `capabilities.markUnsupported(chainId, rpcUrl, method, ..., ttlMs)`.
   - Before the try-loop over `rankedRpcs`:
     - Filter `rankedRpcs = capabilities.filterSupported(chainId, method, rankedRpcs)`.
2. Avoid false positives:
   - Only mark unsupported after `N` occurrences within a window, or mark immediately but with short TTL (e.g. 10 minutes), escalating TTL if repeated.

#### Tests

- A unit test that simulates:
  - First provider returns `-32601`.
  - Second provider succeeds.
  - Result returned successfully.
  - Capability map excludes first provider for future calls of that method.

---

### 3) Method Classification (Read vs Write)

#### Problem

Hedging and aggressive retries are safe for reads but dangerous for writes (double-submission).

#### Requirements

- Provide a single authoritative `isWriteMethod(method: string): boolean` implementation.
- Default to conservative behavior (unknown methods treated as “do not hedge”).

#### New Module

Add `packages/permit2-rpc-server/src/core/method-classifier.ts`:

- `export function isWriteMethod(method: string): boolean`
  - Include known write methods:
    - `eth_sendRawTransaction`, `eth_sendTransaction`, `eth_signTransaction`
    - `eth_sign`, `eth_signTypedData`, `eth_signTypedData_v4`, `personal_sign`
    - Add chain-specific “write” methods if we support them later.
- (Optional) `export function isSafeToCache(method: string): boolean`
  - Probably only trivial calls like `eth_chainId`, `net_version` (and only with very short TTL).

#### Integration

`Permit2RpcManager._sendInternal()` uses `isWriteMethod(method)` to decide whether hedging is allowed.

---

### 4) Metrics Registry (Per Method/Upstream Measurements)

#### Problem

Our current scoring is global-per-URL (`RpcScorer` in `reliability-improvements.ts`) and based on average latency and decayed success rate. It does not capture:

- Per-method differences (some RPCs are fast for `eth_call` but slow for `eth_getLogs`).
- Tail latency (p95/p99), which dominates UX.
- Throttle/429 frequency separately from generic errors.
- Chain-head lag (staleness) even when `eth_syncing` is false.

#### Requirements

- Track per `(chainId, rpcUrl, method)` metrics:
  - `requestsTotal`, `successes`, `errors`, `throttles`
  - latency samples (bounded ring buffer)
  - head lag samples (bounded; optional)
  - misbehavior counts (optional, for consensus)
- Provide fast access to:
  - latency quantiles (e.g., p70 used for scoring and hedge delay)
  - error rate, throttle rate

#### New Module

Add `packages/permit2-rpc-server/src/core/rpc-metrics.ts`:

- `export type RpcMetricKey = { chainId: number; rpcUrl: string; method: string };`
- `export class RpcMetricsRegistry { ... }`
  - `recordSuccess(key, latencyMs): void`
  - `recordFailure(key, classification): void`
  - `recordThrottle(key): void` (or inferred from classification)
  - `recordHeadSample(chainId, rpcUrl, blockNumber): void`
  - `getMethodStats(chainId, method, rpcUrls): Map<rpcUrl, MethodStats>`
    - `MethodStats` includes quantiles, errorRate, throttleRate, requestCount, headLag, etc.
  - Keep history bounded (e.g., `maxSamples = 200` per key).

Implementation detail for quantiles:

- Use a small ring buffer + sort copy on demand (O(n log n), n ≤ 200).
- Quantile function: `qIndex = ceil(q*n) - 1` clamped.

---

### 5) Advanced Scoring v2 (Quantiles + Confidence + EMA)

#### Problem

We want ranking that is stable and sensitive to real upstream health differences without overreacting to low-sample noise.

#### Requirements

- Use latency **quantiles** (not mean) for scoring.
- Separate error rate from throttle rate.
- Mix each upstream metric with a peer baseline when sample size is low (confidence weighting).
- Smooth score over time (EMA) to prevent flapping.
- Allow future extensions (head lag, finality lag, misbehavior).

#### New Module

Add `packages/permit2-rpc-server/src/core/rpc-scoring-v2.ts`:

- `export interface ScoringConfig { ... }`
  - `latencyQuantile = 0.70` (like eRPC default)
  - `minSamplesForConfidence = 50`
  - `emaPrevWeight = 0.70`
  - weights: `wLatency`, `wError`, `wThrottle`, `wHeadLag`, `wMisbehavior`
  - normalization toggles (log for latency/headLag)
- `export class RpcScorerV2 { ... }`
  - Depends on `RpcMetricsRegistry`
  - `rank(chainId, method, candidates): string[]`
  - Maintains previous scores map for EMA

#### Algorithm (modeled after eRPC’s `RefreshUpstreamNetworkMethodScores`)

For a given `(chainId, method, candidates)`:

1. Gather stats from `RpcMetricsRegistry`:
   - `latencyQ`, `errorRate`, `throttleRate`, `requestsTotal`, `headLag`, `misbehaviorRate`
2. Compute baselines across candidates:
   - `baselineLatency = medianPositive(latencyQ)` fallback to neutral (e.g., 1s)
   - `baselineError = median(errorRate)`
   - `baselineThrottle = median(throttleRate)`
3. Confidence weighting by sample size:
   - `w = clamp01(requestsTotal / minSamplesForConfidence)`
   - `effLatency = w*latency + (1-w)*baselineLatency` (if latency missing, use baseline)
   - `effError = w*error + (1-w)*baselineError`
   - `effThrottle = w*throttle + (1-w)*baselineThrottle`
4. Normalize metrics:
   - latency/headLag: log normalize
   - rates: linear normalize
5. Compute instantaneous score:
   - Example (weights are configurable):
     - `score = 1.0`
     - `score -= wLatency * normLatency`
     - `score -= wError * normError`
     - `score -= wThrottle * normThrottle`
     - `score -= wHeadLag * normHeadLag`
     - `score -= wMisbehavior * normMisbehavior`
6. Apply EMA:
   - `smoothed = emaPrevWeight*prev + (1-emaPrevWeight)*instant`
7. Sort descending by `smoothed`.

#### Integration (Landmarks)

Update `packages/permit2-rpc-server/src/core/permit2-rpc-manager.ts`:

- Replace `this.rpcScorer.getRankedRpcs(availableRpcs)` with `this.rpcScorerV2.rank(chainId, method, availableRpcs)`.
- Continue to use the existing round-robin offset (`rpcIndexMap`) so we don’t pin 100% of traffic to the #1 candidate.

---

### 6) Head Lag / Staleness Sampling (eth_blockNumber)

#### Problem

Nodes can be behind the chain head while still reporting `eth_syncing = false`. This causes stale reads and can break UX (e.g., seeing missing txs).

#### Requirements

- Estimate “head lag” per upstream (difference between its head and the peer median head).
- Penalize lagging nodes in scoring (and optionally hard-exclude above a threshold).
- Do this without a heavy background scheduler (Deno Deploy constraints).

#### Implementation Plan

Add `packages/permit2-rpc-server/src/infra/head-tracker.ts` (or `src/core/head-tracker.ts`):

- `export class HeadTracker { ... }`
  - `maybeSampleHeads(chainId, rpcUrls): Promise<void>`
    - Rate-limited (e.g., no more than once per chain per `sampleIntervalMs`, and no more than once per rpc per interval).
    - For a subset of candidates (e.g., top 5), call `eth_blockNumber`.
    - Compute median head and record `headLag = medianHead - rpcHead` to `RpcMetricsRegistry`.

Integration points:

- In `Permit2RpcManager._sendInternal()` just before ranking:
  - `await headTracker.maybeSampleHeads(chainId, availableRpcsSubset)`
  - Don’t block request path if sampling fails; best-effort.

---

### 7) Hedged Requests (Read Methods Only)

#### Problem

Sequential failover is good for availability but not for tail latency. Many upstreams exhibit high p95/p99 spikes.

#### Requirements

- For **read** methods, optionally hedge:
  - Start primary request.
  - After delay, start secondary if primary not finished.
  - Return the first successful response; cancel others.
- Never hedge writes (see `isWriteMethod`).
- Hedge delay should be adaptive using observed quantiles.

#### New Module

Add `packages/permit2-rpc-server/src/core/hedged-requester.ts`:

- `export interface HedgeConfig { enabled: boolean; maxHedges: number; delayMs: number; quantile?: number; minDelayMs?: number; maxDelayMs?: number }`
- `export class HedgedRequester { ... }`
  - `execute<T>(candidates, requestFn, policy): Promise<T>`
  - Uses AbortControllers per attempt.
  - Delay policy:
    - If quantile provided: `delay = clamp(qLatency(method, chainId) + baseDelay, minDelay, maxDelay)` (matches eRPC’s quantile+clamp pattern).
    - Else use fixed delay.
  - Ensure we don’t hedge `sendBatch` directly (batch is already split into multiple `send()` calls).

Integration (Landmark):

- In `Permit2RpcManager._sendInternal()`:
  - If `!isWriteMethod(method)` and hedging enabled:
    - Use `HedgedRequester.execute()` to attempt the top `k` candidates.
  - Otherwise, use existing sequential loop.

Observability:

- Count hedges triggered and canceled in logs or metrics.

---

### 8) Circuit Breaker v2 (Open Only on “Provider Is Bad” Classes)

#### Problem

Our current circuit breaker (`reliability-improvements.ts` `CircuitBreaker`) opens on a generic failure count. This can incorrectly penalize endpoints for caller errors or chain-level errors.

#### Requirements

- Only open circuit on provider-fault classes:
  - sustained 5xx
  - auth/forbidden/billing/quota misconfig (401/403 patterns)
  - repeated timeouts/network errors
  - (optional) “syncing + empty response” or “stale head beyond threshold”
- Do not open on:
  - invalid request/params
  - execution revert / blockchain errors

#### Implementation Plan

Option A (preferred): introduce a new circuit breaker type to avoid refactoring risk:

- Add `packages/permit2-rpc-server/src/core/circuit-breaker-v2.ts`
  - `recordResult(rpcUrl, classification, success)` uses classification to decide failure severity.
  - `canRequest(rpcUrl)` same as now.

Option B: refactor existing `CircuitBreaker` to accept a predicate for “counts as circuit failure”.

Integration (Landmark):

- In `Permit2RpcManager._sendInternal()`:
  - Replace `this.circuitBreaker.recordResult(rpcUrl, success)` with `this.circuitBreakerV2.recordResult(rpcUrl, classification, success)`.

---

### 9) Optional: Lightweight Consensus / Integrity Checks

#### Problem

Some upstreams return inconsistent data (e.g., bad indexing, stale caches, partial archive support). eRPC offers a consensus policy that punishes misbehaving nodes.

#### Requirements

- Keep default mode fast (no extra calls).
- Provide optional “integrity mode” for a small set of methods where correctness matters.
- Penalize misbehaving endpoints via `RpcMetricsRegistry` (misbehavior rate) and scoring.

#### New Module

Add `packages/permit2-rpc-server/src/core/consensus.ts`:

- `export interface ConsensusConfig { enabled: boolean; methods: string[]; participants: number; agreementThreshold: number; preferNonEmpty?: boolean }`
- `export class ConsensusExecutor { ... }`
  - `execute<T>(candidates, requestFn): Promise<T>`
  - Dispatch to `participants` upstreams concurrently.
  - Compare results with:
    - strict equality for primitives
    - deep stable JSON stringify for objects (careful with ordering; use a stable stringify helper)
  - If disagreement:
    - pick majority if available
    - otherwise prefer “non-empty” if configured
    - record misbehavior for outliers

Integration:

- In `Permit2RpcManager._sendInternal()` before hedging:
  - If `consensus.enabled && consensus.methods.includes(method)`:
    - use consensus executor; return its decision.

---

### 10) Configuration Surface & Rollout Flags

#### Requirements

All advanced behaviors must be **configurable and safe by default**.

#### Proposed Additions

Extend `Permit2RpcManagerOptions` in `packages/permit2-rpc-server/src/core/permit2-rpc-manager.ts`:

- `validateChainId?: boolean` (default `true` once proven)
- `capabilityTtlMs?: number` (default 10m)
- `hedge?: { enabled?: boolean; maxHedges?: number; delayMs?: number; quantile?: number; minDelayMs?: number; maxDelayMs?: number }`
- `scoringV2?: { enabled?: boolean; ...weights and params... }`
- `headSampling?: { enabled?: boolean; sampleIntervalMs?: number; maxRpcsPerSample?: number }`
- `consensus?: { enabled?: boolean; methods?: string[]; participants?: number; agreementThreshold?: number }`

In `packages/permit2-rpc-server/src/deno-server.ts`, map env vars to these options (additive only).

---

### 11) Observability / Health Output

#### Requirements

- `/health` should help diagnose routing decisions.
- Include (at least):
  - whether chainId validation is enabled
  - number of endpoints excluded for wrong chainId
  - top N scored endpoints per chain for a few common methods (optional)
  - hedge counts (optional)

Landmark: `Permit2RpcManager.getHealthStatus()` in `packages/permit2-rpc-server/src/core/permit2-rpc-manager.ts`.

---

## Acceptance Criteria (Global)

- Wrong-chain endpoints are never selected (validated via tests that simulate chainId mismatch).
- `METHOD_NOT_FOUND` errors no longer hard-fail if another upstream supports the method.
- Hedging never triggers for write methods.
- Scoring v2 demonstrates stable ordering (no rapid flapping) and prefers low-latency, low-error, low-throttle endpoints.
- Circuit breaker opens only on provider-fault classes and recovers via half-open probing.

---

## Sprint / Parallelization Plan (Agent-friendly)

Goal: enable multiple agents to work concurrently with minimal file overlap. The general strategy:

- Most work should land as **new modules** (new files), each with its own tests.
- Only one “integration agent” per sprint touches `packages/permit2-rpc-server/src/core/permit2-rpc-manager.ts` to wire modules together.

### Sprint 1 — Correctness & Capability Foundations

**Workstream A (Agent 1): ChainId validation**

- Files:
  - `packages/permit2-rpc-server/src/infra/latency-tester.ts`
  - `packages/permit2-rpc-server/src/core/rpc-selector.ts`
  - `packages/permit2-rpc-server/src/infra/cache-manager.ts` (types only if needed)
  - Tests under `packages/permit2-rpc-server/src/**` or `tests/**` (choose existing conventions)
- Outcome:
  - Adds `wrong_chain_id` status and filtering.

**Workstream B (Agent 2): Method classifier**

- Files:
  - `packages/permit2-rpc-server/src/core/method-classifier.ts` (new)
  - tests for `isWriteMethod`
- Outcome:
  - Shared utility for later sprints; no integration required yet.

**Workstream C (Agent 3): Capability tracker**

- Files:
  - `packages/permit2-rpc-server/src/core/rpc-capabilities.ts` (new)
  - tests for TTL + filtering behavior
- Outcome:
  - Standalone module; integration happens in Workstream D.

**Workstream D (Agent 4 — Integration owner): Wire capability behavior**

- Files:
  - `packages/permit2-rpc-server/src/core/permit2-rpc-manager.ts`
- Outcome:
  - `classifyError()` treats `-32601` as retry-different and updates capability map.
  - `_sendInternal()` filters candidates using capability map.

Dependencies:

- D depends on C (capabilities module).
- B is independent and can merge anytime.

### Sprint 2 — Metrics + Scoring v2

**Workstream E (Agent 1): Metrics registry**

- Files:
  - `packages/permit2-rpc-server/src/core/rpc-metrics.ts` (new)
  - tests for quantiles/rates and bounded memory

**Workstream F (Agent 2): Scoring v2 module**

- Files:
  - `packages/permit2-rpc-server/src/core/rpc-scoring-v2.ts` (new)
  - tests for baseline/confidence/EMA sorting stability
- Dependency:
  - Depends on the interface of E, but can start with a minimal `MethodStats` contract.

**Workstream G (Agent 3): Head lag sampling**

- Files:
  - `packages/permit2-rpc-server/src/core/head-tracker.ts` (new) OR `packages/permit2-rpc-server/src/infra/head-tracker.ts` (new)
  - tests for median head and lag calculation (mock `executeRpcCall` or `fetch`)
- Dependency:
  - Depends lightly on E (to record head samples), but can stub if needed.

**Workstream H (Agent 4 — Integration owner): Wire scoring v2**

- Files:
  - `packages/permit2-rpc-server/src/core/permit2-rpc-manager.ts`
  - Possibly `packages/permit2-rpc-server/src/core/reliability-improvements.ts` (if we deprecate old `RpcScorer`)
- Outcome:
  - Request attempts update `RpcMetricsRegistry`.
  - Candidate ranking uses `RpcScorerV2`.
  - Head tracker is called best-effort before ranking (optional if G is ready).

### Sprint 3 — Failsafe Policies (Hedge + CB v2 + Consensus)

**Workstream I (Agent 1): Hedged requester**

- Files:
  - `packages/permit2-rpc-server/src/core/hedged-requester.ts` (new)
  - tests: no hedging for write methods (using `method-classifier.ts`)

**Workstream J (Agent 2): Circuit breaker v2**

- Files:
  - `packages/permit2-rpc-server/src/core/circuit-breaker-v2.ts` (new) OR refactor `packages/permit2-rpc-server/src/core/reliability-improvements.ts`
  - tests: only provider-fault classifications count toward opening

**Workstream K (Agent 3): Consensus executor**

- Files:
  - `packages/permit2-rpc-server/src/core/consensus.ts` (new)
  - tests for agreement/dispute behaviors + misbehavior accounting

**Workstream L (Agent 4 — Integration owner): Wire failsafe policies**

- Files:
  - `packages/permit2-rpc-server/src/core/permit2-rpc-manager.ts`
  - `packages/permit2-rpc-server/src/core/method-classifier.ts` (only if adjustments needed)
- Outcome:
  - Hedging enabled for reads behind config.
  - Circuit breaker v2 replaces/augments current breaker.
  - Optional consensus mode for configured methods.

### Sprint 4 — WS Path (Optional, separate)

WS uses `RpcSelector` + `WsLatencyTester` and invalidates endpoints on connect failure.

**Workstream M (Agent 1): WS capability & chain checks**

- Files:
  - `packages/permit2-rpc-server/src/infra/ws-latency-tester.ts`
  - Possibly add a WS “chainId verification” ping after connect (send `eth_chainId` over WS).

**Workstream N (Agent 2): WS scoring reuse**

- Files:
  - `packages/permit2-rpc-server/src/deno-server.ts`
  - reuse `RpcScorerV2` to pick WS endpoints (optional).

---

## Notes / Risk Management

- Deno Deploy isolates are ephemeral; in-memory scoring helps per-instance but isn’t globally consistent. Persist only what materially helps correctness (capabilities, health backoff) and keep the rest in memory.
- Hedging increases upstream call volume; default to **off** or very conservative limits unless we accept higher cost.
- Consensus is expensive; keep it off by default and scope it to a small method allowlist.

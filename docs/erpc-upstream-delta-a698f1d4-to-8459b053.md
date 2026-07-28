# eRPC Upstream Delta: `a698f1d4` to `8459b053`

## Document Status

| Field                   | Value                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit date              | 2026-07-27                                                                                                                                                  |
| Repository              | `ubiquity/permit2-rpc-manager`                                                                                                                              |
| Research submodule      | `lib/erpc`                                                                                                                                                  |
| Pinned eRPC commit      | [`a698f1d4350e43c960c6f8a2ed18b85c226b7a8e`](https://github.com/erpc/erpc/commit/a698f1d4350e43c960c6f8a2ed18b85c226b7a8e)                                  |
| Audited upstream commit | [`8459b05354b0834e0e140621e54a9233d2abb790`](https://github.com/erpc/erpc/commit/8459b05354b0834e0e140621e54a9233d2abb790)                                  |
| Exact range             | `a698f1d4350e43c960c6f8a2ed18b85c226b7a8e..8459b05354b0834e0e140621e54a9233d2abb790`                                                                        |
| Range relationship      | Upstream is 202 commits ahead and 0 commits behind                                                                                                          |
| Version span            | `0.0.60-14-ga698f1d4` to `0.1.1-45-g8459b053`                                                                                                               |
| Upstream dates          | 2025-12-17 through 2026-07-23                                                                                                                               |
| GitHub comparison       | [Compare the exact audited range](https://github.com/erpc/erpc/compare/a698f1d4350e43c960c6f8a2ed18b85c226b7a8e...8459b05354b0834e0e140621e54a9233d2abb790) |

## Executive Summary

The eRPC research submodule is pinned at `a698f1d4`, while eRPC's `main` branch is
at `8459b053`. The latter is a direct descendant of the pin: the comparison is an
unambiguous 202-commit forward delta, not a divergent branch comparison.

There are useful ideas in the range, but most do not justify implementation work
for this Permit2-focused product. This repository already incorporated an
eRPC-inspired reliability pass in
`4887736eb740101eee572e07631b53677b4712ad`
(`perf: implement rpc routing reliability v2`). The new upstream work is best
treated as a research catalog and evidence for a few targeted bug fixes, not as an
adoption roadmap.

The highest-value research concepts are:

1. One authoritative candidate-selection pipeline with sticky primary selection
   and bounded recovery probes.
2. Explicit per-method retry, hedge, write, and empty-result policies.
3. Lossless JSON-RPC request ID handling and response-envelope validation.
4. Hedge winner validation and separate accounting for speculative attempts.
5. Safe hash-based idempotency for `eth_sendRawTransaction`.
6. A stateless strict-majority chain head suitable for serverless execution.
7. Schema-versioned, atomic Deno KV state rather than isolate-local whole-cache
   snapshots.
8. Strict consensus composition and quorum behavior if consensus is enabled.

The comparison also exposed concrete local issues, but only a small subset warrants
immediate work:

- Override ordering is calculated but ignored by ordinary sequential execution.
- Endpoints that reach the failure threshold can remain excluded permanently.
- The JSON-RPC implementation-defined error range is checked in the wrong
  direction, making configured quota errors non-retryable.
- Raw upstream URLs can escape through diagnostics.
- JSON-RPC ID `0` is dropped from batches.

The Permit2-specific Multicall3 path should remain. It groups reads by block tag,
deduplicates repeated calls, reduces upstream rate-limit pressure, and already
excludes the four sender-sensitive Permit2 transfer selectors. Its generic EVM
semantic caveat is relevant only if the route is treated as an unrestricted proxy
for arbitrary contracts.

The recommended implementation is therefore a small hardening patch: fix quota
classification, endpoint recovery, diagnostic URL redaction, override precedence
if override headers remain supported, and batch ID `0`. Defer the larger routing,
JSON-RPC, KV, hedging, head, and consensus redesigns until production evidence or
a new product requirement justifies them.

## Product-Fit Conclusion

Implementing the original P0 package as a single architectural rewrite is not
worth the cost or regression risk for the current product.

### Worth implementing now

1. Correct retry classification for the known quota codes `-32004` and `-32005`.
2. Let an endpoint re-enter service through one bounded probe after its backoff
   expires.
3. Replace credential-bearing RPC URLs in health, logs, and errors with stable
   opaque endpoint IDs.
4. Fix override precedence if the override headers remain part of supported
   operations and testing.
5. Preserve batch request ID `0` while touching the handler.

These are isolated correctness or security fixes with direct operational value.

### Keep as implemented

- Keep the Permit2-specific Multicall3 optimization.
- Keep grouping by block tag and chunking calls.
- Keep deduplication of identical reads.
- Keep rejecting call objects with fields other than `to` and `data`.
- Keep excluding the four sender-sensitive Permit2 transfer and witness-transfer
  selectors.
- Keep the existing routing architecture unless observed traffic demonstrates
  selection instability that the small fixes cannot address.

### Defer

- A unified candidate-policy rewrite and sticky-primary policy.
- Full lossless support for exotic JSON-RPC numeric IDs.
- Named-parameter support when controlled clients use positional arrays.
- Raw-transaction idempotency unless this proxy is the transaction broadcaster.
- Cross-isolate KV redesign without evidence of lost updates affecting users.
- Hedging, head sampling, and consensus work while those features remain disabled.
- Response caching.

The research and licensing boundary remains behavior-level analysis followed by
independent Deno/TypeScript implementation when a deferred item is eventually
justified. The eRPC submodule does not need to be updated or shipped.

## Scope and Methodology

### Range verification

The audit used the submodule's Git history rather than commit-count claims from a
web interface:

- `a698f1d4` is the checked-out submodule commit and was committed upstream on
  2025-12-17 as `fix: correct selection policy config validation (#643)`.
- `8459b053` exactly matched `origin/main` during the audit and was committed on
  2026-07-23 as
  `feat(consensus): winner-composition quota via requiredParticipants[].minAgreement (#1008)`.
- `a698f1d4` is an ancestor of `8459b053`.
- `git rev-list --count a698f1d4..8459b053` returned `202`.
- The range touches 553 paths. That number is inflated by documentation,
  dependency, provider-catalog, generated, and repository-reorganization changes;
  it is not a count of transferable product features.

A mechanical subject-prefix triage of the 202 commits found 62 `feat` commits,
102 `fix` commits, 27 `chore` commits, and 11 other commits. Subject prefixes are
only an orientation aid; each recommended item below was checked at the commit and
affected-file level.

### Inclusion rules

This report includes a change only when:

1. The commit is reachable from audited upstream `main` at `8459b053`.
2. The behavior is relevant to an EVM JSON-RPC proxy.
3. The behavior can be translated to the existing Deno/TypeScript architecture
   without importing eRPC's runtime.
4. The behavior improves correctness, reliability, latency, or observability in
   a way that fits a stateless serverless deployment.
5. There is a concrete local integration point or a clearly identified future
   product use.

### Exclusion rules

The audit excludes:

- Dependency upgrades, release bookkeeping, CI-only changes, documentation churn,
  and provider catalog additions unless they carry a directly reusable behavior.
- Go-specific lifecycle, goroutine, `http.Transport`, Prometheus, gRPC, BDS, and
  provider-integration mechanics.
- Work present only on remote branches and not merged into `main`.
- Broad response-cache machinery because this project currently caches endpoint
  test state, not arbitrary JSON-RPC responses.
- Literal source, test, configuration, or comment copying.

## Relationship to the Existing Reliability Specification

[`docs/rpc-routing-reliability-v2.md`](./rpc-routing-reliability-v2.md) is the prior
design baseline. It describes chain identity validation, method capabilities,
per-method metrics, scoring v2, head sampling, hedging, circuit breaking, and
optional consensus. Much of that design was implemented in commit `4887736`.

This report does not replace that specification. It records what changed in eRPC
after our research pin, tests those ideas against the current implementation, and
identifies corrections to the implemented semantics. In several cases eRPC later
removed or superseded designs that resemble our current code, which is particularly
useful evidence for choosing the next implementation.

## Current Permit2 RPC Baseline

The relevant local components are:

- `packages/permit2-rpc-server/src/core/permit2-rpc-manager.ts`
  - Candidate filtering, scoring, retries, health state, hedging, consensus, and
    upstream execution.
- `packages/permit2-rpc-server/src/core/rpc-selector.ts`
  - Cached endpoint testing and ranked endpoint lists.
- `packages/permit2-rpc-server/src/core/rpc-scoring-v2.ts`
  - Per-chain/per-method score calculation.
- `packages/permit2-rpc-server/src/core/hedged-requester.ts`
  - Concurrent speculative attempts and winner selection.
- `packages/permit2-rpc-server/src/core/head-tracker.ts`
  - Chain-head samples and lag calculation.
- `packages/permit2-rpc-server/src/core/consensus.ts`
  - Response bucketing and quorum tracking.
- `packages/permit2-rpc-server/src/infra/cache-manager.ts`
  - Endpoint test-result persistence and isolate-local cache snapshot.
- `packages/permit2-rpc-server/src/deno-server.ts`
  - HTTP JSON-RPC parsing, batch handling, Multicall aggregation, and `/health`.

At audit time:

- `deno task build` succeeded.
- All 36 server tests passed.
- Production health reported scoring v2 enabled.
- Production health reported hedging, head sampling, and consensus disabled.

The passing suite does not cover the confirmed override, round-robin, health
recovery, KV hydration, JSON-RPC handler, hedge, or head-sampling failures described
below.

## Detailed Transferable Findings

### Research candidate: Unified selection policy and bounded recovery probes

#### eRPC evidence

- [`70a1f178`](https://github.com/erpc/erpc/commit/70a1f1785ab8a4e6d63afd9f0be5bfd63b2ef4eb),
  [PR #888](https://github.com/erpc/erpc/pull/888):
  `feat: unified selection policy and scoring mechanism`.
- [`50959ff8`](https://github.com/erpc/erpc/commit/50959ff8f2936767e048b3fdc23c7a51a0a3f952),
  [PR #931](https://github.com/erpc/erpc/pull/931):
  `feat(selection-policy): probe-eligibility verdicts decided at the exclusion site`.

PR #888 replaced separate and partially conflicting selection mechanisms with one
policy pipeline. At the audited head, the default policy:

- Applies minimum sample gates before excluding an endpoint for errors or
  throttling.
- Treats latency as exclusion-worthy only when it is both absolutely slow and
  materially slower than peers.
- Excludes endpoints that lag the relevant chain head.
- Fails open when every endpoint would otherwise be excluded.
- Prefers non-fallback tiers.
- Orders survivors using p70 latency.
- Keeps the current primary sticky, using a 30% improvement threshold and a
  30-second minimum switch interval to prevent flapping.
- Schedules bounded probes for endpoints excluded by recoverable health state.

PR #931 refined that behavior so the exclusion decision also determines whether
probing is useful. Health-driven exclusions remain probeable, while explicit
configuration exclusions, tags, and cordons do not consume probe traffic.

#### Local gap

`Permit2RpcManager._sendInternal()` currently has multiple overlapping sources of
selection truth:

1. `RpcSelector` returns a ranked list.
2. Capability, circuit, head, and health filters modify it.
3. `RpcScorerV2` sorts it.
4. A chain-wide round-robin index rotates the sorted list.
5. Override logic constructs a separate `orderedRpcs` list.
6. Sequential, hedge, and consensus paths consume different lists.

Two runtime reproductions confirmed concrete consequences:

- The override-aware `orderedRpcs` list is built, but the default sequential path
  loops over `rankedRpcs`; a lower-ranked fallback was called instead of the
  requested override.
- Given ranked endpoints `[best, worst]`, a round-robin index of `1` selected
  `worst`. Scores therefore influence failover order but do not reliably control
  primary traffic share.

Recovery is also broken. After the configured failure threshold,
`recordFailure()` creates a timed exclusion. When that time expires,
`isRpcAvailable()` clears the timestamp but still requires the failure count to be
below the threshold. The endpoint remains unavailable indefinitely whenever
another endpoint keeps the pool healthy.

#### Product-fit disposition

Do not replace the current routing architecture solely to match eRPC. Lift only the
bounded recovery-probe behavior now, plus a direct override-precedence fix if the
override headers remain supported. Reconsider the broader candidate-plan and
sticky-primary design only if production evidence shows persistent selection
flapping, excessive traffic on slow providers, or conflicting behavior between
execution modes.

#### Clean-room adaptation if later justified

Implement one TypeScript candidate plan that is authoritative for sequential,
hedge, consensus, and override execution:

1. Apply hard chain, capability, configuration, and write-safety constraints.
2. Apply health exclusions with explicit probe eligibility.
3. Score and sort candidates per chain and method.
4. Select a sticky primary.
5. Attach a bounded attempt plan describing primary, retry, hedge, probe, or
   consensus purpose.
6. Make every execution mode consume that plan without re-sorting or rotating it.

Use the upstream 30%/30-second stickiness values as internal defaults, not new
environment variables. After a health backoff expires, allow one recovery probe
per endpoint and backoff window. A probe success resets the failure state; a probe
failure starts the next backoff. Static exclusions never probe.

#### Required tests

- Override remains first even when scoring ranks a fallback above it.
- Disabling override fallback prevents any fallback attempt.
- Round-robin state cannot replace the highest-ranked healthy primary.
- A less than 30% improvement does not switch the primary.
- A sufficiently better candidate switches only after the minimum hold interval.
- An endpoint becomes probe-eligible after backoff and rejoins after success.
- Concurrent requests cannot stampede the same half-open endpoint.
- An all-excluded pool follows an explicit, observable fail-open policy.

### Targeted lift: Error classification; defer the general method-policy table

#### eRPC evidence

- [`a9ba3f68`](https://github.com/erpc/erpc/commit/a9ba3f68ab42de28fa35710a46d21a61956d34bb),
  [PR #843](https://github.com/erpc/erpc/pull/843):
  `fix(failsafe): honor WithRetryableTowardNetwork(false) at network scope`.
- [`10ed9d35`](https://github.com/erpc/erpc/commit/10ed9d35bc41eb3ffe00977a6d58c0fc77b01262),
  [PR #967](https://github.com/erpc/erpc/pull/967):
  `fix(errors): correct severity + retry classification for client/transient errors`.

These changes make “do not retry” authoritative across wrapper layers and separate
malformed or client-caused errors from transient upstream failures. This is less
about copying an error table and more about maintaining a single retry decision
after normalization.

#### Local gap

`Permit2RpcManager.classifyError()` checks an implementation-defined JSON-RPC range
using `code >= -32000`. Configured quota codes `-32004` and `-32005` cannot enter
that branch, so a status-200 quota error becomes `DO_NOT_RETRY`. A reproduction
confirmed that `-32005` stopped before a healthy second endpoint.

At the same time, the common `-32000` code can represent an execution revert,
nonce-too-low, already-known transaction, or a provider fault. Treating all of
those as provider failures causes inappropriate health penalties and can rebroadcast
writes.

`isWriteMethod()` only disables hedge and consensus. The sequential loop can still
retry writes across every candidate with no authoritative method-specific attempt
budget.

#### Product-fit disposition

Fix the confirmed quota-code range bug now. Do not build the complete method-policy
framework until the proxy supports a broader uncontrolled method surface or a
write-safety incident demonstrates the need.

#### Clean-room adaptation if later justified

Create an internal method-policy table covering:

- Whether the method is allowed.
- Read, raw-transaction write, stateful write, filter/session, or unknown class.
- Retry behavior for transport, throttle, provider, client, and blockchain errors.
- Hedge and consensus eligibility.
- Acceptable empty-result shapes.
- Upstream stickiness requirements.
- Overall deadline and maximum attempts.

Known idempotent reads may fail over. `eth_sendRawTransaction` receives its own
hash-verification policy. Other writes, filter methods, signing methods, and unknown
methods use one sticky endpoint and do not fan out by default.

#### Required tests

- `-32004` and `-32005` retry a different endpoint without penalizing the caller.
- Invalid params and deterministic execution errors do not retry.
- Method-not-found retries only when another endpoint may support the method.
- Unknown methods do not create unbounded metric keys or inherit read-method
  hedging.
- Filter IDs remain tied to the endpoint that created them.
- Generic writes never fan out.

### Low priority: Full JSON-RPC fidelity

#### eRPC evidence

- [`d5f85371`](https://github.com/erpc/erpc/commit/d5f85371200de3963f3c92f4edf7a2796e4d3241),
  [PR #830](https://github.com/erpc/erpc/pull/830):
  `fix: return HTTP 200 for JSON-RPC request-too-large errors`.
- [`a75325d5`](https://github.com/erpc/erpc/commit/a75325d59f726265cdbf8da60fd81449910b992a),
  [PR #846](https://github.com/erpc/erpc/pull/846):
  `fix(networks): rewrite response ID for all JSON-RPC architectures`.
- [`5d700536`](https://github.com/erpc/erpc/commit/5d700536eccbe6d9dd81f8f4b004959d9f9399b7),
  [PR #851](https://github.com/erpc/erpc/pull/851):
  `fix: preserve verbatim request id bytes through response`.

PR #846 makes the proxy authoritative for response IDs rather than trusting an
upstream to return the original client ID. PR #851 preserves the raw JSON bytes for
the ID so parsing, cloning, and internal ID replacement cannot corrupt values such
as `0`, strings, integers above JavaScript's safe integer limit, or fractional
numbers. PR #830 keeps JSON-RPC application failures in a successful HTTP envelope
instead of confusing them with HTTP transport limits.

#### Local gap

`deno-server.ts` uses `request.json()`, which irreversibly rounds numeric IDs above
`2^53`. Batch handling checks ID truthiness, dropping valid `0` and empty-string
IDs. Notifications are not distinguished consistently from requests with a
present `null` ID. Named parameter objects pass validation but are later replaced
with `[]`.

`executeRpcCall()` generates an internal timestamp ID but does not verify the
upstream `jsonrpc` field, returned ID, or result/error exclusivity. The error path
can also pass through an upstream HTTP 413 even when the incoming proxy request did
not exceed a transport limit.

#### Product-fit disposition

Fix the batch truthiness check so ID `0` is retained. Defer raw-token parsing,
exotic numeric ID preservation, notifications, named params, and full
response-envelope normalization while controlled Permit2 clients do not require
them.

#### Clean-room adaptation if later justified

- Read the request body as text and retain each request's raw ID token.
- Use an internal upstream ID, validate the response envelope, and restore the
  exact original ID token on all success and error responses.
- Treat absent ID as a notification and emit no response for it.
- Preserve present IDs including `0`, `""`, and `null`.
- Forward positional arrays and named parameter objects unchanged.
- Require `jsonrpc: "2.0"` and exactly one of `result` or `error`.
- Return HTTP 200 for valid JSON-RPC application responses, including provider
  query/range limits. Reserve HTTP 413 for the proxy's own incoming body limit.
- Keep cancellation active through complete response-body parsing.

#### Required tests

Build a bundled conformance matrix covering:

- IDs `0`, `""`, `null`, strings, fractions, `9007199254740993`, and values near
  unsigned 64-bit limits.
- Absent-ID notifications in single and batch requests.
- Mixed batches containing requests and notifications.
- Named parameter objects.
- Wrong upstream IDs and malformed envelopes.
- Upstream application “request too large” errors over HTTP 200.
- Actual proxy body-limit rejection over HTTP 413.
- A provider that sends headers and then stalls the body.

### Keep: Permit2-specific Multicall3 aggregation

#### Product benefit

The current Multicall3 path is valuable for the intended workload:

- Calls are grouped by block tag, providing a consistent snapshot.
- Identical reads are deduplicated.
- Up to 500 reads are collapsed into one upstream call per group.
- Fewer upstream requests reduce latency and rate-limit exposure.
- Call objects with fields other than `to` and `data` are rejected.
- The four sender-sensitive Permit2 transfer and witness-transfer selectors are
  excluded.

#### Known boundary

`deno-server.ts` aggregates eligible simple `eth_call` requests through
Multicall3. If the same public route is used as an unrestricted proxy for arbitrary
contracts, this is not equivalent to generic JSON-RPC:

- Any contract reading `msg.sender` sees Multicall3 rather than the caller implied
  by a direct `eth_call`.
- Revert and return-data behavior is transformed by the aggregation contract.
- Eligibility based only on a small selector exclusion list cannot prove semantic
  equivalence for arbitrary contracts.

This is an intentional product tradeoff for controlled Permit2 traffic, not a
reason to remove the optimization.

#### Recommendation

- Preserve the current Multicall3 path and existing exclusions.
- Keep Permit2 clients on the optimized batch path.
- Document that arbitrary third-party contract calls are outside the semantic
  guarantee of the optimization.
- If the proxy later becomes a general-purpose public JSON-RPC service, revisit
  eligibility using an explicit allowlist or separate endpoint.

#### Required tests

- Eligible Permit2 reads are grouped and deduplicated.
- Calls with `from`, `value`, state overrides, or other extra fields are rejected
  from Multicall eligibility.
- All four sender-sensitive Permit2 selectors bypass Multicall3.
- Block-tag groups never mix.
- Batch IDs, including ID `0`, map back to the correct response.

### Defer until enabled: Hedge winner semantics and score isolation

#### eRPC evidence

- [`5a448317`](https://github.com/erpc/erpc/commit/5a448317dc108c9b7613ea5a1e2f813d570168e7),
  [PR #886](https://github.com/erpc/erpc/pull/886):
  `fix: exclude hedge attempts from per-upstream score counters`.
- [`8dba1590`](https://github.com/erpc/erpc/commit/8dba159050d4559c5e2478a2b30c3a36ac84bd9f),
  [PR #894](https://github.com/erpc/erpc/pull/894):
  `fix: accept empty results for state-reads + trace filters by default`.
- [`2f94c1b7`](https://github.com/erpc/erpc/commit/2f94c1b7e5df80b71de1f2ce21ce9e8f4dc83078),
  [PR #895](https://github.com/erpc/erpc/pull/895):
  `fix(hedge): reject emptyish results as winners for non-accept methods`.

Speculative hedge attempts must not distort the same request and error rates used
to select ordinary traffic. A fulfilled promise is also not automatically a valid
winner: emptiness is method-dependent.

Legitimate empty results include values such as `0x`, `0x0`, and `[]` for relevant
state or range reads. Conversely, `null` for a block, transaction, or receipt
lookup means “not found yet” and should not beat another in-flight attempt that may
return the requested object.

#### Local gap

`HedgedRequester` accepts the first fulfilled attempt. Every attempt records normal
success or failure inside the manager before the hedger chooses the winner.
Timeout and external abort listeners are removed after response headers, so a
losing attempt can continue parsing and later mutate health metrics.

#### Clean-room adaptation

- Keep hedging disabled until the protocol and accounting tests pass.
- Restrict hedging to the method-policy safe-read allowlist.
- Validate each result using method-specific empty semantics before it can win.
- Record speculative latency and outcomes in a separate attempt ledger.
- Update ordinary selection metrics only from the effective primary/winner policy.
- Abort losers through body consumption and prevent late metric mutation.

### Conditional on broadcaster role: Idempotent `eth_sendRawTransaction`

#### eRPC evidence

- [`efa32c93`](https://github.com/erpc/erpc/commit/efa32c93af1cf868046df25a00e46f01b9f08e04),
  [PR #703](https://github.com/erpc/erpc/pull/703):
  `feat: idempotent transaction broadcasting for eth_sendRawTransaction`.
- [`ce6fdfc2`](https://github.com/erpc/erpc/commit/ce6fdfc22a8108b08bd57106e7b1c9e993e4014a),
  [PR #898](https://github.com/erpc/erpc/pull/898):
  `fix(eth_sendRawTransaction): verify on-chain before returning 'all upstreams failed'`.

The transferable pattern is deliberately narrow:

1. Derive the signed transaction hash locally.
2. Treat “already known” as success for that exact transaction.
3. For nonce-too-low, timeout, or exhausted upstreams, query
   `eth_getTransactionByHash` using an independent bounded context.
4. Synthesize success only when the returned transaction hash exactly matches the
   locally derived hash.

This behavior is safe for a raw signed transaction because its hash identifies the
immutable payload. It does not justify generic write retries.

#### Clean-room adaptation

Implement this as the sole multi-upstream write policy. Other writes, including
`eth_sendTransaction`, signing methods, and unknown vendor methods, remain
single-upstream and sticky.

### Defer until enabled: Stateless strict-majority chain head

#### eRPC evidence

- [`7dee07c0`](https://github.com/erpc/erpc/commit/7dee07c086ce3e562679ee50625d9d9a8d413744),
  [PR #924](https://github.com/erpc/erpc/pull/924):
  `fix(served-tip): heal the frozen-tip incident, then replace the pipeline with a stateless majority pick`.
- [`fd08647b`](https://github.com/erpc/erpc/commit/fd08647bc669b0c0fc4241a71a7cf144671525f9),
  [PR #977](https://github.com/erpc/erpc/pull/977):
  chain-identity and connection-freshness enforcement.
- [`cae35e73`](https://github.com/erpc/erpc/commit/cae35e73f264de6dddfa5570f7cd39bc0b8033e9),
  [PR #978](https://github.com/erpc/erpc/pull/978):
  `eth_blockNumber` consistency with the majority tip.
- [`2b47ac38`](https://github.com/erpc/erpc/commit/2b47ac385e53c891846bcd0a24f12007212ce931),
  [PR #997](https://github.com/erpc/erpc/pull/997):
  chain-identity gating for major out-of-band head suggestions.

PR #924 is important because it reverses an earlier stateful design after a
production frozen-tip incident. The replacement sorts observed heads in descending
order and selects `heads[floor(N / 2)]`: the freshest block already reached by a
strict majority.

This statistic is deterministic, cannot invent a block number between observations,
and requires no persistent monotonic counter or velocity estimator.

#### Local gap

`HeadTracker` uses an arithmetic median for even sample counts. Arithmetic averaging
can produce a block number that no endpoint reported. Head state is isolate-local,
and head sampling can block the request that triggered it.

#### Clean-room adaptation

- Use the strict-majority order statistic for routing lag calculations.
- Verify `eth_chainId` before accepting a major head outlier.
- Initially use majority head only to exclude or penalize stale candidates.
- Do not synthesize `eth_blockNumber` responses in the first implementation.
- Do not persist a served-tip pipeline; recompute from bounded fresh samples.
- Keep sampling off the foreground request path.

### Defer until incident evidence: Adaptive deadlines and per-attempt observability

#### eRPC evidence

- [`eae6de71`](https://github.com/erpc/erpc/commit/eae6de7172a44c51ec5f528a4e674da2cac25343),
  [PR #811](https://github.com/erpc/erpc/pull/811):
  `feat: dynamic quantile-based timeout policy`.
- [`10513c82`](https://github.com/erpc/erpc/commit/10513c82f78e63f7c46d649d4a6839947100dd1b),
  [PR #889](https://github.com/erpc/erpc/pull/889):
  `feat: in-house failsafe + per-attempt observability`.
- [`ddbe6253`](https://github.com/erpc/erpc/commit/ddbe62532ba2bf491d524dde66a024f9ebf1b7e7),
  [PR #987](https://github.com/erpc/erpc/pull/987):
  vendor cost accounting and batch coverage.

The useful behavior is a method-scoped deadline derived from observed latency,
bounded by a minimum, maximum, and cold-start fallback. Each physical attempt is
then recorded with its role and outcome rather than inferred from one aggregate
request counter.

#### Clean-room adaptation

Retain the current adaptive timeout concept but make the overall request budget
authoritative through headers and body parsing. Record a compact attempt:

- Stable upstream ID.
- Primary, retry, hedge, consensus, probe, or verification reason.
- Start time and duration.
- Normalized outcome.
- Whether it won.
- Optional provider cost when reliable data exists.

Health and logs must use stable opaque upstream IDs rather than raw URLs.

### Defer until demonstrated impact: Serverless-safe shared state

#### eRPC evidence

- [`8c26c11d`](https://github.com/erpc/erpc/commit/8c26c11d425fff11aa263fa57fb6b7a36c23f4a3),
  [PR #658](https://github.com/erpc/erpc/pull/658):
  `fix: update shared variable local value synchronously`.
- [`5e95216a`](https://github.com/erpc/erpc/commit/5e95216a5ef9080dc24e4c8db33d3652a82ecfa6),
  [PR #956](https://github.com/erpc/erpc/pull/956):
  `fix(evm): namespace shared-state counter keys by value schema version`.

The transferable principles are:

- Apply a local state transition coherently before asynchronous reconciliation.
- Bound and deduplicate remote reconciliation.
- Version shared-state keys when the serialized value schema changes so a rolling
  deployment cannot parse an incompatible old value.

#### Local gap

`CacheManager` reads one whole-cache KV blob once per isolate and then rewrites the
entire object for a single-chain change. Two warm isolates can overwrite unrelated
chain updates using stale snapshots.

Health persistence is also internally inconsistent:

- `rpc_failures` is written and deleted but never read or hydrated.
- `recordSuccess()` does not clear `lastFailureTime`, so after the first failure
  later successes can repeatedly open KV and delete the same key.
- In-memory scores, capabilities, circuits, and heads differ across isolates.

#### Clean-room adaptation

- Hard-cut to schema-versioned per-chain endpoint-test keys.
- Use Deno KV atomic checks/versionstamps for competing writers.
- Store per-endpoint correctness-critical exclusion and recovery-lease state only
  if routing reads and enforces it.
- Remove write-only persistence.
- Keep advisory metrics isolate-local unless a demonstrated correctness requirement
  justifies their shared-state cost.
- Await essential KV commits; a Deno Deploy request cannot assume background work
  survives isolate teardown.

### Defer until enabled: Consensus composition and integrity

#### eRPC evidence

- [`8459b053`](https://github.com/erpc/erpc/commit/8459b05354b0834e0e140621e54a9233d2abb790),
  [PR #1008](https://github.com/erpc/erpc/pull/1008):
  `feat(consensus): winner-composition quota via requiredParticipants[].minAgreement`.

The audited head deduplicates votes by upstream identity and can require the winning
bucket to include a minimum number of participants from selected groups. This
prevents retries, duplicate endpoints, or one correlated provider group from
manufacturing apparent quorum.

#### Local gap

The local consensus implementation returns the plurality winner, or the first
successful response, even when configured quorum is not met. Quorum currently
affects misbehavior recording more than response validity. Comparing independent
“latest” requests can also punish honest providers that observed adjacent blocks.

#### Clean-room adaptation

If consensus is activated:

- Give one vote to each stable upstream identity.
- Pin latest-state requests to a common block or finality point before comparison.
- Require configured quorum to return a consensus result.
- Optionally require independent provider groups in the winning bucket.
- Return an explicit JSON-RPC failure when quorum is absent; never silently return
  plurality.

Consensus remains deferred because it is disabled in production and depends on
method-policy and JSON-RPC work that is not currently justified.

### Do not pursue now: Response-cache patterns

The audited range contains useful response-cache work:

- PR #876 races independent cache connectors and cancels after the first valid hit.
- PR #908 rejects realtime hits from connectors behind the known head.
- PR #926 derives TTL from observed block time with a cold-start fallback.
- PR #932 refuses to persist or serve realtime values already behind the known tip.

These are not immediate lifts. `CacheManager` stores endpoint test results rather
than JSON-RPC responses. Adding broad response caching would introduce a new
product surface with block-tag, finality, invalidation, and privacy semantics.

The bounded-race concept is still applicable to endpoint probing: replace the
current full-pool request herd with a bounded, cancelable probe plan.

## Confirmed Local Issue Map

The existence of a local issue does not by itself make an architectural fix worth
shipping. The disposition column reflects current Permit2 product value.

| Disposition | Local behavior                                   | Evidence location                                                                                       | Product impact                                           | Current recommendation                                    |
| ----------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| Do now      | Endpoint cannot recover after threshold          | `isRpcAvailable()` clears backoff but retains the disqualifying failure count                           | Recovered capacity can remain unavailable                | Add one bounded half-open recovery probe                  |
| Do now      | Quota classification unreachable                 | `classifyError()` checks the implementation-defined range in the wrong direction                        | `-32004/-32005` stop before healthy fallbacks            | Correct the targeted classification                       |
| Do now      | Raw URLs escape diagnostics                      | `/health`, attempted URL errors, and log fields                                                         | Credentials can appear in public or retained diagnostics | Stable upstream IDs and centralized redaction             |
| Conditional | Override list ignored by sequential execution    | `Permit2RpcManager._sendInternal()` builds `orderedRpcs`, but the sequential loop consumes `rankedRpcs` | Controlled failover/testing can use the wrong provider   | Fix directly if override headers remain supported         |
| Do now      | Batch ID `0` is dropped                          | Batch filtering uses ID truthiness                                                                      | A valid response can disappear                           | Check ID presence rather than truthiness                  |
| Keep        | Multicall changes generic `msg.sender` semantics | Batch route and `multicall3.ts` eligibility                                                             | Known tradeoff outside controlled Permit2 calls          | Preserve optimization and sender-sensitive exclusions     |
| Defer       | Score ranking is followed by round-robin         | Scoring sort followed by chain-wide `rpcIndexMap` rotation                                              | May dilute scorer benefit                                | Change only with production selection evidence            |
| Conditional | Writes can retry across candidates               | Sequential loop applies after only hedge/consensus are disabled                                         | Matters if this proxy broadcasts transactions            | Add raw-transaction policy only when required             |
| Defer       | Large numeric IDs are lossy                      | `request.json()` parses IDs as JavaScript numbers                                                       | Controlled clients do not depend on exotic IDs           | Defer raw-token parser                                    |
| Defer       | Named params are discarded                       | Validator accepts object; handler substitutes `[]`                                                      | Controlled clients use positional arrays                 | Defer named-parameter support                             |
| Defer       | Timeout ends before body parsing                 | `executeRpcCall()` clears timeout after headers                                                         | Potential stalled response body                          | Address if observed or while revisiting request lifecycle |
| Defer       | Hedge attempts pollute scores                    | Attempt callback records before winner selection                                                        | No current impact while hedging is disabled              | Fix before enabling hedging                               |
| Defer       | Empty result can win a hedge                     | `HedgedRequester` accepts first fulfillment                                                             | No current impact while hedging is disabled              | Fix before enabling hedging                               |
| Defer       | KV whole-blob rewrites                           | `CacheManager` caches and rewrites all chains                                                           | Theoretical cross-isolate stale/lost updates             | Redesign only after demonstrated user impact              |
| Defer       | Failure persistence is write-only                | `rpc_failures` set/delete has no read path                                                              | Misleading persistence with no proven incident           | Clean up when touching health persistence                 |
| Defer       | Full probe herd repeats on null fastest endpoint | `RpcSelector` retests when cached `fastestRpc` is null                                                  | Potential outage amplification                           | Instrument before adding leases or shared state           |
| Defer       | Batch execution is broadly concurrent            | HTTP batch path uses `Promise.all`                                                                      | Load-dependent capacity risk                             | Add limits only from measured traffic requirements        |
| Defer       | Consensus fails open below quorum                | `consensus.ts` returns plurality or first success                                                       | No current impact while consensus is disabled            | Fix before enabling consensus                             |

## Recommended Implementation Scope

### Small hardening patch

The current findings justify only these bounded changes:

1. Correct the `-32004/-32005` quota classification and add a failover regression
   test.
2. Admit one recovery probe after endpoint backoff and add recovery/concurrency
   tests.
3. Replace raw RPC URLs in health, logs, and serialized errors with stable opaque
   endpoint IDs.
4. If override headers remain supported, make the override-ordered list
   authoritative in the sequential path.
5. Preserve batch ID `0` by testing for ID presence instead of truthiness.
6. Retain Multicall3 and add regression coverage for its Permit2-specific
   eligibility and sender-sensitive exclusions.

This patch does not require a new environment variable, CLI flag, routing engine,
method-policy framework, or KV schema.

### Explicitly deferred research

- Unified candidate policy, sticky-primary selection, and scorer redesign.
- Full lossless JSON-RPC parsing, notifications, named params, and envelope
  normalization.
- Generic write-policy and raw-transaction idempotency unless this service becomes
  the transaction broadcaster.
- Adaptive deadlines and per-attempt cost accounting.
- Cross-isolate KV redesign.
- Hedging and head work while those modes remain disabled.
- Consensus and integrity work while consensus remains disabled.
- Response caching.

### Evidence required to reopen deferred work

- Routing rewrite: sustained production evidence that scoring/round-robin behavior
  selects materially worse endpoints or causes user-visible flapping.
- KV redesign: a reproduced cross-isolate lost update that changes routing or
  availability.
- Adaptive deadlines or batch limits: measured stalled-body or capacity incidents.
- Raw-transaction idempotency: confirmation that this proxy broadcasts signed
  transactions.
- Hedge, head, or consensus hardening: an approved plan to enable the feature.

## Test and Acceptance Matrix

### Minimum hardening patch

- `-32004/-32005` fail over to a healthy endpoint.
- Client and deterministic blockchain errors remain non-retryable.
- A backed-off endpoint receives no traffic before expiry.
- Exactly one bounded recovery probe is admitted after expiry.
- Recovery success resets the failure state.
- Override precedence works when override headers are enabled.
- Override fallback false prevents non-override attempts.
- Batch ID `0` receives its matching response.
- Health, logs, and errors contain no raw endpoint credentials.
- Eligible Permit2 reads still use Multicall3.
- Sender-sensitive Permit2 transfer selectors still bypass Multicall3.

### Deferred routing-policy tests

These tests are required only if the unified selection-policy work is reopened:

- Primary selection is sticky and respects the improvement threshold.
- Static exclusions never probe.
- All-excluded behavior is deterministic and observable.

The remaining test groups are retained as research acceptance criteria and apply
only if their corresponding deferred work is reopened.

### Deferred: Full error and method policy

- Quota and throttle errors retry safely.
- Malformed client requests and deterministic execution errors do not retry.
- Method-not-found is tracked per endpoint and method.
- Unknown methods use conservative single-attempt behavior.
- Stateful filter methods remain endpoint-sticky.
- Only `eth_sendRawTransaction` uses verified idempotency.

### Deferred: Full JSON-RPC conformance

- Preserve IDs `0`, `""`, `null`, large integers, fractions, and strings.
- Notifications produce no response.
- Mixed batches omit notification entries without dropping valid ID `0`.
- Named params remain objects.
- Upstream response IDs cannot leak through.
- Malformed envelopes are rejected.
- JSON-RPC application errors use HTTP 200.
- Actual incoming body-limit failures use HTTP 413.

### Deferred: Hedging and deadlines

- Empty-result acceptability follows method policy.
- Hedge losers do not modify ordinary score counters.
- Cancellation remains active until the body is consumed.
- A stalled body cannot exceed the overall deadline.
- A canceled loser cannot mutate health later.

### Deferred: Head and consensus

- Odd and even endpoint sets choose the freshest strict-majority head.
- The chosen head is always one an endpoint actually reported.
- Wrong-chain and implausible outliers are excluded.
- Consensus counts one vote per upstream identity.
- No-quorum returns an explicit error.

### Deferred: Shared state

- Concurrent isolates can update different chains without overwriting each other.
- Conflicting updates use Deno KV versionstamp compare-and-set.
- Rolling schema versions cannot parse incompatible old values.
- Essential writes are awaited.
- No write-only state remains.

### Current patch: Security and observability

- Health, logs, exceptions, and attempt records contain no raw upstream URLs.
- Query parameters, embedded credentials, and sensitive path tokens cannot appear
  in serialized diagnostics.
- Stable upstream IDs allow correlation without revealing endpoint secrets.

## Designs Not to Lift

### Superseded weighted scorer

[`e3995704`](https://github.com/erpc/erpc/commit/e3995704ebd152f3b23a3f7b309c2a892c4e1e8f),
[PR #772](https://github.com/erpc/erpc/pull/772), introduced smoother weighted
scoring and round-robin routing. The local `RpcScorerV2` already resembles that
generation, and eRPC later replaced it with the exclusion/rank/sticky policy in
PR #888. Porting #772 literally would reinforce the local conflict between scoring
and uniform rotation.

### Persisted served-tip pipeline

[`242b2d4d`](https://github.com/erpc/erpc/commit/242b2d4d06bc50be8714fc1d162af9bd80370be0),
[PR #900](https://github.com/erpc/erpc/pull/900), implemented a stateful cluster,
velocity, and monotonic served-tip design. PR #924 documents a production
frozen-tip incident and deletes that machinery in favor of a stateless majority
pick. Do not port #900 or add a persistent served-tip counter.

### Runtime architecture and unrelated product surfaces

Do not lift:

- Go background registries or long-lived process assumptions.
- The JavaScript policy DSL.
- gRPC, BDS, and provider-specific integration layers.
- Go `http.Transport` and goroutine lifecycle fixes.
- Prometheus deployment machinery.
- Provider catalogs or public endpoint feeds.
- Broad response caching without a separate product specification.
- Generic transaction broadcasting.
- Exact-equality consensus over independent `latest` reads.

### Branch-only work

The local research clone contains 85 remote refs not merged into audited `main`.
Examples include:

- `origin/feat/network-headers`
- `origin/fix/upstream-jsonrpc-error-code-fidelity`
- `origin/copilot/implement-cross-instance-cache-invalidation`
- `origin/claude/integrity-module`
- `origin/claude/data-integrity-spec`

These may be useful hypotheses but are not shipped upstream evidence. No
recommendation in this report depends on them.

## Public Interface Effects

The recommended implementation preserves:

- `POST /{chainId}`
- The client SDK entry point and request API
- Standard JSON-RPC 2.0 response shapes

The small hardening patch has only two intentional externally observable effects:

- Batch request ID `0` receives a response rather than being dropped.
- `/health` and logs using stable upstream IDs instead of raw URLs.

The Permit2-specific Multicall3 behavior remains part of the product. Full
lossless IDs, notification handling, named params, HTTP normalization, and other
JSON-RPC changes remain research candidates rather than approved interface work.

## Research and Licensing Boundary

eRPC is licensed under Apache-2.0. This report does not provide legal advice, but
the engineering boundary is intentionally stricter than the license minimum:

- Treat eRPC as a competing product and research reference only.
- Record behavior, failure modes, architectural lessons, and commit provenance.
- Implement selected behavior independently in Deno/TypeScript.
- Do not copy Go source, tests, comments, configuration, dashboards, or deployment
  machinery.
- Do not add a runtime or build dependency on the eRPC submodule.
- Do not update or ship the submodule merely to adopt these findings.

## Curated Commit Index

| Disposition | Commit     | PR                                              | Upstream change                             | Local relevance                                      |
| ----------- | ---------- | ----------------------------------------------- | ------------------------------------------- | ---------------------------------------------------- |
| Defer       | `70a1f178` | [#888](https://github.com/erpc/erpc/pull/888)   | Unified selection and scoring policy        | Revisit only with production routing evidence        |
| Partial now | `50959ff8` | [#931](https://github.com/erpc/erpc/pull/931)   | Exclusion-site probe eligibility            | Lift only bounded health recovery                    |
| Partial now | `a9ba3f68` | [#843](https://github.com/erpc/erpc/pull/843)   | Authoritative no-network-retry decision     | Correct known quota classification                   |
| Partial now | `10ed9d35` | [#967](https://github.com/erpc/erpc/pull/967)   | Client/transient error separation           | Correct known quota classification                   |
| Defer       | `d5f85371` | [#830](https://github.com/erpc/erpc/pull/830)   | JSON-RPC application error over HTTP 200    | Full transport normalization is not currently needed |
| Defer       | `a75325d5` | [#846](https://github.com/erpc/erpc/pull/846)   | Response ID rewriting                       | Keep as JSON-RPC research                            |
| Defer       | `5d700536` | [#851](https://github.com/erpc/erpc/pull/851)   | Raw ID byte preservation                    | Fix ID `0` locally; defer raw-token parsing          |
| Defer       | `5a448317` | [#886](https://github.com/erpc/erpc/pull/886)   | Hedge attempts excluded from score counters | Required only before enabling hedging                |
| Defer       | `8dba1590` | [#894](https://github.com/erpc/erpc/pull/894)   | Valid empty state/range results             | Required only before enabling hedging                |
| Defer       | `2f94c1b7` | [#895](https://github.com/erpc/erpc/pull/895)   | Empty lookup result cannot win hedge        | Required only before enabling hedging                |
| Conditional | `efa32c93` | [#703](https://github.com/erpc/erpc/pull/703)   | Raw transaction idempotency                 | Relevant only if this proxy broadcasts transactions  |
| Conditional | `ce6fdfc2` | [#898](https://github.com/erpc/erpc/pull/898)   | Final on-chain transaction verification     | Relevant only if this proxy broadcasts transactions  |
| Defer       | `7dee07c0` | [#924](https://github.com/erpc/erpc/pull/924)   | Stateless strict-majority served tip        | Required only before enabling head sampling          |
| Defer       | `fd08647b` | [#977](https://github.com/erpc/erpc/pull/977)   | Chain identity and freshness                | Head-outlier research                                |
| Defer       | `cae35e73` | [#978](https://github.com/erpc/erpc/pull/978)   | Majority-tip block-number consistency       | Response synthesis is not currently needed           |
| Defer       | `2b47ac38` | [#997](https://github.com/erpc/erpc/pull/997)   | Out-of-band head identity gate              | Head-outlier research                                |
| Defer       | `eae6de71` | [#811](https://github.com/erpc/erpc/pull/811)   | Quantile-based method timeout               | Revisit after measured timeout incidents             |
| Defer       | `10513c82` | [#889](https://github.com/erpc/erpc/pull/889)   | Per-attempt failsafe observability          | Revisit with hedge/retry redesign                    |
| Defer       | `ddbe6253` | [#987](https://github.com/erpc/erpc/pull/987)   | Winner and provider cost accounting         | No current product requirement                       |
| Defer       | `8c26c11d` | [#658](https://github.com/erpc/erpc/pull/658)   | Synchronous local shared-state update       | Revisit after demonstrated cross-isolate impact      |
| Defer       | `5e95216a` | [#956](https://github.com/erpc/erpc/pull/956)   | Schema-versioned shared-state keys          | Revisit after demonstrated cross-isolate impact      |
| Defer       | `8459b053` | [#1008](https://github.com/erpc/erpc/pull/1008) | Consensus winner composition                | Required only before enabling consensus              |

## Final Recommendation

Do not bump or integrate eRPC as part of the product implementation. Keep this
audit as a research catalog. Implement only the small hardening patch described
above, preserve the Permit2-specific Multicall3 optimization, and leave the current
routing architecture intact. Reopen deferred eRPC concepts only when production
evidence or a concrete product requirement supplies a benefit large enough to
justify the implementation and regression risk.

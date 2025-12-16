import { assertEquals } from "jsr:@std/assert@1";
import { CircuitBreakerV2, CircuitState } from "./circuit-breaker-v2.ts";

Deno.test("CircuitBreakerV2: client/non-provider errors do not trip the circuit", () => {
  const now = 0;
  const breaker = new CircuitBreakerV2({
    threshold: 3,
    timeoutMs: 1000,
    halfOpenTestLimit: 1,
    now: () => now,
  });

  const rpcUrl = "https://rpc.example";
  const clientErr = { reason: "invalid_params", isProviderIssue: false };

  for (let i = 0; i < 10; i++) {
    breaker.recordResult(rpcUrl, clientErr, false);
    assertEquals(breaker.getState(rpcUrl), CircuitState.CLOSED);
    assertEquals(breaker.canRequest(rpcUrl), true);
  }
});

Deno.test("CircuitBreakerV2: provider-fault failures open, half-open probes recover", () => {
  let now = 0;
  const breaker = new CircuitBreakerV2({
    threshold: 2,
    timeoutMs: 1000,
    halfOpenTestLimit: 2,
    now: () => now,
  });

  const rpcUrl = "https://rpc.example";
  const providerErr = { reason: "network_error", isProviderIssue: true };

  breaker.recordResult(rpcUrl, providerErr, false);
  assertEquals(breaker.getState(rpcUrl), CircuitState.CLOSED);
  assertEquals(breaker.canRequest(rpcUrl), true);

  breaker.recordResult(rpcUrl, providerErr, false);
  assertEquals(breaker.getState(rpcUrl), CircuitState.OPEN);
  assertEquals(breaker.canRequest(rpcUrl), false);

  // Timeout expires -> half-open.
  now = 1001;
  assertEquals(breaker.canRequest(rpcUrl), true);
  assertEquals(breaker.getState(rpcUrl), CircuitState.HALF_OPEN);

  breaker.recordResult(rpcUrl, providerErr, true);
  assertEquals(breaker.getState(rpcUrl), CircuitState.HALF_OPEN);
  assertEquals(breaker.canRequest(rpcUrl), true);

  breaker.recordResult(rpcUrl, providerErr, true);
  assertEquals(breaker.getState(rpcUrl), CircuitState.CLOSED);
  assertEquals(breaker.canRequest(rpcUrl), true);
});

Deno.test("CircuitBreakerV2: forbidden/auth-style failures count even if isProviderIssue is false", () => {
  const now = 0;
  const breaker = new CircuitBreakerV2({
    threshold: 2,
    timeoutMs: 1000,
    halfOpenTestLimit: 1,
    now: () => now,
  });

  const rpcUrl = "https://rpc.example";
  const forbidden = { reason: "forbidden", isProviderIssue: false };

  breaker.recordResult(rpcUrl, forbidden, false);
  assertEquals(breaker.getState(rpcUrl), CircuitState.CLOSED);

  breaker.recordResult(rpcUrl, forbidden, false);
  assertEquals(breaker.getState(rpcUrl), CircuitState.OPEN);
});

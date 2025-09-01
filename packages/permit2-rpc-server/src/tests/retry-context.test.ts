import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { RetryManager } from "../retry-context.ts";

Deno.test("RetryManager", async (t) => {
  const manager = new RetryManager();

  await t.step("should create context with default budget", () => {
    const context = manager.createContext();

    assertEquals(context.budget, 3);
    assertEquals(context.attemptCount, 0);
    assertEquals(context.rpcAttempts.size, 0);
    assertEquals(context.errors.length, 0);
    assert(context.startTime > 0);
  });

  await t.step("should create context with custom budget", () => {
    const context = manager.createContext(5);
    assertEquals(context.budget, 5);
  });

  await t.step("should track RPC attempts", () => {
    const context = manager.createContext();

    manager.recordAttempt(context, "rpc1");
    assertEquals(context.attemptCount, 1);
    assertEquals(context.rpcAttempts.get("rpc1"), 1);

    manager.recordAttempt(context, "rpc1");
    assertEquals(context.attemptCount, 2);
    assertEquals(context.rpcAttempts.get("rpc1"), 2);

    manager.recordAttempt(context, "rpc2");
    assertEquals(context.attemptCount, 3);
    assertEquals(context.rpcAttempts.get("rpc2"), 1);
  });

  await t.step("should check if can retry", () => {
    const context = manager.createContext(2);

    assert(manager.canRetry(context));

    context.budget = 0;
    assert(!manager.canRetry(context));

    context.budget = 1;
    context.startTime = Date.now() - 40000; // 40 seconds ago
    assert(!manager.canRetry(context)); // Exceeds max time
  });

  await t.step("should check if can retry specific RPC", () => {
    const context = manager.createContext();

    assert(manager.canRetryRpc(context, "rpc1"));

    manager.recordAttempt(context, "rpc1");
    assert(manager.canRetryRpc(context, "rpc1"));

    manager.recordAttempt(context, "rpc1");
    assert(!manager.canRetryRpc(context, "rpc1")); // Max 2 per RPC

    assert(manager.canRetryRpc(context, "rpc2")); // Different RPC still ok
  });

  await t.step("should record errors", () => {
    const context = manager.createContext();
    const error = new Error("Test error");

    manager.recordError(context, "rpc1", error, "timeout");

    assertEquals(context.errors.length, 1);
    assertEquals(context.errors[0].rpc, "rpc1");
    assertEquals(context.errors[0].error, error);
    assertEquals(context.errors[0].classification, "timeout");
    assertEquals(context.budget, 2); // Decreased from 3
  });

  await t.step("should create aggregate error", () => {
    const context = manager.createContext();

    manager.recordAttempt(context, "rpc1");
    manager.recordError(context, "rpc1", new Error("Error 1"), "timeout");

    manager.recordAttempt(context, "rpc2");
    manager.recordError(context, "rpc2", new Error("Error 2"), "rate_limit");

    const aggregateError = manager.createAggregateError(context);

    assert(aggregateError.message.includes("2 times"));
    assert(aggregateError.message.includes("2 RPCs"));
    assert(aggregateError.message.includes("timeout"));
    assert(aggregateError.message.includes("rate_limit"));
  });

  await t.step("should generate summary", () => {
    const context = manager.createContext();

    manager.recordAttempt(context, "rpc1");
    manager.recordAttempt(context, "rpc1");
    manager.recordAttempt(context, "rpc2");

    manager.recordError(context, "rpc1", new Error("E1"), "timeout");
    manager.recordError(context, "rpc1", new Error("E2"), "timeout");
    manager.recordError(context, "rpc2", new Error("E3"), "rate_limit");

    const summary = manager.getSummary(context);

    assert(summary.includes("Attempts: 3"));
    assert(summary.includes("rpc1:2"));
    assert(summary.includes("rpc2:1"));
    assert(summary.includes("timeout:2"));
    assert(summary.includes("rate_limit:1"));
  });
});

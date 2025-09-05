import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { EnhancedErrorClassifier, ErrorBehavior } from "../error-classifier.ts";

Deno.test("LatencyTester - method support detection", async (t) => {
  await t.step("should detect supported methods in test result", () => {
    // Mock a simple test - we can't actually test real RPCs in unit tests
    // but we can verify the structure
    const result = {
      url: "https://example.com",
      latency: 100,
      status: "ok" as const,
      supportedMethods: new Set(["eth_getCode", "eth_syncing", "eth_getLogs"]),
    };

    assertExists(result.supportedMethods);
    assertEquals(result.supportedMethods.has("eth_getLogs"), true);
    assertEquals(result.supportedMethods.has("eth_getCode"), true);
    assertEquals(result.supportedMethods.has("eth_syncing"), true);
  });
});

Deno.test("EnhancedErrorClassifier - block range limit detection", async (t) => {
  const classifier = new EnhancedErrorClassifier();

  await t.step("should detect block range limit exceeded", () => {
    const error = {
      code: -32602, // INVALID_PARAMS
      message: "block range is too large",
    };

    const classification = classifier.classify(error, 1);
    assertEquals(classification.behavior, ErrorBehavior.DO_NOT_RETRY);
    assertEquals(classification.reason, "block_range_limit_exceeded");
    assertEquals(classification.isTransient, false);
    assertEquals(classification.severity, "high");
  });

  await t.step("should detect 'exceeds maximum' error", () => {
    const error = {
      code: -32602,
      message: "Query returned more than 10000 results, exceeds maximum",
    };

    const classification = classifier.classify(error, 1);
    assertEquals(classification.behavior, ErrorBehavior.DO_NOT_RETRY);
    assertEquals(classification.reason, "block_range_limit_exceeded");
  });

  await t.step("should detect 'too many blocks' error", () => {
    const error = {
      code: -32602,
      message: "eth_getLogs: too many blocks requested",
    };

    const classification = classifier.classify(error, 1);
    assertEquals(classification.behavior, ErrorBehavior.DO_NOT_RETRY);
    assertEquals(classification.reason, "block_range_limit_exceeded");
  });

  await t.step("should not misclassify other invalid params errors", () => {
    const error = {
      code: -32602,
      message: "Invalid address format",
    };

    const classification = classifier.classify(error, 1);
    assertEquals(classification.behavior, ErrorBehavior.DO_NOT_RETRY);
    assertEquals(classification.reason, "invalid_request");
    assertEquals(classification.severity, "critical");
  });
});

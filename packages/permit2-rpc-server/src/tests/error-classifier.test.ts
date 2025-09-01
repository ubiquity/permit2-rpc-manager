import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { EnhancedErrorClassifier, ErrorBehavior } from "../error-classifier.ts";

Deno.test("EnhancedErrorClassifier", async (t) => {
  const classifier = new EnhancedErrorClassifier();

  await t.step("should retry -32603 errors on same RPC first", () => {
    const error = { code: -32603, message: "Internal error" };
    const classification = classifier.classify(error, 1);
    
    assertEquals(classification.behavior, ErrorBehavior.RETRY_SAME_RPC);
    assertEquals(classification.retryDelay, 100);
    assertEquals(classification.isTransient, true);
    assertEquals(classification.severity, 'low');
  });

  await t.step("should switch RPC on second -32603 attempt", () => {
    const error = { code: -32603, message: "Internal error" };
    const classification = classifier.classify(error, 2);
    
    assertEquals(classification.behavior, ErrorBehavior.RETRY_DIFFERENT_RPC);
    assertEquals(classification.isTransient, true);
    assertEquals(classification.severity, 'medium');
  });

  await t.step("should handle rate limiting with immediate RPC switch", () => {
    const error = { code: 429, message: "Too many requests" };
    const classification = classifier.classify(error, 1);
    
    assertEquals(classification.behavior, ErrorBehavior.RETRY_DIFFERENT_RPC);
    assertEquals(classification.reason, 'rate_limit');
    assertEquals(classification.isTransient, true);
  });

  await t.step("should handle timeout errors", () => {
    const error = { name: 'AbortError', message: "Request timeout" };
    const classification = classifier.classify(error, 1);
    
    assertEquals(classification.behavior, ErrorBehavior.RETRY_SAME_RPC);
    assertEquals(classification.reason, 'timeout');
    assertEquals(classification.retryDelay, 0);
  });

  await t.step("should not retry execution reverted errors", () => {
    const error = { code: 3, message: "Execution reverted" };
    const classification = classifier.classify(error, 1);
    
    assertEquals(classification.behavior, ErrorBehavior.BLOCKCHAIN_ERROR);
    assertEquals(classification.reason, 'execution_reverted');
    assertEquals(classification.isTransient, false);
  });

  await t.step("should handle server errors", () => {
    const error = { httpStatus: 500, message: "Internal server error" };
    const classification = classifier.classify(error, 1);
    
    assertEquals(classification.behavior, ErrorBehavior.RETRY_DIFFERENT_RPC);
    assertEquals(classification.reason, 'server_error');
    assertEquals(classification.isTransient, true);
    assertEquals(classification.severity, 'high');
  });

  await t.step("should not retry client errors", () => {
    const error = { httpStatus: 400, message: "Bad request" };
    const classification = classifier.classify(error, 1);
    
    assertEquals(classification.behavior, ErrorBehavior.DO_NOT_RETRY);
    assertEquals(classification.reason, 'client_error');
    assertEquals(classification.isTransient, false);
  });

  await t.step("should calculate retry delay with backoff", () => {
    const classification = {
      behavior: ErrorBehavior.RETRY_SAME_RPC,
      reason: 'test',
      retryDelay: 100,
      isTransient: true,
      severity: 'low' as const
    };
    
    const delay1 = classifier.getRetryDelay(classification, 1);
    const delay2 = classifier.getRetryDelay(classification, 2);
    const delay3 = classifier.getRetryDelay(classification, 3);
    
    assertEquals(delay1, 100);
    assertEquals(delay2, 150); // 100 * 1.5^1
    assertEquals(delay3, 225); // 100 * 1.5^2
  });
});
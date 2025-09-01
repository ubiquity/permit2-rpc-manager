import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { MethodAwareRpcScorer } from "../method-aware-scorer.ts";

Deno.test("MethodAwareRpcScorer", async (t) => {
  await t.step("should select optimal RPC based on method stats", () => {
    const scorer = new MethodAwareRpcScorer();
    
    // Record some success/failure data
    scorer.recordSuccess("rpc1", "eth_call", 100);
    scorer.recordSuccess("rpc1", "eth_call", 150);
    scorer.recordFailure("rpc1", "eth_call");
    
    scorer.recordSuccess("rpc2", "eth_call", 500);
    scorer.recordSuccess("rpc2", "eth_call", 600);
    
    scorer.recordSuccess("rpc3", "eth_call", 50);
    scorer.recordSuccess("rpc3", "eth_call", 60);
    scorer.recordSuccess("rpc3", "eth_call", 70);
    
    const optimal = scorer.getOptimalRpc(["rpc1", "rpc2", "rpc3"], "eth_call");
    
    // rpc3 should be optimal (fastest and most reliable)
    assertEquals(optimal, "rpc3");
  });

  await t.step("should handle RPCs with no stats", () => {
    const scorer = new MethodAwareRpcScorer();
    
    const optimal = scorer.getOptimalRpc(["rpc1", "rpc2"], "eth_call");
    
    // Should return one of them (with randomization)
    assert(optimal === "rpc1" || optimal === "rpc2");
  });

  await t.step("should favor recent success", () => {
    const scorer = new MethodAwareRpcScorer();
    
    // rpc1: old success
    const stats1 = scorer.getMethodStats("rpc1", "eth_call");
    stats1.successCount = 10;
    stats1.failureCount = 0;
    stats1.avgResponseTime = 100;
    stats1.lastSuccess = Date.now() - 120000; // 2 minutes ago
    
    // rpc2: recent success
    const stats2 = scorer.getMethodStats("rpc2", "eth_call");
    stats2.successCount = 10;
    stats2.failureCount = 0;
    stats2.avgResponseTime = 100;
    stats2.lastSuccess = Date.now() - 1000; // 1 second ago
    
    const optimal = scorer.getOptimalRpc(["rpc1", "rpc2"], "eth_call");
    
    // rpc2 should be preferred due to recency
    assertEquals(optimal, "rpc2");
  });

  await t.step("should penalize recent failures", () => {
    const scorer = new MethodAwareRpcScorer();
    
    scorer.recordSuccess("rpc1", "eth_call", 100);
    scorer.recordSuccess("rpc2", "eth_call", 100);
    
    // Record an actual failure for rpc1 (which sets lastFailure)
    scorer.recordFailure("rpc1", "eth_call", "timeout");
    
    const optimal = scorer.getOptimalRpc(["rpc1", "rpc2"], "eth_call");
    
    // rpc2 should be preferred (no recent failure)
    assertEquals(optimal, "rpc2");
  });

  await t.step("should track method-specific stats separately", () => {
    const scorer = new MethodAwareRpcScorer();
    
    // Record different performance for different methods
    scorer.recordSuccess("rpc1", "eth_call", 100);
    scorer.recordSuccess("rpc1", "eth_getBalance", 500);
    
    const callStats = scorer.getMethodStats("rpc1", "eth_call");
    const balanceStats = scorer.getMethodStats("rpc1", "eth_getBalance");
    
    assertEquals(callStats.avgResponseTime, 100);
    assertEquals(balanceStats.avgResponseTime, 500);
  });

  await t.step("should calculate p95 response time", () => {
    const scorer = new MethodAwareRpcScorer();
    
    // Add response times
    for (let i = 1; i <= 100; i++) {
      scorer.recordSuccess("rpc1", "eth_call", i * 10);
    }
    
    const stats = scorer.getMethodStats("rpc1", "eth_call");
    
    // p95 should be around 950 (95th value * 10)
    assert(stats.p95ResponseTime >= 940 && stats.p95ResponseTime <= 960);
  });

  await t.step("should handle high priority requests", () => {
    const scorer = new MethodAwareRpcScorer();
    
    // rpc1: fast but less reliable
    scorer.recordSuccess("rpc1", "eth_call", 50);
    scorer.recordFailure("rpc1", "eth_call");
    scorer.recordFailure("rpc1", "eth_call");
    
    // rpc2: slower but more reliable
    scorer.recordSuccess("rpc2", "eth_call", 200);
    scorer.recordSuccess("rpc2", "eth_call", 250);
    scorer.recordSuccess("rpc2", "eth_call", 300);
    
    const optimal = scorer.getOptimalRpc(["rpc1", "rpc2"], "eth_call", { priority: 'high' });
    
    // For high priority, should prefer reliable rpc2
    assertEquals(optimal, "rpc2");
  });

  await t.step("should prune old stats", () => {
    const scorer = new MethodAwareRpcScorer();
    
    const stats = scorer.getMethodStats("rpc1", "eth_call");
    stats.lastSuccess = Date.now() - 7200000; // 2 hours ago
    stats.lastFailure = Date.now() - 7200000;
    
    scorer.pruneOldStats(3600000); // Prune older than 1 hour
    
    const report = scorer.getMethodReport("eth_call");
    assertEquals(report.size, 0);
  });
});
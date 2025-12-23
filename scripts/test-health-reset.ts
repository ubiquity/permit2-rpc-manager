#!/usr/bin/env -S deno run --allow-net --allow-env --unstable-kv

/**
 * Direct unit test for health reset functionality
 * Tests the specific scenario where all RPCs are marked unhealthy
 */

import { Permit2RpcManager } from "../packages/permit2-rpc-server/src/core/permit2-rpc-manager.ts";

async function testHealthResetDirectly() {
  console.log("🧪 Direct Health Reset Test\n");

  // Create manager with working RPC endpoints (using public RPCs)
  const manager = new Permit2RpcManager({
    logLevel: "debug",
    maxConsecutiveFailures: 2, // Low threshold for testing
    backoffBaseMs: 100,
    maxBackoffMs: 1000,
    initialRpcData: {
      rpcs: {
        "1": ["https://ethereum.publicnode.com", "https://eth.llamarpc.com", "https://cloudflare-eth.com"],
      },
    },
  });

  try {
    console.log("📡 Phase 1: Normal request (should succeed)");

    // First, test that normal requests work
    try {
      const result = await manager.send(1, "eth_blockNumber", []);
      console.log("✅ Normal request succeeded:", result);
    } catch (error) {
      console.log("❌ Normal request failed:", (error as Error).message);
      console.log("⚠️ Skipping health reset test due to connectivity issues");
      return;
    }

    console.log("\n📡 Phase 2: Simulating RPC health failures");

    // Access the private method to simulate health failures
    // We'll simulate the scenario by directly manipulating the health map
    const healthMap = (manager as any).rpcHealthStates as Map<string, any>;

    // Mark all RPCs as unhealthy by simulating consecutive failures
    const chains = ["1"];
    const rpcs = ["https://ethereum.publicnode.com", "https://eth.llamarpc.com", "https://cloudflare-eth.com"];

    for (const rpc of rpcs) {
      // The key is just the RPC URL, not chainId:rpcUrl
      healthMap.set(rpc, {
        consecutiveFailures: 3, // Above threshold
        lastFailureTime: Date.now(),
        lastSuccessTime: null,
        temporaryUnavailableUntil: null,
        failureReasons: new Map([["test_error", 3]]),
      });
      console.log(`🚨 Marked ${rpc} as unhealthy (3 consecutive failures)`);
    }

    console.log("\n📡 Phase 3: Testing emergency fallback");

    // Now make a request that should trigger the emergency fallback
    try {
      const result = await manager.send(1, "eth_blockNumber", []);
      console.log("✅ Emergency fallback succeeded:", result);
      console.log("🎉 SUCCESS: Health reset mechanism is working!");
    } catch (error) {
      console.log("❌ Emergency fallback failed:", (error as Error).message);
      console.log("🔍 FAILED: Health reset mechanism needs adjustment");

      // Let's check the health states after the attempt
      console.log("\nHealth states after fallback attempt:");
      for (const rpc of rpcs) {
        const state = healthMap.get(rpc);
        if (state) {
          console.log(`  ${rpc}: failures=${state.consecutiveFailures}, lastSuccess=${state.lastSuccessTime}`);
        }
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log("📊 DIRECT TEST COMPLETED");
    console.log("=".repeat(60));
  } catch (error) {
    console.error("❌ Test failed with unexpected error:", error);
  }
}

// Run the test
if (import.meta.main) {
  await testHealthResetDirectly();
}

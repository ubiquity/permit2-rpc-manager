#!/usr/bin/env -S deno run --allow-net --allow-env --unstable-kv

/**
 * Test script to verify rate limit handling with the new cooldown system
 */

import { Permit2RpcManager } from "../packages/permit2-rpc-server/src/permit2-rpc-manager.ts";

// Create a mock RPC that returns rate limit errors
const mockServer = Deno.serve({ port: 8545 }, (req) => {
  const url = new URL(req.url);

  // First 3 requests succeed, then rate limit
  const requestCount = parseInt(localStorage.getItem("requestCount") || "0");
  localStorage.setItem("requestCount", String(requestCount + 1));

  if (requestCount < 3) {
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: "0x1234"
    }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // Return Tenderly-style quota error
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    error: {
      code: -32004,
      message: "You've reached the quota limit for your current plan."
    }
  }), {
    status: 403,
    headers: { "Content-Type": "application/json" }
  });
});

// Test the manager
async function testRateLimitHandling() {
  const manager = new Permit2RpcManager({
    logLevel: "debug",
    backoffBaseMs: 1000, // 1 second base backoff for testing
    maxBackoffMs: 3000, // 3 seconds max backoff for testing
    initialRpcData: {
      rpcs: {
        "1": [
          "http://localhost:8545",
          "https://rpc.ankr.com/eth",
          "https://cloudflare-eth.com"
        ]
      }
    }
  });

  console.log("\n=== Testing Rate Limit Handling ===\n");

  // First few requests should succeed
  for (let i = 0; i < 5; i++) {
    try {
      console.log(`\nRequest ${i + 1}:`);
      const result = await manager.send(1, "eth_blockNumber");
      console.log("✅ Success:", result);
    } catch (error) {
      console.log("❌ Error:", error.message);
    }

    // Small delay between requests
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log("\n=== Waiting for cooldown to expire... ===\n");
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Try again after cooldown
  try {
    console.log("\nRequest after cooldown:");
    const result = await manager.send(1, "eth_blockNumber");
    console.log("✅ Success:", result);
  } catch (error) {
    console.log("❌ Error:", error.message);
  }

  // Cleanup
  await mockServer.shutdown();
  localStorage.removeItem("requestCount");
}

// Run the test
if (import.meta.main) {
  await testRateLimitHandling();
  Deno.exit(0);
}

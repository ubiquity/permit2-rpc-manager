#!/usr/bin/env -S deno run --allow-net --allow-env --unstable-kv

/**
 * Test script to verify cascading failure recovery mechanisms
 * This test simulates the scenario where bad requests cascade through all RPCs
 * and verifies that the emergency fallback resets RPC health states
 */

import { Permit2RpcManager } from "../packages/permit2-rpc-server/src/permit2-rpc-manager.ts";

// Track request counts per port to simulate different RPC behaviors
const requestCounts = new Map<number, number>();

// Create mock RPC servers that simulate different failure scenarios
async function createMockRpcServer(port: number, behavior: "bad-request" | "healthy") {
  return Deno.serve({ port }, (req) => {
    const count = requestCounts.get(port) || 0;
    requestCounts.set(port, count + 1);
    
    console.log(`[Mock RPC ${port}] Request #${count + 1}, behavior: ${behavior}`);

    if (behavior === "bad-request") {
      // Return a JSON-RPC error that should be classified as DO_NOT_RETRY
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32602,
          message: "Invalid params: missing required parameter"
        }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Healthy response
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: "0x1234567890abcdef"
    }), {
      headers: { "Content-Type": "application/json" }
    });
  });
}

async function testCascadingFailureRecovery() {
  console.log("🧪 Starting Cascading Failure Recovery Test\n");

  // Create 3 mock RPC servers
  console.log("🚀 Starting mock RPC servers...");
  const server1 = await createMockRpcServer(8545, "bad-request");
  const server2 = await createMockRpcServer(8546, "bad-request"); 
  const server3 = await createMockRpcServer(8547, "bad-request");
  
  // Give servers a moment to start up
  await new Promise(resolve => setTimeout(resolve, 500));
  console.log("✅ Mock servers ready\n");

  // Create RPC manager with test configuration
  const initialData = {
    rpcs: {
      "1": [
        "http://localhost:8545",
        "http://localhost:8546", 
        "http://localhost:8547"
      ]
    }
  };
  
  console.log("🔧 Creating manager with initial data:", JSON.stringify(initialData, null, 2));
  
  const manager = new Permit2RpcManager({
    logLevel: "debug", // More verbose logging
    backoffBaseMs: 100, // Short backoff for testing
    maxBackoffMs: 1000,
    maxConsecutiveFailures: 2, // Lower threshold for faster testing
    initialRpcData: initialData
  });

  try {
    // Phase 1: Send bad requests that should cause cascading failures
    console.log("📡 Phase 1: Sending bad requests to trigger cascading failures...");
    
    let cascadeErrorCount = 0;
    
    // Send multiple bad requests to trigger the cascade
    for (let i = 0; i < 6; i++) {
      try {
        console.log(`\n--- Request ${i + 1} ---`);
        const result = await manager.send(1, "eth_call", [
          { to: "0x1234", data: "0xabcd" } // Missing required parameters
        ]);
        console.log(`✅ Request ${i + 1} succeeded:`, result);
      } catch (error) {
        cascadeErrorCount++;
        console.log(`❌ Request ${i + 1} failed:`, (error as Error).message);
        
        // Check if this is the expected "No healthy RPC endpoints available" error
        if ((error as Error).message.includes("No healthy RPC endpoints available")) {
          console.log("🚨 EXPECTED: Hit the 'No healthy RPC endpoints' error!");
          break;
        }
      }
    }

    if (cascadeErrorCount === 0) {
      console.log("⚠️ WARNING: Expected to see cascading failures but none occurred");
    }

    console.log("\n⏳ Phase 2: Testing emergency fallback by switching to healthy responses...");
    
    // Switch all servers to healthy behavior
    await server1.shutdown();
    await server2.shutdown(); 
    await server3.shutdown();
    
    // Give a moment for cleanup
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const healthyServer1 = await createMockRpcServer(8545, "healthy");
    const healthyServer2 = await createMockRpcServer(8546, "healthy");
    const healthyServer3 = await createMockRpcServer(8547, "healthy");

    // Now try to make requests - the emergency fallback should reset health states
    console.log("\n📡 Testing emergency fallback recovery...");
    
    let recoverySuccessCount = 0;
    
    for (let i = 0; i < 3; i++) {
      try {
        console.log(`\n--- Recovery Request ${i + 1} ---`);
        const result = await manager.send(1, "eth_blockNumber", []);
        console.log(`✅ Recovery Request ${i + 1} succeeded:`, result);
        recoverySuccessCount++;
      } catch (error) {
        console.log(`❌ Recovery Request ${i + 1} failed:`, (error as Error).message);
      }
    }

    // Clean up
    await healthyServer1.shutdown();
    await healthyServer2.shutdown();
    await healthyServer3.shutdown();

    // Results
    console.log("\n" + "=".repeat(60));
    console.log("📊 TEST RESULTS:");
    console.log(`• Cascade errors triggered: ${cascadeErrorCount}`);
    console.log(`• Recovery requests succeeded: ${recoverySuccessCount}/3`);
    
    if (recoverySuccessCount > 0) {
      console.log("✅ SUCCESS: Emergency fallback recovery is working!");
      console.log("   The system was able to recover from cascading failures.");
    } else {
      console.log("❌ FAILED: Recovery mechanism did not work.");
      console.log("   The system could not recover from cascading failures.");
    }
    
    console.log("=".repeat(60));

  } catch (error) {
    console.error("❌ Test failed with unexpected error:", error);
  }
}

// Run the test
if (import.meta.main) {
  await testCascadingFailureRecovery();
  console.log("\n🏁 Test completed. Press Ctrl+C to exit.");
}
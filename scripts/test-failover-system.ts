#!/usr/bin/env -S deno run --allow-all

import { Permit2RpcManager } from "../packages/permit2-rpc-server/src/permit2-rpc-manager.ts";

// Mock server to simulate various error conditions
class MockRpcServer {
  private port: number;
  private controller: AbortController;
  private requestCount = 0;

  constructor(port: number) {
    this.port = port;
    this.controller = new AbortController();
  }

  async start(behavior: "rate_limit" | "quota" | "server_error" | "healthy") {
    const handler = (req: Request) => {
      this.requestCount++;

      // Parse JSON-RPC request
      return req.json().then(body => {
        const isBatch = Array.isArray(body);

        switch (behavior) {
          case "rate_limit":
            return new Response("Too Many Requests", { status: 429 });

          case "quota":
            const quotaError = {
              jsonrpc: "2.0",
              id: isBatch ? body[0].id : body.id,
              error: {
                code: -32004,
                message: "You've reached the quota limit",
                data: undefined
              }
            };
            return new Response(
              JSON.stringify(isBatch ? [quotaError] : quotaError),
              {
                status: 403,
                headers: { "Content-Type": "application/json" }
              }
            );

          case "server_error":
            return new Response("Internal Server Error", { status: 500 });

          case "healthy":
            const result = {
              jsonrpc: "2.0",
              id: isBatch ? body[0].id : body.id,
              result: "0x12345"
            };
            return new Response(
              JSON.stringify(isBatch ? body.map((r: any) => ({
                jsonrpc: "2.0",
                id: r.id,
                result: "0x12345"
              })) : result),
              {
                status: 200,
                headers: { "Content-Type": "application/json" }
              }
            );
        }
      });
    };

    Deno.serve({
      port: this.port,
      signal: this.controller.signal,
      onListen: () => {}
    }, handler);

    console.log(`Mock RPC server started on port ${this.port} with ${behavior} behavior`);
  }

  shutdown() {
    this.controller.abort();
  }

  getRequestCount() {
    return this.requestCount;
  }
}

async function testFailoverSystem() {
  console.log("=== Testing RPC Failover System ===\n");

  // Start mock servers
  const rateLimitServer = new MockRpcServer(8001);
  const quotaServer = new MockRpcServer(8002);
  const healthyServer = new MockRpcServer(8003);
  const serverErrorServer = new MockRpcServer(8004);

  await rateLimitServer.start("rate_limit");
  await quotaServer.start("quota");
  await healthyServer.start("healthy");
  await serverErrorServer.start("server_error");

  // Small delay to ensure servers are ready
  await new Promise(resolve => setTimeout(resolve, 100));

  // Create manager with test configuration
  const manager = new Permit2RpcManager({
    initialRpcData: {
      rpcs: {
        "1": [
          "http://localhost:8001", // Rate limited
          "http://localhost:8002", // Quota exceeded
          "http://localhost:8004", // Server error
          "http://localhost:8003", // Healthy
        ]
      }
    },
    logLevel: "info",
    requestTimeoutMs: 2000,
    disableCache: true
  });

  console.log("\n--- Test 1: Single Request Failover ---");
  try {
    const result = await manager.send(1, "eth_blockNumber");
    console.log("✅ Successfully failed over to healthy RPC:", result);
  } catch (error) {
    console.log("❌ Unexpected error:", error);
  }

  console.log("\n--- Test 2: Batch Request Handling ---");
  try {
    const batchResult = await manager.sendBatch(1, [
      { method: "eth_blockNumber" },
      { method: "eth_chainId" },
      { method: "eth_gasPrice" }
    ]);
    console.log("✅ Batch request succeeded with", batchResult.length, "results");
  } catch (error) {
    console.log("❌ Batch request failed:", error);
  }

  console.log("\n--- Test 3: Multiple Requests (Rate Limit Recovery) ---");
  for (let i = 0; i < 5; i++) {
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      const result = await manager.send(1, "eth_blockNumber");
      console.log(`✅ Request ${i + 1} succeeded`);
    } catch (error) {
      console.log(`❌ Request ${i + 1} failed:`, error.message);
    }
  }

  console.log("\n--- Test 4: Request Counts ---");
  console.log("Rate limit server requests:", rateLimitServer.getRequestCount());
  console.log("Quota server requests:", quotaServer.getRequestCount());
  console.log("Server error server requests:", serverErrorServer.getRequestCount());
  console.log("Healthy server requests:", healthyServer.getRequestCount());

  // Cleanup
  rateLimitServer.shutdown();
  quotaServer.shutdown();
  healthyServer.shutdown();
  serverErrorServer.shutdown();

  console.log("\n✅ All tests completed!");
}

// Run the test
if (import.meta.main) {
  await testFailoverSystem();
  Deno.exit(0);
}

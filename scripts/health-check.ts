#!/usr/bin/env bun

/**
 * Health check script for deployed RPC endpoint
 * Tests basic functionality and response times
 */

interface HealthCheckResult {
  endpoint: string;
  chainId: number;
  status: "healthy" | "degraded" | "unhealthy";
  checks: {
    connectivity: boolean;
    blockNumber: boolean;
    gasPrice: boolean;
    permit2Contract: boolean;
    responseTime: number;
  };
  details: {
    blockNumber?: string;
    gasPrice?: string;
    permit2Present?: boolean;
    error?: string;
  };
  timestamp: string;
}

const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

async function makeRpcRequest(url: string, method: string, params: any[] = []): Promise<any> {
  const startTime = Date.now();
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
      id: 1,
    }),
  });

  const responseTime = Date.now() - startTime;
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  
  if (data.error) {
    throw new Error(`RPC Error: ${data.error.message || JSON.stringify(data.error)}`);
  }

  return { result: data.result, responseTime };
}

async function checkHealth(endpoint: string, chainId: number): Promise<HealthCheckResult> {
  const url = `${endpoint}/${chainId}`;
  const result: HealthCheckResult = {
    endpoint,
    chainId,
    status: "healthy",
    checks: {
      connectivity: false,
      blockNumber: false,
      gasPrice: false,
      permit2Contract: false,
      responseTime: 0,
    },
    details: {},
    timestamp: new Date().toISOString(),
  };

  const responseTimes: number[] = [];

  try {
    // Test 1: Basic connectivity and block number
    console.log("🔍 Checking connectivity and block number...");
    const blockResponse = await makeRpcRequest(url, "eth_blockNumber");
    result.checks.connectivity = true;
    result.checks.blockNumber = true;
    result.details.blockNumber = blockResponse.result;
    responseTimes.push(blockResponse.responseTime);
    console.log(`  ✅ Block number: ${parseInt(blockResponse.result, 16)}`);

    // Test 2: Gas price
    console.log("🔍 Checking gas price...");
    const gasResponse = await makeRpcRequest(url, "eth_gasPrice");
    result.checks.gasPrice = true;
    result.details.gasPrice = gasResponse.result;
    responseTimes.push(gasResponse.responseTime);
    console.log(`  ✅ Gas price: ${parseInt(gasResponse.result, 16) / 1e9} Gwei`);

    // Test 3: Permit2 contract presence
    console.log("🔍 Checking Permit2 contract...");
    const codeResponse = await makeRpcRequest(url, "eth_getCode", [PERMIT2_ADDRESS, "latest"]);
    const hasCode = codeResponse.result && codeResponse.result !== "0x" && codeResponse.result !== "0x0";
    result.checks.permit2Contract = hasCode;
    result.details.permit2Present = hasCode;
    responseTimes.push(codeResponse.responseTime);
    console.log(`  ${hasCode ? "✅" : "⚠️"} Permit2 contract: ${hasCode ? "present" : "not found"}`);

    // Calculate average response time
    result.checks.responseTime = Math.round(
      responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
    );

    // Determine overall status
    const passedChecks = Object.values(result.checks).filter(v => v === true).length;
    if (passedChecks === 4) {
      result.status = "healthy";
    } else if (passedChecks >= 2) {
      result.status = "degraded";
    } else {
      result.status = "unhealthy";
    }

  } catch (error) {
    result.status = "unhealthy";
    result.details.error = error instanceof Error ? error.message : String(error);
    console.error(`  ❌ Error: ${result.details.error}`);
  }

  return result;
}

async function runHealthCheck() {
  const endpoint = process.env.RPC_ENDPOINT || "https://rpc.ubq.fi";
  const chainId = parseInt(process.env.CHAIN_ID || "100");

  console.log("═".repeat(60));
  console.log("🏥 RPC Endpoint Health Check");
  console.log("═".repeat(60));
  console.log(`📍 Endpoint: ${endpoint}`);
  console.log(`🔗 Chain ID: ${chainId}`);
  console.log(`🕐 Time: ${new Date().toISOString()}`);
  console.log("─".repeat(60));

  const result = await checkHealth(endpoint, chainId);

  console.log("─".repeat(60));
  console.log("📊 Results:");
  console.log(`  Status: ${getStatusEmoji(result.status)} ${result.status.toUpperCase()}`);
  console.log(`  Response Time: ${result.checks.responseTime}ms`);
  
  if (result.details.blockNumber) {
    console.log(`  Latest Block: ${parseInt(result.details.blockNumber, 16)}`);
  }
  
  if (result.details.gasPrice) {
    console.log(`  Gas Price: ${parseInt(result.details.gasPrice, 16) / 1e9} Gwei`);
  }

  console.log("═".repeat(60));

  // Exit with appropriate code
  if (result.status === "unhealthy") {
    process.exit(1);
  } else if (result.status === "degraded") {
    process.exit(0); // Warning but not failure
  }
}

function getStatusEmoji(status: string): string {
  switch (status) {
    case "healthy": return "✅";
    case "degraded": return "⚠️";
    case "unhealthy": return "❌";
    default: return "❓";
  }
}

// Run if executed directly
if (import.meta.main) {
  runHealthCheck().catch(error => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
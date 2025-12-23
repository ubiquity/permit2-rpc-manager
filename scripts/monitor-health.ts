#!/usr/bin/env bun

/**
 * Continuous health monitoring for RPC endpoints
 * Performs periodic health checks and logs metrics
 */

interface HealthMetrics {
  timestamp: string;
  endpoint: string;
  chainId: number;
  status: "healthy" | "degraded" | "unhealthy";
  responseTime: number;
  blockNumber?: number;
  gasPrice?: number;
  permit2Present?: boolean;
  error?: string;
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
    signal: AbortSignal.timeout(10000), // 10 second timeout
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

async function performHealthCheck(endpoint: string, chainId: number): Promise<HealthMetrics> {
  const url = `${endpoint}/${chainId}`;
  const metrics: HealthMetrics = {
    timestamp: new Date().toISOString(),
    endpoint,
    chainId,
    status: "healthy",
    responseTime: 0,
  };

  const responseTimes: number[] = [];

  try {
    // Test 1: Block number
    const blockResponse = await makeRpcRequest(url, "eth_blockNumber");
    metrics.blockNumber = parseInt(blockResponse.result, 16);
    responseTimes.push(blockResponse.responseTime);

    // Test 2: Gas price
    const gasResponse = await makeRpcRequest(url, "eth_gasPrice");
    metrics.gasPrice = parseInt(gasResponse.result, 16) / 1e9; // Convert to Gwei
    responseTimes.push(gasResponse.responseTime);

    // Test 3: Permit2 contract
    const codeResponse = await makeRpcRequest(url, "eth_getCode", [PERMIT2_ADDRESS, "latest"]);
    metrics.permit2Present = codeResponse.result && codeResponse.result !== "0x" && codeResponse.result !== "0x0";
    responseTimes.push(codeResponse.responseTime);

    // Calculate average response time
    metrics.responseTime = Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length);

    // Determine status based on response time and Permit2 presence
    if (metrics.responseTime > 5000) {
      metrics.status = "degraded";
    } else if (!metrics.permit2Present) {
      metrics.status = "degraded";
    }
  } catch (error) {
    metrics.status = "unhealthy";
    metrics.error = error instanceof Error ? error.message : String(error);
  }

  return metrics;
}

async function monitorHealth() {
  const endpoint = process.env.RPC_ENDPOINT || "https://rpc.ubq.fi";
  const chainId = parseInt(process.env.CHAIN_ID || "100");
  const interval = parseInt(process.env.CHECK_INTERVAL || "60000"); // Default 60 seconds
  const logFile = process.env.LOG_FILE || null;

  console.log("🔄 Starting continuous health monitoring");
  console.log(`📍 Endpoint: ${endpoint}`);
  console.log(`🔗 Chain ID: ${chainId}`);
  console.log(`⏱️  Check interval: ${interval / 1000} seconds`);
  if (logFile) {
    console.log(`📝 Logging to: ${logFile}`);
  }
  console.log("─".repeat(60));

  let consecutiveFailures = 0;
  let totalChecks = 0;
  let healthyChecks = 0;
  let totalResponseTime = 0;

  const runCheck = async () => {
    totalChecks++;
    const metrics = await performHealthCheck(endpoint, chainId);

    // Update statistics
    if (metrics.status === "healthy") {
      healthyChecks++;
      consecutiveFailures = 0;
    } else if (metrics.status === "unhealthy") {
      consecutiveFailures++;
    }

    if (metrics.responseTime > 0) {
      totalResponseTime += metrics.responseTime;
    }

    // Format output
    const statusEmoji = metrics.status === "healthy" ? "✅" : metrics.status === "degraded" ? "⚠️" : "❌";

    const logEntry =
      `[${metrics.timestamp}] ${statusEmoji} ${metrics.status.toUpperCase()} | ` +
      `Response: ${metrics.responseTime}ms | ` +
      `Block: ${metrics.blockNumber || "N/A"} | ` +
      `Gas: ${metrics.gasPrice?.toFixed(6) || "N/A"} Gwei` +
      (metrics.error ? ` | Error: ${metrics.error}` : "");

    console.log(logEntry);

    // Log to file if specified
    if (logFile) {
      const fs = await import("fs/promises");
      await fs.appendFile(logFile, JSON.stringify(metrics) + "\n");
    }

    // Alert on consecutive failures
    if (consecutiveFailures >= 3) {
      console.error(`\n🚨 ALERT: ${consecutiveFailures} consecutive failures detected!\n`);
    }

    // Print statistics every 10 checks
    if (totalChecks % 10 === 0) {
      const uptime = ((healthyChecks / totalChecks) * 100).toFixed(1);
      const avgResponseTime = Math.round(totalResponseTime / totalChecks);
      console.log("─".repeat(60));
      console.log(`📊 Statistics after ${totalChecks} checks:`);
      console.log(`   Uptime: ${uptime}%`);
      console.log(`   Average response time: ${avgResponseTime}ms`);
      console.log("─".repeat(60));
    }
  };

  // Initial check
  await runCheck();

  // Set up interval for continuous monitoring
  setInterval(runCheck, interval);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n─".repeat(60));
    console.log("📊 Final Statistics:");
    console.log(`   Total checks: ${totalChecks}`);
    console.log(`   Healthy checks: ${healthyChecks}`);
    console.log(`   Uptime: ${((healthyChecks / totalChecks) * 100).toFixed(1)}%`);
    console.log(`   Average response time: ${Math.round(totalResponseTime / totalChecks)}ms`);
    console.log("─".repeat(60));
    console.log("👋 Monitoring stopped");
    process.exit(0);
  });
}

// Run if executed directly
if (import.meta.main) {
  monitorHealth().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}

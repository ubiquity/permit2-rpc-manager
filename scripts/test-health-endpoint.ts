#!/usr/bin/env bun

/**
 * Test the /health endpoint on deployed or local RPC service
 */

async function testHealthEndpoint(baseUrl: string) {
  console.log(`🔍 Testing health endpoint at: ${baseUrl}/health`);
  console.log("─".repeat(60));

  try {
    const response = await fetch(`${baseUrl}/health`);

    if (!response.ok) {
      console.error(`❌ HTTP Error: ${response.status} ${response.statusText}`);
      return;
    }

    const data = await response.json();

    // Display summary
    if (data.summary) {
      console.log("📊 Summary:");
      console.log(`  Total Chains: ${data.summary.totalChains}`);
      console.log(`  Total RPCs: ${data.summary.totalRpcs}`);
      console.log(`  Healthy: ${data.summary.healthyRpcs}`);
      console.log(`  Degraded: ${data.summary.degradedRpcs}`);
      console.log(`  Failed: ${data.summary.failedRpcs}`);
      console.log(`  Eliminated: ${data.summary.eliminatedRpcs}`);
    }

    // Display system info
    if (data.system) {
      console.log("\n⚙️  System Info:");
      console.log(`  Cache Enabled: ${data.system.cacheEnabled}`);
      console.log(`  Log Level: ${data.system.logLevel}`);
      console.log(`  Max Consecutive Failures: ${data.system.maxConsecutiveFailures}`);
    }

    // Display a few chains as examples
    if (data.chains) {
      console.log("\n🔗 Sample Chains:");
      const sampleChains = [1, 100, 8453]; // Ethereum, Gnosis, Base

      for (const chainId of sampleChains) {
        const chain = data.chains[chainId];
        if (chain) {
          console.log(`\n  Chain ${chainId}:`);
          console.log(`    Total RPCs: ${chain.totalRpcs}`);
          console.log(`    Healthy: ${chain.healthyRpcs}`);
          if (chain.fastestRpc) {
            console.log(`    Fastest: ${chain.fastestRpc}`);
          }
          if (chain.lastTested) {
            const age = Math.round((Date.now() - chain.lastTested) / 1000 / 60);
            console.log(`    Last tested: ${age} minutes ago`);
          }
        }
      }
    }

    console.log("\n✅ Health endpoint is working!");
  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : String(error));
  }
}

// Main
const url = process.argv[2] || process.env.RPC_ENDPOINT || "https://rpc.ubq.fi";
testHealthEndpoint(url);

#!/usr/bin/env -S deno run --allow-net --allow-env --unstable-kv

/**
 * Script to inspect the Deno KV cache state for the Permit2 RPC Manager
 * This helps diagnose issues with RPC failover and adaptive pool management
 */

// Map DENO_DEPLOY_TOKEN to DENO_KV_ACCESS_TOKEN if not already set
if (Deno.env.get("DENO_DEPLOY_TOKEN") && !Deno.env.get("DENO_KV_ACCESS_TOKEN")) {
  Deno.env.set("DENO_KV_ACCESS_TOKEN", Deno.env.get("DENO_DEPLOY_TOKEN")!);
}

const kv = await Deno.openKv("https://api.deno.com/databases/ffc5ea23-274a-4dcc-9821-0201fb52e0dc/connect");

console.log("=== Permit2 RPC Manager KV Cache Inspection ===\n");

// Check RPC failures for common chains
const chains = [1, 10, 56, 100, 137, 8453, 42161, 42220, 43114, 81457, 7777777];
const chainNames: Record<number, string> = {
  1: "Ethereum",
  10: "Optimism",
  56: "BSC",
  100: "Gnosis",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum",
  42220: "Celo",
  43114: "Avalanche",
  81457: "Blast",
  7777777: "Zora",
};

console.log("=== RPC Failure Tracking ===");
for (const chainId of chains) {
  const failures: Array<{ url: string; data: any }> = [];
  const iter = kv.list({ prefix: ["rpc_failures", chainId] });

  for await (const entry of iter) {
    const url = entry.key[2] as string;
    failures.push({ url, data: entry.value });
  }

  if (failures.length > 0) {
    console.log(`\n${chainNames[chainId] || `Chain ${chainId}`} (${chainId}):`);
    for (const { url, data } of failures) {
      console.log(`  ${url}:`);
      console.log(`    Consecutive failures: ${data.consecutiveFailures}`);
      console.log(`    Status: ${data.status}`);
      console.log(`    Last failure: ${new Date(data.lastFailureTime).toISOString()}`);
    }
  }
}

console.log("\n\n=== Cache State ===");
const cacheResult = await kv.get(["permit2RpcManagerCache"]);

if (cacheResult.value) {
  const cache = cacheResult.value as any;

  for (const [chainId, data] of Object.entries(cache)) {
    const chainIdNum = parseInt(chainId);
    console.log(`\n${chainNames[chainIdNum] || `Chain ${chainIdNum}`} (${chainId}):`);
    console.log(`  Fastest RPC: ${data.fastestRpc || "none"}`);
    console.log(`  Last tested: ${new Date(data.lastTested).toISOString()}`);
    console.log(`  Age: ${Math.round((Date.now() - data.lastTested) / 1000 / 60)} minutes`);

    if (data.latencyMap) {
      const totalRpcs = Object.keys(data.latencyMap).length;
      console.log(`  Total RPCs in cache: ${totalRpcs}`);

      // Count by status
      const statusCounts: Record<string, number> = {};
      const eliminatedRpcs: string[] = [];

      for (const [url, result] of Object.entries(data.latencyMap)) {
        const r = result as any;
        const status = r.status || "unknown";
        statusCounts[status] = (statusCounts[status] || 0) + 1;

        // Check for eliminated RPCs
        if (r._invalidated && r._healthStatus === "eliminated") {
          eliminatedRpcs.push(url);
        }
      }

      console.log(`  Status breakdown:`);
      for (const [status, count] of Object.entries(statusCounts)) {
        console.log(`    ${status}: ${count}`);
      }

      if (eliminatedRpcs.length > 0) {
        console.log(`  \nEliminated RPCs (${eliminatedRpcs.length}):`);
        for (const url of eliminatedRpcs) {
          const result = (data.latencyMap as any)[url];
          const timeUntilRetry = result._nextRetryAt ? Math.round((result._nextRetryAt - Date.now()) / 1000 / 60) : 0;
          console.log(`    ${url}`);
          if (timeUntilRetry > 0) {
            console.log(`      Retry in: ${timeUntilRetry} minutes`);
          } else {
            console.log(`      Ready for retry`);
          }
        }
      }

      // Show top 5 healthy RPCs by latency
      const healthyRpcs = Object.entries(data.latencyMap)
        .filter(([_, r]: [string, any]) => ["ok", "wrong_bytecode", "syncing"].includes(r.status) && !r._invalidated)
        .sort(([_, a]: [string, any], [__, b]: [string, any]) => a.latency - b.latency)
        .slice(0, 5);

      if (healthyRpcs.length > 0) {
        console.log(`  \nTop ${Math.min(5, healthyRpcs.length)} healthy RPCs:`);
        for (const [url, result] of healthyRpcs) {
          const r = result as any;
          console.log(`    ${url}: ${r.latency}ms (${r.status})`);
        }
      }
    }
  }
} else {
  console.log("No cache data found in KV store");
}

console.log("\n\n=== Summary ===");
const failureIter = kv.list({ prefix: ["rpc_failures"] });
let totalFailures = 0;
let eliminatedCount = 0;

for await (const entry of failureIter) {
  totalFailures++;
  const data = entry.value as any;
  if (data.status === "eliminated") {
    eliminatedCount++;
  }
}

console.log(`Total RPCs with failure tracking: ${totalFailures}`);
console.log(`Currently eliminated RPCs: ${eliminatedCount}`);

await kv.close();

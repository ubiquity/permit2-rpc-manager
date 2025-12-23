#!/usr/bin/env -S deno run --allow-net --allow-env --unstable-kv

/**
 * RPC Status Dashboard - Shows comprehensive health status of all upstream RPCs
 * Connects to production Deno KV to display real-time RPC health metrics
 */

// Map DENO_DEPLOY_TOKEN to DENO_KV_ACCESS_TOKEN if not already set
if (Deno.env.get("DENO_DEPLOY_TOKEN") && !Deno.env.get("DENO_KV_ACCESS_TOKEN")) {
  Deno.env.set("DENO_KV_ACCESS_TOKEN", Deno.env.get("DENO_DEPLOY_TOKEN")!);
}

const kv = await Deno.openKv("https://api.deno.com/databases/ffc5ea23-274a-4dcc-9821-0201fb52e0dc/connect");

// Chain metadata
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

interface RpcHealth {
  url: string;
  status: string;
  latency?: number;
  consecutiveFailures?: number;
  lastFailureTime?: number;
  lastSuccessTime?: number;
  failureReasons?: Map<string, number>;
  eliminated?: boolean;
  nextRetryAt?: number;
}

interface ChainStatus {
  chainId: number;
  chainName: string;
  totalRpcs: number;
  healthyRpcs: number;
  degradedRpcs: number;
  failedRpcs: number;
  eliminatedRpcs: number;
  fastestRpc?: string;
  fastestLatency?: number;
  rpcs: RpcHealth[];
}

async function getRpcHealthData(): Promise<Map<number, ChainStatus>> {
  const chainStatuses = new Map<number, ChainStatus>();

  // Get cache state with latency data
  const cacheResult = await kv.get(["permit2RpcManagerCache"]);
  const cache = (cacheResult.value as any) || {};

  // Get all failure tracking data
  const failureData = new Map<string, any>();
  const failureIter = kv.list({ prefix: ["rpc_failures"] });

  for await (const entry of failureIter) {
    const chainId = entry.key[1] as number;
    const url = entry.key[2] as string;
    const key = `${chainId}:${url}`;
    failureData.set(key, entry.value);
  }

  // Process each chain
  for (const [chainIdStr, chainData] of Object.entries(cache)) {
    const chainId = parseInt(chainIdStr);
    const chainName = chainNames[chainId] || `Chain ${chainId}`;

    const status: ChainStatus = {
      chainId,
      chainName,
      totalRpcs: 0,
      healthyRpcs: 0,
      degradedRpcs: 0,
      failedRpcs: 0,
      eliminatedRpcs: 0,
      fastestRpc: chainData.fastestRpc,
      rpcs: [],
    };

    if (chainData.latencyMap) {
      for (const [url, result] of Object.entries(chainData.latencyMap)) {
        const r = result as any;
        const failureKey = `${chainId}:${url}`;
        const failure = failureData.get(failureKey);

        const rpcHealth: RpcHealth = {
          url,
          status: r.status || "unknown",
          latency: r.latency,
        };

        // Add failure data if exists
        if (failure) {
          rpcHealth.consecutiveFailures = failure.consecutiveFailures;
          rpcHealth.lastFailureTime = failure.lastFailureTime;
          rpcHealth.lastSuccessTime = failure.lastSuccessTime;
          rpcHealth.failureReasons = failure.failureReasons;

          if (failure.status === "eliminated") {
            rpcHealth.eliminated = true;
            rpcHealth.nextRetryAt = failure.nextRetryAt;
          }
        }

        // Categorize RPC health
        status.totalRpcs++;

        if (rpcHealth.eliminated || r._healthStatus === "eliminated") {
          status.eliminatedRpcs++;
          rpcHealth.status = "eliminated";
        } else if (r.status === "ok" && !r._invalidated) {
          status.healthyRpcs++;
          if (url === chainData.fastestRpc) {
            status.fastestLatency = r.latency;
          }
        } else if (r.status === "syncing" || r.status === "wrong_bytecode") {
          status.degradedRpcs++;
        } else {
          status.failedRpcs++;
        }

        status.rpcs.push(rpcHealth);
      }

      // Sort RPCs by status and latency
      status.rpcs.sort((a, b) => {
        // Priority: healthy -> degraded -> failed -> eliminated
        const statusPriority: Record<string, number> = {
          ok: 0,
          syncing: 1,
          wrong_bytecode: 1,
          error: 2,
          timeout: 2,
          eliminated: 3,
          unknown: 4,
        };

        const aPriority = statusPriority[a.status] ?? 4;
        const bPriority = statusPriority[b.status] ?? 4;

        if (aPriority !== bPriority) return aPriority - bPriority;

        // Within same status, sort by latency
        if (a.latency && b.latency) return a.latency - b.latency;
        if (a.latency) return -1;
        if (b.latency) return 1;
        return 0;
      });
    }

    chainStatuses.set(chainId, status);
  }

  return chainStatuses;
}

function formatStatus(status: string): string {
  const statusEmojis: Record<string, string> = {
    ok: "✅",
    syncing: "🔄",
    wrong_bytecode: "⚠️",
    error: "❌",
    timeout: "⏱️",
    eliminated: "🚫",
    unknown: "❓",
  };

  return `${statusEmojis[status] || "❓"} ${status}`;
}

function formatLatency(latency?: number): string {
  if (!latency) return "N/A";
  if (latency < 100) return `${latency}ms 🟢`;
  if (latency < 500) return `${latency}ms 🟡`;
  if (latency < 1000) return `${latency}ms 🟠`;
  return `${latency}ms 🔴`;
}

function formatTimeSince(timestamp?: number): string {
  if (!timestamp) return "never";
  const minutes = Math.round((Date.now() - timestamp) / 1000 / 60);
  if (minutes < 1) return "< 1 min ago";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

async function displayDashboard() {
  console.clear();
  console.log("═".repeat(80));
  console.log("🎛️  RPC STATUS DASHBOARD");
  console.log("═".repeat(80));
  console.log(`📅 ${new Date().toISOString()}`);
  console.log("─".repeat(80));

  const chainStatuses = await getRpcHealthData();

  // Overall statistics
  let totalHealthy = 0,
    totalDegraded = 0,
    totalFailed = 0,
    totalEliminated = 0;

  for (const status of chainStatuses.values()) {
    totalHealthy += status.healthyRpcs;
    totalDegraded += status.degradedRpcs;
    totalFailed += status.failedRpcs;
    totalEliminated += status.eliminatedRpcs;
  }

  console.log("\n📊 OVERALL STATISTICS");
  console.log(`  ✅ Healthy: ${totalHealthy}`);
  console.log(`  ⚠️  Degraded: ${totalDegraded}`);
  console.log(`  ❌ Failed: ${totalFailed}`);
  console.log(`  🚫 Eliminated: ${totalEliminated}`);
  console.log("─".repeat(80));

  // Display each chain
  for (const [chainId, status] of [...chainStatuses.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`\n🔗 ${status.chainName} (Chain ${chainId})`);
    console.log(
      `   Total RPCs: ${status.totalRpcs} | ✅ ${status.healthyRpcs} | ⚠️  ${status.degradedRpcs} | ❌ ${status.failedRpcs} | 🚫 ${status.eliminatedRpcs}`
    );

    if (status.fastestRpc) {
      console.log(`   🏆 Fastest: ${status.fastestRpc} (${formatLatency(status.fastestLatency)})`);
    }

    const showDetailed = Deno.args.includes("--detailed") || Deno.args.includes("-d");

    if (showDetailed) {
      console.log("   " + "─".repeat(75));

      // Show top healthy RPCs
      const healthyRpcs = status.rpcs.filter((r) => r.status === "ok").slice(0, 3);
      if (healthyRpcs.length > 0) {
        console.log("   Top Healthy RPCs:");
        for (const rpc of healthyRpcs) {
          console.log(`     ${formatStatus(rpc.status)} ${rpc.url.padEnd(50)} ${formatLatency(rpc.latency)}`);
        }
      }

      // Show problematic RPCs
      const problematicRpcs = status.rpcs.filter((r) => r.status === "error" || r.status === "timeout" || r.eliminated).slice(0, 3);

      if (problematicRpcs.length > 0) {
        console.log("   Problematic RPCs:");
        for (const rpc of problematicRpcs) {
          console.log(`     ${formatStatus(rpc.status)} ${rpc.url}`);
          if (rpc.consecutiveFailures) {
            console.log(`        Failures: ${rpc.consecutiveFailures} | Last: ${formatTimeSince(rpc.lastFailureTime)}`);
          }
          if (rpc.eliminated && rpc.nextRetryAt) {
            const minutesUntilRetry = Math.round((rpc.nextRetryAt - Date.now()) / 1000 / 60);
            if (minutesUntilRetry > 0) {
              console.log(`        Retry in: ${minutesUntilRetry} minutes`);
            } else {
              console.log(`        Ready for retry`);
            }
          }
        }
      }
    }
  }

  console.log("\n" + "═".repeat(80));
  console.log("💡 Use --detailed or -d flag to see individual RPC details");
  console.log("═".repeat(80));
}

async function watchDashboard() {
  const interval = parseInt(Deno.env.get("REFRESH_INTERVAL") || "30000");

  while (true) {
    await displayDashboard();

    if (Deno.args.includes("--watch") || Deno.args.includes("-w")) {
      await new Promise((resolve) => setTimeout(resolve, interval));
    } else {
      break;
    }
  }
}

// Handle graceful shutdown
if (Deno.args.includes("--watch") || Deno.args.includes("-w")) {
  console.log("Starting dashboard in watch mode. Press Ctrl+C to exit.");

  const abortController = new AbortController();

  Deno.addSignalListener("SIGINT", () => {
    console.log("\n👋 Stopping dashboard...");
    abortController.abort();
    kv.close();
    Deno.exit(0);
  });
}

// Run dashboard
await watchDashboard();
await kv.close();

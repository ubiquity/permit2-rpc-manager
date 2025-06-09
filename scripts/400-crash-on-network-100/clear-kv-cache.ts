#!/usr/bin/env deno run --allow-read --allow-write --unstable-kv
/**
 * Utility script to clear the Deno KV cache for permit2-rpc-manager
 * This can help resolve issues with cached bad RPC selections
 */

async function clearKvCache() {
  console.log("Opening Deno KV store...");

  // Open the KV store (this will use the default location)
  const kv = await Deno.openKv();

  console.log("Listing all entries in KV store...");

  // Track what we find and delete
  const entries: string[] = [];
  let count = 0;

  // List all entries
  for await (const entry of kv.list({ prefix: [] })) {
    const keyStr = JSON.stringify(entry.key);
    entries.push(keyStr);
    count++;

    // Delete the entry
    await kv.delete(entry.key);
    console.log(`Deleted: ${keyStr}`);
  }

  console.log(`\n=====================================`);
  console.log(`Total entries deleted: ${count}`);
  console.log(`=====================================`);

  if (count === 0) {
    console.log("No entries found in KV store - cache was already empty.");
  } else {
    console.log("\nCache cleared successfully!");
    console.log("The next RPC request will trigger fresh latency testing.");
  }

  // Close the KV store
  kv.close();
}

// Run the cache clearing
if (import.meta.main) {
  await clearKvCache();
}

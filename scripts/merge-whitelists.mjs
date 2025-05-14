import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

async function mergeWhitelists(artifactsDir, outputPath) {
  console.log("Starting whitelist merge process...");
  console.log(`Artifacts directory: ${artifactsDir}`);
  console.log(`Output path: ${outputPath}`);

  // List and validate artifacts
  const files = await fs.readdir(artifactsDir);
  // Get all subdirectories that match our pattern
  const chainDirs = files.filter((f) => f.startsWith("whitelist-chain-"));
  if (chainDirs.length === 0) {
    throw new Error("No whitelist chain directories found in artifacts directory");
  }
  console.log(`Found ${chainDirs.length} chain directories: ${chainDirs.join(", ")}`);

  const whitelistFiles = chainDirs.map((dir) => ({
    dir,
    path: path.join(artifactsDir, dir, "rpc-whitelist.json"),
  }));
  console.log(`Found ${whitelistFiles.length} whitelist files: ${whitelistFiles.join(", ")}`);

  if (whitelistFiles.length === 0) {
    throw new Error("No whitelist files found in artifacts directory");
  }

  // Read and parse each whitelist file
  const whitelists = [];
  for (const file of whitelistFiles) {
    console.log(`\nProcessing ${file.dir}...`);

    try {
      const content = await fs.readFile(file.path, "utf8");
      console.log(`File content for ${file.dir}:`, content);

      const data = JSON.parse(content);
      if (!data.rpcs || typeof data.rpcs !== "object") {
        throw new Error("Invalid whitelist structure - missing or invalid rpcs object");
      }

      console.log(`Chain RPCs found: ${Object.keys(data.rpcs).length}`);
      console.log("RPC entries:", Object.keys(data.rpcs).join(", "));
      whitelists.push(data);
    } catch (err) {
      console.error(`Error parsing ${file}:`, err);
      throw new Error(`Invalid JSON in ${file}: ${err.message}`);
    }
  }

  // Merge RPCs
  console.log("\nMerging whitelists...");
  const merged = {
    rpcs: {},
  };

  for (const whitelist of whitelists) {
    const chainIds = Object.keys(whitelist.rpcs);
    console.log(`Adding RPCs for chains: ${chainIds.join(", ")}`);
    for (const chainId of chainIds) {
      if (!merged.rpcs[chainId]) {
        merged.rpcs[chainId] = [];
      }
      merged.rpcs[chainId].push(...whitelist.rpcs[chainId]);
      console.log(`Chain ${chainId}: Added ${whitelist.rpcs[chainId].length} RPCs`);
    }
  }

  // Validate final structure
  console.log("\nValidating merged whitelist...");
  console.log("Total chains:", Object.keys(merged.rpcs).length);
  console.log("Chains included:", Object.keys(merged.rpcs).join(", "));
  for (const [chainId, rpcs] of Object.entries(merged.rpcs)) {
    console.log(`Chain ${chainId}: ${rpcs.length} RPCs`);
  }

  // Write merged whitelist
  console.log("\nWriting merged whitelist to:", outputPath);
  const mergedContent = JSON.stringify(merged, null, 2);
  console.log("Final content:", mergedContent);
  await fs.writeFile(outputPath, mergedContent);
  console.log("Merge complete!");

  return merged;
}

// Direct execution support
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const artifactsDir = process.argv[2] || "artifacts";
  const outputPath = process.argv[3] || "packages/permit2-rpc-server/rpc-whitelist.json";

  mergeWhitelists(artifactsDir, outputPath).catch((err) => {
    console.error("Merge failed:", err);
    process.exit(1);
  });
}

export { mergeWhitelists };

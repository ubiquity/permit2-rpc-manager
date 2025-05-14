import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CRITICAL_CHAINS } from "../tests/constants.ts";
import { testRpcs } from "../tests/endpoint.ts";
import { normalizeRpcUrls } from "../tests/url-utils.ts";
import process from "node:process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.join(__dirname, "..");
const chainlistGeneratedPath = path.join(projectRoot, "lib/chainlist/out/rpcs.json");
const ourWhitelistPath = path.join(projectRoot, "packages/permit2-rpc-server/rpc-whitelist.json");

async function updateWhitelist() {
  console.log("Starting whitelist update for critical chains...");

  try {
    // 1. Read the generated Chainlist rpcs.json
    const chainlistRaw = await fs.readFile(chainlistGeneratedPath, "utf-8");
    const chainlistData = JSON.parse(chainlistRaw);

    // Support single chain processing via UPDATE_CHAIN env var
    const chainlistRpcsMap = {};
    const chainsToProcess = process.env.UPDATE_CHAIN
      ? chainlistData.filter((chain) => chain.chainId.toString() === process.env.UPDATE_CHAIN)
      : chainlistData.filter((chain) => CRITICAL_CHAINS.has(chain.chainId));

    for (const chain of chainsToProcess) {
      console.log(`Processing chain ${chain.chainId}...`);
      const urls = normalizeRpcUrls(chain.rpc);
      const validUrls = await testRpcs(urls);

      if (validUrls.length > 0) {
        console.log(`Found ${validUrls.length} valid RPCs for chain ${chain.chainId}`);
        chainlistRpcsMap[chain.chainId.toString()] = validUrls;
      }
    }

    // Get existing whitelist to merge if in single chain mode
    let existingWhitelist = { rpcs: {} };
    if (process.env.UPDATE_CHAIN) {
      try {
        const existingContent = await fs.readFile(ourWhitelistPath, "utf-8");
        existingWhitelist = JSON.parse(existingContent);
      } catch (error) {
        // If file doesn't exist or is invalid, use empty whitelist
        console.log("No existing whitelist found, creating new one");
      }
    }

    // Create whitelist, merging with existing if in single chain mode
    const newWhitelist = {
      rpcs: process.env.UPDATE_CHAIN ? { ...existingWhitelist.rpcs, ...chainlistRpcsMap } : chainlistRpcsMap,
    };

    await fs.writeFile(ourWhitelistPath, JSON.stringify(newWhitelist, null, 2));
    console.log("Whitelist updated successfully with critical chains only.");
  } catch (error) {
    console.error("Error updating whitelist:", error);
    process.exit(1);
  }
}

updateWhitelist();

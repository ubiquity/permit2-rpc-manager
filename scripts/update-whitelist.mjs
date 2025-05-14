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

    // 2. Process RPCs for critical chains
    const chainlistRpcsMap = {};
    for (const chain of chainlistData) {
      if (!CRITICAL_CHAINS.has(chain.chainId)) {
        continue;
      }

      console.log(`Processing chain ${chain.chainId}...`);

      // Filter and normalize URLs
      const urls = normalizeRpcUrls(chain.rpc);

      // Test all URLs in parallel batches
      const validUrls = await testRpcs(urls);

      if (validUrls.length > 0) {
        console.log(`Found ${validUrls.length} valid RPCs for chain ${chain.chainId}`);
        chainlistRpcsMap[chain.chainId.toString()] = validUrls;
      }
    }

    // 3. Create fresh whitelist with only critical chains
    const newWhitelist = {
      rpcs: chainlistRpcsMap,
    };

    // 4. Write updated whitelist
    await fs.writeFile(ourWhitelistPath, JSON.stringify(newWhitelist, null, 2));
    console.log("Whitelist updated successfully with critical chains only.");
  } catch (error) {
    console.error("Error updating whitelist:", error);
    process.exit(1);
  }
}

updateWhitelist();

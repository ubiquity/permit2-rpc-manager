import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { CRITICAL_CHAINS } from "../tests/constants.ts";
import { testRpcs } from "../tests/endpoint.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.join(__dirname, "..");
const ourWhitelistPath = path.join(projectRoot, "packages/permit2-rpc-server/rpc-whitelist.json");

const RPCS_PER_CHAIN_TO_TEST = 5; // Test more RPCs per chain for better coverage

async function testWhitelist() {
  console.log("Starting whitelist connectivity test...");
  let failedChains = 0;

  try {
    // Read our updated rpc-whitelist.json
    console.log(`Reading whitelist from: ${ourWhitelistPath}`);
    const ourWhitelistRaw = await fs.readFile(ourWhitelistPath, "utf-8");
    const ourWhitelist = JSON.parse(ourWhitelistRaw);
    console.log(`Whitelist contains ${Object.keys(ourWhitelist.rpcs || {}).length} chains.`);

    // Support single chain testing via TEST_CHAIN env var
    const chainsToTest = process.env.TEST_CHAIN
      ? [process.env.TEST_CHAIN]
      : Object.keys(ourWhitelist.rpcs).filter((chainIdStr) => CRITICAL_CHAINS.has(parseInt(chainIdStr, 10)));

    for (const chainIdStr of chainsToTest) {
      const chainId = parseInt(chainIdStr, 10);

      console.log(`\nTesting critical chain ${chainId}...`);
      const rpcUrls = ourWhitelist.rpcs[chainIdStr] || [];
      const urlsToTest = rpcUrls.slice(0, RPCS_PER_CHAIN_TO_TEST);

      if (urlsToTest.length === 0) {
        console.warn(`  No RPCs listed for critical chain ${chainId}.`);
        failedChains++;
        continue;
      }

      // Test RPCs and get working ones (that match permit2 bytecode)
      const workingRpcs = await testRpcs(urlsToTest);
      const successfulTests = workingRpcs.length;

      console.log(
        `  Tested ${urlsToTest.length} RPCs for chain ${chainId}: ` +
          `${successfulTests} succeeded (${Math.round((successfulTests / urlsToTest.length) * 100)}%)`
      );

      // Fail only if no working RPCs are found
      if (successfulTests === 0) {
        console.error(`  ERROR: No working RPCs found for critical chain ${chainId}!`);
        failedChains++;
      }
    }

    if (failedChains > 0) {
      console.error(`\nWhitelist test failed: ${failedChains} critical chain(s) had issues.`);
      process.exit(1);
    } else {
      console.log("\nWhitelist connectivity test passed for critical chains.");
    }
  } catch (error) {
    console.error("Error testing whitelist:", error);
    process.exit(1);
  }
}

testWhitelist();

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CRITICAL_CHAINS } from "../tests/constants.ts";
import { testRpcs, testWsRpcs } from "../tests/endpoint.ts";
import { normalizeHttpRpcUrls, normalizeWsRpcUrls } from "../tests/url-utils.ts";
import process from "node:process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.join(__dirname, "..");
const chainlistGeneratedPath = path.join(projectRoot, "lib/chainlist/out/rpcs.json");
const ourWhitelistPath = path.join(projectRoot, "packages/permit2-rpc-server/rpc-whitelist.json");

function deriveWsUrl(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim().replace(/\/$/, "");
  if (!trimmed || trimmed.includes("${")) return null;
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  return null;
}

function unique(list) {
  return [...new Set(list)];
}

async function updateWhitelist() {
  console.log("Starting whitelist update for critical chains...");

  try {
    // 1. Read the generated Chainlist rpcs.json
    const chainlistRaw = await fs.readFile(chainlistGeneratedPath, "utf-8");
    const chainlistData = JSON.parse(chainlistRaw);

    // Support single chain processing via UPDATE_CHAIN env var
    const chainlistRpcsMap = {};
    const chainlistWssMap = {};
    const chainsToProcess = process.env.UPDATE_CHAIN
      ? chainlistData.filter((chain) => chain.chainId.toString() === process.env.UPDATE_CHAIN)
      : chainlistData.filter((chain) => CRITICAL_CHAINS.has(chain.chainId));

    for (const chain of chainsToProcess) {
      console.log(`Processing chain ${chain.chainId}...`);
      const httpUrls = normalizeHttpRpcUrls(chain.rpc);
      const wsUrlsExplicit = normalizeWsRpcUrls(chain.rpc);
      const derivedWsUrls = unique(httpUrls.map(deriveWsUrl).filter(Boolean));
      const wsUrls = unique([...wsUrlsExplicit, ...derivedWsUrls]);

      const wsTestLimitRaw = Number.parseInt(process.env.WS_TEST_LIMIT ?? "60", 10);
      const wsTestLimit = Number.isFinite(wsTestLimitRaw) && wsTestLimitRaw > 0 ? wsTestLimitRaw : 60;
      const wsUrlsToTest = wsUrls.slice(0, wsTestLimit);

      const validHttpUrls = await testRpcs(httpUrls);
      const requirePendingTxEvent = chain.chainId === 1 && (process.env.WS_REQUIRE_PENDING_TX_EVENT ?? "1") !== "0";
      const validWsUrls = wsUrlsToTest.length > 0 ? await testWsRpcs(wsUrlsToTest, { requirePendingTxEvent }) : [];

      if (validHttpUrls.length > 0) {
        console.log(`Found ${validHttpUrls.length} valid HTTP RPCs for chain ${chain.chainId}`);
        chainlistRpcsMap[chain.chainId.toString()] = validHttpUrls;
      }

      if (validWsUrls.length > 0) {
        console.log(`Found ${validWsUrls.length} valid WS RPCs for chain ${chain.chainId}`);
        chainlistWssMap[chain.chainId.toString()] = validWsUrls;
      }
    }

    // Create whitelist output
    const newWhitelist = {
      rpcs: chainlistRpcsMap,
      wss: chainlistWssMap,
    };

    await fs.writeFile(ourWhitelistPath, JSON.stringify(newWhitelist, null, 2));
    console.log(
      process.env.UPDATE_CHAIN ? `Whitelist updated for chain ${process.env.UPDATE_CHAIN}.` : "Whitelist updated successfully with critical chains only."
    );
  } catch (error) {
    console.error("Error updating whitelist:", error);
    process.exit(1);
  }
}

updateWhitelist();

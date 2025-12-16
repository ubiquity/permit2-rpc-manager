import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.join(__dirname, "..");
const chainlistRoot = path.join(repoRoot, "lib", "chainlist");
const outDir = path.join(chainlistRoot, "out");
const outPath = path.join(outDir, "rpcs.json");

function stripTrackingDetails(entry) {
  if (!entry || typeof entry !== "object") return null;
  const { trackingDetails: _trackingDetails, ...rest } = entry;
  return rest;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });

  const extraRpcsModuleUrl = pathToFileURL(path.join(chainlistRoot, "constants", "extraRpcs.js")).href;
  const { default: extraRpcs } = await import(extraRpcsModuleUrl);

  const chains = Object.entries(extraRpcs)
    .map(([chainIdStr, value]) => {
      const chainId = Number.parseInt(chainIdStr, 10);
      if (!Number.isFinite(chainId)) return null;
      const rpcEntries = value?.rpcs;
      if (!Array.isArray(rpcEntries) || rpcEntries.length === 0) return null;

      const cleaned = rpcEntries
        .map((rpc) => {
          if (typeof rpc === "string") return rpc.trim().replace(/\/$/, "");
          if (rpc && typeof rpc === "object") {
            const stripped = stripTrackingDetails(rpc);
            if (!stripped || typeof stripped.url !== "string") return null;
            return {
              ...stripped,
              url: stripped.url.trim().replace(/\/$/, ""),
            };
          }
          return null;
        })
        .filter((rpc) => rpc !== null && rpc !== "");

      if (cleaned.length === 0) return null;
      return { chainId, rpc: cleaned };
    })
    .filter((chain) => chain !== null)
    .sort((a, b) => a.chainId - b.chainId);

  await fs.writeFile(outPath, JSON.stringify(chains, null, 2));
  console.log(
    `Generated fallback chainlist RPC data (${chains.length} chains) at ${path.relative(repoRoot, outPath)}.`,
  );
  console.log("Source: lib/chainlist/constants/extraRpcs.js (no network).");
}

main().catch((error) => {
  console.error("Fallback chainlist generation failed:", error);
  process.exit(1);
});


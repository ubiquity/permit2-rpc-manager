// Directly import the JSON data as a fallback.
// Adjust path to point two levels up from src/data/
import fallbackWhitelistJson from "../../rpc-whitelist.json" with { type: "json" };

type LoggerFn = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  ...optionalParams: unknown[]
) => void;

export type RpcWhitelist = {
  rpcs?: Record<string, string[]>;
  wss?: Record<string, string[]>;
  ws?: Record<string, string[]>;
};

const fallbackJsonData = fallbackWhitelistJson as RpcWhitelist;

function normalizeWsUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\/$/, "");
  if (!trimmed || trimmed.includes("${")) return null;
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
  return null;
}

function deriveWsUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\/$/, "");
  if (!trimmed || trimmed.includes("${")) return null;
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  return null;
}

export class ChainlistWsDataSource {
  private whitelistData: { chainId: number; rpcUrls: string[] }[] = [];
  private initialized = false;
  private log: LoggerFn;
  private candidateLimit: number | null;

  constructor(
    logger?: LoggerFn,
    initialData?: RpcWhitelist,
    options: { candidateLimit?: number } = {},
  ) {
    this.log = logger || (() => {});
    const limit = options.candidateLimit;
    this.candidateLimit = Number.isFinite(limit) && (limit ?? 0) > 0 ? limit! : null;
    const sourceData = initialData || fallbackJsonData;
    this.loadData(sourceData);
  }

  private loadData(jsonData: RpcWhitelist): void {
    if (this.initialized) return;

    this.log("info", "Initializing WS whitelist data...");
    try {
      const wss = jsonData.wss || {};
      const ws = jsonData.ws || {};
      const rpcs = jsonData.rpcs || {};

      const chainIds = new Set<string>([
        ...Object.keys(wss),
        ...Object.keys(ws),
        ...Object.keys(rpcs),
      ]);

      this.whitelistData = Array.from(chainIds).map((chainIdStr) => {
        const explicit = [...(wss[chainIdStr] ?? []), ...(ws[chainIdStr] ?? [])]
          .filter((u): u is string => typeof u === "string")
          .map((u) => normalizeWsUrl(u))
          .filter((u): u is string => typeof u === "string");

        const derived = (rpcs[chainIdStr] ?? [])
          .filter((u): u is string => typeof u === "string")
          .map((u) => deriveWsUrl(u))
          .filter((u): u is string => typeof u === "string");

        return {
          chainId: Number.parseInt(chainIdStr, 10),
          rpcUrls: (() => {
            const urls = [...new Set([...explicit, ...derived])];
            if (this.candidateLimit) return urls.slice(0, this.candidateLimit);
            return urls;
          })(),
        };
      }).filter((entry) => Number.isFinite(entry.chainId) && entry.chainId > 0);

      this.initialized = true;
      this.log("info", `Successfully initialized WS whitelist data for ${this.whitelistData.length} chains.`);
    } catch (error) {
      this.log("error", "Failed to process WS whitelist data:", error);
      this.whitelistData = [];
      this.initialized = true;
    }
  }

  getRpcUrls(chainId: number): string[] {
    const chainEntry = this.whitelistData.find((c) => c.chainId === chainId);
    if (!chainEntry) {
      this.log("warn", `No whitelisted WS RPCs found for chainId: ${chainId}`);
      return [];
    }
    return chainEntry.rpcUrls;
  }

  getAllChainIds(): number[] {
    return this.whitelistData.map((chain) => chain.chainId);
  }

  getAvailableChains(): number[] {
    return this.getAllChainIds();
  }
}

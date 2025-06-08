// Type for RPC URL object format
type RpcUrlObject = {
  url?: string;
  http?: string;
  https?: string;
  endpoint?: string;
};

type RpcInput = string | RpcUrlObject | null;

// Normalize RPC URL string - handle cases where URL might be in an object
export function normalizeRpcUrl(rpc: RpcInput): string | null {
  if (typeof rpc === "string") {
    return rpc;
  }
  if (typeof rpc === "object" && rpc !== null) {
    return rpc.url || rpc.http || rpc.https || rpc.endpoint || null;
  }
  return null;
}

// Filter and normalize list of RPC URLs
export function normalizeRpcUrls(rpcList: RpcInput[]): string[] {
  if (!Array.isArray(rpcList)) {
    return [];
  }

  const normalized = rpcList
    .map((rpc) => normalizeRpcUrl(rpc))
    .filter((url): url is string => url !== null && typeof url === "string")
    .map((url) => url.trim().replace(/\/$/, "")) // Trim and remove trailing slash
    .filter((url) => url.length > 0);

  return [...new Set(normalized)]; // Deduplicate
}

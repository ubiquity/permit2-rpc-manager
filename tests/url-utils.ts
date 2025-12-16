// Type for RPC URL object format
type RpcUrlObject = {
  url?: string;
  http?: string;
  https?: string;
  ws?: string;
  wss?: string;
  websocket?: string;
  endpoint?: string;
};

type RpcInput = string | RpcUrlObject | null;

// Normalize HTTP RPC URL string - handle cases where URL might be in an object
export function normalizeHttpRpcUrl(rpc: RpcInput): string | null {
  if (typeof rpc === "string") {
    return rpc.startsWith("http://") || rpc.startsWith("https://") ? rpc : null;
  }
  if (typeof rpc === "object" && rpc !== null) {
    const candidate = rpc.url || rpc.http || rpc.https || rpc.endpoint || null;
    if (!candidate) return null;
    return candidate.startsWith("http://") || candidate.startsWith("https://") ? candidate : null;
  }
  return null;
}

// Normalize WS RPC URL string - handle cases where URL might be in an object
export function normalizeWsRpcUrl(rpc: RpcInput): string | null {
  if (typeof rpc === "string") {
    return rpc.startsWith("ws://") || rpc.startsWith("wss://") ? rpc : null;
  }
  if (typeof rpc === "object" && rpc !== null) {
    const candidate = rpc.ws || rpc.wss || rpc.websocket || rpc.url || rpc.endpoint || null;
    if (!candidate) return null;
    return candidate.startsWith("ws://") || candidate.startsWith("wss://") ? candidate : null;
  }
  return null;
}

function normalizeList(list: RpcInput[], normalizer: (rpc: RpcInput) => string | null): string[] {
  if (!Array.isArray(list)) {
    return [];
  }

  const normalized = list
    .map((rpc) => normalizer(rpc))
    .filter((url): url is string => url !== null && typeof url === "string")
    .map((url) => url.trim().replace(/\/$/, "")) // Trim and remove trailing slash
    .filter((url) => url.length > 0);

  return [...new Set(normalized)]; // Deduplicate
}

// Filter and normalize list of HTTP RPC URLs
export function normalizeHttpRpcUrls(rpcList: RpcInput[]): string[] {
  return normalizeList(rpcList, normalizeHttpRpcUrl);
}

// Filter and normalize list of WS RPC URLs
export function normalizeWsRpcUrls(rpcList: RpcInput[]): string[] {
  return normalizeList(rpcList, normalizeWsRpcUrl);
}

// Backwards-compatible alias (HTTP-only)
export function normalizeRpcUrl(rpc: RpcInput): string | null {
  return normalizeHttpRpcUrl(rpc);
}

// Backwards-compatible alias (HTTP-only)
export function normalizeRpcUrls(rpcList: RpcInput[]): string[] {
  return normalizeHttpRpcUrls(rpcList);
}

/// <reference lib="deno.ns" />
// Deno Deploy entrypoint for the Permit2 RPC Manager Proxy with MCP compliance
import { isMulticall3Request, Multicall3Request } from "./evm/multicall3.ts";
import { JsonRpcRequest, JsonRpcResponse } from "./core/types.ts";
import { CacheManager } from "./infra/cache-manager.ts";
import { Permit2RpcManager } from "./core/permit2-rpc-manager.ts";
import { RpcSelector } from "./core/rpc-selector.ts";
import { ChainlistWsDataSource } from "./data/chainlist-ws-data-source.ts";
import { WsLatencyTester } from "./infra/ws-latency-tester.ts";
// Adjust path to point one level up from src/
import rpcWhitelist from "../rpc-whitelist.json" with { type: "json" };

// MCP SDK imports
import { Tool } from "npm:@modelcontextprotocol/sdk@1.0.4/types.js";

// Type guard to check for valid JSON-RPC request object structure
function isValidJsonRpcRequest(obj: unknown): obj is JsonRpcRequest {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }
  // Use 'in' operator for safer property checks on unknown
  return (
    "jsonrpc" in obj &&
    obj.jsonrpc === "2.0" &&
    "method" in obj &&
    typeof obj.method === "string" &&
    (!("params" in obj) || obj.params === undefined || Array.isArray(obj.params) || typeof obj.params === "object") &&
    "id" in obj &&
    (typeof obj.id === "string" || typeof obj.id === "number" || obj.id === null)
  );
}

// Helper to create a JSON-RPC error response
function createJsonRpcError(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

// MCP Tool Definitions for Ethereum JSON-RPC methods
function getEthereumTools(): Tool[] {
  return [
    // Core Methods
    {
      name: "eth_getBalance",
      description: "Returns the balance of the account at the given address",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "20-byte address to check for balance",
          },
          blockNumber: {
            type: "string",
            description: "Block number or 'latest', 'earliest', 'pending'",
          },
          chainId: {
            type: "number",
            description: "Chain ID (default: 1 for Ethereum mainnet)",
          },
        },
        required: ["address", "blockNumber"],
      },
    },
    {
      name: "eth_getCode",
      description: "Returns the code at a given address",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "20-byte address",
          },
          blockNumber: {
            type: "string",
            description: "Block number or 'latest', 'earliest', 'pending'",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["address", "blockNumber"],
      },
    },
    {
      name: "eth_getTransactionCount",
      description: "Returns the number of transactions sent from an address (nonce)",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "20-byte address",
          },
          blockNumber: {
            type: "string",
            description: "Block number or 'latest', 'earliest', 'pending'",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["address", "blockNumber"],
      },
    },
    {
      name: "eth_getStorageAt",
      description: "Returns the value from a storage position at a given address",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "20-byte address of the storage",
          },
          position: {
            type: "string",
            description: "Position in storage",
          },
          blockNumber: {
            type: "string",
            description: "Block number or 'latest', 'earliest', 'pending'",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["address", "position", "blockNumber"],
      },
    },
    {
      name: "eth_call",
      description: "Executes a call without creating a transaction",
      inputSchema: {
        type: "object",
        properties: {
          transaction: {
            type: "object",
            description: "Transaction call object",
            properties: {
              from: { type: "string", description: "Optional: sender address" },
              to: { type: "string", description: "Contract address" },
              gas: { type: "string", description: "Optional: gas limit" },
              gasPrice: { type: "string", description: "Optional: gas price" },
              value: { type: "string", description: "Optional: value in wei" },
              data: { type: "string", description: "Optional: encoded data" },
            },
            required: ["to"],
          },
          blockNumber: {
            type: "string",
            description: "Block number or 'latest', 'earliest', 'pending'",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["transaction", "blockNumber"],
      },
    },
    {
      name: "eth_estimateGas",
      description: "Estimates gas needed for a transaction",
      inputSchema: {
        type: "object",
        properties: {
          transaction: {
            type: "object",
            description: "Transaction object",
            properties: {
              from: { type: "string", description: "Optional: sender address" },
              to: { type: "string", description: "Optional: recipient address" },
              gas: { type: "string", description: "Optional: gas limit" },
              gasPrice: { type: "string", description: "Optional: gas price" },
              value: { type: "string", description: "Optional: value in wei" },
              data: { type: "string", description: "Optional: encoded data" },
            },
          },
          blockNumber: {
            type: "string",
            description: "Optional: Block number",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["transaction"],
      },
    },
    {
      name: "eth_blockNumber",
      description: "Returns the latest block number",
      inputSchema: {
        type: "object",
        properties: {
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
      },
    },

    // Transaction Methods
    {
      name: "eth_sendRawTransaction",
      description: "Submit a signed transaction",
      inputSchema: {
        type: "object",
        properties: {
          signedTransaction: {
            type: "string",
            description: "Signed transaction data",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["signedTransaction"],
      },
    },
    {
      name: "eth_getTransactionByHash",
      description: "Returns transaction details by hash",
      inputSchema: {
        type: "object",
        properties: {
          hash: {
            type: "string",
            description: "Transaction hash",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["hash"],
      },
    },
    {
      name: "eth_getTransactionReceipt",
      description: "Returns the receipt of a transaction",
      inputSchema: {
        type: "object",
        properties: {
          hash: {
            type: "string",
            description: "Transaction hash",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["hash"],
      },
    },
    {
      name: "eth_getTransactionByBlockHashAndIndex",
      description: "Returns transaction by block hash and index",
      inputSchema: {
        type: "object",
        properties: {
          blockHash: {
            type: "string",
            description: "Block hash",
          },
          index: {
            type: "string",
            description: "Transaction index in block",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["blockHash", "index"],
      },
    },
    {
      name: "eth_getTransactionByBlockNumberAndIndex",
      description: "Returns transaction by block number and index",
      inputSchema: {
        type: "object",
        properties: {
          blockNumber: {
            type: "string",
            description: "Block number or tag",
          },
          index: {
            type: "string",
            description: "Transaction index in block",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["blockNumber", "index"],
      },
    },
    {
      name: "eth_getBlockTransactionCountByHash",
      description: "Returns the number of transactions in a block by hash",
      inputSchema: {
        type: "object",
        properties: {
          blockHash: {
            type: "string",
            description: "Block hash",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["blockHash"],
      },
    },

    // Block Methods
    {
      name: "eth_getBlockByHash",
      description: "Returns block information by hash",
      inputSchema: {
        type: "object",
        properties: {
          blockHash: {
            type: "string",
            description: "Block hash",
          },
          fullTransactions: {
            type: "boolean",
            description: "Return full transaction objects",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["blockHash", "fullTransactions"],
      },
    },
    {
      name: "eth_getBlockByNumber",
      description: "Returns block information by number",
      inputSchema: {
        type: "object",
        properties: {
          blockNumber: {
            type: "string",
            description: "Block number or tag",
          },
          fullTransactions: {
            type: "boolean",
            description: "Return full transaction objects",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["blockNumber", "fullTransactions"],
      },
    },
    {
      name: "eth_getBlockTransactionCountByNumber",
      description: "Returns the number of transactions in a block by number",
      inputSchema: {
        type: "object",
        properties: {
          blockNumber: {
            type: "string",
            description: "Block number or tag",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["blockNumber"],
      },
    },
    {
      name: "eth_getUncleCountByBlockHash",
      description: "Returns the number of uncles in a block by hash",
      inputSchema: {
        type: "object",
        properties: {
          blockHash: {
            type: "string",
            description: "Block hash",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["blockHash"],
      },
    },
    {
      name: "eth_getUncleCountByBlockNumber",
      description: "Returns the number of uncles in a block by number",
      inputSchema: {
        type: "object",
        properties: {
          blockNumber: {
            type: "string",
            description: "Block number or tag",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["blockNumber"],
      },
    },
    {
      name: "eth_getUncleByBlockHashAndIndex",
      description: "Returns uncle block by hash and index",
      inputSchema: {
        type: "object",
        properties: {
          blockHash: {
            type: "string",
            description: "Block hash",
          },
          index: {
            type: "string",
            description: "Uncle index",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["blockHash", "index"],
      },
    },
    {
      name: "eth_getUncleByBlockNumberAndIndex",
      description: "Returns uncle block by number and index",
      inputSchema: {
        type: "object",
        properties: {
          blockNumber: {
            type: "string",
            description: "Block number or tag",
          },
          index: {
            type: "string",
            description: "Uncle index",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["blockNumber", "index"],
      },
    },

    // Network Info Methods
    {
      name: "eth_protocolVersion",
      description: "Returns the current Ethereum protocol version",
      inputSchema: {
        type: "object",
        properties: {
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
      },
    },
    {
      name: "eth_syncing",
      description: "Returns sync status or false",
      inputSchema: {
        type: "object",
        properties: {
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
      },
    },
    {
      name: "eth_coinbase",
      description: "Returns the coinbase address",
      inputSchema: {
        type: "object",
        properties: {
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
      },
    },
    {
      name: "eth_chainId",
      description: "Returns the chain ID",
      inputSchema: {
        type: "object",
        properties: {
          chainId: {
            type: "number",
            description: "Override chain ID for routing",
          },
        },
      },
    },
    {
      name: "eth_mining",
      description: "Returns true if client is mining",
      inputSchema: {
        type: "object",
        properties: {
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
      },
    },
    {
      name: "eth_hashrate",
      description: "Returns the current hashrate",
      inputSchema: {
        type: "object",
        properties: {
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
      },
    },
    {
      name: "eth_gasPrice",
      description: "Returns the current gas price",
      inputSchema: {
        type: "object",
        properties: {
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
      },
    },
    {
      name: "eth_accounts",
      description: "Returns the list of accounts",
      inputSchema: {
        type: "object",
        properties: {
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
      },
    },
  ];
}

// Convert MCP tool arguments to JSON-RPC parameters
function buildRpcParams(method: string, args: any): unknown[] {
  switch (method) {
    case "eth_getBalance":
      return [args.address, args.blockNumber];
    case "eth_getCode":
      return [args.address, args.blockNumber];
    case "eth_getTransactionCount":
      return [args.address, args.blockNumber];
    case "eth_getStorageAt":
      return [args.address, args.position, args.blockNumber];
    case "eth_call":
      return [args.transaction, args.blockNumber];
    case "eth_estimateGas":
      return args.blockNumber ? [args.transaction, args.blockNumber] : [args.transaction];
    case "eth_sendRawTransaction":
      return [args.signedTransaction];
    case "eth_getTransactionByHash":
      return [args.hash];
    case "eth_getTransactionReceipt":
      return [args.hash];
    case "eth_getTransactionByBlockHashAndIndex":
      return [args.blockHash, args.index];
    case "eth_getTransactionByBlockNumberAndIndex":
      return [args.blockNumber, args.index];
    case "eth_getBlockTransactionCountByHash":
      return [args.blockHash];
    case "eth_getBlockByHash":
      return [args.blockHash, args.fullTransactions];
    case "eth_getBlockByNumber":
      return [args.blockNumber, args.fullTransactions];
    case "eth_getBlockTransactionCountByNumber":
      return [args.blockNumber];
    case "eth_getUncleCountByBlockHash":
      return [args.blockHash];
    case "eth_getUncleCountByBlockNumber":
      return [args.blockNumber];
    case "eth_getUncleByBlockHashAndIndex":
      return [args.blockHash, args.index];
    case "eth_getUncleByBlockNumberAndIndex":
      return [args.blockNumber, args.index];
    case "eth_blockNumber":
    case "eth_protocolVersion":
    case "eth_syncing":
    case "eth_coinbase":
    case "eth_chainId":
    case "eth_mining":
    case "eth_hashrate":
    case "eth_gasPrice":
    case "eth_accounts":
      return [];
    default:
      return [];
  }
}

// Detect if request is MCP protocol
function isMcpRequest(body: unknown): boolean {
  if (typeof body === "object" && body !== null && "method" in body) {
    const method = (body as any).method;
    return typeof method === "string" && (
      method === "initialize" ||
      method.startsWith("tools/") ||
      method.startsWith("resources/") ||
      method.startsWith("prompts/")
    );
  }
  return false;
}

const PORT = parseInt(Deno.env.get("PORT") ?? "8000");

console.log("Initializing Permit2 RPC Manager Proxy...");

// Check environment variable to potentially disable cache
const disableCacheEnv = Deno.env.get("DISABLE_RPC_CACHE");
const shouldDisableCache = disableCacheEnv === "true" || disableCacheEnv === "1";

if (shouldDisableCache) {
  console.warn("RPC Caching is DISABLED via DISABLE_RPC_CACHE environment variable.");
}

// Instantiate Permit2RpcManager, passing initial data and cache option.
const manager = new Permit2RpcManager({
  initialRpcData: rpcWhitelist,
  disableCache: shouldDisableCache,
  // TODO: Configure other CacheManager options like TTL if needed
});

type WsLogLevel = "debug" | "info" | "warn" | "error";
const wsLogger = (level: WsLogLevel, message: string, ...optionalParams: unknown[]) => {
  if (level === "debug" || level === "info") return;
  const logFn = console[level] || console.log;
  logFn(`[Permit2WSS:${level}] ${message}`, ...optionalParams);
};

const wsCandidateLimitRaw = Number.parseInt(Deno.env.get("WS_CANDIDATE_LIMIT") ?? "25", 10);
const wsCandidateLimit = Number.isFinite(wsCandidateLimitRaw) && wsCandidateLimitRaw > 0 ? wsCandidateLimitRaw : 25;
const wsDataSource = new ChainlistWsDataSource(wsLogger, rpcWhitelist, { candidateLimit: wsCandidateLimit });
const wsCacheManager = new CacheManager({
  localStorageKey: "permit2RpcManagerWsCache",
  logger: wsLogger,
  disableCache: shouldDisableCache,
});
const wsLatencyTesterTimeoutMsRaw = Number.parseInt(Deno.env.get("WS_LATENCY_TIMEOUT_MS") ?? "5000", 10);
const wsLatencyTesterTimeoutMs = Number.isFinite(wsLatencyTesterTimeoutMsRaw) && wsLatencyTesterTimeoutMsRaw > 0
  ? wsLatencyTesterTimeoutMsRaw
  : 5000;
const wsLatencyTester = new WsLatencyTester(wsLatencyTesterTimeoutMs, wsLogger);
const wsSelector = new RpcSelector(wsDataSource, wsCacheManager, wsLatencyTester, wsLogger);

function deriveWsUrl(url: string): string | undefined {
  const trimmed = url.trim().replace(/\/$/, "");
  if (trimmed.includes("${")) return undefined;
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  return undefined;
}

function getWsOverrideCandidates(chainId: number): string[] {
  const candidates: string[] = [];

  const chainSpecific = Deno.env.get(`RPC_WSS_URL_${chainId}`);
  if (chainSpecific) candidates.push(chainSpecific);

  if (chainId === 1) {
    const eth = Deno.env.get("ETH_WSS_URL");
    if (eth) candidates.push(eth);
  }

  const global = Deno.env.get("RPC_WSS_URL");
  if (global) candidates.push(global);

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const derived = deriveWsUrl(candidate);
    if (!derived) continue;
    if (seen.has(derived)) continue;
    seen.add(derived);
    deduped.push(derived);
  }

  return deduped;
}

function openWebSocket(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error("Upstream WebSocket connection timed out."));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      ws.onopen = null;
      ws.onerror = null;
      ws.onclose = null;
    };

    ws.onopen = () => {
      cleanup();
      resolve(ws);
    };

    ws.onerror = () => {
      cleanup();
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error("Upstream WebSocket connection failed."));
    };

    ws.onclose = () => {
      cleanup();
      reject(new Error("Upstream WebSocket closed before opening."));
    };
  });
}

async function connectFirstWebSocket(urls: string[], timeoutMs: number): Promise<WebSocket> {
  let lastError: Error | undefined;
  for (const url of urls) {
    try {
      return await openWebSocket(url, timeoutMs);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("No upstream WebSocket candidates available.");
}

const STATIC_ASSET_ROOT = new URL("../static/", import.meta.url);
const staticTextAssetCache = new Map<string, string>();

async function readStaticTextAsset(fileName: string): Promise<string> {
  const cached = staticTextAssetCache.get(fileName);
  if (cached !== undefined) return cached;

  const text = await Deno.readTextFile(new URL(fileName, STATIC_ASSET_ROOT));
  staticTextAssetCache.set(fileName, text);
  return text;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Deno.errors.NotFound;
}

const handler = async (request: Request): Promise<Response> => {
  // Set CORS headers for all responses
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*", // Allow requests from any origin
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization", // Adjust as needed
  };

  // WebSocket JSON-RPC proxy (ws/wss). Connect clients to our server, proxy to an upstream WS RPC.
  const upgradeHeader = request.headers.get("upgrade");
  if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const pathParts = url.pathname.split("/").filter(Boolean);

    let chainId = 1; // default to Ethereum mainnet if not provided
    if (pathParts.length === 1) {
      const parsed = parseInt(pathParts[0], 10);
      if (Number.isNaN(parsed)) {
        return new Response("Not Found", { status: 404 });
      }
      chainId = parsed;
    } else if (pathParts.length > 1) {
      return new Response("Not Found", { status: 404 });
    }

    const { socket, response } = Deno.upgradeWebSocket(request);

    const queuedToUpstream: Array<string | ArrayBuffer> = [];
    const MAX_QUEUE = 256;
    let upstream: WebSocket | null = null;
    let clientClosed = false;

    const sendToClient = (data: unknown) => {
      const send = (payload: string | ArrayBuffer) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        try {
          socket.send(payload);
        } catch {
          // ignore
        }
      };

      if (typeof data === "string") send(data);
      else if (data instanceof ArrayBuffer) send(data);
      else if (data instanceof Blob) {
        data.arrayBuffer().then((buf) => send(buf)).catch(() => undefined);
      }
    };

    const enqueueToUpstream = (data: unknown) => {
      const sendOrQueue = (payload: string | ArrayBuffer) => {
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          try {
            upstream.send(payload);
          } catch {
            // ignore
          }
          return;
        }
        if (!upstream || upstream.readyState === WebSocket.CONNECTING) {
          if (queuedToUpstream.length < MAX_QUEUE) queuedToUpstream.push(payload);
        }
      };

      if (typeof data === "string") sendOrQueue(data);
      else if (data instanceof ArrayBuffer) sendOrQueue(data);
      else if (data instanceof Blob) {
        data.arrayBuffer().then((buf) => sendOrQueue(buf)).catch(() => undefined);
      }
    };

    socket.onmessage = (event) => {
      enqueueToUpstream(event.data);
    };

    socket.onerror = () => {
      clientClosed = true;
      try {
        upstream?.close();
      } catch {
        // ignore
      }
    };

    socket.onclose = () => {
      clientClosed = true;
      try {
        upstream?.close();
      } catch {
        // ignore
      }
    };

    (async () => {
      const timeoutMs = Number.parseInt(Deno.env.get("WS_CONNECT_TIMEOUT_MS") ?? "5000", 10);
      const connectTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;

      const overrideCandidates = getWsOverrideCandidates(chainId);
      if (overrideCandidates.length > 0) {
        try {
          upstream = await connectFirstWebSocket(overrideCandidates, connectTimeout);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to connect to configured WS override";
          wsLogger("warn", `WS override failed for chain ${chainId}: ${message}`);
        }
      }

      if (!upstream) {
        const rankedCandidates = await wsSelector.getRankedRpcList(chainId);
        if (rankedCandidates.length === 0) {
          try {
            socket.close(1011, `No upstream WS RPCs available for chain ${chainId}`);
          } catch {
            // ignore
          }
          return;
        }

        let lastError: Error | undefined;
        for (const candidate of rankedCandidates) {
          try {
            upstream = await openWebSocket(candidate, connectTimeout);
            break;
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            try {
              await wsCacheManager.invalidateRpcInCache(chainId, candidate, "eliminated");
            } catch {
              // ignore
            }
          }
        }

        if (!upstream) {
          const message = lastError?.message ?? "Failed to connect to upstream WebSocket";
          try {
            socket.close(1011, message);
          } catch {
            // ignore
          }
          return;
        }
      }

      if (clientClosed) {
        try {
          upstream.close();
        } catch {
          // ignore
        }
        return;
      }

      upstream.onmessage = (event) => {
        sendToClient(event.data);
      };

      upstream.onerror = () => {
        try {
          socket.close(1011, "Upstream WebSocket error");
        } catch {
          // ignore
        }
      };

      upstream.onclose = () => {
        try {
          socket.close(1011, "Upstream WebSocket closed");
        } catch {
          // ignore
        }
      };

      for (const payload of queuedToUpstream.splice(0, queuedToUpstream.length)) {
        try {
          upstream.send(payload);
        } catch {
          // ignore
        }
      }
    })();

    return response;
  }

  // Serve logo SVG at GET /logo.svg
  if ((request.method === "GET" || request.method === "HEAD") && new URL(request.url).pathname === "/logo.svg") {
    try {
      const ubiquityDaoLogo = await readStaticTextAsset("logo.svg");
      return new Response(ubiquityDaoLogo, {
        status: 200,
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          ...corsHeaders,
        },
      });
    } catch (error) {
      console.error("Failed to read static asset logo.svg:", error);
      return new Response("Not Found", {
        status: isNotFoundError(error) ? 404 : 500,
        headers: corsHeaders,
      });
    }
  }

  // Serve health check JSON at GET /health
  if (request.method === "GET" && new URL(request.url).pathname === "/health") {
    try {
      // Get health data from manager
      const healthData = await manager.getHealthStatus();

      return new Response(JSON.stringify(healthData), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...corsHeaders,
        },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: "Failed to retrieve health status",
          message: error instanceof Error ? error.message : String(error),
        }),
        {
          status: 500,
          headers: {
            "content-type": "application/json; charset=utf-8",
            ...corsHeaders,
          },
        },
      );
    }
  }

  // Serve HTML at GET /
  if ((request.method === "GET" || request.method === "HEAD") && new URL(request.url).pathname === "/") {
    try {
      const html = await readStaticTextAsset("index.html");
      return new Response(html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          ...corsHeaders,
        },
      });
    } catch (error) {
      console.error("Failed to read static asset index.html:", error);
      return new Response("Not Found", {
        status: isNotFoundError(error) ? 404 : 500,
        headers: corsHeaders,
      });
    }
  }

  // Handle CORS preflight requests
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  // Ensure request.url is valid before constructing URL
  if (!request.url) {
    return new Response("Bad Request: Missing URL", {
      status: 400,
      headers: corsHeaders,
    });
  }
  // Assign to variable after check to help type narrowing
  const checkedUrl = request.url;
  const url = new URL(checkedUrl);
  const pathParts = url.pathname.split("/").filter(Boolean); // e.g., ['100'] or []

  let requestBody: unknown;
  try {
    requestBody = await request.json();
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    console.error("Failed to parse request body:", error);
    // Return JSON-RPC error for parse error
    const errorResponse = createJsonRpcError(null, -32700, `Parse error: ${error.message}`);
    return new Response(JSON.stringify(errorResponse), {
      status: 200, // JSON-RPC compliance: parse errors return HTTP 200
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Check if this is an MCP request (at root path or with chainId)
  if (isMcpRequest(requestBody)) {
    const mcpRequest = requestBody as any;
    let mcpResponse: any;

    // Extract chainId from path if present, otherwise from request params
    let chainId = 1; // Default to Ethereum mainnet
    if (pathParts.length === 1) {
      const parsed = parseInt(pathParts[0], 10);
      if (!isNaN(parsed)) {
        chainId = parsed;
      }
    }

    switch (mcpRequest.method) {
      case "initialize":
        mcpResponse = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: {
            name: "ethereum-json-rpc",
            version: "1.0.0",
          },
        };
        break;

      case "tools/list":
        mcpResponse = {
          tools: getEthereumTools(),
        };
        break;

      case "tools/call": {
        const toolName = mcpRequest.params?.name;
        const toolArgs = mcpRequest.params?.arguments || {};

        // Use chainId from arguments if provided, otherwise use path or default
        if (toolArgs.chainId) {
          chainId = toolArgs.chainId;
        }

        // Build RPC parameters
        const params = buildRpcParams(toolName, toolArgs);

        try {
          // Execute via existing RPC manager
          const result = await manager.send(chainId, toolName, params);

          mcpResponse = {
            content: [{
              type: "text",
              text: JSON.stringify(result, null, 2),
            }],
          };
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          mcpResponse = {
            error: {
              code: -32603,
              message: error.message,
            },
          };
        }
        break;
      }

      default:
        mcpResponse = {
          error: {
            code: -32601,
            message: `Method not found: ${mcpRequest.method}`,
          },
        };
    }

    // Return MCP response
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: mcpRequest.id,
        result: mcpResponse.error ? undefined : mcpResponse,
        error: mcpResponse.error,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  // For regular JSON-RPC requests, require chainId in path
  if (pathParts.length !== 1) {
    return new Response("Not Found: Expected path /{chainId}", {
      status: 404,
      headers: corsHeaders,
    });
  }

  const chainIdStr = pathParts[0]; // Get chainId from the first part
  const chainId = parseInt(chainIdStr, 10);

  if (isNaN(chainId)) {
    const errorResponse = createJsonRpcError(null, -32602, "Invalid params: Invalid chainId");
    return new Response(JSON.stringify(errorResponse), {
      status: 200, // JSON-RPC compliance: always return 200 for JSON-RPC errors
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // --- Handle Batch Request ---
  if (Array.isArray(requestBody)) {
    console.log(`Received batch request for chain ${chainId} with ${requestBody.length} calls.`);

    if (requestBody.length === 0) {
      const errorResponse = createJsonRpcError(null, -32600, "Invalid Request: Received empty batch.");
      return new Response(JSON.stringify(errorResponse), {
        status: 200, // JSON-RPC compliance: invalid requests return HTTP 200
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate all requests in the batch first
    if (!requestBody.every(isValidJsonRpcRequest)) {
      const errorResponse = createJsonRpcError(
        null,
        -32600,
        "Invalid Request: Batch contains invalid JSON-RPC object(s).",
      );
      return new Response(JSON.stringify(errorResponse), {
        status: 200, // JSON-RPC compliance: invalid requests return HTTP 200
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const multiCallRequests = requestBody.filter((req) => isMulticall3Request(chainId, req));
    const otherRequests = requestBody.filter((req) => req.id && !multiCallRequests.map((r) => r.id).includes(req.id));

    // group by block tag and split the array into chunks of 500 to avoid exceeding multicall limits
    const multiCallRequestsByBlockTag = multiCallRequests.reduce(
      (acc, req) => {
        const blockTag = req.params[1];
        if (!acc[blockTag]) {
          acc[blockTag] = [];
        }
        const currentBatch = acc[blockTag];
        if (currentBatch.length === 0 || currentBatch[currentBatch.length - 1].length >= 500) {
          currentBatch.push([req]);
        } else {
          currentBatch[currentBatch.length - 1].push(req);
        }
        return acc;
      },
      {} as Record<string, Multicall3Request[][]>,
    );

    const multicallPromises: Promise<JsonRpcResponse[]>[] = [];
    for (const [blockTag, batches] of Object.entries(multiCallRequestsByBlockTag)) {
      for (const batch of batches) {
        multicallPromises.push(manager.multicall3(chainId, batch, blockTag));
      }
    }
    const multicallResponses = (await Promise.all(multicallPromises)).flat();

    // Process batch requests concurrently
    const otherResponses = await Promise.all(
      otherRequests.map(async (req) => {
        try {
          // Ensure params is always an array for manager.send()
          const params = Array.isArray(req.params) ? req.params : [];
          const result = await manager.send(chainId, req.method, params);
          return { jsonrpc: "2.0", id: req.id, result } as JsonRpcResponse;
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          console.error(
            `Error processing batch item (id: ${req.id}, method: ${req.method}) for chain ${chainId}:`,
            error,
          );

          // Extract error details consistently
          const code = error.name === "JsonRpcError" && "code" in error && typeof error.code === "number"
            ? error.code
            : -32603;
          const data = "data" in error ? error.data : undefined;

          return {
            jsonrpc: "2.0",
            id: req.id,
            error: {
              code,
              message: error.message,
              data,
            },
          } as JsonRpcResponse;
        }
      }),
    );

    return new Response(JSON.stringify([...multicallResponses, ...otherResponses]), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } // --- Handle Single Request ---
  else if (isValidJsonRpcRequest(requestBody)) {
    console.log(`Received single request for chain ${chainId}: ${requestBody.method}`);
    try {
      // Ensure params is always an array for manager.send()
      const params = Array.isArray(requestBody.params) ? requestBody.params : [];
      const result = await manager.send(chainId, requestBody.method, params);
      const rpcResponse: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: requestBody.id,
        result,
      };
      return new Response(JSON.stringify(rpcResponse), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      console.error(
        `Error processing single request (id: ${requestBody.id}, method: ${requestBody.method}) for chain ${chainId}:`,
        error,
      );

      // Pass through HTTP status if available, otherwise default to 200 for JSON-RPC compliance
      // Contract reverts and JSON-RPC errors should return HTTP 200 per JSON-RPC spec
      let httpStatus = 200;
      if (error.name === "JsonRpcError" && "httpStatus" in error && typeof error.httpStatus === "number") {
        httpStatus = error.httpStatus;
      }

      const errorResponse = {
        jsonrpc: "2.0",
        id: requestBody.id,
        error: {
          code: "code" in error && typeof error.code === "number" ? error.code : -32603,
          message: error.message,
          data: "data" in error ? error.data : undefined,
        },
      };

      return new Response(JSON.stringify(errorResponse), {
        status: httpStatus,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } // --- Handle Invalid Request Structure ---
  else {
    console.error("Invalid request body structure:", requestBody);
    const errorResponse = createJsonRpcError(null, -32600, "Invalid Request: Not a valid JSON-RPC object or batch.");
    return new Response(JSON.stringify(errorResponse), {
      status: 200, // JSON-RPC compliance: invalid requests return HTTP 200
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
};

console.log(`Permit2 RPC Manager Proxy listening on http://localhost:${PORT}`);
Deno.serve({ port: PORT }, handler);

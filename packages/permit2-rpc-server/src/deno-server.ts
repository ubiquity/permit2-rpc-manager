/// <reference lib="deno.ns" />
// Deno Deploy entrypoint for the Permit2 RPC Manager Proxy with MCP compliance

// Note: CacheManager will be adapted for Deno KV later
// ChainlistDataSource is instantiated internally by Permit2RpcManager
// import { ChainlistDataSource } from './chainlist-data-source.ts';
import { Permit2RpcManager } from "./permit2-rpc-manager.ts";
// Adjust path to point one level up from src/
import rpcWhitelist from "../rpc-whitelist.json" with { type: "json" };

// MCP SDK imports
import { 
  CallToolRequest, 
  CallToolResult, 
  ListToolsRequest, 
  ListToolsResult, 
  Tool 
} from "npm:@modelcontextprotocol/sdk@1.0.4/types.js";

// Simple interface for JSON-RPC request structure
interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params: unknown[] | Record<string, any>; // Allow both array and object params for MCP
  id: number | string | null; // Allow null ID for notifications, though we might not process them specially
}

// Define the structure for a JSON-RPC response
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

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
            description: "20-byte address to check for balance" 
          },
          blockNumber: { 
            type: "string", 
            description: "Block number or 'latest', 'earliest', 'pending'" 
          },
          chainId: { 
            type: "number", 
            description: "Chain ID (default: 1 for Ethereum mainnet)" 
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
            description: "20-byte address" 
          },
          blockNumber: { 
            type: "string", 
            description: "Block number or 'latest', 'earliest', 'pending'" 
          },
          chainId: { 
            type: "number", 
            description: "Chain ID" 
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
            description: "20-byte address" 
          },
          blockNumber: { 
            type: "string", 
            description: "Block number or 'latest', 'earliest', 'pending'" 
          },
          chainId: { 
            type: "number", 
            description: "Chain ID" 
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
            description: "20-byte address of the storage" 
          },
          position: { 
            type: "string", 
            description: "Position in storage" 
          },
          blockNumber: { 
            type: "string", 
            description: "Block number or 'latest', 'earliest', 'pending'" 
          },
          chainId: { 
            type: "number", 
            description: "Chain ID" 
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
            description: "Block number or 'latest', 'earliest', 'pending'" 
          },
          chainId: { 
            type: "number", 
            description: "Chain ID" 
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
            description: "Optional: Block number" 
          },
          chainId: { 
            type: "number", 
            description: "Chain ID" 
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
            description: "Chain ID" 
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
            description: "Signed transaction data" 
          },
          chainId: { 
            type: "number", 
            description: "Chain ID" 
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
            description: "Transaction hash" 
          },
          chainId: { 
            type: "number", 
            description: "Chain ID" 
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
            description: "Transaction hash" 
          },
          chainId: { 
            type: "number", 
            description: "Chain ID" 
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
            description: "Block hash" 
          },
          index: { 
            type: "string", 
            description: "Transaction index in block" 
          },
          chainId: { 
            type: "number", 
            description: "Chain ID" 
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
            description: "Block number or tag" 
          },
          index: { 
            type: "string", 
            description: "Transaction index in block" 
          },
          chainId: { 
            type: "number", 
            description: "Chain ID" 
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
            description: "Block hash" 
          },
          chainId: { 
            type: "number", 
            description: "Chain ID" 
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
            description: "Block hash" 
          },
          fullTransactions: { 
            type: "boolean", 
            description: "Return full transaction objects" 
          },
          chainId: { 
            type: "number", 
            description: "Chain ID" 
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
            description: "Block number or tag" 
          },
          fullTransactions: { 
            type: "boolean", 
            description: "Return full transaction objects" 
          },
          chainId: { 
            type: "number", 
            description: "Chain ID" 
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
            description: "Block number or tag" 
          },
          chainId: { 
            type: "number", 
            description: "Chain ID" 
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
            description: "Block hash" 
          },
          chainId: { 
            type: "number", 
            description: "Chain ID" 
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
            description: "Block number or tag" 
          },
          chainId: { 
            type: "number", 
            description: "Chain ID" 
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
            description: "Block hash" 
          },
          index: { 
            type: "string", 
            description: "Uncle index" 
          },
          chainId: { 
            type: "number", 
            description: "Chain ID" 
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
            description: "Block number or tag" 
          },
          index: { 
            type: "string", 
            description: "Uncle index" 
          },
          chainId: { 
            type: "number", 
            description: "Chain ID" 
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
            description: "Chain ID" 
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
            description: "Chain ID" 
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
            description: "Chain ID" 
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
            description: "Override chain ID for routing" 
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
            description: "Chain ID" 
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
            description: "Chain ID" 
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
            description: "Chain ID" 
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
            description: "Chain ID" 
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
      return args.blockNumber 
        ? [args.transaction, args.blockNumber] 
        : [args.transaction];
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

const handler = async (request: Request): Promise<Response> => {
  // Set CORS headers for all responses
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*", // Allow requests from any origin
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization", // Adjust as needed
  };

  // Serve logo SVG at GET /logo.svg
  if ((request.method === "GET" || request.method === "HEAD") && new URL(request.url).pathname === "/logo.svg") {
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="96" height="96" viewBox="0 0 96 96" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M90.2449 26.0946C90.2449 24.6236 89.4133 23.2165 88.134 22.449L50.2014 0.575616C49.5617 0.191872 48.8581 0 48.0905 0C47.3868 0 46.6192 0.191872 45.9795 0.575616L8.11092 22.449C6.83157 23.2165 6 24.5596 6 26.0946V69.9054C6 71.3764 6.83157 72.7835 8.11092 73.551L46.0435 95.4244C47.3229 96.1919 48.922 96.1919 50.2014 95.4244L88.134 73.551C89.4133 72.7835 90.2449 71.4404 90.2449 69.9054V26.0946ZM82.6328 66.068C82.6328 67.7948 81.7373 69.3937 80.266 70.2252L50.4573 87.8135C49.7536 88.2612 48.922 88.453 48.0905 88.453C47.2589 88.453 46.4913 88.2612 45.7237 87.8135L15.9149 70.2252C14.4437 69.3937 13.5481 67.7948 13.5481 66.068V34.4091C13.5481 33.6416 13.9319 32.8741 14.6356 32.4903C15.3392 32.1066 16.1068 32.1066 16.8105 32.4903L21.9279 35.4963C23.1432 36.1999 23.8469 37.6069 24.7424 39.2059C24.9343 39.5256 25.0622 39.8454 25.2541 40.1013C27.493 44.1306 28.5804 48.4157 29.6039 52.573C31.5229 60.1839 33.442 68.0506 43.229 70.6089C46.4273 71.4404 49.8815 71.4404 53.0799 70.6089C62.8029 68.0506 64.7859 60.1839 66.7049 52.573C67.7284 48.4157 68.8159 44.1306 71.0547 40.1013C71.2466 39.7815 71.3746 39.4617 71.5665 39.2059C72.398 37.6069 73.1656 36.2638 74.381 35.4963L79.4984 32.4903C80.1381 32.1066 80.9696 32.1066 81.6733 32.4903C82.3769 32.8741 82.7607 33.5776 82.7607 34.4091V66.068H82.6328ZM45.8516 8.57029C47.2589 7.73884 48.986 7.73884 50.3933 8.57029L76.1721 23.8561C76.8118 24.2398 77.1956 24.4957 77.1956 25.2632C77.1956 26.0306 76.8118 26.4783 76.1721 26.8621L71.2466 29.8041C69.0717 31.0833 67.9843 33.1299 67.0248 34.9847L66.9608 35.1126C66.8329 35.3684 66.7049 35.5603 66.577 35.8161C64.1462 40.1652 62.3552 44.7701 61.3317 48.8634C59.2847 56.7941 58.5171 62.0386 51.8645 63.7655C50.6492 64.0853 49.3698 64.2132 48.1544 64.2132C46.8751 64.2132 45.6597 64.0213 44.4443 63.7655C37.7917 62.0386 36.9602 56.7941 34.9772 48.7995C33.9537 44.7062 32.1626 40.1013 29.7319 35.7522C29.6039 35.5603 29.476 35.3045 29.3481 35.1126L29.2841 34.9207C28.3246 33.1299 27.1732 31.0193 25.0622 29.7402L20.1368 26.7981C19.4971 26.4144 19.1133 25.9667 19.1133 25.1992C19.1133 24.4317 19.4971 24.1759 20.1368 23.7921L45.8516 8.57029Z" fill="url(#paint0_linear_1101_5)"/>
<defs>
<linearGradient id="paint0_linear_1101_5" x1="90.2449" y1="0" x2="5.96876" y2="95.959" gradientUnits="userSpaceOnUse">
<stop stop-color="#00FFBF"/>
<stop offset="1" stop-color="#00BFFF"/>
</linearGradient>
</defs>
</svg>
`;
    return new Response(svg, {
      status: 200,
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        ...corsHeaders,
      },
    });
  }

  // Serve HTML at GET /
  if ((request.method === "GET" || request.method === "HEAD") && new URL(request.url).pathname === "/") {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>RPC Gateway | Ubiquity DAO</title>
  <meta name="viewport" content="width=320, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/logo.svg">
  <style>
    html, body { height: 100%; margin: 0; background: #fff; }
    body { display: flex; align-items: center; justify-content: center; height: 100vh; }
    .logo { width: 50vw; height: 50vh; }
  </style>
</head>
<body>
  <div>
    <img class="logo" src="/logo.svg" width="96" height="96" alt="Ubiquity Logo" />
  </div>
</body>
</html>`;
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...corsHeaders,
      },
    });
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
          protocolVersion: "2024-11-05",
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

      case "tools/call":
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

      default:
        mcpResponse = {
          error: {
            code: -32601,
            message: `Method not found: ${mcpRequest.method}`,
          },
        };
    }

    // Return MCP response
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: mcpRequest.id,
      result: mcpResponse.error ? undefined : mcpResponse,
      error: mcpResponse.error,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
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
      const errorResponse = createJsonRpcError(null, -32600, "Invalid Request: Batch contains invalid JSON-RPC object(s).");
      return new Response(JSON.stringify(errorResponse), {
        status: 200, // JSON-RPC compliance: invalid requests return HTTP 200
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Process batch requests concurrently
    const promises = requestBody.map(async (req) => {
      try {
        const result = await manager.send(chainId, req.method, req.params ?? []);
        return { jsonrpc: "2.0", id: req.id, result } as JsonRpcResponse;
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        console.error(`Error processing batch item (id: ${req.id}, method: ${req.method}) for chain ${chainId}:`, error);

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
    });

    const responses = await Promise.all(promises);

    return new Response(JSON.stringify(responses), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } // --- Handle Single Request ---
  else if (isValidJsonRpcRequest(requestBody)) {
    console.log(`Received single request for chain ${chainId}: ${requestBody.method}`);
    try {
      const result = await manager.send(chainId, requestBody.method, requestBody.params ?? []);
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
      console.error(`Error processing single request (id: ${requestBody.id}, method: ${requestBody.method}) for chain ${chainId}:`, error);

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

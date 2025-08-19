#!/usr/bin/env deno run --allow-all

import { parseArgs } from "https://deno.land/std@0.224.0/cli/parse_args.ts";
import { SimpleMcpServer } from "./mcp-simple-server.ts";

interface CliOptions {
  transport: "stdio";
  rpcBaseUrl?: string;
  help?: boolean;
}

function printUsage() {
  console.log(`
Ethereum JSON-RPC MCP Server (Using Load Balancer)

USAGE:
  deno run --allow-all mcp-ethereum-server.ts [OPTIONS]

OPTIONS:
  --rpc-base-url <url>     Base URL for RPC load balancer (default: https://rpc.ubq.fi)
  --help                   Show this help message

EXAMPLES:
  # Run with default load balancer (rpc.ubq.fi)
  deno run --allow-all mcp-ethereum-server.ts

  # Run with custom load balancer
  deno run --allow-all mcp-ethereum-server.ts --rpc-base-url https://custom-rpc.example.com

ETHEREUM JSON-RPC METHODS:
  This server exposes all standard Ethereum JSON-RPC methods as MCP tools.
  All calls are routed through the load balancer at {rpcBaseUrl}/{chainId}

  Core Methods:
  - eth_getBalance, eth_getCode, eth_getTransactionCount, eth_getStorageAt
  - eth_call, eth_estimateGas, eth_blockNumber, eth_sendRawTransaction

  Block Methods:
  - eth_getBlockByHash, eth_getBlockByNumber, eth_getBlockTransactionCountByHash
  - eth_getBlockTransactionCountByNumber, eth_getUncleCountByBlockHash, eth_getUncleCountByBlockNumber

  Transaction Methods:
  - eth_getTransactionByHash, eth_getTransactionByBlockHashAndIndex
  - eth_getTransactionByBlockNumberAndIndex, eth_getTransactionReceipt
  - eth_getUncleByBlockHashAndIndex, eth_getUncleByBlockNumberAndIndex

  Network Info:
  - eth_protocolVersion, eth_syncing, eth_coinbase, eth_chainId
  - eth_mining, eth_hashrate, eth_gasPrice, eth_accounts

All methods support a 'chainId' parameter (default: 1 for Ethereum mainnet).
`);
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["rpc-base-url"],
    boolean: ["help"],
    default: {
      "rpc-base-url": "https://rpc.ubq.fi",
    },
  }) as CliOptions;

  if (args.help) {
    printUsage();
    Deno.exit(0);
  }

  const rpcBaseUrl = args.rpcBaseUrl || args["rpc-base-url"] || "https://rpc.ubq.fi";

  try {
    // Create simplified MCP server that uses load balancer
    const server = new SimpleMcpServer(rpcBaseUrl);
    
    console.error(`Starting Ethereum MCP Server using load balancer: ${rpcBaseUrl}`);
    await server.run();
  } catch (error) {
    console.error("Failed to start server:", error);
    Deno.exit(1);
  }
}

// Handle uncaught errors
globalThis.addEventListener("error", (event) => {
  console.error("Uncaught error:", event.error);
});

globalThis.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled rejection:", event.reason);
});

if (import.meta.main) {
  await main();
}
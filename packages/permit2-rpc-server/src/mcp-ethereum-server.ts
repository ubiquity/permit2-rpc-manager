#!/usr/bin/env deno run --allow-all

import { parseArgs } from "https://deno.land/std@0.224.0/cli/parse_args.ts";
import { Permit2RpcManager } from "./permit2-rpc-manager.ts";
import { EthereumMcpServer } from "./mcp-server.ts";
import { EthereumMcpHttpServer, StreamableHttpServerOptions } from "./mcp-http-server.ts";

interface CliOptions {
  transport: "stdio" | "http";
  port?: number;
  host?: string;
  cors?: boolean;
  config?: string;
  help?: boolean;
}

function printUsage() {
  console.log(`
Ethereum JSON-RPC MCP Server

USAGE:
  deno run --allow-all mcp-ethereum-server.ts [OPTIONS]

OPTIONS:
  --transport <stdio|http>  Transport type (default: stdio)
  --port <number>          HTTP server port (default: 3000)
  --host <string>          HTTP server host (default: 127.0.0.1)
  --cors                   Enable CORS for HTTP server
  --config <path>          Path to configuration file
  --help                   Show this help message

EXAMPLES:
  # Run with stdio transport (for MCP clients)
  deno run --allow-all mcp-ethereum-server.ts

  # Run HTTP server on port 8080
  deno run --allow-all mcp-ethereum-server.ts --transport http --port 8080

  # Run HTTP server with CORS enabled
  deno run --allow-all mcp-ethereum-server.ts --transport http --cors

ETHEREUM JSON-RPC METHODS:
  This server exposes all standard Ethereum JSON-RPC methods as MCP tools:

  Core Methods:
  - eth_getBalance: Get account balance
  - eth_getCode: Get contract code
  - eth_getTransactionCount: Get transaction count (nonce)
  - eth_getStorageAt: Get storage value at position
  - eth_call: Execute contract call
  - eth_estimateGas: Estimate gas for transaction
  - eth_blockNumber: Get latest block number
  - eth_sendRawTransaction: Send signed transaction

  Block Methods:
  - eth_getBlockByHash: Get block by hash
  - eth_getBlockByNumber: Get block by number
  - eth_getBlockTransactionCountByHash: Get transaction count in block by hash
  - eth_getBlockTransactionCountByNumber: Get transaction count in block by number
  - eth_getUncleCountByBlockHash: Get uncle count by block hash
  - eth_getUncleCountByBlockNumber: Get uncle count by block number

  Transaction Methods:
  - eth_getTransactionByHash: Get transaction by hash
  - eth_getTransactionByBlockHashAndIndex: Get transaction by block hash and index
  - eth_getTransactionByBlockNumberAndIndex: Get transaction by block number and index
  - eth_getTransactionReceipt: Get transaction receipt
  - eth_getUncleByBlockHashAndIndex: Get uncle by block hash and index
  - eth_getUncleByBlockNumberAndIndex: Get uncle by block number and index

  Network Info:
  - eth_protocolVersion: Get protocol version
  - eth_syncing: Get sync status
  - eth_coinbase: Get coinbase address
  - eth_chainId: Get chain ID
  - eth_mining: Get mining status
  - eth_hashrate: Get mining hashrate
  - eth_gasPrice: Get current gas price
  - eth_accounts: Get available accounts

Each method supports an optional 'rpcUrl' parameter to override the default RPC endpoint.
`);
}

async function loadConfig(configPath?: string) {
  if (!configPath) {
    return {};
  }

  try {
    const configText = await Deno.readTextFile(configPath);
    return JSON.parse(configText);
  } catch (error) {
    console.error(`Failed to load config from ${configPath}:`, error);
    Deno.exit(1);
  }
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["transport", "port", "host", "config"],
    boolean: ["cors", "help"],
    default: {
      transport: "stdio",
      port: "3000",
      host: "127.0.0.1",
      cors: false,
    },
  }) as CliOptions;

  if (args.help) {
    printUsage();
    Deno.exit(0);
  }

  // Load configuration
  const config = await loadConfig(args.config);

  // Initialize RPC Manager
  const rpcManagerOptions = {
    maxConsecutiveFailures: config.maxConsecutiveFailures || 3,
    requestTimeoutMs: config.requestTimeoutMs || 30000,
    initialRpcData: config.initialRpcData,
    ...config,
  };

  // Add some default RPC URLs if none configured
  if (!rpcManagerOptions.initialRpcData) {
    console.log("No RPC URLs configured, using default Ethereum mainnet RPCs");
    rpcManagerOptions.initialRpcData = {
      rpcs: {
        "1": [
          "https://eth.llamarpc.com",
          "https://ethereum.publicnode.com",
          "https://eth.drpc.org",
        ],
      },
    };
  }

  const rpcManager = new Permit2RpcManager(rpcManagerOptions);

  try {
    if (args.transport === "http") {
      // HTTP Transport
      const httpOptions: StreamableHttpServerOptions = {
        port: parseInt(args.port as string) || 3000,
        host: args.host || "127.0.0.1",
        cors: args.cors || false,
        sessionTimeoutMs: config.sessionTimeoutMs || 300000,
      };

      const httpServer = new EthereumMcpHttpServer(rpcManager, httpOptions);
      
      console.log("Starting Ethereum MCP HTTP Server...");
      await httpServer.start();

      // Handle graceful shutdown
      const signals = ["SIGINT", "SIGTERM"] as const;
      for (const signal of signals) {
        Deno.addSignalListener(signal, async () => {
          console.log(`\nReceived ${signal}, shutting down...`);
          await httpServer.stop();
          Deno.exit(0);
        });
      }

      // Keep process alive
      console.log("Server started. Press Ctrl+C to stop.");
      await new Promise(() => {}); // Keep alive
    } else {
      // Stdio Transport
      const stdioServer = new EthereumMcpServer(rpcManager);
      
      console.error("Starting Ethereum MCP Server with stdio transport...");
      await stdioServer.run();
    }
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
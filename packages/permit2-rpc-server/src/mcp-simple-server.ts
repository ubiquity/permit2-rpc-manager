#!/usr/bin/env deno run --allow-all

import { Server } from "npm:@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "npm:@modelcontextprotocol/sdk/types.js";

/**
 * Simple MCP server that uses rpc.ubq.fi load balancer
 * instead of managing RPC connections directly
 */
export class SimpleMcpServer {
  private server: Server;
  private rpcBaseUrl: string;

  constructor(rpcBaseUrl = "https://rpc.ubq.fi") {
    this.rpcBaseUrl = rpcBaseUrl;
    this.server = new Server(
      {
        name: "ethereum-json-rpc-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    // List all available Ethereum JSON-RPC methods
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: this.getEthereumTools(),
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        // Get chain ID from arguments or default to mainnet
        const chainId = (args as any)?.chainId || 1;
        let params: unknown[];

        // Build parameters based on method
        params = this.buildRpcParams(name, args);

        // Execute via rpc.ubq.fi load balancer
        const result = await this.callRpcLoadBalancer(chainId, name, params);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to execute ${name}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  private getEthereumTools() {
    return [
      {
        name: "eth_getBalance",
        description: "Returns the balance of the account at the given address",
        inputSchema: {
          type: "object",
          properties: {
            address: { type: "string", description: "20-byte address to check for balance" },
            blockNumber: { type: "string", description: "Block number or 'latest', 'earliest', 'pending'" },
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: ["address", "blockNumber"],
        },
      },
      {
        name: "eth_getCode",
        description: "Returns code at a given address",
        inputSchema: {
          type: "object",
          properties: {
            address: { type: "string", description: "20-byte address" },
            blockNumber: { type: "string", description: "Block number or 'latest', 'earliest', 'pending'" },
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: ["address", "blockNumber"],
        },
      },
      {
        name: "eth_getTransactionCount",
        description: "Returns the number of transactions sent from an address",
        inputSchema: {
          type: "object",
          properties: {
            address: { type: "string", description: "20-byte address" },
            blockNumber: { type: "string", description: "Block number or 'latest', 'earliest', 'pending'" },
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: ["address", "blockNumber"],
        },
      },
      {
        name: "eth_call",
        description: "Executes a new message call immediately without creating a transaction",
        inputSchema: {
          type: "object",
          properties: {
            transaction: {
              type: "object",
              description: "Transaction call object",
              properties: {
                from: { type: "string", description: "20-byte address the transaction is sent from" },
                to: { type: "string", description: "20-byte address the transaction is directed to" },
                data: { type: "string", description: "Hash of the method signature and encoded parameters" },
              },
            },
            blockNumber: { type: "string", description: "Block number or 'latest', 'earliest', 'pending'" },
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: ["transaction", "blockNumber"],
        },
      },
      {
        name: "eth_blockNumber",
        description: "Returns the number of the most recent block",
        inputSchema: {
          type: "object",
          properties: {
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: [],
        },
      },
      {
        name: "eth_gasPrice",
        description: "Returns the current price per gas in wei",
        inputSchema: {
          type: "object",
          properties: {
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: [],
        },
      },
      {
        name: "eth_chainId",
        description: "Returns the currently configured chain id",
        inputSchema: {
          type: "object",
          properties: {
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: [],
        },
      },
      {
        name: "eth_getTransactionByHash",
        description: "Returns information about a transaction requested by transaction hash",
        inputSchema: {
          type: "object",
          properties: {
            transactionHash: { type: "string", description: "32-byte hash of a transaction" },
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: ["transactionHash"],
        },
      },
      {
        name: "eth_getTransactionReceipt",
        description: "Returns the receipt of a transaction by transaction hash",
        inputSchema: {
          type: "object",
          properties: {
            transactionHash: { type: "string", description: "32-byte hash of a transaction" },
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: ["transactionHash"],
        },
      },
      {
        name: "eth_getStorageAt",
        description: "Returns the value from a storage position at a given address",
        inputSchema: {
          type: "object",
          properties: {
            address: { type: "string", description: "20-byte address of the storage" },
            position: { type: "string", description: "Integer of the position in the storage" },
            blockNumber: { type: "string", description: "Block number or 'latest', 'earliest', 'pending'" },
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: ["address", "position", "blockNumber"],
        },
      },
      {
        name: "eth_estimateGas",
        description: "Generates and returns an estimate of how much gas is necessary to allow the transaction to complete",
        inputSchema: {
          type: "object",
          properties: {
            transaction: {
              type: "object",
              description: "Transaction call object",
              properties: {
                from: { type: "string", description: "20-byte address the transaction is sent from" },
                to: { type: "string", description: "20-byte address the transaction is directed to" },
                data: { type: "string", description: "Hash of the method signature and encoded parameters" },
                value: { type: "string", description: "Integer of the value sent with this transaction" },
              },
            },
            blockNumber: { type: "string", description: "Block number or 'latest', 'earliest', 'pending'" },
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: ["transaction"],
        },
      },
      {
        name: "eth_sendRawTransaction",
        description: "Submits a raw transaction",
        inputSchema: {
          type: "object",
          properties: {
            data: { type: "string", description: "The signed transaction data" },
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: ["data"],
        },
      },
      {
        name: "eth_getBlockByHash",
        description: "Returns information about a block by hash",
        inputSchema: {
          type: "object",
          properties: {
            blockHash: { type: "string", description: "32-byte hash of a block" },
            fullTransactionObjects: { type: "boolean", description: "If true returns full transaction objects, otherwise only hashes" },
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: ["blockHash", "fullTransactionObjects"],
        },
      },
      {
        name: "eth_getBlockByNumber",
        description: "Returns information about a block by number",
        inputSchema: {
          type: "object",
          properties: {
            blockNumber: { type: "string", description: "Block number or 'latest', 'earliest', 'pending'" },
            fullTransactionObjects: { type: "boolean", description: "If true returns full transaction objects, otherwise only hashes" },
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: ["blockNumber", "fullTransactionObjects"],
        },
      },
      {
        name: "eth_getBlockTransactionCountByHash",
        description: "Returns the number of transactions in a block by block hash",
        inputSchema: {
          type: "object",
          properties: {
            blockHash: { type: "string", description: "32-byte hash of a block" },
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: ["blockHash"],
        },
      },
      {
        name: "eth_getBlockTransactionCountByNumber",
        description: "Returns the number of transactions in a block by block number",
        inputSchema: {
          type: "object",
          properties: {
            blockNumber: { type: "string", description: "Block number or 'latest', 'earliest', 'pending'" },
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: ["blockNumber"],
        },
      },
      {
        name: "eth_getUncleCountByBlockHash",
        description: "Returns the number of uncles in a block by block hash",
        inputSchema: {
          type: "object",
          properties: {
            blockHash: { type: "string", description: "32-byte hash of a block" },
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: ["blockHash"],
        },
      },
      {
        name: "eth_getUncleCountByBlockNumber",
        description: "Returns the number of uncles in a block by block number",
        inputSchema: {
          type: "object",
          properties: {
            blockNumber: { type: "string", description: "Block number or 'latest', 'earliest', 'pending'" },
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: ["blockNumber"],
        },
      },
      {
        name: "eth_getTransactionByBlockHashAndIndex",
        description: "Returns information about a transaction by block hash and transaction index position",
        inputSchema: {
          type: "object",
          properties: {
            blockHash: { type: "string", description: "32-byte hash of a block" },
            index: { type: "string", description: "Integer of the transaction index position" },
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: ["blockHash", "index"],
        },
      },
      {
        name: "eth_getTransactionByBlockNumberAndIndex",
        description: "Returns information about a transaction by block number and transaction index position",
        inputSchema: {
          type: "object",
          properties: {
            blockNumber: { type: "string", description: "Block number or 'latest', 'earliest', 'pending'" },
            index: { type: "string", description: "Integer of the transaction index position" },
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: ["blockNumber", "index"],
        },
      },
      {
        name: "eth_getUncleByBlockHashAndIndex",
        description: "Returns information about an uncle by block hash and uncle index position",
        inputSchema: {
          type: "object",
          properties: {
            blockHash: { type: "string", description: "32-byte hash of a block" },
            index: { type: "string", description: "Integer of the uncle index position" },
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: ["blockHash", "index"],
        },
      },
      {
        name: "eth_getUncleByBlockNumberAndIndex",
        description: "Returns information about an uncle by block number and uncle index position",
        inputSchema: {
          type: "object",
          properties: {
            blockNumber: { type: "string", description: "Block number or 'latest', 'earliest', 'pending'" },
            index: { type: "string", description: "Integer of the uncle index position" },
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: ["blockNumber", "index"],
        },
      },
      {
        name: "eth_protocolVersion",
        description: "Returns the current ethereum protocol version",
        inputSchema: {
          type: "object",
          properties: {
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: [],
        },
      },
      {
        name: "eth_syncing",
        description: "Returns an object with data about the sync status or false",
        inputSchema: {
          type: "object",
          properties: {
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: [],
        },
      },
      {
        name: "eth_coinbase",
        description: "Returns the client coinbase address",
        inputSchema: {
          type: "object",
          properties: {
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: [],
        },
      },
      {
        name: "eth_mining",
        description: "Returns true if client is actively mining new blocks",
        inputSchema: {
          type: "object",
          properties: {
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: [],
        },
      },
      {
        name: "eth_hashrate",
        description: "Returns the number of hashes per second that the node is mining with",
        inputSchema: {
          type: "object",
          properties: {
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: [],
        },
      },
      {
        name: "eth_accounts",
        description: "Returns a list of addresses owned by client",
        inputSchema: {
          type: "object",
          properties: {
            chainId: { type: "number", description: "Chain ID (default: 1 for Ethereum mainnet)" },
          },
          required: [],
        },
      },
    ];
  }

  private buildRpcParams(method: string, args: any): unknown[] {
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
        return [args.data];
      case "eth_getBlockByHash":
        return [args.blockHash, args.fullTransactionObjects];
      case "eth_getBlockByNumber":
        return [args.blockNumber, args.fullTransactionObjects];
      case "eth_getBlockTransactionCountByHash":
        return [args.blockHash];
      case "eth_getBlockTransactionCountByNumber":
        return [args.blockNumber];
      case "eth_getUncleCountByBlockHash":
        return [args.blockHash];
      case "eth_getUncleCountByBlockNumber":
        return [args.blockNumber];
      case "eth_getTransactionByHash":
        return [args.transactionHash];
      case "eth_getTransactionByBlockHashAndIndex":
        return [args.blockHash, args.index];
      case "eth_getTransactionByBlockNumberAndIndex":
        return [args.blockNumber, args.index];
      case "eth_getTransactionReceipt":
        return [args.transactionHash];
      case "eth_getUncleByBlockHashAndIndex":
        return [args.blockHash, args.index];
      case "eth_getUncleByBlockNumberAndIndex":
        return [args.blockNumber, args.index];
      case "eth_blockNumber":
      case "eth_gasPrice":
      case "eth_chainId":
      case "eth_protocolVersion":
      case "eth_syncing":
      case "eth_coinbase":
      case "eth_mining":
      case "eth_hashrate":
      case "eth_accounts":
        return [];
      default:
        throw new McpError(ErrorCode.InvalidRequest, `Unknown tool: ${method}`);
    }
  }

  private async callRpcLoadBalancer(chainId: number, method: string, params: unknown[]): Promise<unknown> {
    const url = `${this.rpcBaseUrl}/${chainId}`;
    const requestBody = {
      jsonrpc: "2.0",
      method,
      params,
      id: Math.floor(Math.random() * 1000000),
    };

    console.error(`Calling ${url} with method ${method}`);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const jsonResponse = await response.json();

      if (jsonResponse.error) {
        throw new McpError(ErrorCode.InternalError, `RPC Error: ${jsonResponse.error.message}`);
      }

      return jsonResponse.result;
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(
        ErrorCode.InternalError,
        `RPC call failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

// Main entry point
if (import.meta.main) {
  const rpcBaseUrl = Deno.env.get("RPC_BASE_URL") || "https://rpc.ubq.fi";
  const server = new SimpleMcpServer(rpcBaseUrl);
  
  console.error(`Starting MCP server using load balancer: ${rpcBaseUrl}`);
  await server.run();
}
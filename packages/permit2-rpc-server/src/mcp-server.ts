import { Server } from "npm:@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "npm:@modelcontextprotocol/sdk/types.js";
import { Permit2RpcManager } from "./permit2-rpc-manager.ts";

export interface EthereumJsonRpcParams {
  method: string;
  params: unknown[];
  rpcUrl?: string;
}

export class EthereumMcpServer {
  private server: Server;
  private rpcManager: Permit2RpcManager;

  constructor(rpcManager: Permit2RpcManager) {
    this.rpcManager = rpcManager;
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
        tools: [
          // Core Ethereum methods
          {
            name: "eth_getBalance",
            description: "Returns the balance of the account at the given address",
            inputSchema: {
              type: "object",
              properties: {
                address: { type: "string", description: "20-byte address to check for balance" },
                blockNumber: { type: "string", description: "Block number or 'latest', 'earliest', 'pending'" },
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
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
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
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
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
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
                address: { type: "string", description: "20-byte address of the storage" },
                position: { type: "string", description: "Integer of the position in the storage" },
                blockNumber: { type: "string", description: "Block number or 'latest', 'earliest', 'pending'" },
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
              },
              required: ["address", "position", "blockNumber"],
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
                    gas: { type: "string", description: "Integer of the gas provided for the transaction execution" },
                    gasPrice: { type: "string", description: "Integer of the gasPrice used for each paid gas" },
                    value: { type: "string", description: "Integer of the value sent with this transaction" },
                    data: { type: "string", description: "Hash of the method signature and encoded parameters" },
                  },
                },
                blockNumber: { type: "string", description: "Block number or 'latest', 'earliest', 'pending'" },
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
              },
              required: ["transaction", "blockNumber"],
            },
          },
          {
            name: "eth_estimateGas",
            description: "Generates and returns an estimate of how much gas is necessary for a transaction",
            inputSchema: {
              type: "object",
              properties: {
                transaction: {
                  type: "object",
                  description: "Transaction call object",
                  properties: {
                    from: { type: "string", description: "20-byte address the transaction is sent from" },
                    to: { type: "string", description: "20-byte address the transaction is directed to" },
                    gas: { type: "string", description: "Integer of the gas provided for the transaction execution" },
                    gasPrice: { type: "string", description: "Integer of the gasPrice used for each paid gas" },
                    value: { type: "string", description: "Integer of the value sent with this transaction" },
                    data: { type: "string", description: "Hash of the method signature and encoded parameters" },
                  },
                },
                blockNumber: { type: "string", description: "Block number or 'latest', 'earliest', 'pending'" },
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
              },
              required: ["transaction"],
            },
          },
          {
            name: "eth_blockNumber",
            description: "Returns the number of the most recent block",
            inputSchema: {
              type: "object",
              properties: {
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
              },
              required: [],
            },
          },
          {
            name: "eth_sendRawTransaction",
            description: "Submits a pre-signed transaction for broadcast to the Ethereum network",
            inputSchema: {
              type: "object",
              properties: {
                signedTransactionData: { type: "string", description: "Signed transaction data" },
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
              },
              required: ["signedTransactionData"],
            },
          },
          // Block and transaction methods
          {
            name: "eth_getBlockByHash",
            description: "Returns information about a block by hash",
            inputSchema: {
              type: "object",
              properties: {
                blockHash: { type: "string", description: "32-byte hash of a block" },
                fullTxObjects: { type: "boolean", description: "If true returns full transaction objects, if false returns transaction hashes" },
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
              },
              required: ["blockHash", "fullTxObjects"],
            },
          },
          {
            name: "eth_getBlockByNumber",
            description: "Returns information about a block by block number",
            inputSchema: {
              type: "object",
              properties: {
                blockNumber: { type: "string", description: "Integer block number or 'latest', 'earliest', 'pending'" },
                fullTxObjects: { type: "boolean", description: "If true returns full transaction objects, if false returns transaction hashes" },
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
              },
              required: ["blockNumber", "fullTxObjects"],
            },
          },
          {
            name: "eth_getTransactionByHash",
            description: "Returns information about a transaction requested by transaction hash",
            inputSchema: {
              type: "object",
              properties: {
                transactionHash: { type: "string", description: "32-byte hash of a transaction" },
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
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
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
              },
              required: ["transactionHash"],
            },
          },
          // Network and protocol info
          {
            name: "eth_protocolVersion",
            description: "Returns the current Ethereum protocol version",
            inputSchema: {
              type: "object",
              properties: {
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
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
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
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
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
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
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
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
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
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
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
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
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
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
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
              },
              required: [],
            },
          },
          // Additional block and transaction methods
          {
            name: "eth_getBlockTransactionCountByHash",
            description: "Returns the number of transactions in a block from a block matching the given block hash",
            inputSchema: {
              type: "object",
              properties: {
                blockHash: { type: "string", description: "32-byte hash of a block" },
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
              },
              required: ["blockHash"],
            },
          },
          {
            name: "eth_getBlockTransactionCountByNumber",
            description: "Returns the number of transactions in a block matching the given block number",
            inputSchema: {
              type: "object",
              properties: {
                blockNumber: { type: "string", description: "Integer block number or 'latest', 'earliest', 'pending'" },
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
              },
              required: ["blockNumber"],
            },
          },
          {
            name: "eth_getUncleCountByBlockHash",
            description: "Returns the number of uncles in a block from a block matching the given block hash",
            inputSchema: {
              type: "object",
              properties: {
                blockHash: { type: "string", description: "32-byte hash of a block" },
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
              },
              required: ["blockHash"],
            },
          },
          {
            name: "eth_getUncleCountByBlockNumber",
            description: "Returns the number of uncles in a block from a block matching the given block number",
            inputSchema: {
              type: "object",
              properties: {
                blockNumber: { type: "string", description: "Integer block number or 'latest', 'earliest', 'pending'" },
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
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
                transactionIndex: { type: "string", description: "Integer of the transaction index position" },
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
              },
              required: ["blockHash", "transactionIndex"],
            },
          },
          {
            name: "eth_getTransactionByBlockNumberAndIndex",
            description: "Returns information about a transaction by block number and transaction index position",
            inputSchema: {
              type: "object",
              properties: {
                blockNumber: { type: "string", description: "Integer block number or 'latest', 'earliest', 'pending'" },
                transactionIndex: { type: "string", description: "Integer of the transaction index position" },
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
              },
              required: ["blockNumber", "transactionIndex"],
            },
          },
          {
            name: "eth_getUncleByBlockHashAndIndex",
            description: "Returns information about a uncle of a block by hash and uncle index position",
            inputSchema: {
              type: "object",
              properties: {
                blockHash: { type: "string", description: "32-byte hash of a block" },
                uncleIndex: { type: "string", description: "Integer of the uncle index position" },
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
              },
              required: ["blockHash", "uncleIndex"],
            },
          },
          {
            name: "eth_getUncleByBlockNumberAndIndex",
            description: "Returns information about a uncle of a block by number and uncle index position",
            inputSchema: {
              type: "object",
              properties: {
                blockNumber: { type: "string", description: "Integer block number or 'latest', 'earliest', 'pending'" },
                uncleIndex: { type: "string", description: "Integer of the uncle index position" },
                rpcUrl: { type: "string", description: "Optional RPC URL override" },
              },
              required: ["blockNumber", "uncleIndex"],
            },
          },
        ],
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        let params: unknown[];
        let rpcUrl: string | undefined;

        // Extract RPC URL if provided
        if (args && typeof args === "object" && "rpcUrl" in args) {
          rpcUrl = args.rpcUrl as string;
        }

        // Build parameters based on method
        switch (name) {
          case "eth_getBalance":
            params = [(args as any).address, (args as any).blockNumber];
            break;
          case "eth_getCode":
            params = [(args as any).address, (args as any).blockNumber];
            break;
          case "eth_getTransactionCount":
            params = [(args as any).address, (args as any).blockNumber];
            break;
          case "eth_getStorageAt":
            params = [(args as any).address, (args as any).position, (args as any).blockNumber];
            break;
          case "eth_call":
            params = [(args as any).transaction, (args as any).blockNumber];
            break;
          case "eth_estimateGas":
            params = [(args as any).transaction];
            if ((args as any).blockNumber) {
              params.push((args as any).blockNumber);
            }
            break;
          case "eth_sendRawTransaction":
            params = [(args as any).signedTransactionData];
            break;
          case "eth_getBlockByHash":
            params = [(args as any).blockHash, (args as any).fullTxObjects];
            break;
          case "eth_getBlockByNumber":
            params = [(args as any).blockNumber, (args as any).fullTxObjects];
            break;
          case "eth_getTransactionByHash":
            params = [(args as any).transactionHash];
            break;
          case "eth_getTransactionReceipt":
            params = [(args as any).transactionHash];
            break;
          case "eth_getBlockTransactionCountByHash":
            params = [(args as any).blockHash];
            break;
          case "eth_getBlockTransactionCountByNumber":
            params = [(args as any).blockNumber];
            break;
          case "eth_getUncleCountByBlockHash":
            params = [(args as any).blockHash];
            break;
          case "eth_getUncleCountByBlockNumber":
            params = [(args as any).blockNumber];
            break;
          case "eth_getTransactionByBlockHashAndIndex":
            params = [(args as any).blockHash, (args as any).transactionIndex];
            break;
          case "eth_getTransactionByBlockNumberAndIndex":
            params = [(args as any).blockNumber, (args as any).transactionIndex];
            break;
          case "eth_getUncleByBlockHashAndIndex":
            params = [(args as any).blockHash, (args as any).uncleIndex];
            break;
          case "eth_getUncleByBlockNumberAndIndex":
            params = [(args as any).blockNumber, (args as any).uncleIndex];
            break;
          // Methods with no parameters
          case "eth_blockNumber":
          case "eth_protocolVersion":
          case "eth_syncing":
          case "eth_coinbase":
          case "eth_chainId":
          case "eth_mining":
          case "eth_hashrate":
          case "eth_gasPrice":
          case "eth_accounts":
            params = [];
            break;
          default:
            throw new McpError(ErrorCode.InvalidRequest, `Unknown tool: ${name}`);
        }

        // Execute the JSON-RPC call
        const result = await this.executeJsonRpc(name, params, rpcUrl);

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

  private async executeJsonRpc(method: string, params: unknown[], rpcUrl?: string): Promise<unknown> {
    // Use the permit2 RPC manager to execute the call
    // Default to Ethereum mainnet (chainId 1)
    const chainId = 1;
    
    try {
      const result = await this.rpcManager.send(chainId, method, params);
      return result;
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError, 
        `RPC Error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}
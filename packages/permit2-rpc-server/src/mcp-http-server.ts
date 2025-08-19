import { Server } from "npm:@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResponse,
  InitializeRequestSchema,
} from "npm:@modelcontextprotocol/sdk/types.js";
import { Permit2RpcManager } from "./permit2-rpc-manager.ts";

export interface StreamableHttpServerOptions {
  port?: number;
  host?: string;
  cors?: boolean;
  sessionTimeoutMs?: number;
}

export class EthereumMcpHttpServer {
  private server: Server;
  private rpcManager: Permit2RpcManager;
  private httpServer?: Deno.HttpServer;
  private options: Required<StreamableHttpServerOptions>;
  private sessions = new Map<string, { lastActivity: number }>();

  constructor(rpcManager: Permit2RpcManager, options: StreamableHttpServerOptions = {}) {
    this.rpcManager = rpcManager;
    this.options = {
      port: options.port ?? 3000,
      host: options.host ?? "127.0.0.1",
      cors: options.cors ?? false,
      sessionTimeoutMs: options.sessionTimeoutMs ?? 300000, // 5 minutes
    };

    this.server = new Server(
      {
        name: "ethereum-json-rpc-http-server",
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

    // Handle initialization
    this.server.setRequestHandler(InitializeRequestSchema, async (request) => {
      return {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "ethereum-json-rpc-http-server",
          version: "1.0.0",
        },
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return await this.handleToolCall(request);
    });
  }

  private getEthereumTools() {
    return [
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
      // Additional methods
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
    ];
  }

  private async handleToolCall(request: any): Promise<any> {
    const { name, arguments: args } = request.params;

    try {
      let params: unknown[];
      let rpcUrl: string | undefined;

      // Extract RPC URL if provided
      if (args && typeof args === "object" && "rpcUrl" in args) {
        rpcUrl = args.rpcUrl as string;
      }

      // Build parameters based on method
      params = this.buildRpcParams(name, args);

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
        const estimateParams = [args.transaction];
        if (args.blockNumber) {
          estimateParams.push(args.blockNumber);
        }
        return estimateParams;
      case "eth_sendRawTransaction":
        return [args.signedTransactionData];
      case "eth_getBlockByHash":
        return [args.blockHash, args.fullTxObjects];
      case "eth_getBlockByNumber":
        return [args.blockNumber, args.fullTxObjects];
      case "eth_getTransactionByHash":
        return [args.transactionHash];
      case "eth_getTransactionReceipt":
        return [args.transactionHash];
      case "eth_getBlockTransactionCountByHash":
        return [args.blockHash];
      case "eth_getBlockTransactionCountByNumber":
        return [args.blockNumber];
      case "eth_getUncleCountByBlockHash":
        return [args.blockHash];
      case "eth_getUncleCountByBlockNumber":
        return [args.blockNumber];
      case "eth_getTransactionByBlockHashAndIndex":
        return [args.blockHash, args.transactionIndex];
      case "eth_getTransactionByBlockNumberAndIndex":
        return [args.blockNumber, args.transactionIndex];
      case "eth_getUncleByBlockHashAndIndex":
        return [args.blockHash, args.uncleIndex];
      case "eth_getUncleByBlockNumberAndIndex":
        return [args.blockNumber, args.uncleIndex];
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
        return [];
      default:
        throw new McpError(ErrorCode.InvalidRequest, `Unknown tool: ${method}`);
    }
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

  private generateSessionId(): string {
    return crypto.randomUUID();
  }

  private updateSessionActivity(sessionId: string) {
    this.sessions.set(sessionId, { lastActivity: Date.now() });
  }

  private cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastActivity > this.options.sessionTimeoutMs) {
        this.sessions.delete(sessionId);
      }
    }
  }

  private async handleHttpRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 200,
        headers: this.getCorsHeaders(),
      });
    }

    // Validate Origin header for security (DNS rebinding protection)
    const origin = request.headers.get("origin");
    if (origin && !this.isOriginAllowed(origin)) {
      return new Response("Forbidden: Invalid origin", { status: 403 });
    }

    try {
      if (request.method === "POST") {
        return await this.handlePostRequest(request);
      } else if (request.method === "GET") {
        return await this.handleGetRequest(request);
      } else {
        return new Response("Method not allowed", { 
          status: 405,
          headers: this.getCorsHeaders(),
        });
      }
    } catch (error) {
      console.error("HTTP request error:", error);
      return new Response("Internal server error", { 
        status: 500,
        headers: this.getCorsHeaders(),
      });
    }
  }

  private async handlePostRequest(request: Request): Promise<Response> {
    const acceptHeader = request.headers.get("accept") || "";
    if (!acceptHeader.includes("application/json") && !acceptHeader.includes("text/event-stream")) {
      return new Response("Bad Request: Must accept application/json or text/event-stream", { 
        status: 400,
        headers: this.getCorsHeaders(),
      });
    }

    let sessionId = request.headers.get("Mcp-Session-Id");
    const body = await request.text();
    let jsonrpcMessage: JSONRPCMessage;

    try {
      jsonrpcMessage = JSON.parse(body);
    } catch (error) {
      return new Response("Bad Request: Invalid JSON", { 
        status: 400,
        headers: this.getCorsHeaders(),
      });
    }

    // Handle different types of JSON-RPC messages
    if ("method" in jsonrpcMessage) {
      // This is a request
      const jsonrpcRequest = jsonrpcMessage as JSONRPCRequest;
      
      // Generate session ID for initialize requests
      if (jsonrpcRequest.method === "initialize") {
        sessionId = this.generateSessionId();
      }

      if (sessionId) {
        this.updateSessionActivity(sessionId);
      }

      try {
        // Process the request through the server's request handlers
        let response: any;
        
        if (jsonrpcRequest.method === "initialize") {
          response = {
            jsonrpc: "2.0",
            id: jsonrpcRequest.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {
                tools: {},
              },
              serverInfo: {
                name: "ethereum-json-rpc-http-server",
                version: "1.0.0",
              },
            },
          };
        } else if (jsonrpcRequest.method === "tools/list") {
          const tools = this.getEthereumTools();
          response = {
            jsonrpc: "2.0",
            id: jsonrpcRequest.id,
            result: { tools },
          };
        } else if (jsonrpcRequest.method === "tools/call") {
          const toolResult = await this.handleToolCall({ params: jsonrpcRequest.params });
          response = {
            jsonrpc: "2.0",
            id: jsonrpcRequest.id,
            result: toolResult,
          };
        } else {
          response = {
            jsonrpc: "2.0",
            id: jsonrpcRequest.id,
            error: {
              code: ErrorCode.MethodNotFound,
              message: `Method ${jsonrpcRequest.method} not found`,
            },
          };
        }
        
        const headers = new Headers(this.getCorsHeaders());
        if (sessionId) {
          headers.set("Mcp-Session-Id", sessionId);
        }

        // For now, return JSON response
        headers.set("Content-Type", "application/json");
        
        return new Response(JSON.stringify(response), {
          status: 200,
          headers,
        });
      } catch (error) {
        console.error("Server error:", error);
        const errorResponse: JSONRPCResponse = {
          jsonrpc: "2.0",
          id: jsonrpcRequest.id,
          error: {
            code: ErrorCode.InternalError,
            message: error instanceof Error ? error.message : "Unknown error",
          },
        };

        const headers = new Headers(this.getCorsHeaders());
        if (sessionId) {
          headers.set("Mcp-Session-Id", sessionId);
        }
        headers.set("Content-Type", "application/json");

        return new Response(JSON.stringify(errorResponse), {
          status: 200,
          headers,
        });
      }
    } else {
      // This is a response or notification - return 202 Accepted
      if (sessionId) {
        this.updateSessionActivity(sessionId);
      }

      const headers = new Headers(this.getCorsHeaders());
      if (sessionId) {
        headers.set("Mcp-Session-Id", sessionId);
      }

      return new Response(null, {
        status: 202,
        headers,
      });
    }
  }

  private async handleGetRequest(request: Request): Promise<Response> {
    const acceptHeader = request.headers.get("accept") || "";
    if (!acceptHeader.includes("text/event-stream")) {
      return new Response("Method Not Allowed", { 
        status: 405,
        headers: this.getCorsHeaders(),
      });
    }

    // For now, return 405 as we're not implementing full SSE streaming
    // In a full implementation, this would open an SSE stream
    return new Response("Method Not Allowed: SSE streaming not implemented", { 
      status: 405,
      headers: this.getCorsHeaders(),
    });
  }

  private getCorsHeaders(): Record<string, string> {
    if (!this.options.cors) {
      return {};
    }

    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    };
  }

  private isOriginAllowed(origin: string): boolean {
    // For local development, allow localhost origins
    try {
      const url = new URL(origin);
      return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === this.options.host;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    // Clean up expired sessions periodically
    setInterval(() => {
      this.cleanupExpiredSessions();
    }, 60000); // Every minute

    this.httpServer = Deno.serve(
      {
        port: this.options.port,
        hostname: this.options.host,
      },
      (request) => this.handleHttpRequest(request)
    );

    console.log(`Ethereum MCP HTTP Server running at http://${this.options.host}:${this.options.port}`);
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      await this.httpServer.shutdown();
    }
  }
}
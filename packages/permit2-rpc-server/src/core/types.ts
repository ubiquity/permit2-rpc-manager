// Simple interface for JSON-RPC request structure
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params: unknown[] | Record<string, any>; // Allow both array and object params for MCP
  id: number | string | null; // Allow null ID for notifications, though we might not process them specially
}

// Define the structure for a JSON-RPC response
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

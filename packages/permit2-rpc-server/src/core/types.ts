// JSON-RPC request envelope. Property absence, rather than a null ID, marks a
// notification; positional params may be omitted and default to an empty list.
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: unknown[] | Record<string, unknown>;
  id?: number | string | null;
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

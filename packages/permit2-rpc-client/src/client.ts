// Basic JSON-RPC types (can be shared or refined)
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params: unknown[];
  id: number | string | null;
}

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

export interface ClientOptions {
  baseUrl: string;
  fetchOptions?: RequestInit; // Allow passing custom fetch options (e.g., headers, timeout via AbortSignal)
}

export interface Permit2RpcClient {
  request: <T = unknown>(chainId: number, payload: JsonRpcRequest | JsonRpcRequest[]) => Promise<JsonRpcResponse | JsonRpcResponse[] | T>;
}

export function createRpcClient(options: ClientOptions): Permit2RpcClient {
  if (!options.baseUrl || !options.baseUrl.startsWith("http")) {
    throw new Error("Invalid baseUrl provided. Must be a valid HTTP(S) URL.");
  }

  // Ensure baseUrl doesn't end with a slash
  const baseUrl = options.baseUrl.endsWith("/") ? options.baseUrl.slice(0, -1) : options.baseUrl;

  const client: Permit2RpcClient = {
    request: async <T = unknown>(chainId: number, payload: JsonRpcRequest | JsonRpcRequest[]): Promise<JsonRpcResponse | JsonRpcResponse[] | T> => {
      const url = `${baseUrl}/${chainId}`; // Removed /rpc segment

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...(options.fetchOptions?.headers || {}),
          },
          body: JSON.stringify(payload),
          ...(options.fetchOptions || {}), // Spread other fetch options like signal
        });

        if (!response.ok) {
          let errorBody = `HTTP error ${response.status}`;
          try {
            // Try to get more details from the response body
            const text = await response.text();
            errorBody += `: ${text}`;
            // Try to parse as JSON-RPC error if possible
            try {
              const jsonError = JSON.parse(text);
              if (jsonError.error?.code && jsonError.error?.message) {
                throw jsonError.error; // Re-throw as JSON-RPC error
              }
            } catch {
              /* Not a JSON-RPC error */
            }
          } catch {
            /* Ignore if reading body fails */
          }
          throw new Error(errorBody);
        }

        // Handle potential empty responses for certain status codes if necessary
        if (response.status === 204) {
          // Or handle based on request type (e.g., notifications might expect 204)
          return [] as JsonRpcResponse[]; // Example: return empty array for batch notifications
        }

        const responseData: JsonRpcResponse | JsonRpcResponse[] = await response.json();

        // Basic validation: Check if the response structure matches the request structure (single vs batch)
        if (Array.isArray(payload) && !Array.isArray(responseData)) {
          throw new Error("Invalid Response: Expected batch response (array) but received single object.");
        }
        if (!Array.isArray(payload) && Array.isArray(responseData)) {
          throw new Error("Invalid Response: Expected single response object but received array.");
        }

        // Check for JSON-RPC errors and throw them properly
        if (!Array.isArray(responseData) && responseData.error) {
          throw responseData.error; // Throw the full JSON-RPC error object
        }
        if (Array.isArray(responseData)) {
          const errorResponse = responseData.find((r) => r.error);
          if (errorResponse) {
            throw errorResponse.error; // Throw the first error found in batch
          }
        }

        // If the caller expects a specific type T and it's a single, successful response, return just the result
        if (!Array.isArray(responseData) && responseData.result !== undefined && responseData.error === undefined) {
          return responseData;
        }

        return responseData;
      } catch (error) {
        console.error(`[Permit2RpcClient] Error sending request to ${url}:`, error);
        // Re-throw the error as-is if it's already a JSON-RPC error
        if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
          throw error;
        }
        // Otherwise wrap non-JSON-RPC errors
        throw new Error(`RPC request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };

  return client;
}

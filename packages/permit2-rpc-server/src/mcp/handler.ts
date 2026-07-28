import type { Permit2RpcManager } from "../core/permit2-rpc-manager.ts";
import { redactRpcDiagnostic } from "../core/rpc-endpoint-id.ts";
import { buildRpcParams } from "./ethereum-rpc-params.ts";
import { getEthereumTools } from "./ethereum-tools.ts";

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

const isJsonRpcId = (value: unknown): value is string | number | null => {
  return typeof value === "string" || typeof value === "number" || value === null;
};

function parseChainIdFromSinglePathPart(pathParts: string[]): number {
  if (pathParts.length !== 1) return 1;
  const parsed = parseInt(pathParts[0], 10);
  return Number.isNaN(parsed) ? 1 : parsed;
}

function parseChainIdOverride(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

export function isMcpRequest(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;

  const candidate = body as Record<string, unknown>;
  if (candidate.jsonrpc !== "2.0" || typeof candidate.method !== "string") return false;
  if (hasOwn(candidate, "id") && !isJsonRpcId(candidate.id)) return false;
  if (hasOwn(candidate, "params") && (candidate.params === null || typeof candidate.params !== "object")) {
    return false;
  }

  const { method } = candidate;
  return method === "initialize" || method.startsWith("tools/") || method.startsWith("resources/") ||
    method.startsWith("prompts/");
}

export async function handleMcpRequest(options: {
  requestBody: unknown;
  pathParts: string[];
  manager: Pick<Permit2RpcManager, "send">;
  corsHeaders: Record<string, string>;
}): Promise<Response> {
  const mcpRequest = options.requestBody as any;
  const isNotification = !Object.prototype.hasOwnProperty.call(mcpRequest, "id");
  let mcpResponse: any;

  let chainId = parseChainIdFromSinglePathPart(options.pathParts);

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
      const overrideChainId = parseChainIdOverride(toolArgs.chainId);
      if (overrideChainId !== undefined) {
        chainId = overrideChainId;
      }

      // Build RPC parameters
      const params = buildRpcParams(toolName, toolArgs);

      try {
        // Execute via existing RPC manager
        const result = await options.manager.send(chainId, toolName, params);

        mcpResponse = {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        mcpResponse = {
          error: {
            code: -32603,
            message: redactRpcDiagnostic(error.message),
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

  if (isNotification) {
    return new Response(null, { status: 204, headers: options.corsHeaders });
  }

  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: mcpRequest.id,
      result: mcpResponse.error ? undefined : mcpResponse,
      error: mcpResponse.error,
    }),
    {
      status: 200,
      headers: { ...options.corsHeaders, "Content-Type": "application/json" },
    },
  );
}

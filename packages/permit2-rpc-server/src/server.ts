import { isMulticall3Request, type Multicall3Request } from "./evm/multicall3.ts";
import type { JsonRpcRequest, JsonRpcResponse } from "./core/types.ts";
import type { Permit2RpcManager } from "./core/permit2-rpc-manager.ts";
import { handleMcpRequest, isMcpRequest } from "./mcp/handler.ts";
import { getRpcEndpointId, redactRpcDiagnostic } from "./core/rpc-endpoint-id.ts";
import { SocketPeer } from "./infra/websocket.ts";
import type { RpcRuntime } from "./runtime.ts";

export type RequestHandlerManager = Pick<Permit2RpcManager, "getHealthStatus" | "multicall3" | "send">;

type JsonRpcId = JsonRpcResponse["id"];

interface PositionalJsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params: unknown[];
  id?: JsonRpcId;
}

interface NamedJsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
  id?: JsonRpcId;
}

type ParsedJsonRpcRequest =
  | { kind: "invalid" }
  | { kind: "named-params"; request: NamedJsonRpcRequest }
  | { kind: "positional"; request: PositionalJsonRpcRequest };

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number" || value === null;
}

/**
 * Parses only the JSON-RPC envelope. Ethereum RPC accepts positional params,
 * while named params remain a valid JSON-RPC envelope and are rejected later
 * with -32602.
 */
function parseJsonRpcRequest(value: unknown): ParsedJsonRpcRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "invalid" };
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.jsonrpc !== "2.0" || typeof candidate.method !== "string") {
    return { kind: "invalid" };
  }

  const idIsPresent = hasOwn(candidate, "id");
  if (idIsPresent && !isJsonRpcId(candidate.id)) {
    return { kind: "invalid" };
  }

  const base = {
    jsonrpc: "2.0" as const,
    method: candidate.method,
    ...(idIsPresent ? { id: candidate.id as JsonRpcId } : {}),
  };

  if (!hasOwn(candidate, "params")) {
    return { kind: "positional", request: { ...base, params: [] } };
  }

  if (Array.isArray(candidate.params)) {
    return { kind: "positional", request: { ...base, params: candidate.params } };
  }

  if (typeof candidate.params === "object" && candidate.params !== null) {
    return { kind: "named-params", request: { ...base, params: candidate.params as Record<string, unknown> } };
  }

  return { kind: "invalid" };
}

// Helper to create a JSON-RPC error response
function createJsonRpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

function isNotification(request: { id?: JsonRpcId }): boolean {
  return !hasOwn(request, "id");
}

const RPC_OVERRIDE_HEADER = "x-ubq-rpc-candidates";
const RPC_OVERRIDE_SINGLE_HEADER = "x-ubq-rpc-url";
const RPC_OVERRIDE_FALLBACK_HEADER = "x-ubq-rpc-fallback";

const parseBoolHeader = (value: string | null): boolean => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(normalized);
};

const parseRpcOverrideOptions = (headers: Headers): { rpcOverrides: string[]; allowFallback: boolean } | null => {
  const candidatesRaw = headers.get(RPC_OVERRIDE_HEADER);
  const singleRaw = headers.get(RPC_OVERRIDE_SINGLE_HEADER);
  const allowFallback = parseBoolHeader(headers.get(RPC_OVERRIDE_FALLBACK_HEADER));
  const candidates = [...(candidatesRaw ? candidatesRaw.split(",") : []), ...(singleRaw ? [singleRaw] : [])]
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (candidates.length === 0) return null;
  return { rpcOverrides: candidates, allowFallback };
};

/**
 * Creates the HTTP request handler without starting a listener. Keeping the
 * manager injectable makes the JSON-RPC request path directly testable.
 */
export function createHandler(
  manager: RequestHandlerManager,
  runtime: RpcRuntime,
): (request: Request) => Promise<Response> {
  return (request) => handleRequest(request, manager, runtime);
}

async function handleRequest(request: Request, manager: RequestHandlerManager, runtime: RpcRuntime): Promise<Response> {
  // Set CORS headers for all responses
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*", // Allow requests from any origin
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-UBQ-RPC-CANDIDATES, X-UBQ-RPC-URL, X-UBQ-RPC-FALLBACK",
  };
  const noContentResponse = () => new Response(null, { status: 204, headers: corsHeaders });

  // WebSocket JSON-RPC proxy (ws/wss). Connect clients to our server, proxy to an upstream WS RPC.
  const upgradeHeader = request.headers.get("upgrade");
  if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const pathParts = url.pathname.split("/").filter(Boolean);

    let chainId = 1; // default to Ethereum mainnet if not provided
    if (pathParts.length === 1) {
      const parsed = parseInt(pathParts[0], 10);
      if (Number.isNaN(parsed)) {
        return new Response("Not Found", { status: 404 });
      }
      chainId = parsed;
    } else if (pathParts.length > 1) {
      return new Response("Not Found", { status: 404 });
    }

    const { socket, response } = runtime.upgradeWebSocket(request);

    const queuedToUpstream: Array<string | ArrayBuffer> = [];
    const MAX_QUEUE = 256;
    let upstream: SocketPeer | null = null;
    let clientClosed = false;

    const sendToClient = (data: unknown) => {
      const send = (payload: string | ArrayBuffer) => {
        if (socket.readyState !== SocketPeer.OPEN) return;
        try {
          socket.send(payload);
        } catch {
          // ignore
        }
      };

      if (typeof data === "string") send(data);
      else if (data instanceof ArrayBuffer) send(data);
      else if (data instanceof Blob) {
        data
          .arrayBuffer()
          .then((buf) => send(buf))
          .catch(() => undefined);
      }
    };

    const enqueueToUpstream = (data: unknown) => {
      const sendOrQueue = (payload: string | ArrayBuffer) => {
        if (upstream && upstream.readyState === SocketPeer.OPEN) {
          try {
            upstream.send(payload);
          } catch {
            // ignore
          }
          return;
        }
        if (!upstream || upstream.readyState === SocketPeer.CONNECTING) {
          if (queuedToUpstream.length < MAX_QUEUE) {
            queuedToUpstream.push(payload);
          } else if (!clientClosed) {
            clientClosed = true;
            console.warn(
              `WebSocket upstream queue overflow (limit: ${MAX_QUEUE}) for chainId ${chainId}. Closing client connection.`,
            );
            try {
              socket.close(4000, "Upstream queue overflow");
            } catch {
              // ignore
            }
            try {
              upstream?.close();
            } catch {
              // ignore
            }
          }
        }
      };

      if (typeof data === "string") sendOrQueue(data);
      else if (data instanceof ArrayBuffer) sendOrQueue(data);
      else if (data instanceof Blob) {
        data
          .arrayBuffer()
          .then((buf) => sendOrQueue(buf))
          .catch(() => undefined);
      }
    };

    socket.onmessage = (event) => {
      enqueueToUpstream(event.data);
    };

    socket.onerror = () => {
      clientClosed = true;
      try {
        upstream?.close();
      } catch {
        // ignore
      }
    };

    socket.onclose = () => {
      clientClosed = true;
      try {
        upstream?.close();
      } catch {
        // ignore
      }
    };

    const connect = (async () => {
      const timeoutMs = Number.parseInt(runtime.env("WS_CONNECT_TIMEOUT_MS") ?? "5000", 10);
      const connectTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;

      const overrideCandidates = runtime.getWsOverrideCandidates(chainId);
      if (overrideCandidates.length > 0) {
        try {
          upstream = await runtime.connectFirstWebSocket(overrideCandidates, connectTimeout);
        } catch (error) {
          const message = error instanceof Error
            ? redactRpcDiagnostic(error.message)
            : "Failed to connect to configured WS override";
          runtime.wsLogger("warn", `WS override failed for chain ${chainId}: ${message}`);
        }
      }

      if (!upstream) {
        const rankedCandidates = await runtime.wsSelector.getRankedRpcList(chainId);
        if (rankedCandidates.length === 0) {
          try {
            socket.close(1011, `No upstream WS RPCs available for chain ${chainId}`);
          } catch {
            // ignore
          }
          return;
        }

        let lastError: Error | undefined;
        for (const candidate of rankedCandidates) {
          try {
            upstream = await runtime.openWebSocket(candidate, connectTimeout);
            break;
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            try {
              await runtime.wsCacheManager.invalidateRpcInCache(chainId, candidate, "eliminated");
            } catch {
              // ignore
            }
          }
        }

        if (!upstream) {
          const message = redactRpcDiagnostic(lastError?.message ?? "Failed to connect to upstream WebSocket");
          try {
            socket.close(1011, message);
          } catch {
            // ignore
          }
          return;
        }
      }

      if (clientClosed) {
        try {
          upstream.close();
        } catch {
          // ignore
        }
        return;
      }

      upstream.onmessage = (event) => {
        sendToClient(event.data);
      };

      upstream.onerror = () => {
        try {
          socket.close(1011, "Upstream WebSocket error");
        } catch {
          // ignore
        }
      };

      upstream.onclose = () => {
        try {
          socket.close(1011, "Upstream WebSocket closed");
        } catch {
          // ignore
        }
      };

      for (const payload of queuedToUpstream.splice(0, queuedToUpstream.length)) {
        try {
          upstream.send(payload);
        } catch {
          // ignore
        }
      }
    })();
    runtime.waitUntil(connect.catch((error) => {
      runtime.wsLogger("error", "Upstream WebSocket connection failed", error);
      try {
        socket.close(1011, "Upstream WebSocket connection failed");
      } catch { /* Already closed. */ }
    }));

    return response;
  }

  // Serve logo SVG at GET /logo.svg
  if ((request.method === "GET" || request.method === "HEAD") && new URL(request.url).pathname === "/logo.svg") {
    try {
      const ubiquityDaoLogo = await runtime.readStaticTextAsset("logo.svg");
      return new Response(ubiquityDaoLogo, {
        status: 200,
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          ...corsHeaders,
        },
      });
    } catch (error) {
      console.error("Failed to read static asset logo.svg:", redactRpcDiagnostic(error));
      return new Response("Not Found", {
        status: runtime.isNotFoundError(error) ? 404 : 500,
        headers: corsHeaders,
      });
    }
  }

  // Serve app.css at GET /app.css
  if ((request.method === "GET" || request.method === "HEAD") && new URL(request.url).pathname === "/app.css") {
    try {
      const css = await runtime.readStaticTextAsset("app.css");
      return new Response(css, {
        status: 200,
        headers: {
          "content-type": "text/css; charset=utf-8",
          ...corsHeaders,
        },
      });
    } catch (error) {
      console.error("Failed to read static asset app.css:", redactRpcDiagnostic(error));
      return new Response("Not Found", {
        status: runtime.isNotFoundError(error) ? 404 : 500,
        headers: corsHeaders,
      });
    }
  }

  // Serve app.js at GET /app.js
  if ((request.method === "GET" || request.method === "HEAD") && new URL(request.url).pathname === "/app.js") {
    try {
      const js = await runtime.readStaticTextAsset("app.js");
      return new Response(js, {
        status: 200,
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          ...corsHeaders,
        },
      });
    } catch (error) {
      console.error("Failed to read static asset app.js:", redactRpcDiagnostic(error));
      return new Response("Not Found", {
        status: runtime.isNotFoundError(error) ? 404 : 500,
        headers: corsHeaders,
      });
    }
  }

  // Serve health check JSON at GET /health
  if (request.method === "GET" && new URL(request.url).pathname === "/health") {
    try {
      // Get health data from manager
      const healthData = await manager.getHealthStatus();

      return new Response(JSON.stringify(healthData), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          ...corsHeaders,
        },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: "Failed to retrieve health status",
          message: redactRpcDiagnostic(error instanceof Error ? error.message : String(error)),
        }),
        {
          status: 500,
          headers: {
            "content-type": "application/json; charset=utf-8",
            ...corsHeaders,
          },
        },
      );
    }
  }

  // Serve HTML at GET /
  if ((request.method === "GET" || request.method === "HEAD") && new URL(request.url).pathname === "/") {
    try {
      const html = await runtime.readStaticTextAsset("index.html");
      return new Response(html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          ...corsHeaders,
        },
      });
    } catch (error) {
      console.error("Failed to read static asset index.html:", redactRpcDiagnostic(error));
      return new Response("Not Found", {
        status: runtime.isNotFoundError(error) ? 404 : 500,
        headers: corsHeaders,
      });
    }
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
    console.error("Failed to parse request body:", redactRpcDiagnostic(error));
    // Return JSON-RPC error for parse error
    const errorResponse = createJsonRpcError(null, -32700, `Parse error: ${redactRpcDiagnostic(error.message)}`);
    return new Response(JSON.stringify(errorResponse), {
      status: 200, // JSON-RPC compliance: parse errors return HTTP 200
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Check if this is an MCP request (at root path or with chainId)
  if (isMcpRequest(requestBody)) {
    return handleMcpRequest({ requestBody, pathParts, manager, corsHeaders });
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

  const overrideOptions = parseRpcOverrideOptions(request.headers);
  if (overrideOptions) {
    console.log(
      `Received RPC override headers for chain ${chainId}: ` +
        `${
          overrideOptions.rpcOverrides.map(getRpcEndpointId).join(", ")
        } (allowFallback=${overrideOptions.allowFallback})`,
    );
  }

  // --- Handle Batch Request ---
  if (Array.isArray(requestBody)) {
    console.log("Received batch request for chain " + chainId + " with " + requestBody.length + " calls.");

    if (requestBody.length === 0) {
      const errorResponse = createJsonRpcError(null, -32600, "Invalid Request: Received empty batch.");
      return new Response(JSON.stringify(errorResponse), {
        status: 200, // JSON-RPC compliance: invalid requests return HTTP 200
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    type MulticallCandidate = {
      index: number;
      originalRequest: PositionalJsonRpcRequest;
      syntheticId: string;
      request: Multicall3Request;
    };

    const responses: Array<JsonRpcResponse | undefined> = new Array(requestBody.length);
    const directRequests: Array<{ index: number; request: PositionalJsonRpcRequest }> = [];
    const multicallRequests: MulticallCandidate[] = [];

    for (const [index, value] of requestBody.entries()) {
      const parsed = parseJsonRpcRequest(value);
      if (parsed.kind === "invalid") {
        responses[index] = createJsonRpcError(null, -32600, "Invalid Request: Not a valid JSON-RPC object.");
        continue;
      }

      if (parsed.kind === "named-params") {
        if (!isNotification(parsed.request)) {
          responses[index] = createJsonRpcError(
            parsed.request.id ?? null,
            -32602,
            "Invalid params: Named parameters are not supported.",
          );
        }
        continue;
      }

      if (isNotification(parsed.request)) {
        directRequests.push({ index, request: parsed.request });
        continue;
      }

      // multicall3 deduplicates based on request IDs. Give each candidate a
      // unique per-batch ID, then restore the client ID below.
      const syntheticId = "__uos_multicall_" + index;
      const candidate: JsonRpcRequest = {
        jsonrpc: parsed.request.jsonrpc,
        id: syntheticId,
        method: parsed.request.method,
        params: parsed.request.params,
      };

      if (isMulticall3Request(chainId, candidate)) {
        multicallRequests.push({
          index,
          originalRequest: parsed.request,
          syntheticId,
          request: candidate,
        });
      } else {
        directRequests.push({ index, request: parsed.request });
      }
    }

    const directRequestPromises = directRequests.map(async ({ index, request: rpcRequest }) => {
      const notification = isNotification(rpcRequest);
      try {
        const result = await manager.send(chainId, rpcRequest.method, rpcRequest.params, overrideOptions ?? undefined);
        if (!notification) {
          responses[index] = { jsonrpc: "2.0", id: rpcRequest.id ?? null, result };
        }
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        console.error(
          "Error processing batch item (id: " + rpcRequest.id + ", method: " + rpcRequest.method + ") for chain " +
            chainId + ":",
          redactRpcDiagnostic(error),
        );

        if (notification) return;

        const code =
          ["JsonRpcError", "RpcBudgetExceeded", "RpcDiagnosticsPending"].includes(error.name) && "code" in error &&
            typeof error.code === "number"
            ? error.code
            : -32603;
        const data = "data" in error ? redactRpcDiagnostic(error.data) : undefined;
        responses[index] = {
          jsonrpc: "2.0",
          id: rpcRequest.id ?? null,
          error: {
            code,
            message: redactRpcDiagnostic(error.message),
            data,
          },
        };
      }
    });

    // Group multicall candidates by block tag and split each group into chunks
    // of 500 to avoid exceeding multicall limits.
    const multicallRequestsByBlockTag = new Map<string | number, MulticallCandidate[]>();
    for (const request of multicallRequests) {
      const blockTag = request.request.params[1];
      const requestsForBlockTag = multicallRequestsByBlockTag.get(blockTag) ?? [];
      requestsForBlockTag.push(request);
      multicallRequestsByBlockTag.set(blockTag, requestsForBlockTag);
    }

    const multicallPromises: Promise<void>[] = [];
    for (const [blockTag, requestsForBlockTag] of multicallRequestsByBlockTag) {
      for (let start = 0; start < requestsForBlockTag.length; start += 500) {
        const requestBatch = requestsForBlockTag.slice(start, start + 500);
        multicallPromises.push((async () => {
          try {
            const multicallResponses = await manager.multicall3(
              chainId,
              requestBatch.map(({ request: rpcRequest }) => rpcRequest),
              blockTag,
              overrideOptions ?? undefined,
            );
            const responsesBySyntheticId = new Map<string, JsonRpcResponse>();
            for (const response of multicallResponses) {
              if (typeof response.id === "string") {
                responsesBySyntheticId.set(response.id, response);
              }
            }

            for (const request of requestBatch) {
              const response = responsesBySyntheticId.get(request.syntheticId);
              if (!response) {
                responses[request.index] = createJsonRpcError(
                  request.originalRequest.id ?? null,
                  -32603,
                  "Internal error: Multicall response missing.",
                );
                continue;
              }
              responses[request.index] = { ...response, id: request.originalRequest.id ?? null };
            }
          } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            console.error(
              "Error processing multicall batch for chain " + chainId + ":",
              redactRpcDiagnostic(error),
            );
            const code =
              ["JsonRpcError", "RpcBudgetExceeded", "RpcDiagnosticsPending"].includes(error.name) && "code" in error &&
                typeof error.code === "number"
                ? error.code
                : -32603;
            const data = "data" in error ? redactRpcDiagnostic(error.data) : undefined;
            for (const request of requestBatch) {
              responses[request.index] = {
                jsonrpc: "2.0",
                id: request.originalRequest.id ?? null,
                error: {
                  code,
                  message: redactRpcDiagnostic(error.message),
                  data,
                },
              };
            }
          }
        })());
      }
    }

    await Promise.all([...directRequestPromises, ...multicallPromises]);

    const responseBody = responses.filter((response): response is JsonRpcResponse => response !== undefined);
    if (responseBody.length === 0) return noContentResponse();

    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // --- Handle Single Request ---
  const parsedRequest = parseJsonRpcRequest(requestBody);
  if (parsedRequest.kind === "positional") {
    console.log("Received single request for chain " + chainId + ": " + parsedRequest.request.method);
    const notification = isNotification(parsedRequest.request);
    try {
      const result = await manager.send(
        chainId,
        parsedRequest.request.method,
        parsedRequest.request.params,
        overrideOptions ?? undefined,
      );
      if (notification) return noContentResponse();
      const rpcResponse: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: parsedRequest.request.id ?? null,
        result,
      };
      return new Response(JSON.stringify(rpcResponse), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      console.error(
        "Error processing single request (id: " + parsedRequest.request.id + ", method: " +
          parsedRequest.request.method + ") for chain " + chainId + ":",
        redactRpcDiagnostic(error),
      );

      if (notification) return noContentResponse();

      const errorResponse = {
        jsonrpc: "2.0",
        id: parsedRequest.request.id ?? null,
        error: {
          code: "code" in error && typeof error.code === "number" ? error.code : -32603,
          message: redactRpcDiagnostic(error.message),
          data: "data" in error ? redactRpcDiagnostic(error.data) : undefined,
        },
      };

      return new Response(JSON.stringify(errorResponse), {
        // Application-level JSON-RPC errors always use the same response
        // status as their batch equivalents; protocol details stay in body.
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  if (parsedRequest.kind === "named-params") {
    if (isNotification(parsedRequest.request)) return noContentResponse();
    const errorResponse = createJsonRpcError(
      parsedRequest.request.id ?? null,
      -32602,
      "Invalid params: Named parameters are not supported.",
    );
    return new Response(JSON.stringify(errorResponse), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // --- Handle Invalid Request Structure ---
  console.error("Invalid request body structure:", redactRpcDiagnostic(requestBody));
  const errorResponse = createJsonRpcError(null, -32600, "Invalid Request: Not a valid JSON-RPC object or batch.");
  return new Response(JSON.stringify(errorResponse), {
    status: 200, // JSON-RPC compliance: invalid requests return HTTP 200
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/// <reference lib="deno.ns" />
// Deno Deploy entrypoint for the Permit2 RPC Manager Proxy with MCP compliance
import { isMulticall3Request, Multicall3Request } from "./evm/multicall3.ts";
import { JsonRpcRequest, JsonRpcResponse } from "./core/types.ts";
import { CacheManager } from "./infra/cache-manager.ts";
import { Permit2RpcManager } from "./core/permit2-rpc-manager.ts";
import type { Permit2RpcManagerOptions } from "./core/permit2-rpc-manager.ts";
import { RpcSelector } from "./core/rpc-selector.ts";
import { ChainlistWsDataSource } from "./data/chainlist-ws-data-source.ts";
import { WsLatencyTester } from "./infra/ws-latency-tester.ts";
import { handleMcpRequest, isMcpRequest } from "./mcp/handler.ts";
// Adjust path to point one level up from src/
import rpcWhitelist from "../rpc-whitelist.json" with { type: "json" };

// Type guard to check for valid JSON-RPC request object structure
function isValidJsonRpcRequest(obj: unknown): obj is JsonRpcRequest {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }
  // Use 'in' operator for safer property checks on unknown
  return (
    "jsonrpc" in obj &&
    obj.jsonrpc === "2.0" &&
    "method" in obj &&
    typeof obj.method === "string" &&
    (!("params" in obj) || obj.params === undefined || Array.isArray(obj.params) || typeof obj.params === "object") &&
    "id" in obj &&
    (typeof obj.id === "string" || typeof obj.id === "number" || obj.id === null)
  );
}

// Helper to create a JSON-RPC error response
function createJsonRpcError(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

const PORT = parseInt(Deno.env.get("PORT") ?? "8000");

console.log("Initializing Permit2 RPC Manager Proxy...");

// Check environment variable to potentially disable cache
const disableCacheEnv = Deno.env.get("DISABLE_RPC_CACHE");
const shouldDisableCache = disableCacheEnv === "true" || disableCacheEnv === "1";

if (shouldDisableCache) {
  console.warn("RPC Caching is DISABLED via DISABLE_RPC_CACHE environment variable.");
}

function parseBoolEnv(name: string): boolean | undefined {
  const raw = Deno.env.get(name);
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(value)) return true;
  if (["0", "false", "no", "n", "off"].includes(value)) return false;
  return undefined;
}

function parseIntEnv(name: string): number | undefined {
  const raw = Deno.env.get(name);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseFloatEnv(name: string): number | undefined {
  const raw = Deno.env.get(name);
  if (raw === undefined) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCsvEnv(name: string): string[] | undefined {
  const raw = Deno.env.get(name);
  if (raw === undefined) return undefined;
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts : undefined;
}

function buildPermit2RpcManagerOptionsFromEnv(initialRpcData: Permit2RpcManagerOptions["initialRpcData"], disableCache: boolean): Permit2RpcManagerOptions {
  const scoringV2: NonNullable<Permit2RpcManagerOptions["scoringV2"]> = {};
  const scoringV2Enabled = parseBoolEnv("RPC_SCORING_V2_ENABLED");
  if (scoringV2Enabled !== undefined) scoringV2.enabled = scoringV2Enabled;
  const scoringLatencyQuantile = parseFloatEnv("RPC_SCORING_V2_LATENCY_QUANTILE");
  if (scoringLatencyQuantile !== undefined) scoringV2.latencyQuantile = scoringLatencyQuantile;
  const scoringMinSamples = parseIntEnv("RPC_SCORING_V2_MIN_SAMPLES");
  if (scoringMinSamples !== undefined) scoringV2.minSamplesForConfidence = scoringMinSamples;
  const scoringEmaPrevWeight = parseFloatEnv("RPC_SCORING_V2_EMA_PREV_WEIGHT");
  if (scoringEmaPrevWeight !== undefined) scoringV2.emaPrevWeight = scoringEmaPrevWeight;
  const scoringWLatency = parseFloatEnv("RPC_SCORING_V2_W_LATENCY");
  if (scoringWLatency !== undefined) scoringV2.wLatency = scoringWLatency;
  const scoringWError = parseFloatEnv("RPC_SCORING_V2_W_ERROR");
  if (scoringWError !== undefined) scoringV2.wError = scoringWError;
  const scoringWThrottle = parseFloatEnv("RPC_SCORING_V2_W_THROTTLE");
  if (scoringWThrottle !== undefined) scoringV2.wThrottle = scoringWThrottle;
  const scoringWHeadLag = parseFloatEnv("RPC_SCORING_V2_W_HEAD_LAG");
  if (scoringWHeadLag !== undefined) scoringV2.wHeadLag = scoringWHeadLag;
  const scoringWMisbehavior = parseFloatEnv("RPC_SCORING_V2_W_MISBEHAVIOR");
  if (scoringWMisbehavior !== undefined) scoringV2.wMisbehavior = scoringWMisbehavior;

  const hedge: NonNullable<Permit2RpcManagerOptions["hedge"]> = {};
  const hedgeEnabled = parseBoolEnv("RPC_HEDGE_ENABLED");
  if (hedgeEnabled !== undefined) hedge.enabled = hedgeEnabled;
  const hedgeMaxHedges = parseIntEnv("RPC_HEDGE_MAX_HEDGES");
  if (hedgeMaxHedges !== undefined) hedge.maxHedges = hedgeMaxHedges;
  const hedgeDelayMs = parseIntEnv("RPC_HEDGE_DELAY_MS");
  if (hedgeDelayMs !== undefined) hedge.delayMs = hedgeDelayMs;
  const hedgeQuantile = parseFloatEnv("RPC_HEDGE_QUANTILE");
  if (hedgeQuantile !== undefined) hedge.quantile = hedgeQuantile;
  const hedgeMinDelayMs = parseIntEnv("RPC_HEDGE_MIN_DELAY_MS");
  if (hedgeMinDelayMs !== undefined) hedge.minDelayMs = hedgeMinDelayMs;
  const hedgeMaxDelayMs = parseIntEnv("RPC_HEDGE_MAX_DELAY_MS");
  if (hedgeMaxDelayMs !== undefined) hedge.maxDelayMs = hedgeMaxDelayMs;

  const headSampling: NonNullable<Permit2RpcManagerOptions["headSampling"]> = {};
  const headSamplingEnabled = parseBoolEnv("RPC_HEAD_SAMPLING_ENABLED");
  if (headSamplingEnabled !== undefined) headSampling.enabled = headSamplingEnabled;
  const headSampleIntervalMs = parseIntEnv("RPC_HEAD_SAMPLING_INTERVAL_MS");
  if (headSampleIntervalMs !== undefined) headSampling.sampleIntervalMs = headSampleIntervalMs;
  const headMaxRpcs = parseIntEnv("RPC_HEAD_SAMPLING_MAX_RPCS");
  if (headMaxRpcs !== undefined) headSampling.maxRpcsPerSample = headMaxRpcs;
  const headTimeoutMs = parseIntEnv("RPC_HEAD_SAMPLING_TIMEOUT_MS");
  if (headTimeoutMs !== undefined) headSampling.timeoutMs = headTimeoutMs;

  const consensus: NonNullable<Permit2RpcManagerOptions["consensus"]> = {};
  const consensusEnabled = parseBoolEnv("RPC_CONSENSUS_ENABLED");
  if (consensusEnabled !== undefined) consensus.enabled = consensusEnabled;
  const consensusMethods = parseCsvEnv("RPC_CONSENSUS_METHODS");
  if (consensusMethods !== undefined) consensus.methods = consensusMethods;
  const consensusParticipants = parseIntEnv("RPC_CONSENSUS_PARTICIPANTS");
  if (consensusParticipants !== undefined) consensus.participants = consensusParticipants;
  const consensusThreshold = parseIntEnv("RPC_CONSENSUS_THRESHOLD");
  if (consensusThreshold !== undefined) consensus.agreementThreshold = consensusThreshold;
  const consensusPreferNonEmpty = parseBoolEnv("RPC_CONSENSUS_PREFER_NON_EMPTY");
  if (consensusPreferNonEmpty !== undefined) consensus.preferNonEmpty = consensusPreferNonEmpty;

  return {
    initialRpcData,
    disableCache,
    validateChainId: parseBoolEnv("RPC_VALIDATE_CHAIN_ID"),
    capabilityTtlMs: parseIntEnv("RPC_CAPABILITY_TTL_MS"),
    scoringV2: Object.keys(scoringV2).length > 0 ? scoringV2 : undefined,
    hedge: Object.keys(hedge).length > 0 ? hedge : undefined,
    headSampling: Object.keys(headSampling).length > 0 ? headSampling : undefined,
    consensus: Object.keys(consensus).length > 0 ? consensus : undefined,
    // TODO: Configure other CacheManager options like TTL if needed
  };
}

// Instantiate Permit2RpcManager, passing initial data and cache option.
const manager = new Permit2RpcManager(buildPermit2RpcManagerOptionsFromEnv(rpcWhitelist, shouldDisableCache));

type WsLogLevel = "debug" | "info" | "warn" | "error";
const wsLogger = (level: WsLogLevel, message: string, ...optionalParams: unknown[]) => {
  if (level === "debug" || level === "info") return;
  const logFn = console[level] || console.log;
  logFn(`[Permit2WSS:${level}] ${message}`, ...optionalParams);
};

const wsCandidateLimitRaw = Number.parseInt(Deno.env.get("WS_CANDIDATE_LIMIT") ?? "25", 10);
const wsCandidateLimit = Number.isFinite(wsCandidateLimitRaw) && wsCandidateLimitRaw > 0 ? wsCandidateLimitRaw : 25;
const wsDataSource = new ChainlistWsDataSource(wsLogger, rpcWhitelist, { candidateLimit: wsCandidateLimit });
const wsCacheManager = new CacheManager({
  localStorageKey: "permit2RpcManagerWsCache",
  logger: wsLogger,
  disableCache: shouldDisableCache,
});
const wsLatencyTesterTimeoutMsRaw = Number.parseInt(Deno.env.get("WS_LATENCY_TIMEOUT_MS") ?? "5000", 10);
const wsLatencyTesterTimeoutMs = Number.isFinite(wsLatencyTesterTimeoutMsRaw) && wsLatencyTesterTimeoutMsRaw > 0 ? wsLatencyTesterTimeoutMsRaw : 5000;
const wsLatencyTester = new WsLatencyTester(wsLatencyTesterTimeoutMs, wsLogger);
const wsSelector = new RpcSelector(wsDataSource, wsCacheManager, wsLatencyTester, wsLogger);

function deriveWsUrl(url: string): string | undefined {
  const trimmed = url.trim().replace(/\/$/, "");
  if (trimmed.includes("${")) return undefined;
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  return undefined;
}

function getWsOverrideCandidates(chainId: number): string[] {
  const candidates: string[] = [];

  const chainSpecific = Deno.env.get(`RPC_WSS_URL_${chainId}`);
  if (chainSpecific) candidates.push(chainSpecific);

  if (chainId === 1) {
    const eth = Deno.env.get("ETH_WSS_URL");
    if (eth) candidates.push(eth);
  }

  const global = Deno.env.get("RPC_WSS_URL");
  if (global) candidates.push(global);

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const derived = deriveWsUrl(candidate);
    if (!derived) continue;
    if (seen.has(derived)) continue;
    seen.add(derived);
    deduped.push(derived);
  }

  return deduped;
}

function openWebSocket(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error("Upstream WebSocket connection timed out."));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      ws.onopen = null;
      ws.onerror = null;
      ws.onclose = null;
    };

    ws.onopen = () => {
      cleanup();
      resolve(ws);
    };

    ws.onerror = () => {
      cleanup();
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error("Upstream WebSocket connection failed."));
    };

    ws.onclose = () => {
      cleanup();
      reject(new Error("Upstream WebSocket closed before opening."));
    };
  });
}

async function connectFirstWebSocket(urls: string[], timeoutMs: number): Promise<WebSocket> {
  let lastError: Error | undefined;
  for (const url of urls) {
    try {
      return await openWebSocket(url, timeoutMs);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("No upstream WebSocket candidates available.");
}

const STATIC_ASSET_ROOT = new URL("../static/", import.meta.url);
const staticTextAssetCache = new Map<string, string>();
const CACHE_STATIC_ASSETS = (() => {
  try {
    return Deno.env.get("DENO_DEPLOY") === "1";
  } catch {
    return false;
  }
})();

async function readStaticTextAsset(fileName: string): Promise<string> {
  if (CACHE_STATIC_ASSETS) {
    const cached = staticTextAssetCache.get(fileName);
    if (cached !== undefined) return cached;
  }

  const text = await Deno.readTextFile(new URL(fileName, STATIC_ASSET_ROOT));
  if (CACHE_STATIC_ASSETS) {
    staticTextAssetCache.set(fileName, text);
  }
  return text;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Deno.errors.NotFound;
}

const handler = async (request: Request): Promise<Response> => {
  // Set CORS headers for all responses
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*", // Allow requests from any origin
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization", // Adjust as needed
  };

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

    const { socket, response } = Deno.upgradeWebSocket(request);

    const queuedToUpstream: Array<string | ArrayBuffer> = [];
    const MAX_QUEUE = 256;
    let upstream: WebSocket | null = null;
    let clientClosed = false;

    const sendToClient = (data: unknown) => {
      const send = (payload: string | ArrayBuffer) => {
        if (socket.readyState !== WebSocket.OPEN) return;
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
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          try {
            upstream.send(payload);
          } catch {
            // ignore
          }
          return;
        }
        if (!upstream || upstream.readyState === WebSocket.CONNECTING) {
          if (queuedToUpstream.length < MAX_QUEUE) {
            queuedToUpstream.push(payload);
          } else if (!clientClosed) {
            clientClosed = true;
            console.warn(`WebSocket upstream queue overflow (limit: ${MAX_QUEUE}) for chainId ${chainId}. Closing client connection.`);
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

    (async () => {
      const timeoutMs = Number.parseInt(Deno.env.get("WS_CONNECT_TIMEOUT_MS") ?? "5000", 10);
      const connectTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;

      const overrideCandidates = getWsOverrideCandidates(chainId);
      if (overrideCandidates.length > 0) {
        try {
          upstream = await connectFirstWebSocket(overrideCandidates, connectTimeout);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to connect to configured WS override";
          wsLogger("warn", `WS override failed for chain ${chainId}: ${message}`);
        }
      }

      if (!upstream) {
        const rankedCandidates = await wsSelector.getRankedRpcList(chainId);
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
            upstream = await openWebSocket(candidate, connectTimeout);
            break;
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            try {
              await wsCacheManager.invalidateRpcInCache(chainId, candidate, "eliminated");
            } catch {
              // ignore
            }
          }
        }

        if (!upstream) {
          const message = lastError?.message ?? "Failed to connect to upstream WebSocket";
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

    return response;
  }

  // Serve logo SVG at GET /logo.svg
  if ((request.method === "GET" || request.method === "HEAD") && new URL(request.url).pathname === "/logo.svg") {
    try {
      const ubiquityDaoLogo = await readStaticTextAsset("logo.svg");
      return new Response(ubiquityDaoLogo, {
        status: 200,
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          ...corsHeaders,
        },
      });
    } catch (error) {
      console.error("Failed to read static asset logo.svg:", error);
      return new Response("Not Found", {
        status: isNotFoundError(error) ? 404 : 500,
        headers: corsHeaders,
      });
    }
  }

  // Serve app.css at GET /app.css
  if ((request.method === "GET" || request.method === "HEAD") && new URL(request.url).pathname === "/app.css") {
    try {
      const css = await readStaticTextAsset("app.css");
      return new Response(css, {
        status: 200,
        headers: {
          "content-type": "text/css; charset=utf-8",
          ...corsHeaders,
        },
      });
    } catch (error) {
      console.error("Failed to read static asset app.css:", error);
      return new Response("Not Found", {
        status: isNotFoundError(error) ? 404 : 500,
        headers: corsHeaders,
      });
    }
  }

  // Serve app.js at GET /app.js
  if ((request.method === "GET" || request.method === "HEAD") && new URL(request.url).pathname === "/app.js") {
    try {
      const js = await readStaticTextAsset("app.js");
      return new Response(js, {
        status: 200,
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          ...corsHeaders,
        },
      });
    } catch (error) {
      console.error("Failed to read static asset app.js:", error);
      return new Response("Not Found", {
        status: isNotFoundError(error) ? 404 : 500,
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
          message: error instanceof Error ? error.message : String(error),
        }),
        {
          status: 500,
          headers: {
            "content-type": "application/json; charset=utf-8",
            ...corsHeaders,
          },
        }
      );
    }
  }

  // Serve HTML at GET /
  if ((request.method === "GET" || request.method === "HEAD") && new URL(request.url).pathname === "/") {
    try {
      const html = await readStaticTextAsset("index.html");
      return new Response(html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          ...corsHeaders,
        },
      });
    } catch (error) {
      console.error("Failed to read static asset index.html:", error);
      return new Response("Not Found", {
        status: isNotFoundError(error) ? 404 : 500,
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
    console.error("Failed to parse request body:", error);
    // Return JSON-RPC error for parse error
    const errorResponse = createJsonRpcError(null, -32700, `Parse error: ${error.message}`);
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

  // --- Handle Batch Request ---
  if (Array.isArray(requestBody)) {
    console.log(`Received batch request for chain ${chainId} with ${requestBody.length} calls.`);

    if (requestBody.length === 0) {
      const errorResponse = createJsonRpcError(null, -32600, "Invalid Request: Received empty batch.");
      return new Response(JSON.stringify(errorResponse), {
        status: 200, // JSON-RPC compliance: invalid requests return HTTP 200
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate all requests in the batch first
    if (!requestBody.every(isValidJsonRpcRequest)) {
      const errorResponse = createJsonRpcError(null, -32600, "Invalid Request: Batch contains invalid JSON-RPC object(s).");
      return new Response(JSON.stringify(errorResponse), {
        status: 200, // JSON-RPC compliance: invalid requests return HTTP 200
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const multiCallRequests = requestBody.filter((req) => isMulticall3Request(chainId, req));
    const otherRequests = requestBody.filter((req) => req.id && !multiCallRequests.map((r) => r.id).includes(req.id));

    // group by block tag and split the array into chunks of 500 to avoid exceeding multicall limits
    const multiCallRequestsByBlockTag = multiCallRequests.reduce(
      (acc, req) => {
        const blockTag = req.params[1];
        if (!acc[blockTag]) {
          acc[blockTag] = [];
        }
        const currentBatch = acc[blockTag];
        if (currentBatch.length === 0 || currentBatch[currentBatch.length - 1].length >= 500) {
          currentBatch.push([req]);
        } else {
          currentBatch[currentBatch.length - 1].push(req);
        }
        return acc;
      },
      {} as Record<string, Multicall3Request[][]>
    );

    const multicallPromises: Promise<JsonRpcResponse[]>[] = [];
    for (const [blockTag, batches] of Object.entries(multiCallRequestsByBlockTag)) {
      for (const batch of batches) {
        multicallPromises.push(manager.multicall3(chainId, batch, blockTag));
      }
    }
    const multicallResponses = (await Promise.all(multicallPromises)).flat();

    // Process batch requests concurrently
    const otherResponses = await Promise.all(
      otherRequests.map(async (req) => {
        try {
          // Ensure params is always an array for manager.send()
          const params = Array.isArray(req.params) ? req.params : [];
          const result = await manager.send(chainId, req.method, params);
          return { jsonrpc: "2.0", id: req.id, result } as JsonRpcResponse;
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          console.error(`Error processing batch item (id: ${req.id}, method: ${req.method}) for chain ${chainId}:`, error);

          // Extract error details consistently
          const code = error.name === "JsonRpcError" && "code" in error && typeof error.code === "number" ? error.code : -32603;
          const data = "data" in error ? error.data : undefined;

          return {
            jsonrpc: "2.0",
            id: req.id,
            error: {
              code,
              message: error.message,
              data,
            },
          } as JsonRpcResponse;
        }
      })
    );

    return new Response(JSON.stringify([...multicallResponses, ...otherResponses]), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } // --- Handle Single Request ---
  else if (isValidJsonRpcRequest(requestBody)) {
    console.log(`Received single request for chain ${chainId}: ${requestBody.method}`);
    try {
      // Ensure params is always an array for manager.send()
      const params = Array.isArray(requestBody.params) ? requestBody.params : [];
      const result = await manager.send(chainId, requestBody.method, params);
      const rpcResponse: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: requestBody.id,
        result,
      };
      return new Response(JSON.stringify(rpcResponse), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      console.error(`Error processing single request (id: ${requestBody.id}, method: ${requestBody.method}) for chain ${chainId}:`, error);

      // Pass through HTTP status if available, otherwise default to 200 for JSON-RPC compliance
      // Contract reverts and JSON-RPC errors should return HTTP 200 per JSON-RPC spec
      let httpStatus = 200;
      if (error.name === "JsonRpcError" && "httpStatus" in error && typeof error.httpStatus === "number") {
        httpStatus = error.httpStatus;
      }

      const errorResponse = {
        jsonrpc: "2.0",
        id: requestBody.id,
        error: {
          code: "code" in error && typeof error.code === "number" ? error.code : -32603,
          message: error.message,
          data: "data" in error ? error.data : undefined,
        },
      };

      return new Response(JSON.stringify(errorResponse), {
        status: httpStatus,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } // --- Handle Invalid Request Structure ---
  else {
    console.error("Invalid request body structure:", requestBody);
    const errorResponse = createJsonRpcError(null, -32600, "Invalid Request: Not a valid JSON-RPC object or batch.");
    return new Response(JSON.stringify(errorResponse), {
      status: 200, // JSON-RPC compliance: invalid requests return HTTP 200
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
};

console.log(`Permit2 RPC Manager Proxy listening on http://localhost:${PORT}`);
Deno.serve({ port: PORT }, handler);

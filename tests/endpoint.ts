import { TEST_TIMEOUT, MAX_RETRIES, CONCURRENT_TESTS, RPC_REQUESTS } from "./constants.ts";
import PERMIT2_BYTECODE from "./fixtures/permit2-bytecode.ts";

type RpcEndpointResult = {
  url: string;
  valid: boolean;
};

// Utility function to handle timeouts
async function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(`Operation '${operation}' timed out after ${ms}ms`);
  }, ms);

  try {
    const result = await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(new Error(controller.signal.reason));
        });
      }),
    ]);
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Test a single endpoint
async function testRpcEndpoint(url: string): Promise<boolean> {
  const stages = {
    fetch: Math.floor(TEST_TIMEOUT * 0.6), // 6000ms for network
    parse: Math.floor(TEST_TIMEOUT * 0.3), // 3000ms for parsing
    validate: Math.floor(TEST_TIMEOUT * 0.1), // 1000ms for validation
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`  Attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${url} - Starting test`);

      // Stage 1: Fetch
      const response = await withTimeout(
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(RPC_REQUESTS.getCode),
        }),
        stages.fetch,
        "fetch"
      );

      if (!response.ok) {
        console.log(`  Attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${url} - Response not OK (${response.status})`);
        continue;
      }

      // Stage 2: Parse JSON
      const data = await withTimeout(response.json(), stages.parse, "JSON parse");

      if (data.error) {
        console.log(`  Attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${url} - RPC returned error: ${data.error.message || JSON.stringify(data.error)}`);
        continue;
      }

      const returnedBytecode = data.result;

      // Stage 3: Validate bytecode
      await withTimeout(
        (async () => {
          if (!returnedBytecode || returnedBytecode === "0x") {
            console.log(`  Attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${url} - Empty bytecode`);
            throw new Error("Empty bytecode");
          }

          const bytecodeMatches = returnedBytecode.toLowerCase().startsWith(PERMIT2_BYTECODE.toLowerCase());
          if (!bytecodeMatches) {
            console.log(`  Attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${url} - Bytecode mismatch`);
            throw new Error("Bytecode mismatch");
          }

          return true;
        })(),
        stages.validate,
        "bytecode validation"
      );

      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.log(`  Attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${url} - ${errorMessage}`);

      if (attempt === MAX_RETRIES) {
        console.log(`  Attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${url} - All retries exhausted`);
        return false;
      }
    }
  }

  return false;
}

// Process RPCs in parallel batches
export async function testRpcs(urls: string[]): Promise<string[]> {
  const results: RpcEndpointResult[] = [];

  for (let i = 0; i < urls.length; i += CONCURRENT_TESTS) {
    const batch = urls.slice(i, i + CONCURRENT_TESTS);
    console.log(`\n  Testing batch of ${batch.length} RPCs...`);

    const batchResults = await Promise.all(
      batch.map(async (url: string) => {
        const valid = await testRpcEndpoint(url);
        if (valid) {
          console.log(`✓ Valid: ${url}`);
        } else {
          console.log(`✗ Invalid: ${url}`);
        }
        return { url, valid };
      })
    );
    results.push(...batchResults);
  }

  return results.filter((r) => r.valid).map((r) => r.url);
}

function normalizeWsMessageData(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return null;
}

function openWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const cleanup = () => {
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
      reject(new Error("WebSocket connection error"));
    };

    ws.onclose = () => {
      cleanup();
      reject(new Error("WebSocket closed before opening"));
    };
  });
}

async function wsJsonRpc(ws: WebSocket, requestBody: unknown): Promise<any> {
  return await new Promise((resolve, reject) => {
    const request = JSON.stringify(requestBody);
    const requestId = (requestBody as any)?.id;
    const cleanup = () => {
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
    };

    ws.onmessage = (event: MessageEvent) => {
      const raw = normalizeWsMessageData((event as any).data);
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (requestId !== undefined) {
          if (!parsed || typeof parsed !== "object" || !("id" in parsed)) {
            return; // ignore subscription notifications while waiting for a response
          }
          if (parsed.id !== requestId) return;
        }
        cleanup();
        resolve(parsed);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    ws.onerror = () => {
      cleanup();
      reject(new Error("WebSocket error"));
    };

    ws.onclose = () => {
      cleanup();
      reject(new Error("WebSocket closed"));
    };

    ws.send(request);
  });
}

async function waitForSubscriptionNotification(ws: WebSocket, subscriptionId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
    };

    ws.onmessage = (event: MessageEvent) => {
      const raw = normalizeWsMessageData((event as any).data);
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return;
        if (parsed.method !== "eth_subscription") return;
        const params = parsed.params;
        if (!params || typeof params !== "object") return;
        if (params.subscription !== subscriptionId) return;
        cleanup();
        resolve();
      } catch {
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      cleanup();
      reject(new Error("WebSocket error"));
    };

    ws.onclose = () => {
      cleanup();
      reject(new Error("WebSocket closed"));
    };
  });
}

type WsEndpointTestOptions = {
  requirePendingTxEvent?: boolean;
};

async function testWsRpcEndpoint(url: string, options: WsEndpointTestOptions = {}): Promise<boolean> {
  const stages = {
    connect: Math.floor(TEST_TIMEOUT * 0.6),
    request: Math.floor(TEST_TIMEOUT * 0.3),
    validate: Math.floor(TEST_TIMEOUT * 0.1),
    pendingEvent: 5000,
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let ws: WebSocket | undefined;
    try {
      console.log(`  Attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${url} - Starting WS test`);

      ws = await withTimeout(openWs(url), stages.connect, "ws connect");
      const data = await withTimeout(wsJsonRpc(ws, RPC_REQUESTS.getCode), stages.request, "ws json-rpc");

      if (data?.error) {
        console.log(
          `  Attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${url} - WS RPC returned error: ${
            data.error.message || JSON.stringify(data.error)
          }`,
        );
        continue;
      }

      const returnedBytecode = data?.result;

      await withTimeout(
        (async () => {
          if (!returnedBytecode || returnedBytecode === "0x") {
            console.log(`  Attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${url} - Empty bytecode`);
            throw new Error("Empty bytecode");
          }

          const bytecodeMatches = String(returnedBytecode).toLowerCase().startsWith(PERMIT2_BYTECODE.toLowerCase());
          if (!bytecodeMatches) {
            console.log(`  Attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${url} - Bytecode mismatch`);
            throw new Error("Bytecode mismatch");
          }

          return true;
        })(),
        stages.validate,
        "bytecode validation",
      );

      if (options.requirePendingTxEvent) {
        const subscribeBody = {
          jsonrpc: "2.0",
          id: 2,
          method: "eth_subscribe",
          params: ["newPendingTransactions"],
        };
        const subscribeResponse = await withTimeout(wsJsonRpc(ws, subscribeBody), stages.request, "ws subscribe");
        const subscriptionId = subscribeResponse?.result;
        if (typeof subscriptionId !== "string") {
          console.log(
            `  Attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${url} - newPendingTransactions subscribe failed`,
          );
          continue;
        }

        try {
          await withTimeout(
            waitForSubscriptionNotification(ws, subscriptionId),
            stages.pendingEvent,
            "ws pending tx event",
          );
        } catch (error) {
          console.log(
            `  Attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${url} - No pending tx events received (${(error as Error).message})`,
          );
          continue;
        } finally {
          try {
            await wsJsonRpc(ws, {
              jsonrpc: "2.0",
              id: 3,
              method: "eth_unsubscribe",
              params: [subscriptionId],
            });
          } catch {
            // ignore
          }
        }
      }

      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.log(`  Attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${url} - ${errorMessage}`);

      if (attempt === MAX_RETRIES) {
        console.log(`  Attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${url} - All retries exhausted`);
        return false;
      }
    } finally {
      try {
        ws?.close();
      } catch {
        // ignore
      }
    }
  }

  return false;
}

export async function testWsRpcs(urls: string[], options: WsEndpointTestOptions = {}): Promise<string[]> {
  const results: RpcEndpointResult[] = [];

  for (let i = 0; i < urls.length; i += CONCURRENT_TESTS) {
    const batch = urls.slice(i, i + CONCURRENT_TESTS);
    console.log(`\n  Testing WS batch of ${batch.length} RPCs...`);

    const batchResults = await Promise.all(
      batch.map(async (url: string) => {
        const valid = await testWsRpcEndpoint(url, options);
        if (valid) {
          console.log(`✓ Valid (WS): ${url}`);
        } else {
          console.log(`✗ Invalid (WS): ${url}`);
        }
        return { url, valid };
      }),
    );
    results.push(...batchResults);
  }

  return results.filter((r) => r.valid).map((r) => r.url);
}

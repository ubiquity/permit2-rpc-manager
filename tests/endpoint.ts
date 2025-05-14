import { TEST_TIMEOUT, MAX_RETRIES, CONCURRENT_TESTS, RPC_REQUESTS } from './constants.ts';
import PERMIT2_BYTECODE from './fixtures/permit2-bytecode.ts';

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
        controller.signal.addEventListener('abort', () => {
          reject(new Error(controller.signal.reason));
        });
      })
    ]);
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Test a single endpoint
async function testRpcEndpoint(url: string): Promise<boolean> {
  const stages = {
    fetch: Math.floor(TEST_TIMEOUT * 0.6),    // 6000ms for network
    parse: Math.floor(TEST_TIMEOUT * 0.3),    // 3000ms for parsing
    validate: Math.floor(TEST_TIMEOUT * 0.1)   // 1000ms for validation
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`  Attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${url} - Starting test`);

      // Stage 1: Fetch
      const response = await withTimeout(
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(RPC_REQUESTS.getCode)
        }),
        stages.fetch,
        'fetch'
      );

      if (!response.ok) {
        console.log(`  Attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${url} - Response not OK (${response.status})`);
        continue;
      }

      // Stage 2: Parse JSON
      const data = await withTimeout(
        response.json(),
        stages.parse,
        'JSON parse'
      );

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
        'bytecode validation'
      );

      return true;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
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

  return results.filter(r => r.valid).map(r => r.url);
}

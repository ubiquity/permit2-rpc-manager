import { TEST_TIMEOUT, MAX_RETRIES, CONCURRENT_TESTS, RPC_REQUESTS } from './constants.ts';
import PERMIT2_BYTECODE from './fixtures/permit2-bytecode.ts';

type RpcEndpointResult = {
  url: string;
  valid: boolean;
};

// Test a single endpoint
async function testRpcEndpoint(url: string): Promise<boolean> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TEST_TIMEOUT);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(RPC_REQUESTS.getCode),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          continue;
        }

        const data = await response.json();

        // Skip if the response has an error
        if (data.error) {
          continue;
        }

        const returnedBytecode = data.result;

        // Skip if returned bytecode is null or empty
        if (!returnedBytecode || returnedBytecode === "0x") {
          continue;
        }

        // Compare the first 13995 bytes of the bytecode
        const bytecodeMatches = returnedBytecode.toLowerCase().startsWith(PERMIT2_BYTECODE.toLowerCase());

        return bytecodeMatches;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (_error) {
      if (attempt === MAX_RETRIES) {
        return false;
      }
      // No delay between retries - if it fails, try again immediately
      continue;
    }
  }

  return false;
}

// Process RPCs in parallel batches
export async function testRpcs(urls: string[]): Promise<string[]> {
  const results: RpcEndpointResult[] = [];

  for (let i = 0; i < urls.length; i += CONCURRENT_TESTS) {
    const batch = urls.slice(i, i + CONCURRENT_TESTS);
    const batchResults = await Promise.all(
      batch.map(async (url: string) => {
        const valid = await testRpcEndpoint(url);
        if (valid) {
          console.log(`✓ Valid: ${url}`);
        }
        return { url, valid };
      })
    );
    results.push(...batchResults);
  }

  return results.filter(r => r.valid).map(r => r.url);
}

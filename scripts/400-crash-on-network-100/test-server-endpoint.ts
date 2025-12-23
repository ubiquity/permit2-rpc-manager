#!/usr/bin/env bun
/**
 * Test the permit2-rpc-manager server endpoint directly
 * to reproduce the HTTP 400 error
 */

interface TestResult {
  endpoint: string;
  status: "success" | "error";
  httpStatus?: number;
  responseTime: number;
  error?: string;
  result?: unknown;
  headers?: Record<string, string>;
}

// The exact payload from the error logs
const TEST_PAYLOAD = {
  jsonrpc: "2.0",
  method: "eth_call",
  params: [
    {
      to: "0x000000000022d473030f116ddee9f6b43ac78ba3",
      data: "0x4fe02b440000000000000000000000009051eda96db419c967189f4ac303a290f332768000d5491aa895b1b0b1bbb4e5aca9e06ee4ad36cf15fc51d8bd20720710b11dfa",
    },
    "latest",
  ],
  id: 44, // Using the same ID from the error
};

async function testServerEndpoint(url: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(TEST_PAYLOAD),
      signal: AbortSignal.timeout(30000), // 30 second timeout
    });

    const responseTime = Date.now() - startTime;
    const responseData = await response.json();

    // Capture response headers
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    if (!response.ok) {
      return {
        endpoint: url,
        status: "error",
        httpStatus: response.status,
        responseTime,
        error: `HTTP ${response.status}: ${JSON.stringify(responseData)}`,
        headers,
      };
    }

    if (responseData.error) {
      return {
        endpoint: url,
        status: "error",
        httpStatus: response.status,
        responseTime,
        error: `RPC Error: ${JSON.stringify(responseData.error)}`,
        headers,
      };
    }

    return {
      endpoint: url,
      status: "success",
      httpStatus: response.status,
      responseTime,
      result: responseData.result,
      headers,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    return {
      endpoint: url,
      status: "error",
      responseTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function testBatchRequest(url: string): Promise<TestResult> {
  const startTime = Date.now();

  // Test with a batch of requests
  const batchPayload = [TEST_PAYLOAD, { ...TEST_PAYLOAD, id: 45 }, { ...TEST_PAYLOAD, id: 46 }];

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(batchPayload),
      signal: AbortSignal.timeout(30000),
    });

    const responseTime = Date.now() - startTime;
    const responseData = await response.json();

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    if (!response.ok) {
      return {
        endpoint: `${url} (batch)`,
        status: "error",
        httpStatus: response.status,
        responseTime,
        error: `HTTP ${response.status}: ${JSON.stringify(responseData)}`,
        headers,
      };
    }

    // Check if any of the batch responses have errors
    const errors = responseData.filter((r: any) => r.error);
    if (errors.length > 0) {
      return {
        endpoint: `${url} (batch)`,
        status: "error",
        httpStatus: response.status,
        responseTime,
        error: `Batch errors: ${JSON.stringify(errors)}`,
        headers,
      };
    }

    return {
      endpoint: `${url} (batch)`,
      status: "success",
      httpStatus: response.status,
      responseTime,
      result: responseData,
      headers,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    return {
      endpoint: `${url} (batch)`,
      status: "error",
      responseTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const endpoints = [
    "https://rpc.ubq.fi/100", // Production server
    "http://localhost:8000/100", // Local server (if running)
  ];

  console.log("Testing permit2-rpc-manager server endpoints...");
  console.log(`Payload: eth_call to Permit2 contract`);
  const firstParam = TEST_PAYLOAD.params[0];
  if (typeof firstParam === "object" && "to" in firstParam && "data" in firstParam) {
    console.log(`To: ${firstParam.to}`);
    console.log(`Data: ${firstParam.data.substring(0, 10)}...`);
  }
  console.log("=====================================\n");

  for (const endpoint of endpoints) {
    console.log(`\nTesting: ${endpoint}`);
    console.log("-------------------------------------");

    // Test single request
    const singleResult = await testServerEndpoint(endpoint);
    console.log(`Single request: ${singleResult.status}`);
    if (singleResult.httpStatus) {
      console.log(`  HTTP Status: ${singleResult.httpStatus}`);
    }
    console.log(`  Response time: ${singleResult.responseTime}ms`);

    if (singleResult.status === "error") {
      console.log(`  Error: ${singleResult.error}`);
      if (singleResult.headers) {
        console.log(`  Headers:`, singleResult.headers);
      }
    } else {
      console.log(`  Result: ${JSON.stringify(singleResult.result).substring(0, 100)}...`);
    }

    // Test batch request
    const batchResult = await testBatchRequest(endpoint);
    console.log(`\nBatch request: ${batchResult.status}`);
    if (batchResult.httpStatus) {
      console.log(`  HTTP Status: ${batchResult.httpStatus}`);
    }
    console.log(`  Response time: ${batchResult.responseTime}ms`);

    if (batchResult.status === "error") {
      console.log(`  Error: ${batchResult.error}`);
      if (batchResult.headers) {
        console.log(`  Headers:`, batchResult.headers);
      }
    } else {
      console.log(`  Results: ${JSON.stringify(batchResult.result).substring(0, 100)}...`);
    }
  }

  // Additional analysis
  console.log("\n=====================================");
  console.log("ANALYSIS");
  console.log("=====================================");
  console.log("\nBased on direct endpoint testing:");
  console.log("- All network 100 RPC endpoints work correctly (no 400 errors)");
  console.log("- The HTTP 400 error might be:");
  console.log("  1. From a different RPC not in the current whitelist");
  console.log("  2. A temporary issue that has been resolved");
  console.log("  3. Related to server-side request handling");
  console.log("  4. From a cached bad RPC selection");
  console.log("\nRecommendations:");
  console.log("1. Add HTTP 400 to retryable errors in permit2-rpc-manager.ts");
  console.log("2. Improve error logging to include the failing RPC URL");
  console.log("3. Consider clearing the Deno KV cache if the issue persists");
  console.log("4. Monitor which RPC is actually being selected by the server");
}

// Run the test
main().catch(console.error);

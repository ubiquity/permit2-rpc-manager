#!/usr/bin/env bun
/**
 * Test all network 100 RPC endpoints with the specific eth_call payload
 * that's causing HTTP 400 errors
 */

import rpcWhitelist from "../../packages/permit2-rpc-server/rpc-whitelist.json";

interface TestResult {
  url: string;
  status: "success" | "error";
  httpStatus?: number;
  responseTime: number;
  error?: string;
  result?: unknown;
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
  id: 1,
};

async function testEndpoint(url: string): Promise<TestResult> {
  const startTime = Date.now();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(TEST_PAYLOAD),
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    const responseTime = Date.now() - startTime;
    const responseData = await response.json();

    if (!response.ok) {
      return {
        url,
        status: "error",
        httpStatus: response.status,
        responseTime,
        error: `HTTP ${response.status}: ${JSON.stringify(responseData)}`,
      };
    }

    if (responseData.error) {
      return {
        url,
        status: "error",
        httpStatus: response.status,
        responseTime,
        error: `RPC Error: ${JSON.stringify(responseData.error)}`,
      };
    }

    return {
      url,
      status: "success",
      httpStatus: response.status,
      responseTime,
      result: responseData.result,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    return {
      url,
      status: "error",
      responseTime,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const network100Endpoints = rpcWhitelist.rpcs["100"] || [];

  console.log(`Testing ${network100Endpoints.length} endpoints for network 100...`);
  console.log(`Payload: eth_call to Permit2 contract`);
  console.log(`To: ${TEST_PAYLOAD.params[0].to}`);
  console.log(`Data: ${TEST_PAYLOAD.params[0].data.substring(0, 10)}...`);
  console.log("=====================================\n");

  const results: TestResult[] = [];

  // Test endpoints concurrently in batches of 3 to avoid overwhelming
  const batchSize = 3;
  for (let i = 0; i < network100Endpoints.length; i += batchSize) {
    const batch = network100Endpoints.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(testEndpoint));
    results.push(...batchResults);

    // Log progress
    console.log(`Progress: ${Math.min(i + batchSize, network100Endpoints.length)}/${network100Endpoints.length} endpoints tested`);
  }

  // Analyze results
  const successful = results.filter((r) => r.status === "success");
  const http400Errors = results.filter((r) => r.httpStatus === 400);
  const otherHttpErrors = results.filter((r) => r.status === "error" && r.httpStatus && r.httpStatus !== 400);
  const networkErrors = results.filter((r) => r.status === "error" && !r.httpStatus);

  console.log("\n=====================================");
  console.log("RESULTS SUMMARY");
  console.log("=====================================");
  console.log(`Total endpoints tested: ${results.length}`);
  console.log(`✅ Successful: ${successful.length}`);
  console.log(`❌ HTTP 400 errors: ${http400Errors.length}`);
  console.log(`⚠️  Other HTTP errors: ${otherHttpErrors.length}`);
  console.log(`🌐 Network/timeout errors: ${networkErrors.length}`);

  // Detailed results for HTTP 400 errors
  if (http400Errors.length > 0) {
    console.log("\n🔴 ENDPOINTS RETURNING HTTP 400:");
    console.log("=====================================");
    http400Errors.forEach((result) => {
      console.log(`\n${result.url}`);
      console.log(`  Response time: ${result.responseTime}ms`);
      console.log(`  Error: ${result.error}`);
    });
  }

  // Show successful endpoints
  if (successful.length > 0) {
    console.log("\n✅ SUCCESSFUL ENDPOINTS:");
    console.log("=====================================");
    successful.forEach((result) => {
      console.log(`\n${result.url}`);
      console.log(`  Response time: ${result.responseTime}ms`);
      console.log(`  Result: ${JSON.stringify(result.result).substring(0, 100)}...`);
    });
  }

  // Show other errors
  if (otherHttpErrors.length > 0) {
    console.log("\n⚠️  OTHER HTTP ERRORS:");
    console.log("=====================================");
    otherHttpErrors.forEach((result) => {
      console.log(`\n${result.url}`);
      console.log(`  HTTP Status: ${result.httpStatus}`);
      console.log(`  Response time: ${result.responseTime}ms`);
      console.log(`  Error: ${result.error}`);
    });
  }

  if (networkErrors.length > 0) {
    console.log("\n🌐 NETWORK/TIMEOUT ERRORS:");
    console.log("=====================================");
    networkErrors.forEach((result) => {
      console.log(`\n${result.url}`);
      console.log(`  Response time: ${result.responseTime}ms`);
      console.log(`  Error: ${result.error}`);
    });
  }

  // Export results to JSON for further analysis
  const outputFile = "network-100-test-results.json";
  await Bun.write(
    outputFile,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        payload: TEST_PAYLOAD,
        summary: {
          total: results.length,
          successful: successful.length,
          http400: http400Errors.length,
          otherHttpErrors: otherHttpErrors.length,
          networkErrors: networkErrors.length,
        },
        results: results.sort((a, b) => {
          // Sort by status (success first), then by response time
          if (a.status !== b.status) {
            return a.status === "success" ? -1 : 1;
          }
          return a.responseTime - b.responseTime;
        }),
      },
      null,
      2
    )
  );

  console.log(`\n📄 Detailed results saved to: ${outputFile}`);
}

// Run the test
main().catch(console.error);

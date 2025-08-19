#!/usr/bin/env deno run --allow-all

/**
 * Simple test script to verify MCP server functionality
 */

const SERVER_URL = "http://localhost:3005";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: any;
  id: number | string;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: any;
  error?: {
    code: number;
    message: string;
  };
}

async function sendRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const response = await fetch(SERVER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

async function runTests() {
  console.log("🧪 Starting MCP Ethereum Server Tests");

  // Test 1: Initialize
  console.log("\n📡 Test 1: Initialize");
  const initResponse = await sendRequest({
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
    id: 1,
  });
  console.log("✅ Initialize:", initResponse.result?.serverInfo?.name);

  // Test 2: List tools
  console.log("\n🛠️  Test 2: List Tools");
  const toolsResponse = await sendRequest({
    jsonrpc: "2.0",
    method: "tools/list",
    params: {},
    id: 2,
  });
  const tools = toolsResponse.result?.tools || [];
  console.log(`✅ Found ${tools.length} tools`);
  
  // List first 5 tools
  console.log("First 5 tools:");
  tools.slice(0, 5).forEach((tool: any, index: number) => {
    console.log(`  ${index + 1}. ${tool.name}: ${tool.description}`);
  });

  // Test 3: Get latest block number
  console.log("\n🔗 Test 3: Get Block Number");
  const blockResponse = await sendRequest({
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      name: "eth_blockNumber",
      arguments: {},
    },
    id: 3,
  });
  
  if (blockResponse.result?.content?.[0]?.text) {
    const blockNumber = JSON.parse(blockResponse.result.content[0].text);
    const blockNumberDecimal = parseInt(blockNumber, 16);
    console.log(`✅ Latest block: ${blockNumber} (${blockNumberDecimal})`);
  } else {
    console.log("❌ Failed to get block number:", blockResponse.error);
  }

  // Test 4: Get chain ID
  console.log("\n🌐 Test 4: Get Chain ID");
  const chainResponse = await sendRequest({
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      name: "eth_chainId",
      arguments: {},
    },
    id: 4,
  });
  
  if (chainResponse.result?.content?.[0]?.text) {
    const chainId = JSON.parse(chainResponse.result.content[0].text);
    const chainIdDecimal = parseInt(chainId, 16);
    console.log(`✅ Chain ID: ${chainId} (${chainIdDecimal})`);
  } else {
    console.log("❌ Failed to get chain ID:", chainResponse.error);
  }

  // Test 5: Get balance (test address with likely 0 balance)
  console.log("\n💰 Test 5: Get Balance");
  const balanceResponse = await sendRequest({
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      name: "eth_getBalance",
      arguments: {
        address: "0x742d35Cc6635C0532925a3b8D7389C9b9D06f9C8",
        blockNumber: "latest",
      },
    },
    id: 5,
  });
  
  if (balanceResponse.result?.content?.[0]?.text) {
    const balance = JSON.parse(balanceResponse.result.content[0].text);
    console.log(`✅ Balance: ${balance} wei`);
  } else {
    console.log("❌ Failed to get balance:", balanceResponse.error);
  }

  // Test 6: Get gas price
  console.log("\n⛽ Test 6: Get Gas Price");
  const gasPriceResponse = await sendRequest({
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      name: "eth_gasPrice",
      arguments: {},
    },
    id: 6,
  });
  
  if (gasPriceResponse.result?.content?.[0]?.text) {
    const gasPrice = JSON.parse(gasPriceResponse.result.content[0].text);
    const gasPriceGwei = parseInt(gasPrice, 16) / 1e9;
    console.log(`✅ Gas Price: ${gasPrice} wei (${gasPriceGwei.toFixed(2)} gwei)`);
  } else {
    console.log("❌ Failed to get gas price:", gasPriceResponse.error);
  }

  console.log("\n🎉 All tests completed!");
}

if (import.meta.main) {
  try {
    await runTests();
  } catch (error) {
    console.error("💥 Test failed:", error);
    Deno.exit(1);
  }
}
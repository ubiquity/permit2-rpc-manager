// Only include critical chains needed for Permit2
export const CRITICAL_CHAINS = new Set([
  1,      // Ethereum Mainnet
  10,     // Optimism
  56,     // BNB Chain
  100,    // Gnosis Chain
  137,    // Polygon
  8453,   // Base
  42161,  // Arbitrum
  42220,  // CELO
  43114,  // Avalanche C-Chain
  81457,  // Blast
  7777777 // Zora
]);

// Testing constants
export const TEST_TIMEOUT = 10000;
export const MAX_RETRIES = 2;
export const CONCURRENT_TESTS = 10;

// JSON-RPC request bodies
export const RPC_REQUESTS = {
  getCode: {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_getCode",
    params: [
      "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      "latest"
    ]
  }
};

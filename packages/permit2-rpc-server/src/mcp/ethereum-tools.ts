import type { Tool } from "npm:@modelcontextprotocol/sdk@1.0.4/types.js";

export function getEthereumTools(): Tool[] {
  return [
    // Core Methods
    {
      name: "eth_getBalance",
      description: "Returns the balance of the account at the given address",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "20-byte address to check for balance",
          },
          blockNumber: {
            type: "string",
            description: "Block number or 'latest', 'earliest', 'pending'",
          },
          chainId: {
            type: "number",
            description: "Chain ID (default: 1 for Ethereum mainnet)",
          },
        },
        required: ["address", "blockNumber"],
      },
    },
    {
      name: "eth_getCode",
      description: "Returns the code at a given address",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "20-byte address",
          },
          blockNumber: {
            type: "string",
            description: "Block number or 'latest', 'earliest', 'pending'",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["address", "blockNumber"],
      },
    },
    {
      name: "eth_getTransactionCount",
      description: "Returns the number of transactions sent from an address (nonce)",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "20-byte address",
          },
          blockNumber: {
            type: "string",
            description: "Block number or 'latest', 'earliest', 'pending'",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["address", "blockNumber"],
      },
    },
    {
      name: "eth_getStorageAt",
      description: "Returns the value from a storage position at a given address",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "20-byte address of the storage",
          },
          position: {
            type: "string",
            description: "Position in storage",
          },
          blockNumber: {
            type: "string",
            description: "Block number or 'latest', 'earliest', 'pending'",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["address", "position", "blockNumber"],
      },
    },
    {
      name: "eth_call",
      description: "Executes a call without creating a transaction",
      inputSchema: {
        type: "object",
        properties: {
          transaction: {
            type: "object",
            description: "Transaction call object",
            properties: {
              from: { type: "string", description: "Optional: sender address" },
              to: { type: "string", description: "Contract address" },
              gas: { type: "string", description: "Optional: gas limit" },
              gasPrice: { type: "string", description: "Optional: gas price" },
              value: { type: "string", description: "Optional: value in wei" },
              data: { type: "string", description: "Optional: encoded data" },
            },
            required: ["to"],
          },
          blockNumber: {
            type: "string",
            description: "Block number or 'latest', 'earliest', 'pending'",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["transaction", "blockNumber"],
      },
    },
    {
      name: "eth_estimateGas",
      description: "Estimates gas needed for a transaction",
      inputSchema: {
        type: "object",
        properties: {
          transaction: {
            type: "object",
            description: "Transaction object",
            properties: {
              from: { type: "string", description: "Optional: sender address" },
              to: { type: "string", description: "Optional: recipient address" },
              gas: { type: "string", description: "Optional: gas limit" },
              gasPrice: { type: "string", description: "Optional: gas price" },
              value: { type: "string", description: "Optional: value in wei" },
              data: { type: "string", description: "Optional: encoded data" },
            },
          },
          blockNumber: {
            type: "string",
            description: "Optional: Block number",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["transaction"],
      },
    },
    {
      name: "eth_blockNumber",
      description: "Returns the latest block number",
      inputSchema: {
        type: "object",
        properties: {
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
      },
    },

    // Transaction Methods
    {
      name: "eth_sendRawTransaction",
      description: "Submit a signed transaction",
      inputSchema: {
        type: "object",
        properties: {
          signedTransaction: {
            type: "string",
            description: "Signed transaction data",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["signedTransaction"],
      },
    },
    {
      name: "eth_getTransactionByHash",
      description: "Returns transaction details by hash",
      inputSchema: {
        type: "object",
        properties: {
          hash: {
            type: "string",
            description: "Transaction hash",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["hash"],
      },
    },
    {
      name: "eth_getTransactionReceipt",
      description: "Returns the receipt of a transaction",
      inputSchema: {
        type: "object",
        properties: {
          hash: {
            type: "string",
            description: "Transaction hash",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["hash"],
      },
    },
    {
      name: "eth_getTransactionByBlockHashAndIndex",
      description: "Returns transaction by block hash and index",
      inputSchema: {
        type: "object",
        properties: {
          blockHash: {
            type: "string",
            description: "Block hash",
          },
          index: {
            type: "string",
            description: "Transaction index in block",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["blockHash", "index"],
      },
    },
    {
      name: "eth_getTransactionByBlockNumberAndIndex",
      description: "Returns transaction by block number and index",
      inputSchema: {
        type: "object",
        properties: {
          blockNumber: {
            type: "string",
            description: "Block number or tag",
          },
          index: {
            type: "string",
            description: "Transaction index in block",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["blockNumber", "index"],
      },
    },
    {
      name: "eth_getBlockTransactionCountByHash",
      description: "Returns the number of transactions in a block by hash",
      inputSchema: {
        type: "object",
        properties: {
          blockHash: {
            type: "string",
            description: "Block hash",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["blockHash"],
      },
    },

    // Block Methods
    {
      name: "eth_getBlockByHash",
      description: "Returns block information by hash",
      inputSchema: {
        type: "object",
        properties: {
          blockHash: {
            type: "string",
            description: "Block hash",
          },
          fullTransactions: {
            type: "boolean",
            description: "Return full transaction objects",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["blockHash", "fullTransactions"],
      },
    },
    {
      name: "eth_getBlockByNumber",
      description: "Returns block information by number",
      inputSchema: {
        type: "object",
        properties: {
          blockNumber: {
            type: "string",
            description: "Block number or tag",
          },
          fullTransactions: {
            type: "boolean",
            description: "Return full transaction objects",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["blockNumber", "fullTransactions"],
      },
    },
    {
      name: "eth_getBlockTransactionCountByNumber",
      description: "Returns the number of transactions in a block by number",
      inputSchema: {
        type: "object",
        properties: {
          blockNumber: {
            type: "string",
            description: "Block number or tag",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["blockNumber"],
      },
    },
    {
      name: "eth_getUncleCountByBlockHash",
      description: "Returns the number of uncles in a block by hash",
      inputSchema: {
        type: "object",
        properties: {
          blockHash: {
            type: "string",
            description: "Block hash",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["blockHash"],
      },
    },
    {
      name: "eth_getUncleCountByBlockNumber",
      description: "Returns the number of uncles in a block by number",
      inputSchema: {
        type: "object",
        properties: {
          blockNumber: {
            type: "string",
            description: "Block number or tag",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["blockNumber"],
      },
    },
    {
      name: "eth_getUncleByBlockHashAndIndex",
      description: "Returns uncle block by hash and index",
      inputSchema: {
        type: "object",
        properties: {
          blockHash: {
            type: "string",
            description: "Block hash",
          },
          index: {
            type: "string",
            description: "Uncle index",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["blockHash", "index"],
      },
    },
    {
      name: "eth_getUncleByBlockNumberAndIndex",
      description: "Returns uncle block by number and index",
      inputSchema: {
        type: "object",
        properties: {
          blockNumber: {
            type: "string",
            description: "Block number or tag",
          },
          index: {
            type: "string",
            description: "Uncle index",
          },
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
        required: ["blockNumber", "index"],
      },
    },

    // Network Info Methods
    {
      name: "eth_protocolVersion",
      description: "Returns the current Ethereum protocol version",
      inputSchema: {
        type: "object",
        properties: {
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
      },
    },
    {
      name: "eth_syncing",
      description: "Returns sync status or false",
      inputSchema: {
        type: "object",
        properties: {
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
      },
    },
    {
      name: "eth_coinbase",
      description: "Returns the coinbase address",
      inputSchema: {
        type: "object",
        properties: {
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
      },
    },
    {
      name: "eth_chainId",
      description: "Returns the chain ID",
      inputSchema: {
        type: "object",
        properties: {
          chainId: {
            type: "number",
            description: "Override chain ID for routing",
          },
        },
      },
    },
    {
      name: "eth_mining",
      description: "Returns true if client is mining",
      inputSchema: {
        type: "object",
        properties: {
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
      },
    },
    {
      name: "eth_hashrate",
      description: "Returns the current hashrate",
      inputSchema: {
        type: "object",
        properties: {
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
      },
    },
    {
      name: "eth_gasPrice",
      description: "Returns the current gas price",
      inputSchema: {
        type: "object",
        properties: {
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
      },
    },
    {
      name: "eth_accounts",
      description: "Returns the list of accounts",
      inputSchema: {
        type: "object",
        properties: {
          chainId: {
            type: "number",
            description: "Chain ID",
          },
        },
      },
    },
  ];
}

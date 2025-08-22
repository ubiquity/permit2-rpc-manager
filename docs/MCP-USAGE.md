# MCP (Model Context Protocol) Usage Guide

## Overview

The RPC server at `https://rpc.ubq.fi` is now fully MCP compliant, allowing integration with LLM clients like Claude Desktop for natural language interaction with Ethereum JSON-RPC methods.

## MCP Endpoints

### 1. Initialize
```bash
curl -X POST https://rpc.ubq.fi/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {}
  }'
```

### 2. List Available Tools
```bash
curl -X POST https://rpc.ubq.fi/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }'
```

### 3. Call Ethereum Methods
```bash
curl -X POST https://rpc.ubq.fi/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "eth_blockNumber",
      "arguments": {
        "chainId": 1
      }
    }
  }'
```

## Supported Ethereum Methods (28 total)

### Core Methods
- `eth_getBalance` - Get account balance
- `eth_getCode` - Get contract code
- `eth_getTransactionCount` - Get nonce
- `eth_getStorageAt` - Read storage slot
- `eth_call` - Execute call without transaction
- `eth_estimateGas` - Estimate gas for transaction
- `eth_blockNumber` - Get latest block number

### Transaction Methods
- `eth_sendRawTransaction` - Submit signed transaction
- `eth_getTransactionByHash` - Get transaction details
- `eth_getTransactionReceipt` - Get transaction receipt
- `eth_getTransactionByBlockHashAndIndex`
- `eth_getTransactionByBlockNumberAndIndex`
- `eth_getBlockTransactionCountByHash`

### Block Methods
- `eth_getBlockByHash` - Get block by hash
- `eth_getBlockByNumber` - Get block by number
- `eth_getBlockTransactionCountByNumber`
- `eth_getUncleCountByBlockHash`
- `eth_getUncleCountByBlockNumber`
- `eth_getUncleByBlockHashAndIndex`
- `eth_getUncleByBlockNumberAndIndex`

### Network Info Methods
- `eth_protocolVersion` - Protocol version
- `eth_syncing` - Sync status
- `eth_coinbase` - Coinbase address
- `eth_chainId` - Chain ID
- `eth_mining` - Mining status
- `eth_hashrate` - Hash rate
- `eth_gasPrice` - Current gas price
- `eth_accounts` - List accounts

## Claude Desktop Configuration

Add to your Claude Desktop settings:

```json
{
  "mcpServers": {
    "ethereum-rpc": {
      "url": "https://rpc.ubq.fi/",
      "transport": "http"
    }
  }
}
```

## Backward Compatibility

The server maintains full backward compatibility with existing JSON-RPC clients:

```bash
# Traditional JSON-RPC call (unchanged)
curl -X POST https://rpc.ubq.fi/1 \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "eth_blockNumber",
    "params": []
  }'
```

## Chain ID Routing

- **MCP requests**: Can specify `chainId` in the arguments, or use path `/{chainId}`
- **JSON-RPC requests**: Must use path `/{chainId}` as before
- **Default**: Chain ID 1 (Ethereum mainnet) when not specified in MCP requests

## Example: Get Balance via MCP

```bash
curl -X POST https://rpc.ubq.fi/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "eth_getBalance",
      "arguments": {
        "address": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
        "blockNumber": "latest",
        "chainId": 1
      }
    }
  }'
```

## Implementation Details

- Total additions: ~650 lines to `deno-server.ts`
- No new files required
- Reuses existing `Permit2RpcManager` infrastructure
- Maintains all existing error handling and CORS policies
- Protocol version: `2024-11-05`
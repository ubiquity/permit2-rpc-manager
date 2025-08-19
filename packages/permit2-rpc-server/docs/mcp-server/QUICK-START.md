# MCP Server Quick Start Guide

## Installation in Claude Desktop

Add to your Claude Desktop configuration (`~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ethereum-json-rpc": {
      "command": "/Users/YOUR_USERNAME/.deno/bin/deno",
      "args": [
        "run",
        "--allow-all",
        "/path/to/permit2-rpc-manager/packages/permit2-rpc-server/src/mcp-ethereum-server.ts",
        "--transport",
        "stdio"
      ],
      "disabled": false,
      "autoApprove": [
        "eth_blockNumber",
        "eth_chainId", 
        "eth_gasPrice",
        "eth_getBalance",
        "eth_call"
      ]
    }
  }
}
```

## Quick Test Commands

### Using HTTP Transport
```bash
# Start server
deno task mcp-http

# Test in another terminal
curl -X POST http://localhost:3000 \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"eth_blockNumber","arguments":{}},"id":1}'
```

### Using Stdio Transport
```bash
echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"eth_blockNumber","arguments":{}},"id":1}' | deno task mcp-stdio
```

## Available Tools

All 28 Ethereum JSON-RPC methods are available:

### Core Methods
- `eth_getBalance` - Get account balance
- `eth_getCode` - Get contract code  
- `eth_call` - Execute contract call
- `eth_blockNumber` - Get latest block
- `eth_gasPrice` - Get current gas price
- `eth_chainId` - Get chain ID

### Transaction Methods
- `eth_getTransactionByHash`
- `eth_getTransactionReceipt` 
- `eth_sendRawTransaction`
- `eth_estimateGas`

### Block Methods
- `eth_getBlockByHash`
- `eth_getBlockByNumber`
- And more...

## Example Usage with Claude

Once configured, you can ask Claude:

- "What's the latest Ethereum block number?"
- "Get the balance for address 0x..."
- "What's the current gas price?"
- "Call this smart contract method..."

## Configuration

Copy and modify `examples/mcp-config.example.json` to customize:
- RPC endpoints
- Timeout settings
- Multi-chain support
- Error handling behavior

## Deployment

Ready for Deno Deploy:
```bash
deno deploy --project=ethereum-mcp src/mcp-ethereum-server.ts --transport http
```

For remote MCP usage, connect via:
```json
{
  "ethereum-remote": {
    "command": "bunx",
    "args": ["@modelcontextprotocol/server-http", "https://your-deploy-url.deno.dev"]
  }
}
```
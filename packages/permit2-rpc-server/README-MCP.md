# Ethereum JSON-RPC MCP Server

A comprehensive Model Context Protocol (MCP) server that exposes all Ethereum JSON-RPC methods as tools, built on top of the resilient Permit2 RPC Manager infrastructure.

## Features

- **Complete Ethereum JSON-RPC Support**: All standard Ethereum JSON-RPC methods exposed as MCP tools
- **Dual Transport Support**: Both stdio and Streamable HTTP transports
- **Resilient RPC Management**: Built on Permit2's failover and load balancing system
- **Session Management**: Stateful sessions for HTTP transport with automatic cleanup
- **Security**: DNS rebinding protection, Origin validation, and proper CORS handling
- **Error Handling**: Comprehensive error handling with proper MCP error codes
- **Configuration**: Flexible configuration with support for multiple chains

## Supported Ethereum JSON-RPC Methods

### Core Methods
- `eth_getBalance` - Get account balance
- `eth_getCode` - Get contract bytecode
- `eth_getTransactionCount` - Get transaction count (nonce)
- `eth_getStorageAt` - Get storage value at position
- `eth_call` - Execute contract call
- `eth_estimateGas` - Estimate gas for transaction
- `eth_blockNumber` - Get latest block number
- `eth_sendRawTransaction` - Send signed transaction

### Block Methods
- `eth_getBlockByHash` - Get block by hash
- `eth_getBlockByNumber` - Get block by number
- `eth_getBlockTransactionCountByHash` - Get transaction count in block by hash
- `eth_getBlockTransactionCountByNumber` - Get transaction count in block by number
- `eth_getUncleCountByBlockHash` - Get uncle count by block hash
- `eth_getUncleCountByBlockNumber` - Get uncle count by block number

### Transaction Methods
- `eth_getTransactionByHash` - Get transaction by hash
- `eth_getTransactionByBlockHashAndIndex` - Get transaction by block hash and index
- `eth_getTransactionByBlockNumberAndIndex` - Get transaction by block number and index
- `eth_getTransactionReceipt` - Get transaction receipt
- `eth_getUncleByBlockHashAndIndex` - Get uncle by block hash and index
- `eth_getUncleByBlockNumberAndIndex` - Get uncle by block number and index

### Network Info Methods
- `eth_protocolVersion` - Get protocol version
- `eth_syncing` - Get sync status
- `eth_coinbase` - Get coinbase address
- `eth_chainId` - Get chain ID
- `eth_mining` - Get mining status
- `eth_hashrate` - Get mining hashrate
- `eth_gasPrice` - Get current gas price
- `eth_accounts` - Get available accounts

## Quick Start

### 1. Stdio Transport (for MCP clients like Claude Desktop)

```bash
# Start the MCP server with stdio transport
deno task mcp-stdio
```

### 2. HTTP Transport (for web applications)

```bash
# Start the HTTP server on port 3000
deno task mcp-http

# Or with custom port and CORS
deno run --allow-all src/mcp-ethereum-server.ts --transport http --port 8080 --cors
```

### 3. Using with Configuration File

```bash
# Copy example config
cp mcp-config.example.json mcp-config.json

# Edit configuration as needed
# Then start with config
deno run --allow-all src/mcp-ethereum-server.ts --config mcp-config.json --transport http
```

## Configuration

Create a `mcp-config.json` file based on `mcp-config.example.json`:

```json
{
  "rpcUrls": [
    "https://eth.llamarpc.com",
    "https://ethereum.publicnode.com",
    "https://eth.drpc.org"
  ],
  "maxRetries": 3,
  "requestTimeoutMs": 30000,
  "panicModeConfig": {
    "enabled": true,
    "maxConsecutiveFailures": 5,
    "cooldownPeriod": 30000
  },
  "httpServer": {
    "port": 3000,
    "host": "127.0.0.1",
    "cors": false
  },
  "chains": {
    "1": {
      "name": "Ethereum Mainnet",
      "rpcUrls": ["https://eth.llamarpc.com"]
    },
    "137": {
      "name": "Polygon",
      "rpcUrls": ["https://polygon.llamarpc.com"]
    }
  }
}
```

## Integration with MCP Clients

### Claude Desktop

Add to your Claude Desktop MCP configuration:

```json
{
  "mcpServers": {
    "ethereum-rpc": {
      "command": "deno",
      "args": [
        "run",
        "--allow-all",
        "/path/to/permit2-rpc-manager/packages/permit2-rpc-server/src/mcp-ethereum-server.ts"
      ]
    }
  }
}
```

### Other MCP Clients

For HTTP-based clients, use the Streamable HTTP transport:

```bash
# Start HTTP server
deno task mcp-http

# Connect to http://localhost:3000
```

## Usage Examples

### Get Latest Block Number

```json
{
  "name": "eth_blockNumber",
  "arguments": {}
}
```

### Get Account Balance

```json
{
  "name": "eth_getBalance",
  "arguments": {
    "address": "0x742d35Cc6635C0532925a3b8D7389C9b9D06f9C8",
    "blockNumber": "latest"
  }
}
```

### Call Contract

```json
{
  "name": "eth_call",
  "arguments": {
    "transaction": {
      "to": "0xA0b86a33E6411a3D0fb0e63A4B5e5C4a8f2B5C1D",
      "data": "0x70a08231000000000000000000000000742d35Cc6635C0532925a3b8D7389C9b9D06f9C8"
    },
    "blockNumber": "latest"
  }
}
```

### Override RPC URL

All methods support an optional `rpcUrl` parameter:

```json
{
  "name": "eth_getBalance",
  "arguments": {
    "address": "0x742d35Cc6635C0532925a3b8D7389C9b9D06f9C8",
    "blockNumber": "latest",
    "rpcUrl": "https://your-custom-rpc.com"
  }
}
```

## Security Considerations

### HTTP Transport Security

- **DNS Rebinding Protection**: Origin headers are validated
- **Local Binding**: Server binds to localhost by default
- **Session Management**: Sessions expire automatically
- **CORS**: Configurable CORS support

### RPC Security

- **No Private Key Handling**: Server only makes read calls and broadcasts signed transactions
- **Request Validation**: All parameters are validated before forwarding to RPC providers
- **Timeout Protection**: All requests have configurable timeouts

## Development

### Prerequisites

- Deno 1.40+ with npm package support

### Running Tests

```bash
deno task test
```

### Code Formatting

```bash
deno task fmt
```

### Linting

```bash
deno task lint
```

## API Reference

### EthereumMcpServer (Stdio)

```typescript
import { EthereumMcpServer } from "./src/mcp-server.ts";
import { Permit2RpcManager } from "./src/permit2-rpc-manager.ts";

const rpcManager = new Permit2RpcManager(options);
const server = new EthereumMcpServer(rpcManager);
await server.run();
```

### EthereumMcpHttpServer (HTTP)

```typescript
import { EthereumMcpHttpServer } from "./src/mcp-http-server.ts";
import { Permit2RpcManager } from "./src/permit2-rpc-manager.ts";

const rpcManager = new Permit2RpcManager(options);
const server = new EthereumMcpHttpServer(rpcManager, {
  port: 3000,
  host: "127.0.0.1",
  cors: true
});
await server.start();
```

## Troubleshooting

### Common Issues

1. **Permission Errors**: Make sure to run with `--allow-all` or specific permissions
2. **Port Already in Use**: Check if another process is using the port
3. **RPC Connection Issues**: Verify RPC URLs are accessible and not rate-limited
4. **MCP Client Connection**: Ensure the client supports the MCP protocol version

### Debugging

Enable verbose logging by setting environment variables:

```bash
RUST_LOG=debug deno task mcp-http
```

### Logs

- Server startup and shutdown events
- RPC call successes and failures
- Session management events
- Error details with stack traces

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and linting
5. Submit a pull request

## License

This project inherits the license from the parent Permit2 RPC Manager project.
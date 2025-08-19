# Permit2 RPC Server Package

This package contains both the Permit2 RPC Proxy service and the Ethereum JSON-RPC MCP Server.

Refer to the [root README.md](../../README.md) for overall project information and core features.

## Services

### 1. Permit2 RPC Proxy Service

HTTP service that provides resilient Ethereum RPC access with automatic failover.

**API Endpoint:** `POST /{chainId}`
- Replace `{chainId}` with the desired EVM chain ID
- Request body: JSON-RPC 2.0 request object or array for batching
- Response: JSON-RPC 2.0 response object or array

### 2. Ethereum JSON-RPC MCP Server

Model Context Protocol server exposing all Ethereum JSON-RPC methods as tools for AI agents.

**Features:**
- All 28 standard Ethereum JSON-RPC methods
- Dual transport support (stdio & Streamable HTTP)
- Built on resilient RPC infrastructure
- Ready for Deno Deploy

**Documentation:** [docs/mcp-server/README-MCP.md](docs/mcp-server/README-MCP.md)

## Quick Start

### RPC Proxy Server
```bash
deno task start    # Start RPC proxy
deno task dev      # Development mode
```

### MCP Server
```bash
# Stdio transport (for MCP clients like Claude)
deno task mcp-stdio

# HTTP transport (for web applications)  
deno task mcp-http

# Custom configuration
deno run --allow-all src/mcp-ethereum-server.ts --config examples/mcp-config.example.json
```

## Development

Use Deno tasks defined in `deno.jsonc`:

- `deno task start`: Run the RPC proxy server
- `deno task dev`: Run with file watching
- `deno task mcp`: Run MCP server with stdio transport
- `deno task mcp-http`: Run MCP server with HTTP transport
- `deno task lint`: Lint the code
- `deno task fmt`: Format the code
- `deno task test`: Run tests

## Testing

```bash
# Test MCP server functionality
deno run --allow-all tests/test-mcp.ts
```

## Project Structure

```
├── src/
│   ├── permit2-rpc-manager.ts    # Core RPC management
│   ├── deno-server.ts            # HTTP RPC proxy server
│   ├── mcp-ethereum-server.ts    # MCP server CLI entry point
│   ├── mcp-server.ts             # MCP stdio server
│   ├── mcp-http-server.ts        # MCP HTTP server
│   └── ...                       # Supporting modules
├── docs/
│   └── mcp-server/               # MCP server documentation
├── examples/
│   └── mcp-config.example.json   # Configuration template
├── tests/
│   └── test-mcp.ts              # MCP server tests
└── ...
```

## Deployment

### RPC Proxy
Deployment is handled automatically via GitHub Actions workflow (`.github/workflows/deno-deploy.yml`).

### MCP Server
Ready for Deno Deploy:
```bash
deno deploy --project=ethereum-mcp src/mcp-ethereum-server.ts --transport http
```

## Configuration

- **RPC whitelist:** Managed by `rpc-whitelist.json`
- **MCP configuration:** See `examples/mcp-config.example.json`
- **Environment variables:** Available for Deno Deploy deployment

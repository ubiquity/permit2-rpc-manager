# MCP Implementation Analysis for RPC.UBQ.FI

## Executive Summary

This document analyzes the changes needed to make `https://rpc.ubq.fi/{networkId}` fully MCP (Model Context Protocol) compliant, allowing it to be integrated with LLM clients for natural interaction with Ethereum JSON-RPC methods.

After reviewing the `feat/mcp` branch, I've identified the minimal set of changes required to achieve MCP compliance while maintaining backward compatibility with existing JSON-RPC functionality.

## Current State vs. Target State

### Current State (feat/mcp2)

- Standard JSON-RPC proxy at `https://rpc.ubq.fi/{chainId}`
- Handles Ethereum JSON-RPC methods via POST requests
- Uses `Permit2RpcManager` for RPC endpoint management
- CORS-enabled for browser access

### Target State

- **Dual-mode operation**: Both JSON-RPC and MCP protocols
- **MCP endpoints**:
  - Root path `/` for chain-agnostic MCP requests
  - `/{chainId}` for chain-specific requests (backward compatible)
- **LLM Integration**: Direct integration with Claude Desktop, OpenAI, and other MCP-compatible clients

## Minimal Implementation Requirements

### 1. Dependencies

Add MCP SDK imports to `deno-server.ts`:

```typescript
import { CallToolRequest, CallToolResult, ListToolsRequest, ListToolsResult, Tool } from "npm:@modelcontextprotocol/sdk@1.0.4/types.js";
```

### 2. MCP Tool Definitions

Define all 28 Ethereum JSON-RPC methods as MCP tools. Here's the structure for key methods:

```typescript
const getEthereumTools = (): Tool[] => {
  return [
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
    // ... 27 more methods
  ];
};
```

### 3. Parameter Mapping

Convert MCP tool arguments to JSON-RPC parameters:

```typescript
function buildRpcParams(method: string, args: any): unknown[] {
  switch (method) {
    case "eth_getBalance":
      return [args.address, args.blockNumber];
    case "eth_getCode":
      return [args.address, args.blockNumber];
    case "eth_call":
      return [args.transaction, args.blockNumber];
    case "eth_estimateGas":
      return args.blockNumber ? [args.transaction, args.blockNumber] : [args.transaction];
    case "eth_blockNumber":
    case "eth_gasPrice":
    case "eth_chainId":
      return [];
    // ... more mappings
  }
}
```

### 4. MCP Request Detection and Handling

Extend the existing HTTP handler to detect and process MCP requests:

```typescript
const handler = async (request: Request): Promise<Response> => {
  // ... existing CORS setup ...

  // Detect MCP requests
  const isMcpRequest = (body: unknown): boolean => {
    if (typeof body === "object" && body !== null && "method" in body) {
      const method = (body as any).method;
      return (
        typeof method === "string" &&
        (method === "initialize" || method.startsWith("tools/") || method.startsWith("resources/") || method.startsWith("prompts/"))
      );
    }
    return false;
  };

  // Parse request body
  const requestBody = await request.json();

  // Handle MCP request
  if (isMcpRequest(requestBody)) {
    const mcpRequest = requestBody as any;
    let mcpResponse: any;

    switch (mcpRequest.method) {
      case "initialize":
        mcpResponse = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: {
            name: "ethereum-json-rpc",
            version: "1.0.0",
          },
        };
        break;

      case "tools/list":
        mcpResponse = {
          tools: getEthereumTools(),
        };
        break;

      case "tools/call":
        const toolName = mcpRequest.params?.name;
        const toolArgs = mcpRequest.params?.arguments || {};
        const chainId = toolArgs.chainId || 1;

        // Build RPC parameters
        const params = buildRpcParams(toolName, toolArgs);

        // Execute via existing RPC manager
        const result = await manager.send(chainId, toolName, params);

        mcpResponse = {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
        break;
    }

    // Return MCP response
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: mcpRequest.id,
        result: mcpResponse,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // ... continue with existing JSON-RPC handling ...
};
```

## Complete List of Ethereum Methods to Support

### Core Methods (7)

- `eth_getBalance` - Get account balance
- `eth_getCode` - Get contract code
- `eth_getTransactionCount` - Get nonce
- `eth_getStorageAt` - Read storage slot
- `eth_call` - Execute call without transaction
- `eth_estimateGas` - Estimate gas for transaction
- `eth_blockNumber` - Get latest block number

### Transaction Methods (6)

- `eth_sendRawTransaction` - Submit signed transaction
- `eth_getTransactionByHash` - Get transaction details
- `eth_getTransactionReceipt` - Get transaction receipt
- `eth_getTransactionByBlockHashAndIndex` - Get transaction by position
- `eth_getTransactionByBlockNumberAndIndex` - Get transaction by position
- `eth_getBlockTransactionCountByHash` - Count transactions in block

### Block Methods (8)

- `eth_getBlockByHash` - Get block by hash
- `eth_getBlockByNumber` - Get block by number
- `eth_getBlockTransactionCountByNumber` - Count transactions
- `eth_getUncleCountByBlockHash` - Count uncles
- `eth_getUncleCountByBlockNumber` - Count uncles
- `eth_getUncleByBlockHashAndIndex` - Get uncle details
- `eth_getUncleByBlockNumberAndIndex` - Get uncle details

### Network Info Methods (7)

- `eth_protocolVersion` - Protocol version
- `eth_syncing` - Sync status
- `eth_coinbase` - Coinbase address
- `eth_chainId` - Chain ID
- `eth_mining` - Mining status
- `eth_hashrate` - Hash rate
- `eth_gasPrice` - Current gas price
- `eth_accounts` - List accounts

## Implementation Size Analysis

### Lines of Code Breakdown

- **Tool definitions**: ~400 lines (28 methods × ~14 lines each)
- **MCP handler logic**: ~120 lines
- **Parameter mapping**: ~50 lines
- **Response formatting**: ~80 lines
- **Total addition**: ~650 lines to `deno-server.ts`

### What's NOT Needed from feat/mcp Branch

The following components from `feat/mcp` are **not required** for minimal MCP compliance:

1. **Separate MCP server files** (6 files, ~3000 lines):

   - `mcp-server.ts`
   - `mcp-simple-server.ts`
   - `mcp-http-server.ts`
   - `mcp-ethereum-server.ts`
   - `mcp-deployment-bridge.ts`
   - `mcp-bridge.sh` scripts

2. **Complex features**:

   - Session management
   - Server-sent events streaming
   - Stdio transport layers
   - Deployment bridges

3. **Documentation & Tests** (not needed for MVP):
   - MCP debugging guides
   - Extensive test suites
   - Deployment checklists

## Testing & Validation

### 1. MCP Protocol Testing

Test MCP initialization:

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

Expected response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": { "tools": {} },
    "serverInfo": {
      "name": "ethereum-json-rpc",
      "version": "1.0.0"
    }
  }
}
```

### 2. Tool Discovery Testing

List available tools:

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

### 3. Tool Execution Testing

Execute an Ethereum method via MCP:

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

### 4. Claude Desktop Integration

Configure in Claude Desktop settings:

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

## Benefits of This Approach

### 1. **Minimal Disruption**

- All changes contained in `deno-server.ts`
- No new files or dependencies beyond MCP SDK
- Existing JSON-RPC functionality unchanged

### 2. **Reuses Existing Infrastructure**

- Leverages `Permit2RpcManager` for RPC execution
- Uses existing CORS configuration
- Maintains current error handling

### 3. **Easy to Deploy**

- Single file modification
- No configuration changes needed
- Backward compatible with existing clients

### 4. **LLM-Ready**

- Natural language interaction with Ethereum
- Structured tool discovery
- Type-safe parameter validation

## Implementation Timeline

1. **Phase 1** (2-3 hours): Add MCP tool definitions and parameter mapping
2. **Phase 2** (1-2 hours): Implement MCP request detection and handling
3. **Phase 3** (1 hour): Testing and validation
4. **Phase 4** (30 min): Deploy and verify

Total estimated effort: **4-6 hours**

## Risks and Mitigations

| Risk                       | Impact | Mitigation                                   |
| -------------------------- | ------ | -------------------------------------------- |
| Breaking existing JSON-RPC | High   | Careful request detection, extensive testing |
| MCP protocol changes       | Medium | Pin SDK version, monitor updates             |
| Performance impact         | Low    | Minimal overhead, reuses existing code       |
| Security concerns          | Medium | Validate all inputs, maintain CORS policies  |

## Conclusion

The minimal MCP implementation requires adding approximately 650 lines to the existing `deno-server.ts` file. This approach:

- ✅ Achieves full MCP compliance
- ✅ Maintains backward compatibility
- ✅ Reuses existing infrastructure
- ✅ Enables LLM integration
- ✅ Minimizes complexity and risk

The implementation is straightforward, focused, and delivers exactly what's needed to fulfill the requirement: _"Extend `https://rpc.ubq.fi/{networkId}` to be fully MCP compliant"_ without the overhead of the full `feat/mcp` branch implementation.

## Next Steps

1. Review and approve this implementation plan
2. Implement the changes in `deno-server.ts`
3. Test with curl and Claude Desktop
4. Deploy to production
5. Document usage for LLM client configuration

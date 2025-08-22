# MCP HTTP Transport Solution

## Problem Statement

The current Deno deployment at `https://permit2-rpc-proxy-3bpsw1dk04ww.deno.dev/` implements JSON-RPC over HTTP but Claude CLI's `--transport http` expects the Model Context Protocol (MCP) over HTTP, which uses a different communication format. This creates an architectural incompatibility preventing direct connection from Claude CLI to the deployment.

## Current State

### Working Deployment
- **URL**: `https://permit2-rpc-proxy-3bpsw1dk04ww.deno.dev/`
- **Protocol**: JSON-RPC 2.0 over HTTP
- **Request Format**: 
  ```json
  {
    "jsonrpc": "2.0",
    "method": "tools/list",
    "params": {},
    "id": 1
  }
  ```
- **Response Format**:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 1,
    "result": {
      "tools": [/* 28 Ethereum tools */]
    }
  }
  ```

### Claude CLI HTTP Transport Expectation
Claude CLI's `--transport http` expects MCP protocol over HTTP, which uses:
- Different message format
- Different endpoint structure
- Potentially Server-Sent Events (SSE) or WebSocket connections

## Solution Overview

Modify the Deno deployment to support both protocols:
1. **Keep existing JSON-RPC functionality** (for backward compatibility)
2. **Add MCP HTTP transport support** (for Claude CLI direct connection)
3. **Smart request detection** (route based on request format/headers)

## Implementation Requirements

### 1. Dual Protocol Support

The deployment should handle both:
- **JSON-RPC requests** (current format) - maintain existing functionality
- **MCP HTTP requests** (new format) - enable Claude CLI direct connection

### 2. Request Detection Logic

```typescript
// Pseudo-code for request routing
if (isJsonRpcRequest(request)) {
  return handleJsonRpc(request);
} else if (isMcpRequest(request)) {
  return handleMcpHttp(request);
} else {
  return handleEthereumRpc(request); // fallback to direct RPC
}
```

### 3. MCP HTTP Transport Implementation

#### Required Dependencies
```typescript
import { Server } from "npm:@modelcontextprotocol/sdk/server/index.js";
import { HTTPServerTransport } from "npm:@modelcontextprotocol/sdk/server/http.js"; // If available
// OR implement custom HTTP transport
```

#### MCP Message Format
Unlike JSON-RPC, MCP uses different message structures:

**Tools List Request**:
```json
{
  "method": "tools/list",
  "params": {}
}
```

**Tools List Response**:
```json
{
  "tools": [
    {
      "name": "eth_getBalance",
      "description": "Returns the balance of the account at the given address",
      "inputSchema": {
        "type": "object",
        "properties": {
          "address": {"type": "string"},
          "blockNumber": {"type": "string"},
          "chainId": {"type": "number"}
        },
        "required": ["address", "blockNumber"]
      }
    }
    // ... all 28 tools
  ]
}
```

**Tool Call Request**:
```json
{
  "method": "tools/call",
  "params": {
    "name": "eth_getBalance",
    "arguments": {
      "address": "0x...",
      "blockNumber": "latest",
      "chainId": 1
    }
  }
}
```

**Tool Call Response**:
```json
{
  "content": [
    {
      "type": "text",
      "text": "0x1b1ae4d6e2ef500000" 
    }
  ]
}
```

### 4. File Modifications Required

#### Primary File: `/packages/permit2-rpc-server/src/deno-server.ts`

**Current Smart Detection Logic** (already exists):
```typescript
// Detect if request is MCP-style
if (method === "tools/list" || method === "tools/call") {
  // Handle as MCP request
}
```

**Required Enhancements**:
1. Add proper MCP HTTP response formatting
2. Ensure HTTP headers are MCP-compliant
3. Handle CORS for cross-origin requests from Claude CLI

#### Response Format Changes

**Current JSON-RPC Response**:
```typescript
return new Response(JSON.stringify({
  jsonrpc: "2.0",
  id: body.id,
  result: mcpResponse
}), {
  headers: { "Content-Type": "application/json" }
});
```

**Required MCP HTTP Response**:
```typescript
return new Response(JSON.stringify(mcpResponse), {
  headers: { 
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  }
});
```

### 5. Testing Requirements

After implementation, verify:

1. **JSON-RPC still works**:
   ```bash
   curl -X POST https://permit2-rpc-proxy-3bpsw1dk04ww.deno.dev/ \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}'
   ```

2. **MCP HTTP works**:
   ```bash
   curl -X POST https://permit2-rpc-proxy-3bpsw1dk04ww.deno.dev/ \
     -H "Content-Type: application/json" \
     -d '{"method":"tools/list","params":{}}'
   ```

3. **Claude CLI connects**:
   ```bash
   claude mcp add ethereum-rpc --transport http https://permit2-rpc-proxy-3bpsw1dk04ww.deno.dev/
   claude mcp list
   # Should show: ✓ Connected
   ```

### 6. Key Differences Between Protocols

| Aspect | JSON-RPC | MCP HTTP |
|--------|----------|----------|
| Request ID | Required | Optional |
| Wrapper Object | `{"jsonrpc":"2.0", "method":"...", "id":1}` | `{"method":"...", "params":...}` |
| Response Wrapper | `{"jsonrpc":"2.0", "id":1, "result":...}` | Direct result object |
| Error Format | `{"jsonrpc":"2.0", "id":1, "error":...}` | Different error structure |

### 7. Implementation Steps

1. **Analyze current request detection** in `deno-server.ts`
2. **Modify response formatting** for MCP requests (remove JSON-RPC wrapper)
3. **Add proper CORS headers** for Claude CLI compatibility
4. **Test both protocols** work simultaneously
5. **Deploy and verify** Claude CLI can connect directly

### 8. Success Criteria

- ✅ Existing JSON-RPC functionality unchanged
- ✅ New MCP HTTP requests work without JSON-RPC wrapper
- ✅ Claude CLI connects via `claude mcp add ethereum-rpc --transport http https://permit2-rpc-proxy-3bpsw1dk04ww.deno.dev/`
- ✅ All 28 Ethereum tools accessible through Claude CLI
- ✅ No local execution required

## Technical Notes

- The deployment already has smart request detection logic
- The core RPC functionality doesn't need changes
- Only response formatting and HTTP transport layer need modification
- Maintain backward compatibility with existing integrations
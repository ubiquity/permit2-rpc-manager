# MCP Server Debugging Guide

## Problem
MCP servers fail to connect with Claude Code CLI (`claude mcp list` shows "Failed to connect")

## Root Cause
MCP servers communicate via JSON-RPC over stdio (standard input/output), not HTTP. Debugging requires capturing stdio streams.

## How MCP Communication Works

### 1. Protocol
- **Transport**: stdio (stdin/stdout), not HTTP
- **Format**: JSON-RPC 2.0
- **Encoding**: Plain text JSON, newline-delimited

### 2. Initial Handshake
Claude Code sends this exact initialize request:
```json
{
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {"roots": {}},
    "clientInfo": {"name": "claude-code", "version": "1.0.84"}
  },
  "jsonrpc": "2.0",
  "id": 0
}
```

Server must respond with:
```json
{
  "result": {
    "protocolVersion": "2024-11-05",  // or other supported version
    "capabilities": {"tools": {}},
    "serverInfo": {"name": "your-server", "version": "1.0.0"}
  },
  "jsonrpc": "2.0",
  "id": 0
}
```

## Debugging Steps

### Step 1: Install Debugging Tools
```bash
brew install socat
```

### Step 2: Create Debug Wrapper
Create `debug-wrapper.sh`:
```bash
#!/usr/bin/env bash

# Create debug directory
DEBUG_DIR="/tmp/mcp-debug"
mkdir -p "$DEBUG_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Use socat to intercept stdio
exec socat -t100 -x -v \
    STDIO \
    "EXEC:'your-actual-mcp-server-command',pty,stderr" \
    2>"$DEBUG_DIR/socat-$TIMESTAMP.log"
```

### Step 3: Add Debug Server to Claude
```bash
claude mcp add debug-server /path/to/debug-wrapper.sh
```

### Step 4: Test Connection
```bash
claude mcp list
```

### Step 5: Examine Captured Data
```bash
cat /tmp/mcp-debug/socat-*.log
```

## Common Issues

### Issue 1: Method Not Found Error
**Symptom**: Server responds with error code -32601
**Solution**: Ensure MCP SDK is properly initialized and handling the initialize method

### Issue 2: Protocol Version Mismatch
**Symptom**: Different protocol versions in request/response
**Note**: This is usually not a problem. Claude Code accepts older protocol versions.

### Issue 3: Wrapper Script Breaks Communication
**Symptom**: Server works directly but fails through wrapper
**Solution**: Use simple exec passthrough without stream manipulation:
```bash
#!/usr/bin/env bash
exec your-mcp-server-command 2>/tmp/mcp-stderr.log
```

## Manual Testing

### Test Initialize Request
```bash
echo '{"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"roots":{}},"clientInfo":{"name":"claude-code","version":"1.0.84"}},"jsonrpc":"2.0","id":0}' | your-mcp-server
```

### Expected Response Pattern
```json
{"result":{...},"jsonrpc":"2.0","id":0}
```

## Implementation Requirements

1. Server must handle stdio communication (not HTTP)
2. Server must respond to `initialize` method
3. Server must use JSON-RPC 2.0 format
4. Messages are newline-delimited
5. Server should not exit after handling requests

## Quick Fix Checklist

- [ ] Server handles `initialize` method
- [ ] Server reads from stdin
- [ ] Server writes to stdout
- [ ] Server stays running after initialization
- [ ] No extra output to stdout (only JSON-RPC)
- [ ] Error messages go to stderr, not stdout
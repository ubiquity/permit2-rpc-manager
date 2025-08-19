#!/usr/bin/env bash

# Wrapper script for the MCP deployment bridge to handle Deno flags properly
exec /Users/nv/.deno/bin/deno run --allow-all /Users/nv/repos/ubiquity/permit2-rpc-manager/packages/permit2-rpc-server/src/mcp-deployment-bridge.ts
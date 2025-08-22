#!/usr/bin/env bash

# Simple passthrough with logging
exec /Users/nv/.deno/bin/deno run --allow-all /Users/nv/repos/ubiquity/permit2-rpc-manager/packages/permit2-rpc-server/src/mcp-deployment-bridge.ts 2>/tmp/mcp-stderr.log
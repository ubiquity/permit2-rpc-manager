#!/bin/bash

# Bridge script to connect to remote MCP server via stdio
# This acts as a proxy between Claude CLI (stdio) and the remote HTTP server

REMOTE_URL="https://permit2-rpc-proxy-z8n30xyj1wmp.deno.dev/"

while IFS= read -r line; do
    # Send the request to the remote server and return the response
    echo "$line" | curl -X POST "$REMOTE_URL" \
        -H "Content-Type: application/json" \
        -d @- \
        2>/dev/null
    echo  # Add newline for stdio protocol
done
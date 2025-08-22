#!/bin/bash

# Test script for MCP protocol implementation
# This script tests the MCP compliance of the RPC server

BASE_URL="http://localhost:8000"

echo "========================================="
echo "Testing MCP Protocol Implementation"
echo "========================================="
echo ""

# Test 1: MCP Initialize
echo "Test 1: MCP Initialize"
echo "----------------------"
curl -X POST ${BASE_URL}/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {}
  }' | jq .

echo ""
echo ""

# Test 2: List Tools
echo "Test 2: List Tools (first 3 tools only for brevity)"
echo "----------------------------------------------------"
curl -X POST ${BASE_URL}/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }' | jq '.result.tools[0:3]'

echo ""
echo ""

# Test 3: Call Tool - eth_blockNumber
echo "Test 3: Call Tool - eth_blockNumber (chainId: 1)"
echo "--------------------------------------------------"
curl -X POST ${BASE_URL}/ \
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
  }' | jq .

echo ""
echo ""

# Test 4: Call Tool - eth_gasPrice
echo "Test 4: Call Tool - eth_gasPrice (chainId: 1)"
echo "-----------------------------------------------"
curl -X POST ${BASE_URL}/ \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "eth_gasPrice",
      "arguments": {
        "chainId": 1
      }
    }
  }' | jq .

echo ""
echo ""

# Test 5: Backward compatibility - Regular JSON-RPC
echo "Test 5: Regular JSON-RPC (backward compatibility)"
echo "--------------------------------------------------"
curl -X POST ${BASE_URL}/1 \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 5,
    "method": "eth_blockNumber",
    "params": []
  }' | jq .

echo ""
echo "========================================="
echo "MCP Protocol Tests Complete"
echo "========================================="
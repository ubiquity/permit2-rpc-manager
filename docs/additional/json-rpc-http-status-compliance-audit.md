# JSON-RPC 2.0 HTTP Status Code Compliance Audit

## Overview
This document provides a comprehensive audit of HTTP status code usage in the permit2-rpc-server to ensure full JSON-RPC 2.0 specification compliance. According to the JSON-RPC 2.0 specification, all JSON-RPC responses (both successful results and errors) should return HTTP 200, with errors communicated through the response body. Non-200 HTTP status codes should only be used for transport-level issues.

## Audit Date
June 16, 2025

## JSON-RPC 2.0 Specification Summary
- **HTTP 200**: Should be used for ALL JSON-RPC responses (success or error)
- **Non-200 codes**: Only for transport/protocol issues (not JSON-RPC application errors)
- **Error communication**: Via the `error` field in the JSON-RPC response body

## Current Issues Found

### 1. Parse Errors (HTTP 400) ❌ NON-COMPLIANT
**Location**: `deno-server.ts` lines 199-206
```typescript
const errorResponse = createJsonRpcError(null, -32700, `Parse error: ${error.message}`);
return new Response(JSON.stringify(errorResponse), {
  status: 400, // Should be 200
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});
```
**Issue**: Parse errors (-32700) are JSON-RPC errors and should return HTTP 200

### 2. Invalid Request - Empty Batch (HTTP 400) ❌ NON-COMPLIANT
**Location**: `deno-server.ts` lines 213-219
```typescript
const errorResponse = createJsonRpcError(null, -32600, "Invalid Request: Received empty batch.");
return new Response(JSON.stringify(errorResponse), {
  status: 400, // Should be 200
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});
```
**Issue**: Invalid request errors (-32600) should return HTTP 200

### 3. Invalid Request - Bad Batch (HTTP 400) ❌ NON-COMPLIANT
**Location**: `deno-server.ts` lines 223-229
```typescript
const errorResponse = createJsonRpcError(null, -32600, "Invalid Request: Batch contains invalid JSON-RPC object(s).");
return new Response(JSON.stringify(errorResponse), {
  status: 400, // Should be 200
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});
```
**Issue**: Invalid request errors should return HTTP 200

### 4. Invalid Request Structure (HTTP 400) ❌ NON-COMPLIANT
**Location**: `deno-server.ts` lines 307-313
```typescript
const errorResponse = createJsonRpcError(null, -32600, "Invalid Request: Not a valid JSON-RPC object or batch.");
return new Response(JSON.stringify(errorResponse), {
  status: 400, // Should be 200
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});
```
**Issue**: Invalid request errors should return HTTP 200

### 5. Invalid Path/ChainId (HTTP 400) ❌ NON-COMPLIANT
**Location**: `deno-server.ts` lines 187-192
```typescript
return new Response("Bad Request: Invalid chainId", {
  status: 400,
  headers: corsHeaders,
});
```
**Issue**: This is not a JSON-RPC response, but should be handled as JSON-RPC error with HTTP 200

### 6. Single Request Error Handling ✅ COMPLIANT
**Location**: `deno-server.ts` lines 268-271
```typescript
let httpStatus = 200; // Default to 200
if (error.name === "JsonRpcError" && "httpStatus" in error && typeof error.httpStatus === "number") {
  httpStatus = error.httpStatus;
}
```
**Status**: Correctly defaults to HTTP 200 for JSON-RPC errors

### 7. Batch Request Error Handling ✅ PARTIALLY COMPLIANT
**Location**: `deno-server.ts` lines 258
```typescript
return new Response(JSON.stringify(responses), {
  status: 200,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});
```
**Status**: Always returns HTTP 200 for batch responses (correct)

## Non-JSON-RPC Endpoints (No Changes Needed)

### 1. GET / (HTML) ✅ OK
Returns HTML page - not a JSON-RPC endpoint

### 2. GET /logo.svg ✅ OK
Returns SVG image - not a JSON-RPC endpoint

### 3. OPTIONS (CORS) ✅ OK
Returns 204 for preflight - correct for CORS

### 4. Method Not Allowed ✅ OK
Returns 405 for non-POST methods - correct for non-JSON-RPC requests

### 5. Not Found ✅ OK
Returns 404 for invalid paths - correct for routing errors

## Recommended Changes

1. **All JSON-RPC error responses must return HTTP 200**:
   - Parse errors (-32700)
   - Invalid Request errors (-32600)
   - Invalid Params errors (-32602)
   - Method not found errors (-32601)
   - Internal errors (-32603)
   - Server errors (-32000 to -32099)

2. **Only use non-200 codes for**:
   - Transport/protocol errors (e.g., CORS, method not allowed)
   - Resource not found (before JSON-RPC processing)
   - Genuine HTTP errors from upstream (preserved via httpStatus field)

3. **Invalid chainId handling**:
   - Should return JSON-RPC error response with HTTP 200
   - Use error code -32602 (Invalid params) or -32600 (Invalid Request)

## Implementation Plan

1. Update all JSON-RPC error responses to use HTTP 200
2. Convert non-JSON responses (like invalid chainId) to JSON-RPC format
3. Ensure httpStatus field is only used for genuine upstream HTTP errors
4. Add comprehensive testing for all error scenarios

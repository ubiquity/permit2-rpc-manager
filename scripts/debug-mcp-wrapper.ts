#!/usr/bin/env bun

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

// Create debug directory
const debugDir = path.join(process.cwd(), "mcp-debug");
if (!fs.existsSync(debugDir)) {
  fs.mkdirSync(debugDir);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const stdinLog = fs.createWriteStream(path.join(debugDir, `${timestamp}-stdin.log`));
const stdoutLog = fs.createWriteStream(path.join(debugDir, `${timestamp}-stdout.log`));
const stderrLog = fs.createWriteStream(path.join(debugDir, `${timestamp}-stderr.log`));

// Get the actual MCP server command from arguments
const serverCommand = process.argv.slice(2);

if (serverCommand.length === 0) {
  console.error("Usage: debug-mcp-wrapper.ts <mcp-server-command>");
  process.exit(1);
}

console.error(`[DEBUG] Starting MCP server: ${serverCommand.join(" ")}`);
console.error(`[DEBUG] Logs will be saved to: ${debugDir}`);

// Spawn the actual MCP server
const child = spawn(serverCommand[0], serverCommand.slice(1), {
  stdio: ["pipe", "pipe", "pipe"],
});

// Log and forward stdin
process.stdin.on("data", (data) => {
  const message = data.toString();
  stdinLog.write(`[${new Date().toISOString()}] STDIN:\n${message}\n---\n`);
  console.error(`[DEBUG STDIN] ${message.substring(0, 200)}...`);
  child.stdin.write(data);
});

// Log and forward stdout
child.stdout.on("data", (data) => {
  const message = data.toString();
  stdoutLog.write(`[${new Date().toISOString()}] STDOUT:\n${message}\n---\n`);
  console.error(`[DEBUG STDOUT] ${message.substring(0, 200)}...`);
  process.stdout.write(data);
});

// Log and forward stderr
child.stderr.on("data", (data) => {
  const message = data.toString();
  stderrLog.write(`[${new Date().toISOString()}] STDERR:\n${message}\n---\n`);
  process.stderr.write(data);
});

// Handle process exit
child.on("exit", (code) => {
  console.error(`[DEBUG] MCP server exited with code: ${code}`);
  stdinLog.end();
  stdoutLog.end();
  stderrLog.end();
  process.exit(code || 0);
});

// Handle errors
child.on("error", (err) => {
  console.error(`[DEBUG] Error spawning MCP server:`, err);
  process.exit(1);
});
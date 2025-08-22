#!/usr/bin/env deno run --allow-all

/**
 * Proper MCP stdio bridge that connects Claude Desktop to HTTP deployment
 * Implements full MCP protocol over stdio transport
 */

import { Server } from "npm:@modelcontextprotocol/sdk@1.0.4/server/index.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@1.0.4/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "npm:@modelcontextprotocol/sdk@1.0.4/types.js";

const DEPLOYMENT_URL = "https://permit2-rpc-proxy-3bpsw1dk04ww.deno.dev/";

class DeploymentBridge {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: "ethereum-json-rpc-deployment",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    // Handle tools/list by forwarding to deployment
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      try {
        const response = await fetch(DEPLOYMENT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "tools/list",
            params: {},
            id: 1,
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();
        return result.result;
      } catch (error) {
        console.error("Bridge tools/list error:", error);
        return { tools: [] };
      }
    });

    // Handle tools/call by forwarding to deployment
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const response = await fetch(DEPLOYMENT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
              name: request.params.name,
              arguments: request.params.arguments || {},
            },
            id: 1,
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();
        
        if (result.error) {
          throw new Error(`Deployment error: ${result.error.message}`);
        }

        return result.result;
      } catch (error) {
        console.error("Bridge tools/call error:", error);
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

// Main entry point
if (import.meta.main) {
  const bridge = new DeploymentBridge();
  console.error("Starting MCP deployment bridge...");
  await bridge.run();
}
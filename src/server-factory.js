#!/usr/bin/env node
/**
 * Shared MCP server factory.
 *
 * Both transports build their McpServer here so serverInfo, instructions and
 * the registered tool set stay in sync:
 *   - HTTP  — src/mcp-server.mjs   (StreamableHTTPServerTransport, port 3000)
 *   - stdio — src/stdio-server.mjs (StdioServerTransport, stdin/stdout)
 *
 * The factory is transport-agnostic: it only wires the tool layer, which
 * never touches the network or the process streams.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools.js';

export const SERVER_NAME = 'mermaid-mcp';
export const SERVER_VERSION = '1.0.0';

const INSTRUCTIONS =
  'Mermaid diagram validation and rendering. ' +
  'validate — check diagram syntax (instant). ' +
  'render — render diagram as PNG (default) or SVG. ' +
  'Uses jsdom + sharp — no browser needed.';

/**
 * Create a fully configured McpServer with both tools registered.
 * @returns {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer}
 */
export function createMcpServer() {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  registerTools(server);

  return server;
}

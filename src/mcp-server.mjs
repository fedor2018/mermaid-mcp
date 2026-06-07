#!/usr/bin/env node
/**
 * mermaid-mcp — HTTP-native MCP server for Mermaid.
 *
 * Stateless streamable HTTP transport on port 3000.
 * Each request gets its own McpServer + transport pair (no cross-request state).
 * Uses Node.js built-in http module — NO Express.
 */

import http from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { logInfo, logDebug } from './logger.js';
import { registerTools } from './tools.js';

/**
 * Create the HTTP server.
 */
function createServer() {
  const server = http.createServer(async (req, res) => {
    // Only handle POST /mcp
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(405, { 'Content-Type': 'text/plain' }).end('Method Not Allowed');
      return;
    }

    // Validate Content-Type — must be JSON
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json') && !contentType.includes('+json')) {
      res.writeHead(415, { 'Content-Type': 'text/plain' }).end('Unsupported Media Type');
      return;
    }

    // Body size limit — reject large payloads early
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength > config.maxBodySize) {
      logDebug(`Rejected oversized request: ${contentLength} bytes`);
      res.writeHead(413, { 'Content-Type': 'text/plain' }).end('Payload Too Large');
      return;
    }

    // Read body from stream chunks
    let rawBody;
    try {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
        // Check accumulated size to prevent memory exhaustion
        const totalSize = chunks.reduce((sum, c) => sum + c.length, 0);
        if (totalSize > config.maxBodySize) {
          res.writeHead(413, { 'Content-Type': 'text/plain' }).end('Payload Too Large');
          return;
        }
      }
      rawBody = Buffer.concat(chunks).toString('utf-8');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Error reading request body');
      return;
    }

    // Parse JSON body
    let parsedBody;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Invalid JSON');
      return;
    }

    logDebug(`POST /mcp method=${parsedBody?.method ?? 'unknown'} id=${parsedBody?.id ?? 'null'}`);

    // Per-request stateless McpServer + transport
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });

    const mcpServer = new McpServer(
      { name: 'mermaid-mcp', version: '1.0.0' },
      {
        instructions:
          'Mermaid diagram validation and rendering. ' +
          'validate — check diagram syntax (instant). ' +
          'render — render diagram as PNG (default) or SVG. ' +
          'Uses jsdom + sharp — no browser needed.',
      },
    );

    registerTools(mcpServer);
    await mcpServer.connect(transport);

    try {
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      logInfo(`Transport error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }),
        );
      }
    } finally {
      await mcpServer.close();
    }
  });

  return server;
}

let _signalHandlersInstalled = false;

/**
 * Install process-wide signal handlers (once).
 */
function installSignalHandlers(server) {
  if (_signalHandlersInstalled) return;
  _signalHandlersInstalled = true;

  // Unhandled rejection handler
  process.on('unhandledRejection', (reason) => {
    logInfo(`Unhandled rejection: ${reason?.message || reason}`);
  });

  // Graceful shutdown on SIGINT
  process.on('SIGINT', () => {
    logInfo('Shutting down...');
    server.close(() => process.exit(0));
  });
}

/**
 * Start the server on the given port.
 * @param {number} [port] — Optional port override (for testing). Defaults to config.port.
 * @returns {http.Server}
 */
export function startServer(port) {
  const listenPort = port ?? config.port;
  const server = createServer();

  server.listen(listenPort, '0.0.0.0', () => {
    logInfo(`mermaid-mcp running on port ${listenPort}`);
  });

  installSignalHandlers(server);

  return server;
}

// Start when run directly (not imported for testing)
const scriptPath = process.argv[1] || '';
if (scriptPath.includes('mcp-server.mjs')) {
  startServer();
}

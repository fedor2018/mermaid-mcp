#!/usr/bin/env node
/**
 * mermaid-mcp — stdio transport entry point.
 *
 * Speaks MCP over stdin/stdout using newline-delimited JSON-RPC.
 * stdout carries JSON-RPC messages ONLY — every log line goes to stderr
 * (see logger.js), so the stream stays parseable by the client.
 *
 * Typical usage:
 *   - spawned by a MCP client (Claude Desktop, opencode "local" type)
 *   - spawned by sparfenyuk/mcp-proxy, which re-exposes this server
 *     as SSE / Streamable HTTP:
 *       mcp-proxy --port=8080 -- node /abs/path/src/stdio-server.mjs
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server-factory.js';
import { logInfo, logDebug } from './logger.js';

/**
 * Create the stdio server.
 * @returns {Promise<{ server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer, transport: StdioServerTransport }>}
 */
export async function startStdioServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  logInfo('mermaid-mcp running on stdio');

  return { server, transport };
}

/**
 * Install process-wide signal handlers (once).
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
function installSignalHandlers(server) {
  let shuttingDown = false;

  /**
   * Close the transport and let the process exit naturally.
   *
   * The order matters: closing the transport detaches the stdin listeners,
   * unref'ing stdin releases the last event-loop handle, so Node exits on
   * its own — pending stdout writes are flushed instead of being truncated
   * by a hard process.exit(). The unref'd timer is only a safety net for
   * the case where something else keeps the loop alive.
   */
  async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;

    logInfo('Shutting down...');

    try {
      await server.close();
    } catch (err) {
      logInfo(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
    }

    process.exitCode = code;
    process.stdin.pause();
    process.stdin.unref?.();
    setTimeout(() => process.exit(code), 1000).unref();
  }

  // Client closed the pipe (mcp-proxy closes stdin before SIGTERM).
  // Without this the process would linger until the proxy force-kills it.
  process.stdin.on('end', () => {
    logDebug('stdin closed');
    shutdown(0);
  });

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  process.on('unhandledRejection', (reason) => {
    logInfo(`Unhandled rejection: ${reason?.message || reason}`);
  });
}

// Start when run directly (not imported for testing)
const scriptPath = process.argv[1] || '';
if (scriptPath.includes('stdio-server.mjs')) {
  const { server } = await startStdioServer();
  installSignalHandlers(server);
}

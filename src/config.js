#!/usr/bin/env node
/**
 * Configuration for mermaid-mcp.
 * All environment variables loaded once at startup into a single object.
 * No process.env access outside this module.
 */

export const config = Object.freeze({
  port: parseInt(process.env.MCP_PORT || '3000', 10),
  defaultFormat: (process.env.MERMAID_DEFAULT_FORMAT || 'png').toLowerCase(),
  backgroundColor: process.env.MERMAID_BACKGROUND_COLOR || 'transparent',
  scale: parseInt(process.env.MERMAID_SCALE || '1', 10),
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  maxBodySize: parseInt(process.env.MCP_MAX_BODY_SIZE || String(10 * 1024 * 1024), 10),
});

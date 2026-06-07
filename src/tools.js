#!/usr/bin/env node
/**
 * MCP tool definitions for mermaid-mcp.
 *
 * Two tools:
 *   - validate: Parse-only validation, instant, no rendering
 *   - render:   Validate + render + convert to PNG/SVG
 *
 * Each handler is a thin wrapper — business logic lives in renderer.js.
 */

import { z } from 'zod';
import { validate as rendererValidate, render as rendererRender } from './renderer.js';
import { config } from './config.js';

/**
 * Register all tools on an McpServer instance.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} mcpServer
 */
export function registerTools(mcpServer) {
  mcpServer.registerTool(
    'validate',
    {
      title: 'Validate Mermaid Diagram',
      description:
        'Validate a Mermaid diagram definition without rendering. ' +
        'Returns the detected diagram type on success or a parse error with line number on failure. ' +
        'Pure Node.js — instant, no browser needed.',
      inputSchema: z.object({
        diagram: z.string().describe('Mermaid diagram definition text'),
      }),
    },
    handleValidate,
  );

  mcpServer.registerTool(
    'render',
    {
      title: 'Render Mermaid Diagram',
      description:
        'Render a Mermaid diagram definition to PNG or SVG. ' +
        'Validates first, then renders via jsdom (no browser needed). ' +
        'PNG output uses 2x DPI (density 144) for crisp images.',
      inputSchema: z.object({
        diagram: z.string().describe('Mermaid diagram definition text'),
        format: z
          .enum(['png', 'svg'])
          .default('png')
          .describe('Output format — PNG (raster) or SVG (vector)'),
        backgroundColor: z
          .string()
          .default(config.backgroundColor)
          .describe('Background color for PNG (CSS color value, e.g. "white" or "transparent")'),
      }),
    },
    handleRender,
  );
}

/**
 * Handler for the validate tool.
 */
async function handleValidate(args) {
  try {
    const result = await rendererValidate(args.diagram);

    if (!result.valid) {
      return {
        content: [{ type: 'text', text: `Invalid: ${result.error}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text', text: `Valid: ${result.diagramType}` }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error: ${msg}` }],
      isError: true,
    };
  }
}

/**
 * Handler for the render tool.
 */
async function handleRender(args) {
  try {
    const { diagram, format, backgroundColor } = args;
    const result = await rendererRender(diagram, format || 'png', backgroundColor || 'transparent');

    if (result.error) {
      return {
        content: [{ type: 'text', text: `Error: ${result.error}` }],
        isError: true,
      };
    }

    if (format === 'svg' && result.svg) {
      const svgBuffer = Buffer.from(result.svg, 'utf-8');
      const svgBase64 = svgBuffer.toString('base64');
      return {
        content: [
          { type: 'text', text: `Rendered as SVG (${svgBuffer.length} bytes)` },
          { type: 'image', data: svgBase64, mimeType: 'image/svg+xml' },
        ],
      };
    }

    if (result.png) {
      const pngBase64 = result.png.toString('base64');
      return {
        content: [
          { type: 'text', text: `Rendered as PNG (${result.png.length} bytes)` },
          { type: 'image', data: pngBase64, mimeType: 'image/png' },
        ],
      };
    }

    // Shouldn't reach here
    return {
      content: [{ type: 'text', text: 'Error: No output produced' }],
      isError: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error: ${msg}` }],
      isError: true,
    };
  }
}

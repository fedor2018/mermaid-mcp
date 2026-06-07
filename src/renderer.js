#!/usr/bin/env node
/**
 * Renderer — Mermaid validation and rendering pipeline.
 *
 * Uses jsdom global (set up by polyfills.js) for mermaid.render().
 * Converts SVG to PNG via sharp when PNG format is requested.
 *
 * All functions are async — mermaid is lazily loaded after jsdom polyfills.
 */

import sharp from 'sharp';
import crypto from 'crypto';
import { getMermaid } from './polyfills.js';

/**
 * Validate a Mermaid diagram without rendering.
 *
 * NOTE: mermaid.parse() is async internally (uses an internal queue),
 * so validate() must be async too.
 *
 * @param {string} diagram - Mermaid diagram definition text
 * @returns {Promise<{ valid: true, diagramType: string } | { valid: false, error: string }>}
 */
export async function validate(diagram) {
  if (!diagram || typeof diagram !== 'string' || diagram.trim().length === 0) {
    return { valid: false, error: 'Diagram input is required' };
  }

  try {
    const mermaid = await getMermaid();
    // mermaid.parse() throws on invalid syntax (internally async).
    // suppressErrors: false so we can catch parse errors and return them.
    await mermaid.parse(diagram, { suppressErrors: false });
    // Detect diagram type for valid diagrams
    const diagramType = mermaid.detectType(diagram);
    return { valid: true, diagramType };
  } catch (err) {
    // Extract meaningful error message with line number
    const msg = err instanceof Error ? err.message : String(err);
    // Format: "Parse error on line X: ..." — mermaid already includes this format
    // But if it doesn't, prepend "Parse error:"
    const errorMsg = msg.toLowerCase().includes('parse error') ? msg : `Parse error: ${msg}`;
    return { valid: false, error: errorMsg };
  }
}

/**
 * Render a Mermaid diagram to SVG or PNG.
 *
 * @param {string} diagram - Mermaid diagram definition text
 * @param {'svg'|'png'} format - Output format
 * @param {string} backgroundColor - Background color for PNG (CSS color value)
 * @returns {Promise<{ svg?: string, png?: Buffer, error?: string }>}
 */
export async function render(diagram, format = 'png', backgroundColor = 'transparent') {
  // 1. Validate first — fail fast (validate is async because mermaid.parse() is async)
  const validation = await validate(diagram);
  if (!validation.valid) {
    return { error: validation.error };
  }

  // 2. Generate unique ID for the diagram container
  const id = 'd-' + crypto.randomUUID();

  try {
    const mermaid = await getMermaid();

    // 3. Render SVG via mermaid
    const { svg } = await mermaid.render(id, diagram);

    // 4. Return SVG directly if requested
    if (format === 'svg') {
      return { svg };
    }

    // 5. Convert to PNG via sharp
    try {
      const png = await sharp(Buffer.from(svg), { density: 144 })
        .flatten({ background: backgroundColor === 'transparent' ? { r: 255, g: 255, b: 255 } : backgroundColor })
        .png({ compressionLevel: 9 })
        .toBuffer();
      return { png };
    } catch (sharpErr) {
      const msg = sharpErr instanceof Error ? sharpErr.message : String(sharpErr);
      return { error: `Image conversion failed: ${msg}` };
    }
  } catch (renderErr) {
    const msg = renderErr instanceof Error ? renderErr.message : String(renderErr);
    return { error: `Rendering failed: ${msg}` };
  }
}

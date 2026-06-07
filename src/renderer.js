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
import { JSDOM } from 'jsdom';
import { getMermaid } from './polyfills.js';

/**
 * Post-process Mermaid SVG: convert <foreignObject> labels to native SVG <text>.
 *
 * Mermaid v11+ renders text labels inside <foreignObject> elements, which
 * require a browser layout engine. Sharp cannot render <foreignObject>, so
 * this function extracts the text content and replaces each foreignObject
 * with a native SVG <text> element at the correct position.
 *
 * Strategy: walk all <g class="label"> groups, find the foreignObject inside,
 * extract text from <p> elements, and replace with <text>.
 *
 * @param {string} svg - Raw SVG string from mermaid.render()
 * @returns {string} Modified SVG with foreignObject labels replaced by <text>
 */
function replaceForeignObjectsWithText(svg) {
  const dom = new JSDOM(svg, { contentType: 'image/svg+xml' });
  const doc = dom.window.document;
  const svgEl = doc.querySelector('svg');
  if (!svgEl) return svg;

  // Find all <g class="label"> groups that contain a foreignObject
  const labelGroups = svgEl.querySelectorAll('g.label');
  for (const labelGroup of labelGroups) {
    const foreignObject = labelGroup.querySelector('foreignObject');
    if (!foreignObject) continue;

    // Extract text from <p> and <span> elements inside the foreignObject
    const texts = [];
    const walk = (node) => {
      if (node.nodeType === 3) { // Text node
        const t = node.textContent.trim();
        if (t) texts.push(t);
      }
      if (node.nodeType === 1) { // Element node
        if (node.tagName === 'P' || node.tagName === 'SPAN' || node.tagName === 'DIV') {
          for (const child of node.childNodes) walk(child);
        }
      }
    };
    walk(foreignObject);

    const labelText = texts.join(' ').trim();
    if (!labelText) {
      // Empty label — still remove foreignObject to avoid sharp issues
      foreignObject.remove();
      continue;
    }

    // Create native SVG <text> element
    const textEl = doc.createElementNS('http://www.w3.org/2000/svg', 'text');
    textEl.textContent = labelText;
    textEl.setAttribute('text-anchor', 'middle');
    textEl.setAttribute('dominant-baseline', 'middle');

    // Copy positioning from parent <g> transform or foreignObject position
    const parentTransform = labelGroup.getAttribute('transform') || '';
    if (parentTransform) {
      textEl.setAttribute('transform', parentTransform);
    }

    // For node labels, y-offset to center vertically
    // The parent node <g> has transform that positions the group;
    // the label <g> typically has transform="translate(0,0)" or similar.
    // We set dy for vertical centering within the node rect.
    const nodeGroup = labelGroup.closest('g.node');
    if (nodeGroup) {
      const rect = nodeGroup.querySelector('rect.basic, rect.label-container');
      if (rect) {
        const height = parseFloat(rect.getAttribute('height') || '30');
        // Center text vertically relative to the label group position
        textEl.setAttribute('dy', '0.35em');
      }
    }

    // Replace foreignObject with the new text element
    foreignObject.replaceWith(textEl);
  }

  return dom.serialize();
}

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

    // 5. Convert to PNG via sharp.
    //    Mermaid v11+ uses <foreignObject> for text labels — sharp can't render those.
    //    Post-process the SVG to replace foreignObject with native <text> elements.
    const sharpSafeSvg = replaceForeignObjectsWithText(svg);

    try {
      const png = await sharp(Buffer.from(sharpSafeSvg), { density: 144 })
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

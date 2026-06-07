#!/usr/bin/env node
/**
 * Browser polyfills for Mermaid in a jsdom environment.
 *
 * Creates a single JSDOM instance, attaches globals (window, document, Element),
 * installs browser polyfills (requestAnimationFrame, ResizeObserver, CSSStyleSheet,
 * getComputedStyle), then lazy-loads DOMPurify + Mermaid after globals are ready.
 *
 * IMPORTANT: DOMPurify and Mermaid are loaded via dynamic import() AFTER globals
 * are set, because their static ESM imports would hoist above the module body,
 * causing DOMPurify to detect Node.js instead of jsdom.
 */

import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------------------
// 1. Create single JSDOM instance — reused for all renders
// ---------------------------------------------------------------------------
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  pretendToBeVisual: true,
});

const { window } = dom;
const { document, navigator } = window;

// Attach to global so mermaid, DOMPurify, and sharp can access DOM APIs.
// navigator is a getter-only property on global in Node 25+ (already exists),
// so we only need to ensure window, document, and Element are attached.
// DOMPurify checks global.Element to detect browser environment.
global.window = window;
global.document = document;
global.Element = window.Element;

// ---------------------------------------------------------------------------
// 2. Polyfill: requestAnimationFrame / cancelAnimationFrame
//    Mermaid uses rAF internally for scheduling
// ---------------------------------------------------------------------------
window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
window.cancelAnimationFrame = (id) => clearTimeout(id);

// ---------------------------------------------------------------------------
// 3. Polyfill: ResizeObserver — no-op (Mermaid may observe element size changes)
// ---------------------------------------------------------------------------
class DummyResizeObserver {
  constructor() {}
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = DummyResizeObserver;

// ---------------------------------------------------------------------------
// 4. Polyfill: CSSStyleSheet — Mermaid v11 uses constructable stylesheets
//    jsdom does not provide CSSStyleSheet, so we mock it
// ---------------------------------------------------------------------------
class DummyCSSStyleSheet {
  constructor() {
    this.cssRules = [];
  }
  insertRule(rule, index) {
    this.cssRules.push({ cssText: rule });
    return index ?? this.cssRules.length - 1;
  }
  deleteRule(index) {
    this.cssRules.splice(index, 1);
  }
  replaceSync() {}
  replace() { return Promise.resolve(this); }
}
// Set on both window and globalThis — mermaid may reference either
window.CSSStyleSheet = DummyCSSStyleSheet;
globalThis.CSSStyleSheet = DummyCSSStyleSheet;

// ---------------------------------------------------------------------------
// 5. SVG polyfills — jsdom doesn't implement getBBox() or getCTM()
//    Mermaid uses these for text measurement during layout
// ---------------------------------------------------------------------------
// SVG polyfills: jsdom doesn't implement getBBox() or getCTM()
// Mermaid uses these for text measurement during layout
// NOTE: SVGElement comes from jsdom's window, not Node.js global
const _SVGElement = window.SVGElement;
if (_SVGElement) {
  _SVGElement.prototype.getBBox = function () {
    // Return a reasonable default — mermaid uses this for layout calculations.
    // Approximate dimensions based on tag type.
    const tag = this.tagName?.toLowerCase();
    if (tag === 'text' || tag === 'tspan') {
      const text = this.textContent || '';
      return { x: 0, y: -14, width: text.length * 8, height: 16 };
    }
    return { x: 0, y: 0, width: 50, height: 50 };
  };
  _SVGElement.prototype.getCTM = function () {
    return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  };
  _SVGElement.prototype.getScreenCTM = function () {
    return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  };
}

// ---------------------------------------------------------------------------
// 6. Export getComputedStyle from jsdom window to global
//    (provided by jsdom on window, but Mermaid sometimes expects it on global)
// ---------------------------------------------------------------------------
global.getComputedStyle = window.getComputedStyle.bind(window);

// ---------------------------------------------------------------------------
// 7. Lazy-load DOMPurify + Mermaid (dynamic imports AFTER globals are set)
//    DOMPurify checks global.Element to detect browser — must be set first.
//    Mermaid internally imports DOMPurify — DOMPurify must be initialized first.
// ---------------------------------------------------------------------------
let _mermaidInstance = null;
let _initPromise = null;

/**
 * Initialize DOMPurify (with jsdom globals) and Mermaid.
 * Idempotent — only runs once.
 */
async function _ensureMermaid() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    // DOMPurify must be loaded first — its module reads global.Element
    const DOMPurify = (await import('dompurify')).default;
    window.DOMPurify = DOMPurify;
    globalThis.DOMPurify = DOMPurify;

    // Now load Mermaid — its internal DOMPurify import will get the cached
    // version that was initialized with jsdom globals
    const mermaid = (await import('mermaid')).default;
    mermaid.initialize({
      startOnLoad: false,
      theme: 'default',
      securityLevel: 'loose',
    });
    _mermaidInstance = mermaid;
  })();
  return _initPromise;
}

/**
 * Get the initialized Mermaid instance.
 * @returns {Promise<object>} Mermaid module
 */
export async function getMermaid() {
  await _ensureMermaid();
  return _mermaidInstance;
}

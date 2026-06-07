# Spec 01: Current Approach — jsdom + Sharp (Chromium-Free)

**Status:** ⚠️ Implemented, functionally broken — [Recommendation: migrate to Playwright](./02-recommended-playwright-approach.md)

---

## Architecture

```
diagram text → mermaid.parse() [validate] → mermaid.render() → SVG
                                                           ↓
                                                     sharp → PNG
```

**Dependencies:** `mermaid@11.15.0`, `jsdom@29.1.1`, `sharp@0.34.5`
**Docker image:** `node:26.3.0-slim` + fonts (~150-300 MB, no Chromium)

---

## The Core Problem: foreignObject + Sharp Incompatibility

Mermaid v11+ renders text labels inside `<foreignObject>` elements in the SVG output. Sharp's underlying librsvg/libresvg **cannot rasterize HTML inside `<foreignObject>`** — it requires a full browser layout engine (Blink/WebKit). This is a known, fundamental limitation.

**Result:** PNG output from sharp has colored boxes and arrows but **zero visible text**. Every character of text that appears in a Mermaid diagram is invisible in the PNG.

### Evidence

| Diagram | Expected PNG size | Actual PNG size | Text visible? |
|---------|-------------------|-----------------|---------------|
| Simple 2-node flowchart (`Start → End`) | ~2-5 KB | 315 bytes | **No** |
| Architecture diagram (8 nodes, subgraphs) | ~10-30 KB | 280 bytes | **No** |

Both PNGs pass PNG magic byte validation (`89 50 4E 47`) and have correct IHDR chunks — they're structurally valid PNGs, just empty of text.

### SVG Structure (Mermaid v11+)

```xml
<g class="node default" transform="translate(33, 33)">
  <rect class="basic label-container" x="-30" y="-15" width="60" height="30"></rect>
  <g class="label" transform="translate(0, 0)">
    <rect></rect>
    <foreignObject width="0" height="0">
      <div xmlns="http://www.w3.org/1999/xhtml">
        <span class="nodeLabel"><p>Start</p></span>
      </div>
    </foreignObject>
  </g>
</g>
```

The text `"Start"` lives inside `<foreignObject>` → `<div>` → `<span>` → `<p>`. Sharp drops the entire `<foreignObject>` subtree.

---

## The Second Problem: getBBox Polyfill Layout Imprecision

Mermaid's layout engine uses `getBBox()` to determine node dimensions, edge routing, and viewBox size. jsdom doesn't implement SVG `getBBox()`, so we polyfill it with `text.length * 8` — a crude approximation. This cascades into three bugs:

| Symptom | Root Cause | Affected Format |
|---------|-----------|-----------------|
| **viewBox too small** (66×66 vs 265×361) | Node widths underestimated → layout compressed → viewBox calculated wrong | SVG |
| **Edge labels NaN** `translate(undefined, NaN)` | Edge routing uses getBBox → NaN math | SVG |
| **Gantt zero-width viewBox** `viewBox="0 0 0 124"` | getBBox returns 0 for empty text | SVG+PNG |

### Polyfills Required

Mermaid requires these browser APIs that jsdom doesn't implement:

| API | Polyfill | Problem |
|-----|----------|---------|
| `requestAnimationFrame` | `setTimeout` wrapper | ✅ Works |
| `ResizeObserver` | No-op class | ✅ Works |
| `CSSStyleSheet` | Dummy class with `cssRules` | ✅ Works |
| `SVGElement.getBBox()` | `text.length * 8` approximation | 🔴 **Layout imprecision** |
| `SVGElement.getCTM()` | Identity matrix | ⚠️ May affect transforms |
| `SVGTextElement.getComputedTextLength()` | `text.length * fontSize * 0.5` | 🔴 **Text measurement wrong** |
| `HTMLSpanElement.getComputedTextLength()` | `text.length * 8` | 🔴 **Spans mis-measured** |

---

## Attempted Fixes

### Fix 1: `htmlLabels: false` (FAILED)

Setting `htmlLabels: false` in `mermaid.initialize()` forces Mermaid to use native SVG `<text>` elements instead of `<foreignObject>`.

**Result:** Crashes with `testSpan.node(...).getComputedTextLength is not a function`. Mermaid internally creates `<span>` elements for text measurement even in `htmlLabels: false` mode, and calls `getComputedTextLength()` on them. jsdom doesn't implement this on `HTMLSpanElement`.

Polyfilling `HTMLSpanElement.prototype.getComputedTextLength` did not resolve — the polyfill isn't picked up by Mermaid's internal d3 selections.

### Fix 2: SVG Post-Processor (IN PROGRESS, NOT VERIFIED)

`replaceForeignObjectsWithText()` in `renderer.js` attempts to:
1. Parse SVG with jsdom (`contentType: 'image/svg+xml'`)
2. Find `<g class="label">` groups containing `<foreignObject>`
3. Extract text from nested `<p>` / `<span>` elements
4. Create native SVG `<text>` elements with positioning from parent transforms
5. Replace `<foreignObject>` with `<text>`

**Status:** Smoke tests pass but PNG size unchanged (315 bytes). The post-processor may not be matching the DOM structure correctly. Potential issues:
- jsdom SVG parsing may not apply CSS class selectors to SVG elements
- `dom.serialize()` may lose namespace information
- Text positioning (x, y, transform) may be wrong, rendering text off-screen
- Even if post-processor works, the getBBox layout imprecision remains unfixed

---

## Tradeoff Summary

| Aspect | jsdom + sharp | Notes |
|--------|:---:|-------|
| **Render speed** | 🟢 ~30-100ms | Fastest possible — no browser |
| **Docker image** | 🟢 ~150-300 MB | Smallest possible |
| **Reliability** | 🔴 Broken | foreignObject + layout bugs |
| **Text accuracy** | 🔴 Wrong | getBBox approximation |
| **All diagram types** | 🔴 Broken | Gantt zero-width, many broken |
| **Maintenance** | 🔴 High | Each Mermaid version may break polyfills |

The approach delivers on speed and size but fails on correctness. For correct rendering, a real browser engine is needed — see [Recommended Path: Playwright](./02-recommended-playwright-approach.md).

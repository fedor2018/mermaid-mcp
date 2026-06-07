# mermaid-mcp Features

This document describes the features implemented in the custom Mermaid MCP server.

For an overview of the project's purpose and architecture, see [MERMAID-MCP.md](./MERMAID-MCP.md).

---

## 1. `validate` Tool — Instant Syntax Check

**Status:** ✅ Implemented

Validates Mermaid diagram syntax without rendering. Uses `mermaid.parse()` — pure Node.js, instant (~50ms), no DOM needed.

**Input:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `diagram` | string | Yes | Mermaid diagram definition text |

**Output (valid):**

```json
{
  "content": [{ "type": "text", "text": "Valid: flowchart" }]
}
```

**Output (invalid):**

```json
{
  "content": [{ "type": "text", "text": "Invalid: Parse error on line 3: ..." }],
  "isError": true
}
```

**Supported diagram types:** flowchart, sequence, gantt, class, state, pie, er, journey, git, mindmap, timeline, quadrantChart, sankey, block, packet, architecture, xyChart

**Error handling:** Empty diagram → `"Diagram input is required"`. Whitespace-only → same. `mermaid.parse()` with `suppressErrors: false` catches all parse errors with line numbers.

---

## 2. `render` Tool — PNG + SVG Rendering

**Status:** ⚠️ Implemented (PNG broken — see [spec/01](./spec/01-current-approach.md))

Validates and renders a Mermaid diagram to PNG or SVG. Uses `mermaid.parse()` for validation, then `mermaid.render()` (jsdom) for SVG, then `sharp` for PNG conversion. All in Node.js — zero Chromium.

**Input:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `diagram` | string | Yes | — | Mermaid diagram definition text |
| `format` | enum `"png"` / `"svg"` | No | `"png"` | Output format |
| `backgroundColor` | string | No | `"transparent"` | PNG background color (CSS value) |

**Output (PNG):**

```json
{
  "content": [
    { "type": "text", "text": "Rendered as PNG (12345 bytes)" },
    { "type": "image", "data": "<base64-encoded PNG>", "mimeType": "image/png" }
  ]
}
```

**Output (SVG):**

```json
{
  "content": [
    { "type": "text", "text": "Rendered as SVG (5678 bytes)" },
    { "type": "image", "data": "<base64-encoded SVG>", "mimeType": "image/svg+xml" }
  ]
}
```

**PNG quality:** 2× DPI (density 144) for crisp output. PNG compression level 9 (max). Background flattening via sharp.

**Known issues:**
- **PNG text invisible** — Sharp cannot render `<foreignObject>` elements used by Mermaid v11+ for text labels. See [Current Approach & Problems](./spec/01-current-approach.md).
- **SVG viewBox too small** — `getBBox()` polyfill returns approximations, causing layout engine to miscalculate viewBox. Most content outside visible area.
- **Gantt zero-width viewBox** — Mermaid produces `viewBox="0 0 0 124"` for Gantt diagrams in jsdom.

---

## 3. HTTP Transport — StreamableHTTPServerTransport

**Status:** ✅ Implemented

**Description:** Uses `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` over Node.js built-in `http.createServer`. Follows the hugging-kreuzberg-mcp pattern for remote opencode access via LiteLLM proxy.

**Server properties:**
- Port 3000 (configurable via `PORT` env)
- Single POST `/mcp` endpoint
- GET/DELETE/other methods → 405
- Content-Type validation → 415 for non-JSON
- Body size limit: 10 MB (configurable)
- JSON parse errors → 400
- `Accept: text/event-stream` for SSE responses

**Why no Express:** User explicitly requested no Express. `http.createServer` + manual body parsing (chunk-based JSON accumulation) is sufficient for a single `/mcp` endpoint.

---

## 4. Stateless Per-Request McpServer

**Status:** ✅ Implemented

**Description:** Each HTTP request creates a fresh `McpServer` + `StreamableHTTPServerTransport` pair, registers tools, handles the request, then closes. No cross-request state leakage. Follows the hugging-kreuzberg-mcp pattern exactly.

**Shared state:** The JSDOM instance + mermaid are loaded once at startup and shared across requests (read-only after initialization). They're created in the module scope of `polyfills.js` and accessed via `getMermaid()`.

**Graceful shutdown:** SIGINT handler closes transport and server cleanly.

---

## 5. jsdom + Sharp Rendering (No Chromium)

**Status:** ⚠️ Implemented (broken — see [spec/01](./spec/01-current-approach.md))

📋 [Detailed Spec](./spec/01-current-approach.md)

**Description:** Eliminates Chromium/Puppeteer entirely. Uses jsdom as a fake DOM environment for `mermaid.render()`, then sharp for SVG→PNG rasterization. No browser needed.

**Dependencies:** `jsdom@29.1.1`, `mermaid@11.15.0`, `sharp@0.34.5`

**Polyfills required (see [spec/01](./spec/01-current-approach.md) for details):**

| API | Polyfill | Status |
|-----|----------|--------|
| `requestAnimationFrame` | `setTimeout` wrapper | ✅ Works |
| `ResizeObserver` | No-op class | ✅ Works |
| `CSSStyleSheet` | Dummy class with `cssRules` | ✅ Works |
| `SVGElement.getBBox()` | `text.length * 8` approximation | 🔴 Layout imprecision |
| `SVGElement.getCTM()` | Identity matrix | ⚠️ May affect transforms |
| `SVGTextElement.getComputedTextLength()` | `text.length * fontSize * 0.5` | 🔴 Text measurement wrong |
| `HTMLSpanElement.getComputedTextLength()` | `text.length * 8` | 🔴 Spans mis-measured |

**Tradeoff:** Fastest possible rendering (~30-100ms for SVG) and smallest Docker image (~150-300 MB), but layout imprecision and foreignObject incompatibility make rendering visually broken. The recommended path forward is Playwright — see [spec/02](./spec/02-recommended-playwright-approach.md).

---

## 6. Docker Deployment with LiteLLM Proxy

**Status:** ✅ Implemented

**Description:** Multi-arch Docker image (`linux/amd64`, `linux/arm64`) deployed on puma-net, accessible from opencode via LiteLLM proxy at `https://lite-llm.lan/mcp/mermaid`.

**Dockerfile:** `node:26.3.0-slim` base with `fonts-dejavu` + `fonts-liberation`. No Chromium. ~150-300 MB image.

**Deployment config:** At `puma-lan/lite-llm/mcp/mermaid/`:
- `docker-compose.yaml` — Single service on `puma-net` network, `restart: unless-stopped`
- `start.sh` / `stop.sh` — Infisical integration (`infisical run --env=prod --path=/lite-llm/mcp/mermaid`)
- `build-and-push.sh` — Copies source, builds multi-arch, pushes to Docker Hub (`tuiteraz/mermaid-mcp`)
- `pin-image-digest.sh` — Pins image digest in compose file

**opencode config:** Replaces broken `mermaid-validator` entry with remote HTTP MCP.

---

## 7. Structured JSON Logging

**Status:** ✅ Implemented

**Description:** All logs written as structured JSON to stderr (MCP protocol uses stdout). Configurable log level via `LOG_LEVEL` env var.

**Log format:**

```json
{"level":"info","ts":"2026-06-07T16:49:51.611Z","msg":"mermaid-mcp running on port 3000"}
```

**Levels:** `debug` (includes request timing) and `info` (startup + errors only).

---

## 8. Smoke Test Suite

**Status:** ✅ Implemented

**Description:** `test.sh` — 7 smoke tests via HTTP/curl against the running container. Tests MCP initialize handshake, tools/list, validate (valid + invalid), render (PNG + SVG + invalid). Produces actual `.png` and `.svg` files in `./dist/` for visual inspection.

**Unit tests:** 60 tests (Node.js test runner), 1 skip (Gantt PNG), 0 fail. Covers renderer, tools, and MCP server.

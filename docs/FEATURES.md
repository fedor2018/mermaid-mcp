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

**Description:** Uses `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` over Node.js built-in `http.createServer`. Follows the hugging-kreuzberg-mcp pattern for remote MCP access.

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

## 5. stdio Transport — StdioServerTransport

**Status:** ✅ Implemented

**Description:** The same tools are also exposed over stdio (`src/stdio-server.mjs`). One long-lived `McpServer` per process, JSON-RPC over stdin/stdout. Built for local MCP clients and for [`sparfenyuk/mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy), which spawns stdio servers and re-exposes them as SSE / Streamable HTTP — see [mcp-proxy.md](./mcp-proxy.md).

**Shared tool layer:** `src/server-factory.js` exposes `createMcpServer()` — both transports build their `McpServer` from it, so the tool set, `serverInfo` and `instructions` never drift apart.

**Server properties:**
- stdout carries **JSON-RPC messages only** — all logs go to stderr, so the stream stays parseable
- one `McpServer` for the whole process (stdio is a single long-lived session, unlike the stateless HTTP path)
- exits with code `0` when stdin is closed (EOF), on SIGINT or on SIGTERM
- shutdown order: close the transport → pause and unref stdin → let Node exit naturally, so pending stdout writes are flushed instead of being truncated
- `MCP_PORT` and `MCP_MAX_BODY_SIZE` are HTTP-only and have no effect here

**Tests:** `test/stdio-server.test.js` — 10 tests: initialize, tools/list, validate (valid + invalid), render (PNG + SVG), stdout purity (every line must be valid JSON-RPC), logs on stderr, clean exit on stdin EOF.

**Startup latency:** `jsdom` and `sharp` are imported before the server can answer `initialize` (measured 2.4–9.7 s depending on the filesystem cache). A proxy that waits for the handshake inherits that delay.

---

## 6. jsdom + Sharp Rendering (No Chromium)

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

## 7. Docker Deployment

**Status:** ✅ Implemented

**Description:** Multi-arch Docker image (`linux/amd64`, `linux/arm64`) available via Docker Hub.

**Dockerfile:** `node:26.3.0-slim` base with `fonts-dejavu` + `fonts-liberation`. No Chromium. ~150-300 MB image.

**Deployment:** Standard docker compose with a single service, `restart: unless-stopped`.
- `build-and-push.sh` — Multi-arch build and push to Docker Hub (`tuiteraz/mermaid-mcp`)
- `pin-image-digest.sh` — Pins image digest for reproducible deployments

**Second image:** `mcp-proxy/Dockerfile` — based on the official `ghcr.io/sparfenyuk/mcp-proxy`
image plus Node.js and the Mermaid fonts. The proxy spawns our stdio server as a child process and
serves it as SSE / Streamable HTTP on `:8080/mcp`. See [mcp-proxy/README.md](../mcp-proxy/README.md).

**opencode config:** Configure as a remote MCP server pointing to your deployment endpoint.

---

## 8. Structured JSON Logging

**Status:** ✅ Implemented

**Description:** All logs written as structured JSON to stderr (MCP protocol uses stdout). Configurable log level via `LOG_LEVEL` env var.

**Log format:**

```json
{"level":"info","ts":"2026-06-07T16:49:51.611Z","msg":"mermaid-mcp running on port 3000"}
```

**Levels:** `debug` (includes request timing) and `info` (startup + errors only).

---

## 9. Smoke Test Suite

**Status:** ✅ Implemented

**Description:** `test/smoke.sh` — 7 smoke tests via HTTP/curl against the running container. Tests MCP initialize handshake, tools/list, validate (valid + invalid), render (PNG + SVG + invalid). Produces actual `.png` and `.svg` files in `./dist/` for visual inspection.

**Unit tests:** 71 tests (Node.js test runner), 1 skip (Gantt PNG), 0 fail. Covers renderer, tools, the HTTP server and the stdio server.

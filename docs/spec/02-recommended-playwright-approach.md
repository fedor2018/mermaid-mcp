# Spec 02: Recommended Path — Hybrid Playwright + Sharp

**Status:** 📋 Proposed — Not yet implemented

---

## Why Playwright

The current jsdom + sharp approach has two fundamental problems that cannot be fixed with polyfills:

1. **foreignObject + sharp incompatibility** — Sharp cannot render HTML inside `<foreignObject>`. Mermaid v11+ uses foreignObject for all text labels.
2. **getBBox layout imprecision** — Polyfilled `getBBox()` returns approximations, causing wrong viewBox, NaN edge labels, and broken Gantt diagrams.

A real browser engine is required for correct Mermaid rendering. Playwright provides the best balance of reliability, control, and Docker ergonomics.

---

## Proposed Architecture

```
diagram text → Playwright browser → mermaid.render() → SVG string
                                                      ↓
                                              sharp → PNG
```

**Key design:**
- **Playwright for SVG generation** — Real browser gives correct layout, foreignObject rendering, and text measurement
- **sharp for PNG conversion** — Fast rasterization without browser overhead (sharp converts SVG→PNG in milliseconds)
- **Warm browser pool** — Chromium started once at container startup, reused across all requests

This eliminates all three rendering bugs (foreignObject, Gantt, text measurement) while keeping PNG conversion fast.

---

## Docker Image

```dockerfile
FROM mcr.microsoft.com/playwright:v1.52.0-noble  # Chromium pre-installed

RUN apt-get update && apt-get install -y \
    fonts-dejavu fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
RUN npx playwright install-deps chromium  # System deps for Chromium
EXPOSE 3000
ENTRYPOINT ["node", "src/mcp-server.mjs"]
```

**Image size:** ~500-900 MB (Chromium + Playwright + Node.js)
**vs current:** ~150-300 MB (jsdom + sharp only)

---

## Renderer Changes

### Startup (one-time)

```js
import { chromium } from 'playwright';

let browser;

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}
```

### Per-render (each request)

```js
export async function render(diagram, format = 'png', backgroundColor = 'transparent') {
  // 1. Validate (unchanged — still pure Node.js)
  const validation = await validate(diagram);
  if (!validation.valid) return { error: validation.error };

  // 2. Render SVG in real browser
  const browser = await getBrowser();
  const page = await browser.newPage();
  const id = 'd-' + crypto.randomUUID();

  const svg = await page.evaluate(({ id, diagram }) => {
    // mermaid is loaded in the page context via a <script> tag
    return window.mermaid.render(id, diagram).then(r => r.svg);
  }, { id, diagram });

  await page.close();

  // 3. SVG format — return directly
  if (format === 'svg') return { svg };

  // 4. PNG format — convert via sharp (same as before, but SVG is now correct)
  const png = await sharp(Buffer.from(svg), { density: 144 })
    .flatten({ background: backgroundColor === 'transparent' ? { r: 255, g: 255, b: 255 } : backgroundColor })
    .png({ compressionLevel: 9 })
    .toBuffer();

  return { png };
}
```

**Page setup (at startup, before first render):**

```js
async function setupMermaidPage() {
  const browser = await getBrowser();
  const page = await browser.newPage();
  
  // Load Mermaid from node_modules
  const mermaidCode = fs.readFileSync(
    require.resolve('mermaid/dist/mermaid.min.js'), 'utf-8'
  );
  
  await page.addScriptTag({ content: mermaidCode });
  await page.evaluate(() => {
    window.mermaid.initialize({
      startOnLoad: false,
      theme: 'default',
      securityLevel: 'loose',
    });
  });
  
  await page.close();
}
```

---

## What Stays the Same

| Component | Change? | Notes |
|-----------|:-------:|-------|
| `mcp-server.mjs` | No change | HTTP server unchanged |
| `tools.js` | No change | Tool definitions unchanged |
| `config.js` | No change | Configuration unchanged |
| `logger.js` | No change | Logging unchanged |
| `test.sh` | No change | Smoke tests unchanged |
| `renderer.js` | **Rewritten** | jsdom → Playwright for SVG generation |
| `polyfills.js` | **Removed** | No polyfills needed with real browser |
| `package.json` | Add `playwright` dep | `playwright@^1.52` |
| `Dockerfile` | **Rewritten** | `playwright` base image instead of `node:slim` |

---

## Comparison: Current vs Recommended

| Aspect | Current (jsdom + sharp) | Recommended (Playwright + sharp) |
|--------|:---:|:---:|
| **foreignObject text** | 🔴 Invisible | 🟢 Correct |
| **Layout accuracy** | 🔴 getBBox approximation | 🟢 Real browser |
| **Gantt** | 🔴 Zero-width | 🟢 Correct |
| **All diagram types** | 🔴 Many broken | 🟢 All work |
| **Docker image** | 🟢 150-300 MB | 🔴 500-900 MB |
| **Render speed (cold)** | 🟢 Instant | 🟡 2-5s (Chromium startup) |
| **Render speed (warm)** | 🟢 30-100ms | 🟢 100-500ms |
| **Polyfills needed** | 🔴 7 polyfills | 🟢 Zero |
| **Maintenance** | 🔴 High (polyfill churn) | 🟢 Low (standard Playwright) |
| **Mermaid upgrades** | 🔴 May break polyfills | 🟢 Safe (browser API stable) |

---

## Migration Steps

1. **Add `playwright` to `package.json`** — `playwright@^1.52`
2. **Rewrite `Dockerfile`** — Use `mcr.microsoft.com/playwright:v1.52.0-noble` base
3. **Rewrite `renderer.js`** — Replace jsdom with Playwright browser context
4. **Remove `polyfills.js`** — No longer needed
5. **Update tests** — Smoke tests should pass without changes (same HTTP API)
6. **Build and deploy** — Multi-arch build, push to Docker Hub, deploy on puma-net
7. **Monitor** — Verify render times are acceptable (warm browser should be fast)

---

## Risks

| Risk | Mitigation |
|------|-----------|
| 500-900 MB image size | Acceptable for puma-net; this was the original motivation for avoiding Chromium, but correctness outweighs size |
| Cold start 2-5s | Warm browser pool — Chromium started once at container startup |
| Chromium crash risk | `restart: unless-stopped` in docker compose handles crashes |
| Playwright version churn | Pin to specific Playwright version (v1.52.0); upgrade explicitly |
| `--no-sandbox` security | Private network (puma-net) — acceptable; container runs as non-root |

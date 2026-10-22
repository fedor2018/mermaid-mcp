# Running mermaid-mcp behind `mcp-proxy`

[`sparfenyuk/mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy) is a bridge between MCP transports.
This document covers the two ways it can be used with `mermaid-mcp`.

| Direction | What the proxy does | When to use |
|-----------|---------------------|-------------|
| **stdio → HTTP** (recommended) | Spawns `mermaid-mcp` as a stdio child process, re-exposes it as SSE / Streamable HTTP | The server must run as a plain stdio process (local, container, or a different host) but clients reach it over HTTP |
| **HTTP → stdio** | Connects to the existing `POST /mcp` endpoint and exposes it as a stdio server | A client only speaks stdio, while the server already runs over HTTP |

---

## 1. stdio → HTTP (our stdio server behind the proxy)

### Local

```bash
# The proxy listens on :8080 and spawns our server as a child process.
mcp-proxy --port=8080 --pass-environment -- node /abs/path/to/mermaid-mcp/src/stdio-server.mjs
```

- `http://127.0.0.1:8080/mcp` — Streamable HTTP
- `http://127.0.0.1:8080/sse` — SSE
- `http://127.0.0.1:8080/status` — proxy status

Rules that matter:

| Rule | Why |
|------|-----|
| Use an **absolute path** to `stdio-server.mjs` | The child inherits the proxy's working directory, not the repo root |
| Pass `--pass-environment` | Forwards `PATH` (and `HOME`, `SHELL`, …) to the child — needed when `node` lives outside the default `PATH` |
| `--cwd <dir>` | Sets the child's working directory (default server only) |
| The child must write **only JSON-RPC to stdout** | The proxy parses stdout line by line — our logger writes to stderr, so this holds |

### Multiple servers (named)

```bash
mcp-proxy --port=8080 \
  --named-server mermaid 'node /abs/path/to/mermaid-mcp/src/stdio-server.mjs' \
  --named-server other   'uvx some-other-mcp-server'
```

Named servers are exposed under `/servers/<name>/`:

```
http://127.0.0.1:8080/servers/mermaid/mcp
http://127.0.0.1:8080/servers/other/mcp
```

A JSON config file works too (`--named-server-config servers.json`):

```json
{
  "mcpServers": {
    "mermaid": {
      "enabled": true,
      "command": "node",
      "args": ["/abs/path/to/mermaid-mcp/src/stdio-server.mjs"],
      "transportType": "stdio"
    }
  }
}
```

### Docker (one container: proxy + our stdio server)

`Dockerfile.stdio-proxy` in the repo root builds exactly that — the official proxy image plus our
server:

```dockerfile
FROM ghcr.io/sparfenyuk/mcp-proxy:latest

RUN apk add --no-cache nodejs npm font-dejavu font-liberation

WORKDIR /app/mermaid
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ ./src/

CMD ["--port=8080", "--host=0.0.0.0", "--pass-environment", "--", "node", "/app/mermaid/src/stdio-server.mjs"]
```

```bash
docker build -f Dockerfile.stdio-proxy -t mermaid-mcp-stdio-proxy .
docker run --rm -p 8080:8080 mermaid-mcp-stdio-proxy
```

The base image entry point (`catatonit -- mcp-proxy`) is inherited, so `CMD` holds the proxy
arguments followed by the command to spawn. Override at runtime by repeating the whole command:

```bash
docker run --rm -p 9090:8080 mermaid-mcp-stdio-proxy \
  --port=8080 --host=0.0.0.0 --pass-environment -- node /app/mermaid/src/stdio-server.mjs
```

### Verifying the chain

```bash
# 1. The proxy is up and the child is configured
curl -s http://127.0.0.1:8080/status

# 2. MCP handshake through the proxy
curl -s -D /tmp/h.txt -X POST http://127.0.0.1:8080/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}}}'

# 3. Keep the session id from the response header for the next calls
SID=$(grep -i '^mcp-session-id' /tmp/h.txt | tr -d '\r' | awk '{print $2}')

curl -s -X POST http://127.0.0.1:8080/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"validate","arguments":{"diagram":"graph TD\n A[Start] --> B[End]"}}}'
```

Expected: `serverInfo.name = mermaid-mcp`, then `Valid: flowchart`.

---

## 2. HTTP → stdio (the existing HTTP server behind the proxy)

No code change needed — the proxy connects to the running HTTP server and exposes it as stdio:

```bash
# Our server already runs on :3000
npm start

# The proxy exposes it as a stdio server
mcp-proxy --transport streamablehttp http://127.0.0.1:3000/mcp
```

This direction is useful when a client only speaks stdio but the server lives in Docker on another
host. It adds a hop, so prefer the stdio → HTTP direction when the client can speak HTTP.

---

## Notes and gotchas

- **Startup latency.** The server imports `jsdom` and `sharp` before it can answer `initialize`
  (measured 2.4–9.7 s depending on the filesystem cache). The proxy waits for that handshake, so
  the first connection after a start can be slow. `mcp-proxy` itself has no timeout on the stdio
  session, but a client with a short timeout may need a retry.
- **Shutdown.** The proxy closes the child's stdin and waits 2 s before escalating to SIGTERM, then
  SIGKILL. Our stdio server exits with code `0` on stdin EOF (measured ~70 ms), so the proxy never
  needs to escalate.
- **Protocol version.** The Python client requests `2025-06-18`; the TypeScript SDK answers with the
  requested version whenever it is supported, so the handshake always succeeds.
- **Large payloads.** PNG/SVG results are base64 inside the JSON-RPC message. The Python SDK reads
  stdout in chunks without a per-line size limit, so multi-hundred-kilobyte images pass through
  unchanged.

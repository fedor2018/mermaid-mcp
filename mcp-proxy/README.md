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

### Config file (`--named-server-config`)

The same set can be described in a JSON file. `mcp-proxy/config/servers.json` is the
canonical copy — it is committed here and published on GitHub, so the proxy
can be pointed at it from any machine:

```json
{
  "mcpServers": {
    "mermaid": {
      "enabled": true,
      "timeout": 60,
      "command": "node",
      "args": ["src/stdio-server.mjs"],
      "transportType": "stdio"
    }
  }
}
```

```bash
mcp-proxy --port=8080 --named-server-config ./mcp-proxy/config/servers.json
```

**What the loader actually reads** (`mcp_proxy/config_loader.py`):

| Key | Read? | Notes |
|-----|-------|-------|
| `command` | yes | required — the executable to spawn |
| `args` | yes | list of arguments |
| `env` | yes | merged over the inherited environment |
| `enabled` | yes | `false` skips the server. **The `disabled` key shown in the upstream README's "Named Servers" example is a documentation bug — the loader ignores it.** |
| `timeout` | no | ignored |
| `transportType` | no | ignored — the transport is always stdio |
| `cwd` | no | not supported — the child inherits the proxy's working directory |

Two consequences:

- `--named-server-config` is the **exclusive** source of named servers; any
  `--named-server` CLI arguments are ignored (the proxy logs a warning).
- Because `cwd` cannot be set from the config, `args` must resolve from the
  proxy's working directory. `mcp-proxy/config/servers.json` therefore uses the **relative**
  path `src/stdio-server.mjs`, and the container is started with
  `working_dir: /app/mermaid` (`catatonit` does not change the directory, so
  the child inherits it). A host-run proxy must be started from the repo root
  for the same config to work — use an absolute path there.

### Running the proxy with the config (`mcp-proxy/proxy.sh`)

All proxy tooling lives under `mcp-proxy/`, so the repo root stays shaped as in the upstream
project. Run the commands from the repo root:

```bash
mcp-proxy/proxy.sh fetch     # refresh mcp-proxy/config/servers.json from GitHub
mcp-proxy/proxy.sh start     # fetch + build + run (port 8097)
mcp-proxy/proxy.sh status    # container state + proxy /status
mcp-proxy/proxy.sh stop      # stop the container
```

The config lives in GitHub, so the script pulls it before every start:

```bash
CONFIG_URL="${CONFIG_URL:-https://raw.githubusercontent.com/fedor2018/mermaid-mcp/main/mcp-proxy/config/servers.json}"
curl -fsSL --max-time 20 "$CONFIG_URL" -o mcp-proxy/config/servers.json
```

`mcp-proxy` cannot read a URL itself — `--named-server-config` only accepts a
local path — so the fetch happens on the host. The downloaded copy is validated
(`jq -e '.mcpServers'`) before it replaces the file, and a failed fetch keeps
the local copy, so the proxy always starts with a valid config even offline.
`config/` is mounted into the container as `/config`, so the proxy reads
`/config/servers.json` — the same path the shared `mcp-proxy` stack uses.

Resource limits (`mem_limit`, `cpus`) need domain-level cgroup controllers. On
hosts where cgroup v2 runs in *threaded* mode the daemon refuses them, so
`proxy.sh` falls back to fewer limits and then to none.

Endpoints of the running proxy:

```
http://127.0.0.1:8097/servers/mermaid/mcp   # Streamable HTTP
http://127.0.0.1:8097/servers/mermaid/sse   # SSE
http://127.0.0.1:8097/status                # proxy status
```

The script uses `docker compose` when the plugin is installed and falls back to
an equivalent `docker build` + `docker run` otherwise.

### Docker (one container: proxy + our stdio server)

`mcp-proxy/Dockerfile` builds exactly that — the official proxy image plus our
server:

```dockerfile
FROM ghcr.io/sparfenyuk/mcp-proxy:latest

RUN apk add --no-cache nodejs npm font-dejavu font-liberation

WORKDIR /app/mermaid
COPY package.json package-lock.json ./
RUN npm ci --omit=dev                  # seed-cache; the preinstall hook skips when present
COPY src/ ./src/

COPY mcp-proxy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY mcp-proxy/init.d/ /docker-entrypoint-init.d/

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["--port=8080", "--host=0.0.0.0", "--pass-environment", "--stateless", "--named-server-config=/config/servers.json"]
```

```bash
docker build -f mcp-proxy/Dockerfile -t mermaid-mcp-stdio-proxy .
docker run --rm -p 8080:8080 -v "$(pwd)/mcp-proxy/config:/config:ro" mermaid-mcp-stdio-proxy
```

The base image entry point (`catatonit -- mcp-proxy`) is replaced by `docker-entrypoint.sh`:
it runs every `*.sh` hook from `/docker-entrypoint-init.d` (auto-install, see below) and then
`exec catatonit -- mcp-proxy`. `CMD` holds just the proxy arguments; the config is the exclusive
source of named servers, so the child command is not repeated. Override at runtime by repeating
the whole set:

```bash
docker run --rm -p 9090:8080 mermaid-mcp-stdio-proxy \
  --port=8080 --host=0.0.0.0 --pass-environment --named-server-config=/config/servers.json
```

`mcp-proxy/docker-compose.yml` wires the same thing declaratively — the image is built from
`mcp-proxy/Dockerfile` (context = repo root), the runtime copy of the config is mounted, and the proxy
flags come from `command:`:

```yaml
services:
  mermaid-mcp-proxy:
    build: { context: .., dockerfile: mcp-proxy/Dockerfile }
    working_dir: /app/mermaid
    ports: ["8097:8080"]
    volumes: ["./config:/config:rw", "./cache:/app/cache", "./init.d:/docker-entrypoint-init.d:ro"]
    command: ["--debug", "--pass-environment", "--port=8080", "--host=0.0.0.0",
              "--stateless", "--named-server-config=/config/servers.json"]
```

`working_dir` is what makes the relative path in `mcp-proxy/config/servers.json` resolve — the child process
inherits the proxy's working directory, and `catatonit` does not change it.

`--stateless` drops the session id from the Streamable HTTP transport, so clients do not have to
carry `mcp-session-id` between calls — the same mode the shared `mcp-proxy` stack runs in.

### Auto-install via `init.d` hooks

```text
container start → entrypoint runs /docker-entrypoint-init.d/*.sh (sorted)
                → each hook installs what it owns (mermaid: npm ci --omit=dev)
                → exec mcp-proxy → named servers spawn from /config/servers.json
```

Dependencies do not have to be baked into the image — the container can install them itself at
start. `mcp-proxy/docker-entrypoint.sh` runs every `*.sh` hook from `/docker-entrypoint-init.d`
in lexicographic order (the classic `docker-entrypoint-initdb.d` pattern) before exec-ing the
proxy, and `mcp-proxy/init.d/10-mermaid-preinstall.sh` performs the install. While the hooks
come through, the container log prints `[entrypoint] running 10-mermaid-preinstall.sh`.

Guards and knobs:

| Mechanism | Behavior |
|-----------|----------|
| build-time `npm ci` | seed-cache layer: a normal start **skips** the hook, works offline |
| node_modules guard | the hook skips when `node_modules` is complete (fast restarts) |
| `FORCE_PREINSTALL=1` | forces a fresh `npm ci` (e.g. after pinning new deps) |
| `SKIP_INIT=1` | skips all hooks (`docker run -e SKIP_INIT=1 …`) |
| hook failure | aborts the container — `restart: unless-stopped` picks it up |
| new project hook | drop `mcp-proxy/init.d/20-<project>-preinstall.sh`; the `./init.d` bind-mount makes it visible **without an image rebuild** |

`config/servers.json` stays untouched: the config-loader reads only `command/args/env/enabled`
and would silently ignore install hints anyway — installation is the hook layer's job.

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

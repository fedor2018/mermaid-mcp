#!/usr/bin/env bash
# Manage the local mcp-proxy that fronts mermaid-mcp's stdio server.
#
#   ./proxy.sh fetch    # refresh servers.local.json from GitHub (fallback: local servers.json)
#   ./proxy.sh start    # fetch config, build the image and run the proxy
#   ./proxy.sh stop     # stop the proxy container
#   ./proxy.sh status   # container state + proxy /status output
#
# The proxy re-exposes src/stdio-server.mjs as Streamable HTTP / SSE:
#   http://127.0.0.1:8097/servers/mermaid/mcp
#   http://127.0.0.1:8097/servers/mermaid/sse
#   http://127.0.0.1:8097/status
#
# Uses "docker compose" when the plugin is installed; otherwise falls back to
# an equivalent plain "docker build" + "docker run" (same image, same flags).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE_FILE="docker-compose.proxy.yml"
CONFIG_FILE="servers.local.json"
CANONICAL_CONFIG="servers.json"
CONFIG_URL="${CONFIG_URL:-https://raw.githubusercontent.com/fedor2018/mermaid-mcp/main/servers.json}"
PROXY_PORT="${PROXY_PORT:-8097}"
PROXY_URL="http://127.0.0.1:${PROXY_PORT}"

IMAGE="mermaid-mcp-stdio-proxy:latest"
CONTAINER="mermaid-mcp-proxy"
NETWORK="puma-net"

# The flags passed to mcp-proxy inside the container.
# --named-server-config points at the mounted runtime copy of servers.json.
PROXY_ARGS=(
  --port=8080
  --host=0.0.0.0
  --pass-environment
  --named-server-config=/app/mermaid/servers.json
)

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    return 127
  fi
}

# Refresh the runtime config from GitHub.
# The fetched copy is validated as JSON with an "mcpServers" object, so an
# HTTP error page can never overwrite a working config.
fetch_config() {
  local tmp
  tmp="$(mktemp)"

  if curl -fsSL --max-time 20 "$CONFIG_URL" -o "$tmp" 2>/dev/null \
    && [ -s "$tmp" ] \
    && jq -e '.mcpServers' "$tmp" >/dev/null 2>&1; then
    mv "$tmp" "$CONFIG_FILE"
    echo "config: fetched from $CONFIG_URL"
    return 0
  fi

  rm -f "$tmp"
  if [ -f "$CANONICAL_CONFIG" ]; then
    cp "$CANONICAL_CONFIG" "$CONFIG_FILE"
    echo "config: fetch failed — using local $CANONICAL_CONFIG"
    return 0
  fi

  echo "config: fetch failed and $CANONICAL_CONFIG is missing" >&2
  return 1
}

run_container() {
  if compose version >/dev/null 2>&1; then
    compose -f "$COMPOSE_FILE" up -d --build
    return
  fi

  echo "compose plugin not available — falling back to docker build + docker run"
  docker build -f Dockerfile.stdio-proxy -t "$IMAGE" .
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d \
    --name "$CONTAINER" \
    --network "$NETWORK" \
    --restart unless-stopped \
    -p "${PROXY_PORT}:8080" \
    -v "$SCRIPT_DIR/$CONFIG_FILE:/app/mermaid/servers.json:ro" \
    -w /app/mermaid \
    "$IMAGE" \
    "${PROXY_ARGS[@]}"
}

stop_container() {
  if compose version >/dev/null 2>&1; then
    compose -f "$COMPOSE_FILE" down
  else
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}

start() {
  fetch_config

  # Ensure the external network exists (docker-compose.proxy.yml expects it).
  docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK"

  run_container

  echo "Waiting for the proxy..."
  local i
  for i in $(seq 1 30); do
    if curl -sf "$PROXY_URL/status" >/dev/null 2>&1; then
      echo "Done."
      echo "  MCP:      $PROXY_URL/servers/mermaid/mcp"
      echo "  SSE:      $PROXY_URL/servers/mermaid/sse"
      echo "  Status:   $PROXY_URL/status"
      return 0
    fi
    sleep 1
  done

  echo "Proxy did not become ready within 30s." >&2
  docker logs --tail=50 "$CONTAINER" >&2 || true
  return 1
}

stop() {
  stop_container
  echo "Stopped."
}

status() {
  docker ps --filter "name=$CONTAINER" --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
  echo
  curl -s "$PROXY_URL/status" || echo "proxy is not responding"
}

case "${1:-start}" in
  fetch)  fetch_config ;;
  start)  start ;;
  stop)   stop ;;
  status) status ;;
  *)
    echo "Usage: $0 [fetch|start|stop|status]" >&2
    exit 1
    ;;
esac

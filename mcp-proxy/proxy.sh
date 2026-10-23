#!/usr/bin/env bash
# Manage the local mcp-proxy that fronts mermaid-mcp's stdio server.
#
#   mcp-proxy/proxy.sh fetch    # refresh mcp-proxy/config/servers.json from GitHub (fallback: keep the local copy)
#   mcp-proxy/proxy.sh start    # fetch config, build the image and run the proxy
#   mcp-proxy/proxy.sh stop     # stop the proxy container
#   mcp-proxy/proxy.sh status   # container state + proxy /status output
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

COMPOSE_FILE="docker-compose.yml"
CONFIG_DIR="config"
CONFIG_FILE="${CONFIG_DIR}/servers.json"
CACHE_DIR="cache"
CONFIG_URL="${CONFIG_URL:-https://raw.githubusercontent.com/fedor2018/mermaid-mcp/main/mcp-proxy/config/servers.json}"
PROXY_PORT="${PROXY_PORT:-8097}"
PROXY_URL="http://127.0.0.1:${PROXY_PORT}"

IMAGE="mermaid-mcp-stdio-proxy:latest"
CONTAINER="mermaid-mcp-proxy"
NETWORK="puma-net"

# The flags passed to mcp-proxy inside the container.
# --named-server-config points at the mounted config dir (/config/servers.json).
PROXY_ARGS=(
  --debug
  --pass-environment
  --port=8080
  --host=0.0.0.0
  --stateless
  --named-server-config=/config/servers.json
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

# Refresh the config from GitHub.
# The fetched copy is validated before it replaces the file: it must be JSON
# with an "mcpServers" object that defines our "mermaid" server. A failed or
# foreign config leaves the local copy untouched, so the proxy always starts
# with a valid config even offline.
fetch_config() {
  if [ ! -f "$CONFIG_FILE" ]; then
    echo "config: $CONFIG_FILE is missing" >&2
    return 1
  fi

  local tmp
  tmp="$(mktemp "${CONFIG_DIR}/.servers.json.XXXXXX")"

  if curl -fsSL --max-time 20 "$CONFIG_URL" -o "$tmp" 2>/dev/null \
    && [ -s "$tmp" ] \
    && jq -e '.mcpServers.mermaid' "$tmp" >/dev/null 2>&1; then
    if cmp -s "$tmp" "$CONFIG_FILE"; then
      rm -f "$tmp"
      echo "config: already up to date ($CONFIG_URL)"
    else
      mv "$tmp" "$CONFIG_FILE"
      echo "config: updated from $CONFIG_URL"
    fi
    return 0
  fi

  rm -f "$tmp"
  echo "config: fetch failed or invalid — keeping local $CONFIG_FILE"
  return 0
}

run_container() {
  if compose version >/dev/null 2>&1; then
    compose -f "$COMPOSE_FILE" up -d --build
    return
  fi

  echo "compose plugin not available — falling back to docker build + docker run"
  # Build context is the repo root (package.json + src/ are copied from there),
  # the dockerfile lives in this directory.
  docker build -f "$SCRIPT_DIR/Dockerfile" -t "$IMAGE" "$SCRIPT_DIR/.."

  local -a run_args=(
    --name "$CONTAINER"
    --hostname "$CONTAINER"
    --network "$NETWORK"
    --restart unless-stopped
    -p "${PROXY_PORT}:8080"
    -v "$SCRIPT_DIR/$CONFIG_DIR:/config:rw"
    -v "$SCRIPT_DIR/$CACHE_DIR:/app/cache"
    # Auto-install hooks (init.d) — editable without rebuilding the image.
    -v "$SCRIPT_DIR/init.d:/docker-entrypoint-init.d:ro"
    -w /app/mermaid
  )

  # Resource limits need domain-level cgroup controllers. On hosts where
  # cgroup v2 runs in "threaded" mode the daemon refuses them, so detect that
  # once and start without limits; otherwise apply them and fall back if the
  # daemon still complains.
  local -a limit_profiles
  if [ -r /sys/fs/cgroup/cgroup.type ] && grep -qw threaded /sys/fs/cgroup/cgroup.type 2>/dev/null; then
    echo "limits: none (cgroup v2 runs in threaded mode)" >&2
    limit_profiles=("")
  else
    limit_profiles=(
      "--cpus=1 --memory=1024m --memory-reservation=128m"
      "--memory=1024m --memory-reservation=128m"
      ""
    )
  fi

  local profile
  for profile in "${limit_profiles[@]}"; do
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    # shellcheck disable=SC2086
    if docker run -d "${run_args[@]}" $profile "$IMAGE" "${PROXY_ARGS[@]}"; then
      if [ -n "$profile" ]; then
        echo "limits: $profile"
      fi
      return 0
    fi
    echo "note: the daemon rejected [$profile] — retrying with fewer limits" >&2
  done

  return 1
}

stop_container() {
  if compose version >/dev/null 2>&1; then
    compose -f "$COMPOSE_FILE" down
  else
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}

# Poll the proxy /status endpoint. The spawned server imports jsdom and sharp
# before it can answer initialize, so the proxy binds its port only after
# roughly 20 seconds — allow for that.
wait_for_proxy() {
  local attempts="$1" i
  for i in $(seq 1 "$attempts"); do
    if curl -sf --max-time 5 "$PROXY_URL/status" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start() {
  # Runtime dirs of the proxy layer (init.d is tracked in git, cache/ is not).
  mkdir -p "$CONFIG_DIR" "$CACHE_DIR" "$SCRIPT_DIR/init.d"
  fetch_config

  # Ensure the external network exists (docker-compose.yml expects it).
  docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK"

  run_container

  echo "Waiting for the proxy..."
  if wait_for_proxy 60; then
    echo "Done."
    echo "  MCP:      $PROXY_URL/servers/mermaid/mcp"
    echo "  SSE:      $PROXY_URL/servers/mermaid/sse"
    echo "  Status:   $PROXY_URL/status"
    return 0
  fi

  # The published port can keep a stale NAT rule after a container was
  # recreated — a restart of the container re-installs it.
  echo "Proxy is not answering on $PROXY_PORT — restarting the container..." >&2
  docker restart "$CONTAINER" >/dev/null 2>&1 || true
  if wait_for_proxy 60; then
    echo "Done."
    echo "  MCP:      $PROXY_URL/servers/mermaid/mcp"
    echo "  SSE:      $PROXY_URL/servers/mermaid/sse"
    echo "  Status:   $PROXY_URL/status"
    return 0
  fi

  echo "Proxy did not become ready." >&2
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

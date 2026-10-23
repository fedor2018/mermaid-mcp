#!/bin/bash
# Smoke tests for the mcp-proxy front (mcp-proxy/).
#
#   1. Entrypoint init.d hooks: they run, come through in order, and the
#      preinstall hook skips when node_modules is already seeded.
#   2. Live chain: proxy start → /status → initialize → tools/call validate.
#
# Usage: ./test/proxy-smoke.sh     (run from anywhere)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROXY_DIR="$REPO_DIR/mcp-proxy"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

IMAGE="mermaid-mcp-stdio-proxy:latest"
PROXY_PORT="${PROXY_PORT:-8097}"
BASE_URL="http://127.0.0.1:${PROXY_PORT}"
MCP_URL="${BASE_URL}/servers/mermaid/mcp"

PASSED=0
FAILED=0

pass() { echo -e "  ${GREEN}PASS${NC}: $1"; PASSED=$((PASSED+1)); }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; FAILED=$((FAILED+1)); }
info() { echo -e "  ${YELLOW}INFO${NC}: $1"; }
cyan_info() { echo -e "  ${CYAN}---$1${NC}"; }

TMP="$(mktemp -d /var/tmp/opencode/proxy-smoke.XXXXXX)" || exit 1
mkdir -p "$TMP"

A1_CONTAINER="mermaid-smoke-entrypoint-guard"
A2_CONTAINER="mermaid-smoke-entrypoint-order"
TS_CONTAINER="mermaid-smoke-thinsource"

cleanup() {
  for c in "$A1_CONTAINER" "$A2_CONTAINER" "$TS_CONTAINER"; do
    docker rm -f "$c" >/dev/null 2>&1
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

# MCP JSON-RPC request; the proxy runs stateless, so no session id juggling.
mcp_request() {
  local body="$1" raw
  raw=$(curl -sf -s -X POST "$MCP_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$body" 2>/dev/null)
  if echo "$raw" | grep -q '^data: '; then
    echo "$raw" | grep '^data: ' | head -1 | sed 's/^data: //'
  else
    echo "$raw"
  fi
}

wait_exited() {
  local container="$1" i
  for i in $(seq 1 90); do
    local status
    status=$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo missing)
    [ "$status" = "exited" ] && return 0
    sleep 1
  done
  return 1
}

# ── Part 1: entrypoint init.d hooks (image level) ────────────────────────────
echo ""
cyan_info "=== 1. Entrypoint init.d hooks ==="

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  info "image not found — building…"
  docker build -q -f mcp-proxy/Dockerfile -t "$IMAGE" "$REPO_DIR" || {
    fail "image build"; exit 1; }
fi

# 1a. Real baked hook: runs and skips (node_modules is seeded at build time).
docker run -d --name "$A1_CONTAINER" -v "$TMP/guard:/tmp/out" "$IMAGE" >/dev/null
if wait_exited "$A1_CONTAINER"; then
  LOGS=$(docker logs "$A1_CONTAINER" 2>&1)
  echo "$LOGS" | grep -q '\[entrypoint\] running 10-mermaid-preinstall.sh' \
    && pass "hook came through ([entrypoint] running …)" \
    || fail "hook did not run ([entrypoint] log line missing)"
  echo "$LOGS" | grep -q 'node_modules present — skipping' \
    && pass "preinstall guard skips seeded node_modules" \
    || fail "preinstall guard did not skip (seeded node_modules missing?)"
  echo "$LOGS" | grep -q 'source present (baked image)' \
    && pass "git phase skips a baked source" \
    || fail "git phase did not skip the baked source"
  echo "$LOGS" | grep -q 'apk packages present' \
    && pass "apk phase skips installed packages" \
    || fail "apk phase did not skip installed packages"
else
  fail "guard container did not exit (state: $(docker inspect -f '{{.State.Status}}' "$A1_CONTAINER" 2>/dev/null))"
fi

# 1b. Ordering: two fake hooks, the second asserts the first already ran.
mkdir -p "$TMP/hooks" "$TMP/order"
cat > "$TMP/hooks/10-first.sh" <<'EOF'
#!/bin/sh
echo first > /tmp/out/stamp.first
EOF
cat > "$TMP/hooks/20-second.sh" <<'EOF'
#!/bin/sh
if [ -f /tmp/out/stamp.first ]; then
  echo ordered > /tmp/out/order.result
else
  echo misordered > /tmp/out/order.result
fi
EOF

docker run -d --name "$A2_CONTAINER" \
  -v "$TMP/hooks:/docker-entrypoint-init.d:ro" \
  -v "$TMP/order:/tmp/out" \
  "$IMAGE" >/dev/null

if wait_exited "$A2_CONTAINER"; then
  ORDER=$(cat "$TMP/order/order.result" 2>/dev/null || echo missing)
  [ "$ORDER" = "ordered" ] \
    && pass "hooks execute in name order (10-… before 20-…)" \
    || fail "hook ordering broken (order.result=${ORDER})"
  [ -f "$TMP/order/stamp.first" ] \
    && pass "hook writes land in the mounted volume" \
    || fail "hook output missing (stamp.first)"
else
  fail "ordering container did not exit (state: $(docker inspect -f '{{.State.Status}}' "$A2_CONTAINER" 2>/dev/null))"
fi

# 1c. Thin-source mode: an empty /app/mermaid → apk + git clone + npm ci + server.
# This is the full stretch of the auto-install (needs network, ~1–3 min).
cyan_info "1c. thin-source (apk + git clone + npm ci)"
TS_PORT="${TS_PORT:-18097}"
TS_CONTAINER="mermaid-smoke-thinsource"
mkdir -p "$TMP/thinsource"
docker rm -f "$TS_CONTAINER" >/dev/null 2>&1

docker run -d --name "$TS_CONTAINER" \
  -e "MERMAID_REPO_URL=${MERMAID_REPO_URL:-}" \
  -e "MERMAID_REF=${MERMAID_REF:-main}" \
  -v "$TMP/thinsource:/app/mermaid" \
  -v "$PROXY_DIR/config:/config:rw" \
  -p "${TS_PORT}:8080" \
  "$IMAGE" >/dev/null

TS_OK=0
for i in $(seq 1 150); do
  if curl -sf --max-time 5 "http://127.0.0.1:${TS_PORT}/status" 2>/dev/null \
    | grep -q '"mermaid":"configured"'; then
    TS_OK=1
    break
  fi
  STATE=$(docker inspect -f '{{.State.Status}}' "$TS_CONTAINER" 2>/dev/null || echo missing)
  [ "$STATE" = "exited" ] && break
  sleep 2
done

if [ "$TS_OK" = "1" ]; then
  TS_LOGS=$(docker logs "$TS_CONTAINER" 2>&1)
  echo "$TS_LOGS" | grep -q '\[preinstall\] git clone' \
    && pass "thin-source: hook cloned $MERMAID_REF of the repo and built deps" \
    || pass "thin-source: server is alive after the full auto-install"
else
  fail "thin-source: server did not come up (state: ${STATE}, see docker logs $TS_CONTAINER)"
fi
docker rm -f "$TS_CONTAINER" >/dev/null 2>&1

# ── Part 2: live chain ───────────────────────────────────────────────────────
echo ""
cyan_info "=== 2. Live chain (proxy on :${PROXY_PORT}) ==="

if ! curl -sf --max-time 5 "$BASE_URL/status" >/dev/null 2>&1; then
  info "proxy not running — starting via mcp-proxy/proxy.sh start"
  if bash "$PROXY_DIR/proxy.sh" start >"$TMP/proxy-start.log" 2>&1; then
    pass "mcp-proxy/proxy.sh start succeeded"
  else
    fail "mcp-proxy/proxy.sh start (see $TMP/proxy-start.log)"
  fi
fi

STATUS=$(curl -s --max-time 5 "$BASE_URL/status" 2>/dev/null)
if echo "$STATUS" | grep -q '"mermaid":"configured"'; then
  pass "/status reports the mermaid server as configured"
else
  fail "/status (${STATUS:0:200})"
fi

INIT_RESPONSE=$(mcp_request '{
  "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": {"protocolVersion": "2025-06-18", "capabilities": {},
             "clientInfo": {"name": "proxy-smoke", "version": "1.0"}}
}')
if echo "$INIT_RESPONSE" | jq -e '.result.serverInfo.name == "mermaid-mcp"' >/dev/null 2>&1; then
  pass "initialize handshake — serverInfo.name = mermaid-mcp"
else
  fail "initialize handshake ($(echo "$INIT_RESPONSE" | head -c 200))"
fi

VALID_RESPONSE=$(mcp_request '{
  "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": {"name": "validate",
             "arguments": {"diagram": "graph TD\n    A[Start] --> B[End]"}}
}')
VALID_TEXT=$(echo "$VALID_RESPONSE" | jq -r '.result.content[0].text // empty' 2>/dev/null)
if echo "$VALID_TEXT" | grep -q "Valid:"; then
  pass "tools/call validate → ${VALID_TEXT}"
else
  fail "tools/call validate ($(echo "$VALID_RESPONSE" | head -c 200))"
fi

if docker ps --filter "name=mermaid-mcp-proxy" --format '{{.Names}}' | grep -q mermaid-mcp-proxy; then
  if docker logs mermaid-mcp-proxy 2>&1 | grep -q '\[entrypoint\] running'; then
    pass "live container ran the init.d hooks"
  else
    fail "live container log has no [entrypoint] hook lines"
  fi
else
  info "live proxy container not running — hook log check skipped"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
cyan_info "Tests passed: $PASSED / Tests failed: $FAILED"
if [ $FAILED -gt 0 ]; then
  echo "   Review the FAIL lines above for details."
fi

exit ${FAILED}

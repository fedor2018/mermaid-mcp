#!/bin/bash
# Smoke test mermaid-mcp against the local compose environment
# Tests via HTTP (curl) against http://localhost:3000/mcp
# Usage: ./test.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

BASE_URL="http://localhost:3000/mcp"

PASSED=0
FAILED=0

pass() { echo -e "  ${GREEN}PASS${NC}: $1"; ((PASSED++)); }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; ((FAILED++)); }
info() { echo -e "  ${YELLOW}INFO${NC}: $1"; }
cyan_info() { echo -e "  ${CYAN}---$1${NC}"; }

# ── Helper: send MCP JSON-RPC request and return parsed JSON ──────────────────
# The server uses StreamableHTTPServerTransport which returns SSE (event: message\n data: {...}).
# This function extracts the JSON from the SSE data line, or falls back to raw JSON.
mcp_request() {
  local body="$1"
  local raw
  raw=$(curl -sf -s -X POST "$BASE_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$body" 2>/dev/null)

  # If response contains SSE "data: " prefix, extract the JSON
  if echo "$raw" | grep -q '^data: '; then
    echo "$raw" | grep '^data: ' | head -1 | sed 's/^data: //'
  else
    echo "$raw"
  fi
}

# ── Pre-check: compose must be running ──────────────────────────────────────
echo ""
echo "=== Check: docker compose services ==="
if ! docker compose -f "$SCRIPT_DIR/docker-compose.yml" ps --format json 2>/dev/null | grep -q "running"; then
  fail "docker compose is not running. Run ./start.sh first."
  exit 1
fi
pass "docker compose services are running"

# ── Pre-check: wait for server to be ready ──────────────────────────────────
echo ""
echo "=== Wait for server ==="
MAX_WAIT=30
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
  if curl -sf -o /dev/null "$BASE_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.1"}}}' 2>/dev/null; then
    break
  fi
  sleep 1
  WAITED=$((WAITED + 1))
  if [ $((WAITED % 5)) -eq 0 ]; then
    info "Waiting for server... (${WAITED}s)"
  fi
done
if [ $WAITED -ge $MAX_WAIT ]; then
  fail "Server did not become ready within ${MAX_WAIT}s"
  exit 1
fi
pass "Server is ready (waited ${WAITED}s)"

# ── Test 1: MCP initialize handshake ────────────────────────────────────────
echo ""
echo "=== Test 1: MCP initialize handshake ==="
INIT_RESPONSE=$(mcp_request '{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": {"name": "smoke-test", "version": "1.0"}
  }
}')

if echo "$INIT_RESPONSE" | jq -e '.result.serverInfo.name == "mermaid-mcp"' >/dev/null 2>&1; then
  pass "MCP initialize handshake — serverInfo.name = mermaid-mcp"
else
  fail "MCP initialize handshake (response: $(echo "$INIT_RESPONSE" | head -c 200))"
fi

# ── Test 2: tools/list returns 2 tools ──────────────────────────────────────
echo ""
echo "=== Test 2: tools/list returns 2 tools ==="
TOOLS_RESPONSE=$(mcp_request '{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list",
  "params": {}
}')

TOOL_COUNT=$(echo "$TOOLS_RESPONSE" | jq -r '.result.tools | length' 2>/dev/null)
TOOL_NAMES=$(echo "$TOOLS_RESPONSE" | jq -r '.result.tools[].name' 2>/dev/null | sort | tr '\n' ',' | sed 's/,$//')

if [ "$TOOL_COUNT" = "2" ] && [ "$TOOL_NAMES" = "render,validate" ]; then
  pass "tools/list returns 2 tools: validate, render"
else
  fail "tools/list — expected 2 tools (render,validate), got ${TOOL_COUNT} tools (${TOOL_NAMES})"
fi

# ── Test 3: validate — valid flowchart ──────────────────────────────────────
echo ""
echo "=== Test 3: validate — valid flowchart ==="
VALID_RESPONSE=$(mcp_request '{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "validate",
    "arguments": {
      "diagram": "graph TD\n    A[Start] --> B[End]"
    }
  }
}')

IS_ERROR=$(echo "$VALID_RESPONSE" | jq -r '.result.isError // empty' 2>/dev/null)
CONTENT_TEXT=$(echo "$VALID_RESPONSE" | jq -r '.result.content[0].text // empty' 2>/dev/null)

if [ "$IS_ERROR" != "true" ] && echo "$CONTENT_TEXT" | grep -q "Valid:"; then
  pass "validate — valid flowchart returns Valid"
else
  fail "validate — valid flowchart (isError=${IS_ERROR}, text=${CONTENT_TEXT})"
fi

# ── Test 4: validate — invalid diagram ──────────────────────────────────────
echo ""
echo "=== Test 4: validate — invalid diagram ==="
INVALID_RESPONSE=$(mcp_request '{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "validate",
    "arguments": {
      "diagram": "this is not a valid mermaid diagram at all"
    }
  }
}')

IS_ERROR=$(echo "$INVALID_RESPONSE" | jq -r '.result.isError // empty' 2>/dev/null)

if [ "$IS_ERROR" = "true" ]; then
  pass "validate — invalid diagram returns isError: true"
else
  fail "validate — invalid diagram (isError=${IS_ERROR})"
fi

# ── Test 5: render — PNG format ─────────────────────────────────────────────
echo ""
echo "=== Test 5: render — PNG format ==="
RENDER_PNG_RESPONSE=$(mcp_request '{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "render",
    "arguments": {
      "diagram": "graph TD\n    A[Start] --> B[End]",
      "format": "png",
      "backgroundColor": "white"
    }
  }
}')

IS_ERROR=$(echo "$RENDER_PNG_RESPONSE" | jq -r '.result.isError // empty' 2>/dev/null)
MIME_TYPE=$(echo "$RENDER_PNG_RESPONSE" | jq -r '.result.content[] | select(.type == "image") | .mimeType' 2>/dev/null)
TEXT_INFO=$(echo "$RENDER_PNG_RESPONSE" | jq -r '.result.content[] | select(.type == "text") | .text' 2>/dev/null)

if [ "$IS_ERROR" != "true" ] && [ "$MIME_TYPE" = "image/png" ]; then
  pass "render — PNG returns image/png content"
else
  fail "render — PNG (isError=${IS_ERROR}, mimeType=${MIME_TYPE}, text=${TEXT_INFO})"
fi

# ── Test 6: render — SVG format ─────────────────────────────────────────────
echo ""
echo "=== Test 6: render — SVG format ==="
RENDER_SVG_RESPONSE=$(mcp_request '{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "render",
    "arguments": {
      "diagram": "graph TD\n    A[Start] --> B[End]",
      "format": "svg",
      "backgroundColor": "white"
    }
  }
}')

IS_ERROR=$(echo "$RENDER_SVG_RESPONSE" | jq -r '.result.isError // empty' 2>/dev/null)
MIME_TYPE=$(echo "$RENDER_SVG_RESPONSE" | jq -r '.result.content[] | select(.type == "image") | .mimeType' 2>/dev/null)

if [ "$IS_ERROR" != "true" ] && [ "$MIME_TYPE" = "image/svg+xml" ]; then
  pass "render — SVG returns image/svg+xml content"
else
  fail "render — SVG (isError=${IS_ERROR}, mimeType=${MIME_TYPE})"
fi

# ── Test 7: render — invalid diagram ────────────────────────────────────────
echo ""
echo "=== Test 7: render — invalid diagram ==="
RENDER_INVALID_RESPONSE=$(mcp_request '{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "render",
    "arguments": {
      "diagram": "this is not a valid mermaid diagram at all",
      "format": "png",
      "backgroundColor": "white"
    }
  }
}')

IS_ERROR=$(echo "$RENDER_INVALID_RESPONSE" | jq -r '.result.isError // empty' 2>/dev/null)

if [ "$IS_ERROR" = "true" ]; then
  pass "render — invalid diagram returns isError: true"
else
  fail "render — invalid diagram (isError=${IS_ERROR})"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "=== Summary ==="
cyan_info "Tests passed: $PASSED / Tests failed: $FAILED"
if [ $FAILED -gt 0 ]; then
  echo "   Review the FAIL lines above for details."
fi

exit ${FAILED}

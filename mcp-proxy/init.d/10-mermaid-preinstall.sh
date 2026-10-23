#!/bin/sh
# Preinstall hook: install mermaid-mcp dependencies into /app/mermaid.
#
# Runs once per container start, before mcp-proxy reads the named-server
# config. Guarded:
#   - skipped when node_modules is already complete (it is seeded at docker
#     build time, so a normal start pays nothing and works offline),
#   - FORCE_PREINSTALL=1 forces a fresh `npm ci` even then
#     (the docker cache volume pass through ./cache → /app/cache).
#
# A failure here aborts the container: the proxy would start a server that
# cannot import its dependencies anyway.

TARGET="/app/mermaid"

if [ -d "$TARGET/node_modules" ] \
  && [ -n "$(ls -A "$TARGET/node_modules" 2>/dev/null)" ] \
  && [ "${FORCE_PREINSTALL:-0}" != "1" ]; then
  echo "[preinstall] node_modules present — skipping (FORCE_PREINSTALL=1 to force)" >&2
  exit 0
fi

echo "[preinstall] npm ci --omit=dev in $TARGET ..." >&2
cd "$TARGET"
npm ci --omit=dev --cache /app/cache/npm
echo "[preinstall] done" >&2

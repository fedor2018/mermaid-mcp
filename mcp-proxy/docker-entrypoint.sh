#!/bin/sh
# Entrypoint of the mermaid-mcp mcp-proxy image.
#
# Runs every *.sh hook from /docker-entrypoint-init.d in lexicographic order
# (dependency auto-install and similar one-off container-start work) and then
# execs mcp-proxy with the received arguments. The named-server config
# (/config/servers.json, mounted by the caller) is handled by mcp-proxy
# itself — the hooks only prepare what the config points at.
#
# Behavior mirrors the classic docker-entrypoint-init.d pattern:
#   - hooks run once per container start (not per process),
#   - a failing hook aborts the container (the docker restart policy picks it up),
#   - extra hooks can be added by bind-mounting the directory — no image rebuild.
#
# Environment:
#   SKIP_INIT=1            skip the hooks entirely (debugging, fast restarts)
set -eu

INIT_DIR="/docker-entrypoint-init.d"

if [ "${SKIP_INIT:-0}" = "1" ]; then
  echo "[entrypoint] SKIP_INIT=1 — skipping $INIT_DIR hooks" >&2
else
  mkdir -p "$INIT_DIR"
  for hook in "$INIT_DIR"/*.sh; do
    # The glob stays literal when the directory is empty.
    [ -f "$hook" ] || continue
    echo "[entrypoint] running $(basename "$hook")" >&2
    /bin/sh "$hook"
  done
fi

# catatonit preserves the PID-1 signal semantics of the base image; mcp-proxy
# spawns /config/servers.json entries as stdio children afterwards.
exec catatonit -- mcp-proxy "$@"

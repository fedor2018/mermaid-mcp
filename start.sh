#!/usr/bin/env bash
# Start mermaid-mcp on puma-net.
set -euo pipefail

echo "------ Starting mermaid-mcp"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Ensure external network exists
docker network inspect puma-net >/dev/null 2>&1 || docker network create puma-net

docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d

echo "Done."

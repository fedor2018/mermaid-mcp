#!/bin/bash
# Stop the local mermaid-mcp compose
# Usage: ./stop.sh
set -euo pipefail

docker compose down
echo "Stopped."

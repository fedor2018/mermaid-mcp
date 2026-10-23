# mermaid-mcp behind sparfenyuk/mcp-proxy.
#
# The proxy spawns our stdio MCP server as a child process and re-exposes it
# as SSE / Streamable HTTP — so a single HTTP endpoint serves the Mermaid
# tools, while the server itself stays a plain stdio process.
#
#   docker build -f mcp-proxy/Dockerfile -t mermaid-mcp-stdio-proxy .
#   docker run --rm -p 8080:8080 \
#     -v $(pwd)/mcp-proxy/config:/config:ro mermaid-mcp-stdio-proxy
#
# The build context is the repo root (package.json + src/ live there);
# docker-compose.yml in this directory sets context: ../ accordingly.
#
# The base image ENTRYPOINT (`catatonit -- mcp-proxy`) is replaced by
# /usr/local/bin/docker-entrypoint.sh: it runs every *.sh hook from
# /docker-entrypoint-init.d (auto-install etc.) and then execs the proxy.

FROM ghcr.io/sparfenyuk/mcp-proxy:latest

# Node runtime for the stdio server + fonts for Mermaid text rendering.
RUN apk add --no-cache nodejs npm font-dejavu font-liberation

WORKDIR /app/mermaid

# Seed-cache the dependencies at build time: the preinstall hook skips them
# on container start when node_modules is already complete.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

# Auto-install hooks (init.d) + the entrypoint that runs them.
COPY mcp-proxy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY mcp-proxy/init.d/ /docker-entrypoint-init.d/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# The named-server config is the exclusive source of servers, so the child
# command is not repeated here (config-loader reads only command/args/env/
# enabled; CLI --named-server flags would be ignored).
# --pass-environment hands PATH (and the rest) to the spawned server.
CMD ["--port=8080", "--host=0.0.0.0", "--pass-environment", "--stateless", "--named-server-config=/config/servers.json"]

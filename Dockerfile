FROM node:26.3.0-slim

# Install fonts for proper Mermaid text rendering in sharp
RUN apt-get update && apt-get install -y \
    fonts-dejavu \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

EXPOSE 3000

ENTRYPOINT ["node", "src/mcp-server.mjs"]

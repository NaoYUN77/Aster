FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.19.0-bookworm-slim
LABEL org.opencontainers.image.title="Aster"
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOME=/data \
    NPM_CONFIG_CACHE=/data/.npm
# Agent tools and operator commands use Bash; all mutable state belongs under /data.
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
VOLUME ["/data"]
CMD ["flock", "--no-fork", "--nonblock", "/data/app.lock", "node", "dist/src/main.js"]

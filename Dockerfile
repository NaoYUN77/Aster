# Build stage: install every dependency, type-check inputs by compiling, then drop dev dependencies.
FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime stage: application code and production dependencies only; persistent state lives on a volume.
FROM node:24.19.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# The data directory is a volume owned by the unprivileged runtime user.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

# Node is the entry point and handles SIGTERM itself; run the container with an init process so
# tool subprocesses are reaped.
CMD ["node", "dist/src/main.js"]

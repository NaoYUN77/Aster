FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea
LABEL org.opencontainers.image.title="Aster browser"
WORKDIR /opt/aster-browser
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HOME=/home/aster-browser
# The image supplies Node and browser binaries; install only their matching JS resolver.
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false --save-exact playwright-core@1.64.1 \
    && npm cache clean --force \
    && mkdir -p /data/browser/shots /data/browser/pages /data/browser/traces /home/aster-browser \
    && chown -R 1000:1000 /data/browser /home/aster-browser
# Ubuntu noble can reserve UID 1000 before Playwright creates pwuser. Use the numeric
# application UID explicitly so both containers can write the same bind-mounted artifacts.
COPY --chown=1000:1000 proxy.mjs launch.mjs ./
USER 1000:1000
CMD ["node", "launch.mjs"]

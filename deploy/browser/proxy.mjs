import http from "node:http";
import { open } from "node:fs/promises";
import { join } from "node:path";

const HTTP_LIMIT = 1024 * 1024;
const METRIC_TIMEOUT_MS = 1500;

async function counter(path, limit = false) {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(128);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead === buffer.length) throw new Error("Invalid counter");
    const text = buffer.subarray(0, bytesRead).toString("utf8").trim();
    if (limit && text === "max") return null;
    if (!/^\d+$/.test(text)) throw new Error("Invalid counter");
    const value = BigInt(text);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      if (limit) return null; // cgroup v1 represents unlimited memory with a huge integer.
      throw new Error("Counter out of range");
    }
    return Number(value);
  } finally {
    await file.close();
  }
}

export async function readMetrics(root = "/sys/fs/cgroup") {
  let names = ["memory.current", "memory.max", "pids.current", "pids.max"];
  try {
    const values = await Promise.all(names.map((name, index) => counter(join(root, name), index % 2 === 1)));
    return { memoryBytes: values[0], memoryLimitBytes: values[1], pids: values[2], pidsLimit: values[3] };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  names = ["memory/memory.usage_in_bytes", "memory/memory.limit_in_bytes", "pids/pids.current", "pids/pids.max"];
  const values = await Promise.all(names.map((name, index) => counter(join(root, name), index % 2 === 1)));
  return { memoryBytes: values[0], memoryLimitBytes: values[1], pids: values[2], pidsLimit: values[3] };
}

function reply(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
  response.end(payload);
}

// Chromium's loopback listener stays private. Only this bounded HTTP/WS surface is exposed.
export function createCdpProxy({ upstreamPort = 9223, metrics = readMetrics, metricsTimeoutMs = METRIC_TIMEOUT_MS } = {}) {
  let requests = 0;
  let upgrades = 0;
  let metricsFlight;
  let metricsStalled = false;
  const sockets = new Set();
  const upstreamRequests = new Set();
  const server = http.createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    if (request.method !== "GET") return reply(response, 405, { error: "Method not allowed" });
    if (requests >= 16) return reply(response, 503, { error: "Browser proxy busy" });
    requests++;
    response.once("close", () => requests--);
    if (request.url === "/aster/metrics") {
      if (metricsStalled) return reply(response, 503, { error: "Browser metrics unavailable" });
      if (!metricsFlight) {
        // Share both the read and deadline. After a timeout, refuse new work until the
        // original read settles, avoiding accumulated reads and promise listeners.
        const work = Promise.resolve().then(metrics);
        let timeout;
        metricsFlight = Promise.race([
          work,
          new Promise((_, reject) => {
            timeout = setTimeout(() => { metricsStalled = true; reject(new Error("Metrics timeout")); }, metricsTimeoutMs);
          }),
        ]).finally(() => { clearTimeout(timeout); metricsFlight = undefined; });
        work.then(() => { metricsStalled = false; }, () => { metricsStalled = false; });
      }
      try {
        return reply(response, 200, await metricsFlight);
      } catch {
        return reply(response, 503, { error: "Browser metrics unavailable" });
      }
    }
    // Playwright's HTTP CDP discovery appends a trailing slash.
    const discoveryPath = request.url?.replace(/\/$/, "");
    if (!["/json/version", "/json/list", "/json", "/json/protocol"].includes(discoveryPath)) {
      return reply(response, 404, { error: "Not found" });
    }
    const authority = request.headers.host;
    if (!authority || !/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(?::\d{1,5})?$/.test(authority)) {
      return reply(response, 400, { error: "Invalid host" });
    }
    const upstream = http.get({ hostname: "127.0.0.1", port: upstreamPort, path: discoveryPath, headers: { host: `127.0.0.1:${upstreamPort}` } }, (incoming) => {
      const chunks = [];
      let size = 0;
      incoming.on("data", (chunk) => {
        size += chunk.length;
        if (size > HTTP_LIMIT) upstream.destroy(new Error("CDP response too large"));
        else chunks.push(chunk);
      });
      incoming.on("error", () => reply(response, 502, { error: "Browser unavailable" }));
      incoming.on("end", () => {
        if (incoming.statusCode !== 200) return reply(response, 502, { error: "Browser unavailable" });
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          for (const item of Array.isArray(value) ? value : [value]) {
            if (typeof item?.webSocketDebuggerUrl === "string") {
              const url = new URL(item.webSocketDebuggerUrl);
              item.webSocketDebuggerUrl = `ws://${authority}${url.pathname}`;
            }
          }
          reply(response, 200, value);
        } catch {
          reply(response, 502, { error: "Invalid browser response" });
        }
      });
    });
    upstreamRequests.add(upstream);
    upstream.once("close", () => upstreamRequests.delete(upstream));
    upstream.setTimeout(5000, () => upstream.destroy(new Error("CDP timeout")));
    upstream.on("error", () => reply(response, 502, { error: "Browser unavailable" }));
    response.once("close", () => upstream.destroy());
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    if (request.method !== "GET" || !/^\/devtools\/(browser|page)\/[a-zA-Z0-9-]+$/.test(request.url) || upgrades >= 32) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    upgrades++;
    socket.once("close", () => upgrades--);
    const upstream = http.request({
      hostname: "127.0.0.1", port: upstreamPort, path: request.url,
      headers: { host: `127.0.0.1:${upstreamPort}`, connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": request.headers["sec-websocket-key"] ?? "", "sec-websocket-version": "13" },
    });
    upstreamRequests.add(upstream);
    upstream.once("close", () => upstreamRequests.delete(upstream));
    const handshakeTimeout = setTimeout(() => { upstream.destroy(); socket.destroy(); }, 5000);
    socket.once("close", () => { clearTimeout(handshakeTimeout); upstream.destroy(); });
    upstream.on("upgrade", (response, remote, remoteHead) => {
      clearTimeout(handshakeTimeout);
      if (response.statusCode !== 101 || !response.headers["sec-websocket-accept"]) {
        remote.destroy(); socket.destroy(); return;
      }
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${response.headers["sec-websocket-accept"]}\r\n\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      // Streaming with backpressure avoids buffering whole WebSocket messages in the proxy.
      socket.pipe(remote).pipe(socket);
      socket.setTimeout(10 * 60 * 1000, () => socket.destroy());
      remote.on("error", () => socket.destroy());
      socket.on("error", () => remote.destroy());
      socket.once("close", () => remote.destroy());
      remote.once("close", () => socket.destroy());
    });
    upstream.on("response", (response) => { response.destroy(); socket.destroy(); });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.end();
  });
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  server.requestTimeout = 10_000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.setTimeout(10_000);
  return {
    server,
    close() {
      for (const request of upstreamRequests) request.destroy();
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

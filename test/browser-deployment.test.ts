import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCdpProxy, readMetrics, type BrowserMetrics } from "../deploy/browser/proxy.mjs";

const sample: BrowserMetrics = { memoryBytes: 1234, memoryLimitBytes: 2147483648, pids: 12, pidsLimit: 512 };
async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}
async function close(server: http.Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function directory(t: test.TestContext) {
  const path = await mkdtemp(join(tmpdir(), "aster-browser-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("metrics read bounded cgroup v2 counters and preserve unlimited limits", async (t) => {
  const root = await directory(t);
  await Promise.all(Object.entries({ "memory.current": "1234\n", "memory.max": "2147483648\n", "pids.current": "12\n", "pids.max": "512\n" }).map(([name, value]) => writeFile(join(root, name), value)));
  assert.deepEqual(await readMetrics(root), sample);
  await writeFile(join(root, "memory.max"), "max\n");
  await writeFile(join(root, "pids.max"), "max\n");
  assert.deepEqual(await readMetrics(root), { ...sample, memoryLimitBytes: null, pidsLimit: null });
  for (const invalid of ["-1", "NaN", "9007199254740992", "1".repeat(129)]) {
    await writeFile(join(root, "memory.current"), invalid);
    await assert.rejects(readMetrics(root));
  }
});

test("metrics support cgroup v1 and fail explicitly for missing counters", async (t) => {
  const root = await directory(t);
  await Promise.all(["memory", "pids"].map((name) => mkdir(join(root, name))));
  await Promise.all(Object.entries({ "memory/memory.usage_in_bytes": "1234", "memory/memory.limit_in_bytes": "9223372036854771712", "pids/pids.current": "12", "pids/pids.max": "512" }).map(([name, value]) => writeFile(join(root, name), value)));
  assert.deepEqual(await readMetrics(root), { ...sample, memoryLimitBytes: null });
  await rm(join(root, "pids/pids.current"));
  await assert.rejects(readMetrics(root));
});

test("CDP discovery rewrites loopback URLs and rejects unsupported methods and paths", async (t) => {
  let observedHost;
  const upstream = http.createServer((request, response) => {
    observedHost = request.headers.host;
    response.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/test-id", Browser: "Chromium" }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = createCdpProxy({ upstreamPort, metrics: async () => sample });
  const port = await listen(proxy.server);
  t.after(() => proxy.close());
  const base = `http://127.0.0.1:${port}`;
  const response = await fetch(`${base}/json/version`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).webSocketDebuggerUrl, `ws://127.0.0.1:${port}/devtools/browser/test-id`);
  assert.equal(observedHost, `127.0.0.1:${upstreamPort}`);
  assert.deepEqual(await (await fetch(`${base}/aster/metrics`)).json(), sample);
  assert.equal((await fetch(`${base}/json/new?https://example.com`)).status, 404);
  assert.equal((await fetch(`${base}/aster/metrics`, { method: "POST" })).status, 405);
});

test("CDP returns bounded errors for oversized and malformed upstream responses", async (t) => {
  let body = "x".repeat(1024 * 1024 + 1);
  const upstream = http.createServer((_request, response) => response.end(body));
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = createCdpProxy({ upstreamPort });
  const port = await listen(proxy.server);
  t.after(() => proxy.close());
  for (const value of [body, "not json"]) {
    body = value;
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    assert.equal(response.status, 502);
    assert.ok((await response.text()).length < 100);
  }
});

test("metrics failures hide internals and timeouts do not accumulate background reads", async (t) => {
  let calls = 0;
  const proxy = createCdpProxy({ metricsTimeoutMs: 20, metrics: () => { calls++; return new Promise(() => {}); } });
  const port = await listen(proxy.server);
  t.after(() => proxy.close());
  for (let i = 0; i < 3; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/aster/metrics`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Browser metrics unavailable" });
  }
  assert.equal(calls, 1);
  const failing = createCdpProxy({ metrics: async () => { throw new Error("secret /host/path"); } });
  const failingPort = await listen(failing.server);
  t.after(() => failing.close());
  assert.equal(await (await fetch(`http://127.0.0.1:${failingPort}/aster/metrics`)).text(), '{"error":"Browser metrics unavailable"}');
});

test("metrics concurrency refuses excess requests", async (t) => {
  let release!: (value: BrowserMetrics) => void;
  let notify!: () => void;
  const started = new Promise<void>((resolve) => { notify = resolve; });
  const proxy = createCdpProxy({ metrics: () => { notify(); return new Promise((resolve) => { release = resolve; }); } });
  const port = await listen(proxy.server);
  t.after(() => proxy.close());
  const entered = new Promise<void>((resolve) => {
    let count = 0;
    proxy.server.on("request", () => { if (++count === 16) resolve(); });
  });
  const requests = Array.from({ length: 16 }, () => fetch(`http://127.0.0.1:${port}/aster/metrics`));
  await started;
  await entered;
  const extra = await fetch(`http://127.0.0.1:${port}/aster/metrics`);
  assert.equal(extra.status, 503);
  assert.deepEqual(await extra.json(), { error: "Browser proxy busy" });
  release(sample);
  for (const response of await Promise.all(requests)) {
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
});

test("WebSocket upgrade tunnels bytes and proxy shutdown closes active tunnels", async (t) => {
  const upstream = http.createServer();
  const remoteSockets = new Set<import("node:stream").Duplex>();
  upstream.on("upgrade", (request, socket, head) => {
    remoteSockets.add(socket);
    socket.once("close", () => remoteSockets.delete(socket));
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (head.length) socket.write(head);
    socket.on("data", (chunk) => socket.write(chunk));
  });
  const upstreamPort = await listen(upstream);
  t.after(async () => { for (const socket of remoteSockets) socket.destroy(); await close(upstream); });
  const proxy = createCdpProxy({ upstreamPort });
  const port = await listen(proxy.server);
  t.after(() => { if (proxy.server.listening) return proxy.close(); });
  const socket = await new Promise<import("node:net").Socket>((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port, path: "/devtools/browser/test-id", headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": Buffer.from("test-browser-key").toString("base64"), "sec-websocket-version": "13" } });
    request.on("upgrade", (_response, socket) => resolve(socket));
    request.on("error", reject);
    request.end();
  });
  const echoed = new Promise<Buffer>((resolve) => socket.once("data", resolve));
  socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
  assert.deepEqual(await echoed, Buffer.from([0x81, 0x02, 0x68, 0x69]));
  const disconnected = new Promise<void>((resolve) => socket.once("close", resolve));
  await proxy.close();
  await disconnected;
});

const compose = spawnSync("docker", ["compose", "version"], { encoding: "utf8", timeout: 30_000 });
test("rendered overlay isolates browser resources, proxy and artifacts without published ports", { skip: compose.error || compose.status !== 0 ? "Docker Compose is unavailable" : false }, async (t) => {
  const root = await directory(t);
  await Promise.all([
    writeFile(join(root, "docker-compose.yml"), await readFile(new URL("../docker-compose.yml", import.meta.url))),
    writeFile(join(root, "docker-compose.browser.yml"), await readFile(new URL("../docker-compose.browser.yml", import.meta.url))),
    writeFile(join(root, ".env"), "BROWSER_PROXY=http://proxy.example:8080\nBROWSER_DATA_DIR=/srv/browser-test\n"),
  ]);
  const result = spawnSync("docker", ["compose", "--project-directory", root, "--env-file", join(root, ".env"), "-f", join(root, "docker-compose.yml"), "-f", join(root, "docker-compose.browser.yml"), "config", "--format", "json"], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, HOME: root, BROWSER_PROXY: "http://proxy.example:8080", BROWSER_DATA_DIR: join(root, "browser") },
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  const browser = config.services["aster-browser"];
  const agent = config.services["personal-agent"];
  assert.equal(browser.mem_limit, "2147483648");
  assert.equal(browser.shm_size, "1073741824");
  assert.equal(browser.pids_limit, 512);
  assert.equal(browser.restart, "unless-stopped");
  assert.equal(browser.ports, undefined);
  assert.equal(browser.network_mode, undefined);
  assert.notEqual(config.networks.default.internal, true);
  assert.equal(browser.environment.BROWSER_PROXY, "http://proxy.example:8080");
  assert.equal(agent.environment.BROWSER_PROXY, "");
  assert.equal(agent.environment.BROWSER_CDP_URL, "http://aster-browser:9222");
  const browserMount = browser.volumes.find((value: { target: string }) => value.target === "/data/browser");
  const agentMount = agent.volumes.find((value: { target: string }) => value.target === "/data/browser");
  assert.equal(browserMount.type, "bind");
  assert.equal(browserMount.source, agentMount.source);
  assert.equal(browserMount.bind.create_host_path, false);
  assert.ok(!browser.volumes.some((value: { source: string }) => value.source.includes("docker.sock")));
  assert.ok(!JSON.stringify(agent).includes("playwright-core"));
});

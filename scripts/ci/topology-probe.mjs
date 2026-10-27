import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, chmod, chown, copyFile, stat } from "node:fs/promises";
import net from "node:net";
import http from "node:http";
import tls from "node:tls";
import dgram from "node:dgram";
import { Resolver } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const operation = process.argv[2];
let stage = operation;
const sleep = (ms) => delay(ms);
async function waitFor(test, milliseconds = 45_000) {
  const end = Date.now() + milliseconds;
  while (true) {
    if (await test()) return;
    assert.ok(Date.now() < end, "deadline exceeded");
    await sleep(200);
  }
}
async function control(body) {
  const response = await fetch("http://127.0.0.1:18080/control", {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(3000),
  });
  if (response.status !== 200) {
    const error = new Error("control request rejected");
    error.code = `CONTROL_${response.status}`;
    throw error;
  }
  return response.json();
}
async function api(method, path, body, token) {
  const response = await fetch(`http://127.0.0.1:14321${path}`, {
    method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, text: await response.text() };
}
function connected(host, port, timeout = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(error.code === "ETIMEDOUT" ? false : error.code));
    socket.setTimeout(timeout, () => finish(false));
  });
}
function udpReply(host, port, query) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => { socket.close(); resolve(false); }, 1000);
    const finish = (value) => { clearTimeout(timer); socket.close(); resolve(value); };
    socket.once("message", () => finish(true));
    socket.once("error", () => finish(false));
    socket.send(query, port, host);
  });
}
async function dnsReply() {
  const resolver = new Resolver({ timeout: 700, tries: 1 });
  resolver.setServers(["127.0.0.11"]);
  try { return (await resolver.resolve4("reachable.topology.test")).includes("172.30.82.2"); }
  catch { return false; }
}
function proxyStatus(port, method, target, authorization) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method, path: target,
      headers: { Host: target, ...(authorization ? { "Proxy-Authorization": authorization } : {}) }, timeout: 3000 });
    request.on("connect", (response, socket) => { socket.destroy(); resolve(response.statusCode); });
    request.on("response", (response) => { response.destroy(); resolve(response.statusCode); });
    request.on("timeout", () => request.destroy(new Error("proxy deadline")));
    request.on("error", reject);
    request.end();
  });
}
// CONNECT itself always succeeds after proxy auth; the broker decides about the
// target inside the tunnel. Only the tunnelled HTTP status is a policy verdict.
function tunnelStatus(host, port, agentToken, vault, ca, { method = "GET", path = "/", headers = {}, secrets = [] } = {}) {
  return new Promise((resolve) => {
    const authority = `${host}:${port}`;
    const authorization = `Basic ${Buffer.from(`${agentToken}:${vault}`).toString("base64")}`;
    const request = http.request({ host: "127.0.0.1", port: 14322, method: "CONNECT", path: authority,
      headers: { Host: authority, "Proxy-Authorization": authorization }, timeout: 5000 });
    request.on("connect", (response, socket) => {
      if (response.statusCode !== 200) { socket.destroy(); resolve(`connect-${response.statusCode}`); return; }
      const secure = tls.connect({ socket, servername: host, ca, ALPNProtocols: ["http/1.1"] });
      let data = "";
      const finish = (value) => { secure.destroy(); resolve(value); };
      secure.setTimeout(5000, () => finish("timeout"));
      secure.once("secureConnect", () => secure.write(`${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nContent-Length: 0\r\n` +
        Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("") + "\r\n"));
      secure.on("data", (chunk) => {
        data += chunk.toString();
        if (data.length > 1_048_576) finish("response-too-large");
      });
      secure.once("end", () => {
        const leaked = secrets.some((secret) => [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64"),
          Buffer.from(secret).toString("hex")].some((value) => data.includes(value)));
        finish(leaked ? "credential-in-response" : Number(data.slice(9, 12)) || "no-status");
      });
      secure.once("error", (error) => finish(`tls-${error.code ?? "error"}`));
    });
    request.on("timeout", () => request.destroy(new Error("proxy deadline")));
    request.on("error", (error) => resolve(`proxy-${error.code ?? "error"}`));
    request.end();
  });
}
try {
  if (operation === "ready") {
    await waitFor(async () => { try { await control(); return (await api("GET", "/health")).status === 200; } catch { return false; } });
  } else if (operation === "bootstrap") {
    const credentials = JSON.parse(await readFile("/fixtures/credentials.json", "utf8"));
    stage = "bootstrap:owner-register";
    const ownerResult = await api("POST", "/v1/auth/register", { email: "topology@example.test", password: credentials.ownerPassword });
    assert.equal(ownerResult.status, 201);
    const owner = JSON.parse(ownerResult.text).token;
    assert.ok(owner);
    // The broker terminates tunnelled TLS with its own CA, so policy verdicts
    // inside a tunnel must be read through that CA rather than the fixture CA.
    stage = "bootstrap:ca";
    const ca = await api("GET", "/v1/mitm/ca.pem", undefined, owner);
    assert.equal(ca.status, 200);
    assert.ok(ca.text.includes("BEGIN CERTIFICATE"));
    await writeFile("/app-ca/ca.pem", ca.text, { mode: 0o644 });
    const services = {
      telegram: { name: "telegram", host: "api.telegram.org:443/bot__vault_TELEGRAM_BOT_TOKEN__/*", auth: { type: "passthrough" },
        substitutions: [{ key: "TELEGRAM_BOT_TOKEN", placeholder: "__vault_TELEGRAM_BOT_TOKEN__", in: ["path"] }] },
      deepseek: { name: "deepseek", host: "api.deepseek.com:443/*", auth: { type: "bearer", token: "DEEPSEEK_API_KEY" } },
    };
    for (const name of ["telegram", "deepseek"]) {
      stage = `bootstrap:${name}:vault-create`;
      assert.equal((await api("POST", "/v1/vaults", { name, credential_store: { kind: "infisical", config: {
        project_id: "ci-project", environment: "ci", secret_path: `/ci/${name}` }, poll_interval_seconds: 60 } }, owner)).status, 201);
      stage = `bootstrap:${name}:policy`;
      assert.equal((await api("PATCH", `/v1/vaults/${name}/settings`, { unmatched_host_policy: "deny" }, owner)).status, 200);
      stage = `bootstrap:${name}:services`;
      assert.equal((await api("PUT", `/v1/vaults/${name}/services`, { services: [services[name]] }, owner)).status, 200);
      stage = `bootstrap:${name}:agent`;
      const agent = await api("POST", "/v1/agents", { name: `ci-${name}`, role: "no-access", vaults: [{ vault_name: name, vault_role: "proxy" }] }, owner);
      assert.equal(agent.status, 201);
      const token = JSON.parse(agent.text).av_agent_token;
      assert.ok(token);
      stage = `bootstrap:${name}:router-files`;
      await writeFile(`/router/agent-token-${name}`, token, { mode: 0o600 });
      stage = `bootstrap:${name}:deny`;
      for (const [method, path, body] of [["GET", `/v1/credentials?vault=${name}&reveal=true`],
        ["PUT", `/v1/vaults/${name}/services`, { services: [] }],
        ["POST", "/v1/vaults", { name: "escalate", credential_store: { kind: "infisical", config: { project_id: "ci-project", environment: "ci", secret_path: "/ci" } } }]]) {
        const denied = await api(method, path, body, token);
        assert.equal(denied.status, 403);
        assert.ok(!denied.text.includes(credentials.telegramToken) && !denied.text.includes(credentials.modelKey));
      }
      stage = `bootstrap:${name}:unknown-host`;
      // The broker authenticates CONNECT, then applies the unmatched-host
      // policy to the tunnelled request, so the verdict is inside the tunnel.
      const unknown = await tunnelStatus("unknown.topology.test", 443, token, name, ca.text);
      stage = `bootstrap:${name}:unknown-host-result-${unknown}`;
      assert.equal(unknown, 403);
    }
    stage = "bootstrap:anonymous";
    assert.equal((await api("GET", "/v1/credentials?vault=telegram&reveal=true")).status, 401);
    stage = "bootstrap:router-config";
    await writeFile("/router/client-password", credentials.routerPassword, { mode: 0o600 });
    await copyFile("/fixtures/router-config.json", "/router/config.json");
    for (const name of ["client-password", "agent-token-telegram", "agent-token-deepseek", "config.json"]) {
      await chmod(`/router/${name}`, 0o600);
      await chown(`/router/${name}`, 1001, 1001);
    }
    stage = "bootstrap:upstream-stats";
    const stats = await control();
    assert.ok(stats.login > 0 && stats.secrets >= 2);
    assert.equal(stats.protocolFailures, 0);
  } else if (operation === "api-policy") {
    const credentials = JSON.parse(await readFile("/fixtures/credentials.json", "utf8"));
    const ca = await readFile("/app-ca/ca.pem", "utf8");
    const secrets = Object.values(credentials);
    for (const [vault, host, allowed, encoded] of [
      ["telegram", "api.telegram.org", "/bot__vault_TELEGRAM_BOT_TOKEN__/getMe", "/bot__vault_TELEGRAM_BOT_TOKEN__/%67etMe"],
      ["deepseek", "api.deepseek.com", "/chat/completions", "/chat/%63ompletions"],
    ]) {
      const token = await readFile(`/router/agent-token-${vault}`, "utf8");
      const base = vault === "telegram" ? "/bot__vault_TELEGRAM_BOT_TOKEN__" : "";
      for (const [label, method, path, headers, expected] of [
        ["allowed", "POST", allowed, {}, 200],
        ["wrong-method", "GET", allowed, {}, 403],
        ["export", "POST", `${base}/export`, {}, 403],
        ["tokens", "POST", `${base}/tokens`, {}, 403],
        ["echo", "POST", `${base}/echo`, {}, 403],
        ["encoded", "POST", encoded, {}, 403],
        ["trailing-slash", "POST", `${allowed}/`, {}, 403],
        ["method-override", "POST", allowed, { "X-HTTP-Method-Override": "DELETE" }, 403],
      ]) {
        stage = `api-policy:${vault}:${label}`;
        const before = await control();
        const status = await tunnelStatus(host, 443, token, vault, ca, { method, path,
          headers: { "X-Topology-Policy-Probe": "1", ...headers }, secrets });
        assert.equal(status, expected);
        const after = await control();
        assert.equal(after.apiRequests - before.apiRequests, expected === 200 ? 1 : 0);
        assert.equal(after.policyAllowed - before.policyAllowed, expected === 200 ? 1 : 0);
        assert.equal(after.protocolFailures, 0);
      }
    }
  } else if (["arm-execution", "arm-delivery", "unblock"].includes(operation)) {
    await control({ operation });
  } else if (["execution-barrier", "delivery-barrier", "execution-restored", "delivery-blocked", "delivery-restored"].includes(operation)) {
    await waitFor(async () => {
      const result = await control();
      assert.equal(result.protocolFailures, 0);
      const execution = result.scenarios.execution;
      const delivery = result.scenarios.delivery;
      assert.ok(result.scenarios.business.model === 1 && result.scenarios.business.sends.length === 1);
      if (operation === "execution-barrier") {
        assert.ok(execution.model <= 2 && execution.sends.length === 0);
        return result.barrier?.name === "execution" && result.barrier.reached && execution.model === 2;
      }
      assert.ok(execution.model <= 3, "only the interrupted model request may be repeated");
      assert.ok(execution.sends.length <= 1);
      if (operation === "execution-restored") return execution.model === 3 && execution.sends.length === 1 && execution.acknowledged > 0;
      assert.equal(execution.model, 3);
      assert.equal(execution.sends.length, 1);
      assert.ok(delivery.model <= 1 && delivery.sends.length <= (operation === "delivery-restored" ? 3 : 2));
      assert.deepEqual(delivery.sends, ["A".repeat(4000), "B".repeat(4000), "Delivery tail."].slice(0, delivery.sends.length));
      if (operation === "delivery-barrier") return result.barrier?.name === "delivery" && result.barrier.reached && delivery.sends.length === 2;
      if (operation === "delivery-blocked") return delivery.model === 1 && delivery.sends.length === 2 && delivery.acknowledged > 0;
      return delivery.model === 1 && delivery.sends.length === 3 && delivery.acknowledged > 1;
    }, 60_000);
  } else if (["execution-pending", "execution-sent", "delivery-sending", "delivery-uncertain", "delivery-reconcile", "delivery-sent"].includes(operation)) {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync("/data/inbox.sqlite", { readOnly: true });
    try {
      const execution = operation.startsWith("execution");
      const id = execution ? "telegram:900001:711" : "telegram:900001:712";
      const row = db.prepare("SELECT requestId, status, reply FROM inbox WHERE requestId = ?").get(id);
      assert.ok(row);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE requestId = ?").get(id).n, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM failures").get().n, 0);
      assert.equal(db.prepare("SELECT offset FROM checkpoint WHERE id = 1").get().offset, execution ? 712 : 713);
      assert.ok((await stat("/data/agent.sqlite")).size > 0);
      if (execution) {
        assert.equal(await readFile("/data/workspace/topology-execution-marker", "utf8"), "completed\n", "completed external side effect must not repeat");
        assert.equal(row.status, operation === "execution-pending" ? "pending" : "sent");
        assert.equal(row.reply, operation === "execution-pending" ? null : "Execution recovered reply.");
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE requestId = ?").get(id).n, operation === "execution-pending" ? 0 : 1);
      } else {
        const sending = operation === "delivery-sending";
        const sent = operation === "delivery-sent";
        assert.equal(row.status, sending ? "ready" : sent ? "sent" : "uncertain");
        assert.equal(row.reply, "A".repeat(4000) + "B".repeat(4000) + "Delivery tail.");
        const parts = db.prepare("SELECT part, status, text, messageId, error FROM deliveries WHERE requestId = ? ORDER BY part").all(id);
        assert.deepEqual(parts.map(({ part, status, text, error }) => ({ part, status, text, error })), [
          { part: 0, status: "sent", text: "A".repeat(4000), error: null },
          { part: 1, status: sending ? "sending" : sent ? "sent" : "uncertain", text: "B".repeat(4000), error: sending || sent ? null : "PROCESS_INTERRUPTED" },
          { part: 2, status: sent ? "sent" : "pending", text: "Delivery tail.", error: null },
        ]);
        assert.ok(parts[0].messageId);
        assert.equal(parts[1].messageId, null, "operator confirmation must not invent a Telegram message ID");
        if (!sent) assert.equal(parts[2].messageId, null);
      }
    } finally { db.close(); }
    if (operation === "delivery-reconcile") {
      const cli = (...args) => execFileSync(process.execPath, ["/app/dist/src/deliveries.js", ...args], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
      const listing = JSON.parse(cli("list"));
      assert.equal(listing.failures.length, 0);
      assert.deepEqual(listing.blocked.map(({ requestId, part, status, error }) => ({ requestId, part, status, error })),
        [{ requestId: "telegram:900001:712", part: 1, status: "uncertain", error: "PROCESS_INTERRUPTED" }]);
      cli("sent", "telegram:900001:712", "1");
    }
  } else if (operation === "release" || operation === "replay") {
    stage = `${operation}:control`;
    try {
      await control({ operation });
    } catch (error) {
      stage = `${operation}:control-${error?.cause?.code ?? error?.code ?? error?.name ?? "failed"}`;
      throw error;
    }
  } else if (operation === "business" || operation === "restored") {
    const minimum = Number(process.argv[3] ?? 1);
    await waitFor(async () => {
      const result = await control();
      assert.equal(result.protocolFailures, 0);
      assert.ok(result.model <= 1 && result.sendMessage <= 1, "completed request executed or delivered again");
      return result.getMe >= minimum && result.getWebhookInfo >= minimum && result.getUpdates >= minimum
        && result.model === 1 && result.sendMessage === 1 && result.acknowledged >= minimum;
    }, 60_000);
  } else if (operation === "ipv6-inbound-listen") {
    assert.equal(process.getuid(), 0);
    const server = net.createServer((socket) => {
      socket.setTimeout(1000, () => socket.destroy());
      socket.on("data", (data) => { if (data.toString() === "stop") server.close(); socket.end(); });
    });
    const timer = setTimeout(() => server.close(), 30_000);
    server.once("close", () => clearTimeout(timer));
    server.listen({ host: "::", port: 18081, ipv6Only: true });
  } else if (operation === "ipv6-inbound-ready") {
    assert.equal(process.getuid(), 0);
    const address = Object.values(networkInterfaces()).flat().find((entry) => entry.family === "IPv6"
      && entry.address.startsWith("fd82:6173:7465:") && !entry.internal)?.address;
    assert.ok(address);
    await waitFor(async () => await connected(address, 18081) === true, 5000);
    console.info(address);
  } else if (operation === "ipv6-inbound-stop") {
    assert.equal(process.getuid(), 0);
    const socket = net.connect({ host: "::1", port: 18081 });
    socket.setTimeout(1000, () => socket.destroy());
    socket.once("connect", () => socket.end("stop"));
    socket.on("error", () => { process.exitCode = 1; });
  } else if (operation === "ipv6-inbound") {
    assert.equal(await connected("fd82:6173:7465::2", 443), true);
    const result = await control({ operation, host: process.argv[3] });
    assert.equal(result.result, "timeout", "inbound denial requires a live listener and working route");
  } else if (["root-ipv6", "app-ipv6", "router-ipv6"].includes(operation)) {
    const root = operation === "root-ipv6";
    assert.equal(process.getuid(), root ? 0 : operation === "router-ipv6" ? 1001 : 1000);
    const result = await connected("fd82:6173:7465::2", 443);
    stage = root ? "root-ipv6:live-positive-control" : `${operation}:uid-deny`;
    if (typeof result === "string" && /^[A-Z_]+$/u.test(result)) stage += `:${result.toLowerCase()}`;
    // A routing failure/refusal is not evidence of firewall isolation. The same
    // final app container must first reach this real IPv6 listener as uid 0.
    assert.equal(result, root);
  } else if (operation === "root-network" || operation === "app-network") {
    const root = operation === "root-network";
    assert.equal(process.getuid(), root ? 0 : 1000);
    // Every private target and UDP/DNS service has a successful uid 0 control in this exact namespace.
    for (const port of [443, 14321, 14322]) assert.equal(await connected("172.30.82.2", port), root);
    assert.equal(await udpReply("172.30.82.2", 18053, Buffer.from("ci-udp")), root);
    assert.equal(await dnsReply(), root);
    const publicResult = await connected("1.1.1.1", 443, 2000);
    assert.equal(publicResult, root, "public TCP control or UID isolation failed");
    if (!root) {
      const proxy = new URL(process.env.HTTPS_PROXY);
      const authorization = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
      assert.equal(await proxyStatus(14323, "CONNECT", "api.deepseek.com:443", authorization), 200);
      assert.equal(await proxyStatus(14323, "GET", "http://api.deepseek.com:443/chat/completions", authorization), 400);
      assert.equal(await proxyStatus(14323, "CONNECT", "unknown.topology.test:443", authorization), 403);
      assert.equal(await proxyStatus(14323, "CONNECT", "api.deepseek.com:443"), 407);
    }
  } else if (operation === "persistent-files") {
    for (const path of ["/data/inbox.sqlite", "/data/agent.sqlite"]) assert.ok((await stat(path)).size > 0);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync("/data/inbox.sqlite", { readOnly: true });
    assert.deepEqual(db.prepare("SELECT status, reply FROM inbox").all().map((row) => ({ ...row })), [{ status: "sent", reply: "Topology acceptance reply." }]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM failures").get().n, 0);
    db.close();
  } else {
    throw new Error("unknown operation");
  }
} catch (error) {
  // Assertion values, errors, API responses and credentials must never enter CI diagnostics.
  const line = error?.stack?.match(/topology-probe\.mjs:(\d+):/u)?.[1];
  console.error(`Topology probe failed: ${stage}${line ? ` (line ${line})` : ""}`);
  process.exitCode = 1;
}

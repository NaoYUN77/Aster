import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const credentials = JSON.parse(await readFile("/fixtures/credentials.json", "utf8"));
const operation = process.argv[2];
const secrets = [credentials.clientSecret, credentials.accessToken, credentials.value, credentials.errorSecret, credentials.ownerPassword];
function noSecrets(text) {
  for (const value of secrets) {
    for (const encoded of [value, encodeURIComponent(value), Buffer.from(value).toString("base64")]) {
      assert.ok(!text.includes(encoded), "secret appeared in a prohibited API response");
    }
  }
}
async function api(method, path, body, token) {
  const response = await fetch(`http://127.0.0.1:14321${path}`, {
    method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { value = undefined; }
  return { status: response.status, value, text };
}
async function control(body) {
  const response = await fetch("http://127.0.0.1:18080/control", {
    method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  return response.json();
}
async function create(name, owner) {
  return api("POST", "/v1/vaults", { name, credential_store: {
    kind: "infisical", config: { project_id: "ci-project", environment: "ci", secret_path: "/ci" }, poll_interval_seconds: 10,
  } }, owner);
}

// Real CONNECT and broker-issued TLS, without following redirects or printing
// any peer response. Deliberately preserve the raw request path for negatives.
async function proxied(token, method, path, headers = {}) {
  const ca = await api("GET", "/v1/mitm/ca.pem");
  assert.equal(ca.status, 200, "proxy CA unavailable");
  const socket = net.connect(14322, "127.0.0.1");
  socket.setTimeout(10_000, () => socket.destroy(new Error("proxy timeout")));
  await once(socket, "connect");
  socket.write("CONNECT infisical.ci.test:18888 HTTP/1.1\r\nHost: infisical.ci.test:18888\r\n" +
    `Proxy-Authorization: Basic ${Buffer.from(token).toString("base64")}\r\n\r\n`);
  let response = "";
  while (!response.includes("\r\n\r\n")) response += (await once(socket, "data"))[0].toString();
  assert.match(response, /^HTTP\/1\.1 200 /, "CONNECT rejected");
  const secure = tls.connect({ socket, ca: ca.text, servername: "infisical.ci.test" });
  await once(secure, "secureConnect");
  secure.write(`${method} ${path} HTTP/1.1\r\nHost: infisical.ci.test:18888\r\nConnection: close\r\nContent-Length: 0\r\n` +
    Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("") + "\r\n");
  const chunks = [];
  for await (const chunk of secure) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  noSecrets(text);
  return Number(/^HTTP\/1\.1 (\d{3}) /.exec(text)?.[1]);
}

try {
  if (operation === "ready") {
    const deadline = Date.now() + 35_000;
    while (true) {
      try {
        const result = await api("GET", "/health");
        if (result.status === 200) { noSecrets(result.text); break; }
      } catch {}
      assert.ok(Date.now() < deadline, "broker readiness deadline exceeded");
      await delay(200);
    }
  } else if (operation === "control") {
    await control(JSON.parse(process.argv[3]));
  } else if (operation === "bootstrap") {
    const result = await api("POST", "/v1/auth/register", { email: "ci@example.test", password: credentials.ownerPassword });
    assert.equal(result.status, 201, "owner bootstrap status");
    assert.ok(result.value?.token, "missing ephemeral owner token");
    await writeFile("/tmp/ci-owner", result.value.token, { mode: 0o600 });
  } else if (operation === "baseline") {
    const owner = await readFile("/tmp/ci-owner", "utf8");
    assert.equal((await create("ci-vault", owner)).status, 201, "initial HTTPS sync status");
    const reveal = await api("GET", "/v1/credentials?vault=ci-vault&reveal=true", undefined, owner);
    assert.equal(reveal.status, 200, "authorized reveal status");
    assert.ok(reveal.text.includes(credentials.value), "synthetic secret not synchronized");
    const agent = await api("POST", "/v1/agents", { name: "ci-app", role: "no-access", vaults: [{ vault_name: "ci-vault", vault_role: "proxy" }] }, owner);
    assert.equal(agent.status, 201, "proxy identity status");
    for (const [method, path, body, expected] of [
      ["GET", "/v1/credentials?vault=ci-vault&reveal=true", undefined, 403],
      ["PUT", "/v1/vaults/ci-vault/services", { services: [] }, 403],
      ["POST", "/v1/vaults", { name: "escalate", credential_store: { kind: "infisical", config: { project_id: "ci-project", environment: "ci", secret_path: "/ci" } } }, 403],
    ]) {
      const result = await api(method, path, body, agent.value.av_agent_token);
      assert.equal(result.status, expected, "proxy administrative operation status");
      noSecrets(result.text);
    }
    const anonymous = await api("GET", "/v1/credentials?vault=ci-vault&reveal=true");
    assert.equal(anonymous.status, 401, "anonymous reveal status");
    noSecrets(anonymous.text);
  } else if (operation === "api-default-deny") {
    const owner = await readFile("/tmp/ci-owner", "utf8");
    assert.equal((await create("ci-vault", owner)).status, 201, "deny-all vault creation");
    assert.equal((await api("PUT", "/v1/vaults/ci-vault/services", { services: [{
      name: "ci-operation", host: "infisical.ci.test:18888/*", auth: { type: "bearer", token: "CI_KEY" },
    }] }, owner)).status, 200, "deny-all injection setup");
    const agent = await api("POST", "/v1/agents", { name: "ci-deny", role: "no-access",
      vaults: [{ vault_name: "ci-vault", vault_role: "proxy" }] }, owner);
    assert.equal(agent.status, 201, "deny-all proxy identity");
    assert.equal(await proxied(agent.value.av_agent_token, "POST", "/operations/infer"), 403, "default deny failed");
    assert.equal((await control()).operations, 0, "default deny reached upstream");
  } else if (operation === "api-policy") {
    const owner = await readFile("/tmp/ci-owner", "utf8");
    assert.equal((await create("ci-second", owner)).status, 201, "second vault creation");
    for (const vault of ["ci-vault", "ci-second"]) {
      const rules = await api("PUT", `/v1/vaults/${vault}/services`, { services: [{
        name: "ci-operation", host: "infisical.ci.test:18888/*", auth: { type: "bearer", token: "CI_KEY" },
      }] }, owner);
      assert.equal(rules.status, 200, "operation injection setup");
    }
    for (const vaults of [["ci-vault"], ["ci-vault", "ci-second"]]) {
      const agent = await api("POST", "/v1/agents", { name: `ci-policy-${vaults.length}`, role: "no-access",
        vaults: vaults.map(vault_name => ({ vault_name, vault_role: "proxy" })) }, owner);
      assert.equal(agent.status, 201, "policy proxy identity");
      for (const vault of vaults) {
        // Router uses the same authenticated agent-token:vault-name Basic form.
        const token = vaults.length === 1 ? agent.value.av_agent_token : `${agent.value.av_agent_token}:${vault}`;
        for (const [method, path, headers, expected] of [
          ["POST", "/operations/infer", {}, vault === "ci-vault" ? 200 : 403],
          ["GET", "/operations/status", {}, vault === "ci-second" ? 200 : 403],
          ["GET", "/operations/infer", {}, 403],
          ["POST", "/operations/export", {}, 403],
          ["POST", "/operations/tokens", {}, 403],
          ["POST", "/operations/echo", {}, 403],
          ["POST", "/operations/%69nfer", {}, 403],
          ["POST", "/operations/infer/", {}, 403],
          ["POST", "/operations/infer", { "X-HTTP-Method-Override": "DELETE" }, 403],
        ]) {
          const before = (await control()).operations;
          assert.equal(await proxied(token, method, path, headers), expected, "decrypted operation policy");
          assert.equal((await control()).operations - before, expected === 200 ? 1 : 0, "denied operation reached upstream");
        }
      }
    }
  } else if (operation === "sync-error") {
    const owner = await readFile("/tmp/ci-owner", "utf8");
    const status = Number(process.argv[3]);
    await control({ operation: "secrets", status });
    const result = await api("POST", "/v1/vaults/ci-vault/sync", {}, owner);
    assert.equal(result.status, 502, "manual sync failure status");
    noSecrets(result.text);
    const initial = await create(`ci-failed-${status}`, owner);
    assert.equal(initial.status, 502, "initial sync failure status");
    noSecrets(initial.text);
    const health = await api("GET", "/health");
    noSecrets(health.text);
    const context = await api("GET", "/v1/vaults/ci-vault/context", undefined, owner);
    assert.equal(context.status, 200, "vault health context status");
    noSecrets(context.text);
    if (status === 422) {
      const before = (await control()).secrets;
      const deadline = Date.now() + 25_000;
      while ((await control()).secrets <= before) {
        assert.ok(Date.now() < deadline, "periodic sync did not execute");
        await delay(250);
      }
    }
  } else if (operation === "blocked" || operation === "blocked-stats") {
    if (operation === "blocked") {
      const owner = await readFile("/tmp/ci-owner", "utf8");
      const result = await create("ci-blocked", owner);
      assert.ok([502, 503].includes(result.status), "unsafe upstream accepted");
      noSecrets(result.text);
    }
    const stats = await control();
    assert.equal(stats.redirected, 0, "client followed a forbidden redirect");
    const expected = process.argv[3];
    if (expected === "login") assert.ok(stats.login > 0, "login redirect/error was not exercised");
    if (expected === "secrets") assert.ok(stats.authenticated > 0, "authenticated secret request was not exercised");
    if (expected === "none") assert.equal(stats.login + stats.secrets, 0, "invalid origin/TLS sent credentials");
  } else {
    throw new Error("unknown probe operation");
  }
} catch {
  // Do not emit assertions' actual values or SDK/API response bodies.
  console.error(`Vault probe failed: ${operation}`);
  process.exitCode = 1;
}

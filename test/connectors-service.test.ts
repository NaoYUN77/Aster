import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConnectorsConfig } from "../src/config.js";
import { encryptCredential } from "../src/connectors/crypto.js";
import type { EventHub } from "../src/http/events.js";
import { ConnectorOAuth } from "../src/connectors/oauth.js";
import { FileSecretProvider } from "../src/connectors/secrets.js";
import { ConnectorService } from "../src/connectors/service.js";
import { ConnectorStore, type ConnectorConnection } from "../src/connectors/store.js";

const KEY = "22".repeat(32);
const NOW = Date.parse("2026-11-18T00:00:00.000Z");

async function setup(fetchImpl: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), "aster-connector-service-"));
  const secretDir = join(directory, "secrets");
  await mkdir(secretDir, { recursive: true });
  await writeFile(join(secretDir, "credential_master_key"), KEY);
  await writeFile(join(secretDir, "github_client_id"), "github-client");
  await writeFile(join(secretDir, "github_client_secret"), "github-secret");
  await writeFile(join(secretDir, "google_client_id"), "google-client");
  await writeFile(join(secretDir, "google_client_secret"), "google-secret");
  const config = readConnectorsConfig({
    ASTER_CONNECTOR_SECRET_DIR: secretDir,
    CONNECTOR_OAUTH_REDIRECT_BASE: "https://aster.example",
    CONNECTOR_STDIO_ALLOWLIST: "node,/usr/bin/echo",
  });
  const store = new ConnectorStore(join(directory, "connectors.sqlite"), { now: () => new Date(NOW) });
  const oauth = new ConnectorOAuth({
    store,
    secrets: new FileSecretProvider(secretDir),
    config,
    fetch: fetchImpl,
    now: () => new Date(NOW),
  });
  const events: { event: string; data: unknown }[] = [];
  const hub = {
    broadcast(event: string, data: unknown) { events.push({ event, data }); },
  } as unknown as EventHub;
  const service = new ConnectorService({
    store, oauth, config, ownerId: "owner", dataDir: directory, hub, fetch: fetchImpl, log: () => {},
  });
  return {
    directory, store, service, events,
    connect(connection: ConnectorConnection, token: string) {
      store.saveCredential(connection.id, {
        ciphertext: encryptCredential(Buffer.from(KEY, "hex"), JSON.stringify({
          access_token: token,
          expires_at: NOW + 3_600_000,
        }), `connection:${connection.id}:oauth`),
        expiresAt: new Date(NOW + 3_600_000).toISOString(),
      });
      store.setConnected(connection.id, { accountLabel: "octocat", scopes: ["read:user"] });
    },
    async close() {
      service.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("GitHub and Gmail read-only calls inject the token and never return it", async () => {
  const requests: { url: string; authorization: string }[] = [];
  const fake = (async (input, init) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") ?? "" });
    if (url.startsWith("https://api.github.com/user/repos")) {
      return json([{
        full_name: "octocat/hello", name: "hello", description: "demo", language: "TypeScript",
        html_url: "https://github.com/octocat/hello", updated_at: "2026-11-17T00:00:00Z",
      }]);
    }
    if (url.includes("/repos/octocat/hello/issues?")) {
      return json([{
        number: 7, title: "Bug", state: "open", user: { login: "alice" }, labels: [{ name: "bug" }],
        comments: 2, html_url: "https://github.com/octocat/hello/issues/7",
        created_at: "2026-11-16T00:00:00Z", updated_at: "2026-11-17T00:00:00Z",
      }]);
    }
    if (url.includes("/messages/") && url.includes("format=metadata")) {
      return json({ payload: { headers: [
        { name: "Subject", value: "Hello" }, { name: "From", value: "a@example.test" },
      ] }, snippet: "snippet" });
    }
    if (url.includes("/messages?maxResults=")) return json({ messages: [{ id: "m1", threadId: "t1" }] });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const env = await setup(fake);
  try {
    const github = env.store.create({ ownerId: "owner", provider: "github", slug: "work" }).connection;
    env.connect(github, "github-token-value");
    const binding = { connectionId: "", tool: "", requestId: "req-1", ownerId: "owner" };
    const repos = await env.service.listRepositories({}, binding);
    assert.equal(repos[0]?.fullName, "octocat/hello");
    const issues = await env.service.listIssues({ repo: "octocat/hello" }, binding);
    assert.equal(issues[0]?.title, "Bug");
    assert.equal(JSON.stringify([repos, issues]).includes("github-token-value"), false);
    assert.ok(requests.every((request) => request.authorization === "Bearer github-token-value"));

    const gmail = env.store.create({ ownerId: "owner", provider: "gmail", slug: "mail" }).connection;
    env.connect(gmail, "gmail-token-value");
    const hits = await env.service.searchMessages({ query: "from:alice" }, binding);
    assert.equal(hits[0]?.id, "m1");
    assert.equal(hits[0]?.subject, "Hello");
    assert.equal(JSON.stringify(hits).includes("gmail-token-value"), false);
  } finally {
    await env.close();
  }
});

test("a pending connection asks the client to authorize and returns a safe code", async () => {
  const env = await setup((async () => json({}, 500)) as typeof fetch);
  try {
    env.store.create({ ownerId: "owner", provider: "github", slug: "work" });
    await assert.rejects(
      env.service.listRepositories({}, { connectionId: "", tool: "", requestId: "req-2", ownerId: "owner" }),
      { code: "CONNECTOR_NOT_CONNECTED" },
    );
    assert.deepEqual(env.events.at(-1), {
      event: "credential.request",
      data: {
        connectionId: env.store.get("owner", "work")!.id,
        provider: "github",
        slug: "work",
        tool: "connector_github_list_repositories",
        requestId: "req-2",
      },
    });
  } finally {
    await env.close();
  }
});

test("401 from the provider marks the connection and emits a reauthorization request", async () => {
  const env = await setup((async () => json({ message: "Bad credentials" }, 401)) as typeof fetch);
  try {
    const connection = env.store.create({ ownerId: "owner", provider: "github", slug: "work" }).connection;
    env.connect(connection, "expired-token");
    await assert.rejects(
      env.service.listRepositories({}, { connectionId: "", tool: "", requestId: "req-3", ownerId: "owner" }),
      { code: "CONNECTOR_AUTH_EXPIRED" },
    );
    assert.equal(env.store.get("owner", "work")?.status, "error");
    assert.equal(env.events.at(-1)?.event, "credential.request");
  } finally {
    await env.close();
  }
});

test("multiple connections require an explicit slug", async () => {
  const env = await setup((async () => json([])) as typeof fetch);
  try {
    const first = env.store.create({ ownerId: "owner", provider: "github", slug: "one" }).connection;
    env.store.create({ ownerId: "owner", provider: "github", slug: "two" });
    env.connect(first, "token");
    const binding = { connectionId: "", tool: "", requestId: "req-4", ownerId: "owner" };
    await assert.rejects(env.service.listRepositories({}, binding), { code: "CONNECTOR_INVALID_INPUT" });
    assert.deepEqual(await env.service.listRepositories({ connection: "one" }, binding), []);
  } finally {
    await env.close();
  }
});

test("local stdio connectors are allowlisted, private and never inherit the host environment", async () => {
  const env = await setup((async () => json({}, 500)) as typeof fetch);
  try {
    assert.throws(
      () => env.service.create({ provider: "mcp_stdio", slug: "shell", command: "/bin/sh" }),
      { code: "CONNECTOR_STDIO_NOT_ALLOWED" },
    );
    assert.throws(
      () => env.service.create({ provider: "mcp_stdio", slug: "traversal", command: "../../bin/node" }),
      { code: "CONNECTOR_STDIO_NOT_ALLOWED" },
    );
    assert.throws(
      () => env.service.create({ provider: "mcp_stdio", slug: "noargs", command: "node", args: "server.js" }),
      { code: "CONNECTOR_INVALID_INPUT" },
    );
    const created = env.service.create({
      provider: "mcp_stdio", slug: "local", command: "node", args: ["server.js", "--read-only"],
    });
    assert.equal(created.created, true);
    assert.equal(created.connection.status, "connected");
    const again = env.service.create({ provider: "mcp_stdio", slug: "local", command: "node" });
    assert.equal(again.created, false);

    const servers = await env.service.stdioServers();
    assert.equal(servers.length, 1);
    assert.equal(servers[0]?.name, "conn_local");
    assert.deepEqual(servers[0]?.args, ["server.js", "--read-only"]);
    assert.equal(servers[0]?.transport, "stdio");
    assert.equal(servers[0]?.inheritEnv, false);
    assert.deepEqual(servers[0]?.env, {});
    assert.equal(servers[0]?.cwd, join(env.directory, "connectors", "stdio", "local"));
  } finally {
    await env.close();
  }
});

test("disconnect removes the credential, revokes the connection and disables its tools", async () => {
  const calls: string[] = [];
  const fake = (async (input) => {
    calls.push(String(input));
    throw new Error(`unexpected upstream call: ${String(input)}`);
  }) as typeof fetch;
  const env = await setup(fake);
  try {
    const github = env.store.create({ ownerId: "owner", provider: "github", slug: "work" }).connection;
    env.connect(github, "github-token-value");
    assert.notEqual(env.store.credential(github.id), undefined);

    env.service.disconnect("work");
    const revoked = env.store.get("owner", "work")!;
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.lastErrorCode, null);
    assert.equal(env.store.credential(github.id), undefined);
    const changed = env.events.filter((event) => event.event === "connector.changed").at(-1);
    assert.deepEqual((changed?.data as { connection: { status: string; slug: string } }).connection, {
      id: github.id,
      provider: "github",
      slug: "work",
      status: "revoked",
      accountLabel: "octocat",
      scopes: ["read:user"],
    });

    // A disconnected connector refuses tools without calling the provider.
    const binding = { connectionId: "", tool: "", requestId: "req-1", ownerId: "owner" };
    await assert.rejects(env.service.listRepositories({}, binding), { code: "CONNECTOR_NOT_CONNECTED" });
    assert.deepEqual(calls, []);

    // Repeating the disconnect stays a no-op with the same revoked state.
    env.service.disconnect("work");
    assert.equal(env.store.get("owner", "work")?.status, "revoked");

    assert.throws(() => env.service.disconnect("missing"), { code: "CONNECTOR_NOT_FOUND" });
  } finally {
    await env.close();
  }
});

test("a revoked connection can be authorized again and its tools work with the new token", async () => {
  const requests: { url: string; authorization: string }[] = [];
  const fake = (async (input, init) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") ?? "" });
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return json({ access_token: "reauthorized-token", scope: "read:user", token_type: "bearer" });
    }
    if (url === "https://api.github.com/user") return json({ login: "octocat" });
    if (url.startsWith("https://api.github.com/user/repos")) {
      return json([{
        full_name: "octocat/hello", name: "hello", description: "demo", language: "TypeScript",
        html_url: "https://github.com/octocat/hello", updated_at: "2026-11-17T00:00:00Z",
      }]);
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const env = await setup(fake);
  try {
    const github = env.store.create({ ownerId: "owner", provider: "github", slug: "work" }).connection;
    env.connect(github, "old-token");
    env.service.disconnect("work");
    assert.equal(env.store.get("owner", "work")?.status, "revoked");

    const { url } = await env.service.startOAuth("work");
    const state = new URL(url).searchParams.get("state");
    assert.ok(state, "oauth start still issues a state for a revoked row");
    const connected = await env.service.completeOAuth(state, "code-2");
    assert.equal(connected.status, "connected");
    assert.equal(connected.accountLabel, "octocat");

    const binding = { connectionId: "", tool: "", requestId: "req-2", ownerId: "owner" };
    const repos = await env.service.listRepositories({}, binding);
    assert.equal(repos[0]?.fullName, "octocat/hello");
    assert.ok(requests.some((request) => request.url.startsWith("https://api.github.com/user/repos")
      && request.authorization === "Bearer reauthorized-token"));
  } finally {
    await env.close();
  }
});

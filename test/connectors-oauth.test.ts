import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConnectorsConfig } from "../src/config.js";
import { ConnectorOAuth } from "../src/connectors/oauth.js";
import { FileSecretProvider } from "../src/connectors/secrets.js";
import { ConnectorService } from "../src/connectors/service.js";
import { ConnectorStore } from "../src/connectors/store.js";
import { LocalTokenVault } from "../src/connectors/vault.js";

const KEY = "11".repeat(32);

async function setup(options: { readonly omitClientId?: boolean; readonly fetch?: typeof fetch } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "aster-oauth-"));
  const secretDir = join(directory, "secrets");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(secretDir, { recursive: true });
  await writeFile(join(secretDir, "credential_master_key"), KEY);
  if (options.omitClientId !== true) await writeFile(join(secretDir, "github_client_id"), "github-client");
  await writeFile(join(secretDir, "github_client_secret"), "github-secret");
  await writeFile(join(secretDir, "google_client_id"), "google-client");
  await writeFile(join(secretDir, "google_client_secret"), "google-secret");
  let now = new Date("2026-11-18T00:00:00.000Z");
  const config = readConnectorsConfig({
    ASTER_CONNECTOR_SECRET_DIR: secretDir,
    CONNECTOR_OAUTH_REDIRECT_BASE: "https://aster.example",
  });
  const store = new ConnectorStore(join(directory, "connectors.sqlite"), { now: () => now });
  const secrets = new FileSecretProvider(secretDir);
  const oauth = new ConnectorOAuth({
    secrets,
    config,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    now: () => now,
  });
  const vault = new LocalTokenVault({
    store,
    secrets,
    config,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    now: () => now,
  });
  const service = new ConnectorService({
    store, oauth, vault, config, ownerId: "owner", dataDir: directory, now: () => now, log: () => {},
  });
  return {
    directory,
    secretDir,
    store,
    oauth,
    vault,
    service,
    config,
    advance(ms: number) { now = new Date(now.getTime() + ms); },
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

test("GitHub OAuth start uses PKCE and state, and complete stores only ciphertext", async () => {
  const calls: { url: string; authorization: string }[] = [];
  const fake = (async (input, init) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") ?? "" });
    if (url === "https://github.com/login/oauth/access_token") {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("code_verifier")?.length, 43);
      assert.equal(form.get("client_secret"), "github-secret");
      return json({ access_token: "gh-access-token", token_type: "bearer", scope: "read:user" });
    }
    if (url === "https://api.github.com/user") return json({ login: "octocat" });
    return json({ error: "unexpected" }, 500);
  }) as typeof fetch;
  const env = await setup({ fetch: fake });
  try {
    env.store.create({ ownerId: "owner", provider: "github", slug: "work" });
    const started = await env.service.startOAuth("work");
    const url = new URL(started.url);
    assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
    assert.equal(url.searchParams.get("client_id"), "github-client");
    assert.equal(url.searchParams.get("redirect_uri"), "https://aster.example/api/v1/connectors/oauth/callback");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok((url.searchParams.get("code_challenge") ?? "").length >= 40);
    const state = url.searchParams.get("state");
    assert.ok(state !== null);

    const connected = await env.service.completeOAuth(state, "code-1");
    assert.equal(connected.status, "connected");
    assert.equal(connected.accountLabel, "octocat");
    assert.deepEqual(connected.scopes, ["read:user"]);
    const stored = env.store.credential(connected.id);
    assert.ok(stored !== undefined);
    assert.equal(stored.ciphertext.includes("gh-access-token"), false);
    const rawFile = await readFile(join(env.directory, "connectors.sqlite"));
    assert.equal(rawFile.toString("utf8").includes("gh-access-token"), false, "the token is not plaintext in SQLite");
    assert.equal(calls.some((call) => call.url === "https://api.github.com/user" && call.authorization === "Bearer gh-access-token"), true);
    assert.equal(await env.vault.accessToken(env.store.get("owner", "work")!), "gh-access-token");
    await assert.rejects(env.service.completeOAuth(state, "code-1"), { code: "CONNECTOR_OAUTH_STATE_INVALID" });
  } finally {
    await env.close();
  }
});

test("a stored connection still works after reopening the database", async () => {
  const fake = (async (input) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      return json({ access_token: "restart-token", scope: "read:user", expires_in: 3600 });
    }
    if (url === "https://api.github.com/user") return json({ login: "octocat" });
    return json({}, 500);
  }) as typeof fetch;
  const env = await setup({ fetch: fake });
  try {
    env.store.create({ ownerId: "owner", provider: "github", slug: "work" });
    const started = await env.service.startOAuth("work");
    const state = new URL(started.url).searchParams.get("state")!;
    await env.service.completeOAuth(state, "code-1");
    env.store.close();

    const reopened = new ConnectorStore(join(env.directory, "connectors.sqlite"));
    try {
      const vault = new LocalTokenVault({
        store: reopened,
        secrets: new FileSecretProvider(env.secretDir),
        config: env.config,
        fetch: (async () => json({ error: "must not refresh" }, 500)) as typeof fetch,
        // The stored token was issued at NOW; a real clock would make this test expire at 01:00 UTC.
        now: () => new Date("2026-11-18T00:00:00.000Z"),
      });
      const loaded = reopened.get("owner", "work")!;
      assert.equal(loaded.status, "connected");
      assert.equal(await vault.accessToken(loaded), "restart-token");
    } finally {
      reopened.close();
    }
  } finally {
    await env.close();
  }
});

test("an expired access token refreshes and the refreshed token is what goes upstream", async () => {
  let refreshCalls = 0;
  const env = await setup({ fetch: (async (input, init) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "refresh_token") {
        refreshCalls += 1;
        assert.equal(form.get("refresh_token"), "gh-refresh");
        return json({ access_token: "fresh-token", expires_in: 3600 });
      }
      return json({ access_token: "old-token", refresh_token: "gh-refresh", expires_in: 120 });
    }
    if (url === "https://api.github.com/user") return json({ login: "octocat" });
    return json({}, 500);
  }) as typeof fetch });
  try {
    env.store.create({ ownerId: "owner", provider: "github", slug: "work" });
    const started = await env.service.startOAuth("work");
    await env.service.completeOAuth(new URL(started.url).searchParams.get("state")!, "code-1");
    assert.equal(await env.vault.accessToken(env.store.get("owner", "work")!), "old-token");
    env.advance(61_000);
    assert.equal(await env.vault.accessToken(env.store.get("owner", "work")!), "fresh-token");
    assert.equal(refreshCalls, 1);
  } finally {
    await env.close();
  }
});

test("missing client credentials and failed exchanges are safe errors", async () => {
  const missing = await setup({ omitClientId: true });
  try {
    missing.store.create({ ownerId: "owner", provider: "github", slug: "work" });
    await assert.rejects(missing.service.startOAuth("work"), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "CONNECTOR_SECRET_MISSING");
      assert.equal((error as Error).message.includes("github-secret"), false);
      return true;
    });
  } finally {
    await missing.close();
  }

  const failing = await setup({
    fetch: (async (input) => String(input).includes("access_token")
      ? json({ error: "bad_verification_code" }, 400)
      : json({}, 500)) as typeof fetch,
  });
  try {
    failing.store.create({ ownerId: "owner", provider: "github", slug: "work" });
    const started = await failing.service.startOAuth("work");
    await assert.rejects(
      failing.service.completeOAuth(new URL(started.url).searchParams.get("state")!, "bad"),
      { code: "CONNECTOR_OAUTH_EXCHANGE_FAILED" },
    );
    assert.equal(failing.store.get("owner", "work")?.status, "error");
    assert.equal(failing.store.get("owner", "work")?.lastErrorCode, "CONNECTOR_OAUTH_EXCHANGE_FAILED");
  } finally {
    await failing.close();
  }
});

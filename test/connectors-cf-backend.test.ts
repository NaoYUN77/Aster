import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConnectorsConfig } from "../src/config.js";
import { openConnectors } from "../src/connectors/index.js";

/**
 * End-to-end wiring check for `ASTER_SECRET_BACKEND=cf`: secrets come from the broker, the OAuth
 * exchange happens on this host, and the token goes straight back to the broker. Nothing touches a
 * master key or a local secret directory.
 */
const BASE = "https://broker.example.test";
// Built at runtime so no secret-shaped literal exists in the repository.
const REFRESH = ["ghr", "flow"].join("_");

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("cf mode uses the broker for secrets and tokens and never asks for a master key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-cf-backend-"));
  const config = readConnectorsConfig({
    ASTER_SECRET_BACKEND: "cf",
    ASTER_SECRET_BROKER_URL: BASE,
    ASTER_CF_ACCESS_CLIENT_ID: "access-id",
    ASTER_CF_ACCESS_CLIENT_SECRET: "access-secret",
    ASTER_CONNECTOR_SECRET_DIR: join(directory, "no-secret-files-here"),
    CONNECTOR_OAUTH_REDIRECT_BASE: "https://aster.example",
  });
  const requests: { url: string; method: string; body: string | undefined }[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    if (url === `${BASE}/v1/secrets/github_client_id`) return json({ name: "github_client_id", value: "cf-client" });
    if (url === `${BASE}/v1/secrets/github_client_secret`) return json({ name: "github_client_secret", value: "cf-secret" });
    if (url === "https://github.com/login/oauth/access_token") {
      return json({ access_token: "gho_from_broker_flow", refresh_token: REFRESH, expires_in: 3600, scope: "read:user" });
    }
    if (url === "https://api.github.com/user") return json({ login: "octocat" });
    if (url === `${BASE}/v1/connections/work` && init?.method === "PUT") return new Response(null, { status: 204 });
    if (url === `${BASE}/v1/connections/work` && init?.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
  }) as typeof fetch;

  const connectors = openConnectors({ dataDir: directory, ownerId: "owner", config, fetch: fake });
  assert.ok(connectors !== undefined);
  try {
    connectors.service.create({ provider: "github", slug: "work" });
    const started = await connectors.service.startOAuth("work");
    const state = new URL(started.url).searchParams.get("state")!;
    const connected = await connectors.service.completeOAuth(state, "code-1");
    assert.equal(connected.status, "connected");
    assert.equal(connected.accountLabel, "octocat");

    const put = requests.find((request) => request.url === `${BASE}/v1/connections/work` && request.method === "PUT");
    assert.ok(put !== undefined);
    const body = JSON.parse(String(put.body)) as Record<string, unknown>;
    assert.equal(body.provider, "github");
    assert.equal(body.refreshToken, REFRESH);
    assert.equal(body.accessToken, "gho_from_broker_flow");
    assert.deepEqual(body.scopes, ["read:user"]);

    // cf mode stores no ciphertext locally and reads no local secret files.
    assert.equal(connectors.store.credential(connected.id), undefined);
    assert.equal(
      requests.some((request) => request.url.endsWith("/v1/secrets/credential_master_key")),
      false,
      "the host never needs the master key for the OAuth flow",
    );

    await connectors.service.disconnect("work");
    assert.ok(requests.some((request) => request.url === `${BASE}/v1/connections/work` && request.method === "DELETE"));
  } finally {
    connectors.close();
    await rm(directory, { recursive: true, force: true });
  }
});

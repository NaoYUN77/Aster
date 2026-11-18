import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Runs the real Worker under `wrangler dev --local` (workerd + SQLite Durable Object) and drives
 * the HTTP API. All credentials below are generated fake values; nothing reaches a network
 * provider because the token endpoint is only called while its cached access token is still valid.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url).href);
const WRANGLER = join(ROOT, "node_modules/wrangler/bin/wrangler.js");
const STARTUP_TIMEOUT_MS = 120_000;

type Spawned = { child: ChildProcess; output: () => string };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function startWrangler(port: number): Spawned {
  let buffer = "";
  const child = spawn(process.execPath, [
    WRANGLER,
    "dev",
    "--local",
    "--ip", "127.0.0.1",
    "--port", String(port),
    "--infer-origin-from-routes=false",
    "--show-interactive-dev-session=false",
    "--log-level", "error",
    "--var", "BROKER_DEV_BYPASS:1",
    "--var", `credential_master_key:${randomBytes(32).toString("hex")}`,
    "--var", "github_client_id:test-github-client-id",
    "--var", "github_client_secret:test-github-client-secret",
    "--var", "google_client_id:test-google-client-id",
    "--var", "google_client_secret:test-google-client-secret",
    "--var", "exa_api_key:test-exa-key",
    "--var", "ACCESS_TEAM_DOMAIN:test.cloudflareaccess.com",
    "--var", "ACCESS_AUD:test-aud",
  ], {
    cwd: ROOT,
    detached: true,
    env: {
      ...process.env,
      CI: "1",
      WRANGLER_SEND_METRICS: "false",
      NO_COLOR: "1",
      // A local run must never pick up real Cloudflare credentials from the shell.
      CLOUDFLARE_API_TOKEN: "",
      CLOUDFLARE_ACCOUNT_ID: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => { buffer = (buffer + chunk.toString()).slice(-8000); });
  child.stderr?.on("data", (chunk: Buffer) => { buffer = (buffer + chunk.toString()).slice(-8000); });
  return { child, output: () => buffer };
}

async function stopWrangler(spawned: Spawned): Promise<void> {
  const { child } = spawned;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8_000)),
  ]);
  if (!exited) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

async function waitForHealth(base: string, spawned: Spawned): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawned.child.exitCode !== null) {
      throw new Error(`wrangler dev exited early with code ${spawned.child.exitCode}\n${spawned.output()}`);
    }
    try {
      const response = await fetch(`${base}/v1/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`wrangler dev did not become healthy in ${STARTUP_TIMEOUT_MS}ms\n${spawned.output()}`);
}

test("wrangler dev --local serves the broker API end to end", { timeout: 240_000 }, async (t) => {
  if (!existsSync(WRANGLER)) {
    t.skip("wrangler is not installed; run `npm install` in deploy/cloudflare/broker first");
    return;
  }
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const spawned = startWrangler(port);
  const json = async (response: Response): Promise<Record<string, unknown>> =>
    (await response.json()) as Record<string, unknown>;

  try {
    await waitForHealth(base, spawned);

    await t.test("health needs no Access token", async () => {
      const response = await fetch(`${base}/v1/health`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await json(response), { ok: true, version: "1.0.0" });
    });

    await t.test("whitelisted secrets are served, others are 404", async () => {
      const allowed = await fetch(`${base}/v1/secrets/exa_api_key`);
      assert.equal(allowed.status, 200);
      assert.deepEqual(await json(allowed), { name: "exa_api_key", value: "test-exa-key" });

      const denied = await fetch(`${base}/v1/secrets/openai_api_key`);
      assert.equal(denied.status, 404);
      const body = await json(denied);
      assert.deepEqual(body, {
        error: { code: "SECRET_NOT_ALLOWED", message: "secret is not exposed by this broker" },
      });
      assert.ok(!JSON.stringify(body).includes("test-exa-key"));

      const bare = await fetch(`${base}/v1/secrets`);
      assert.equal(bare.status, 404);
      assert.equal((await json(bare)).error instanceof Object, true);
    });

    await t.test("connections start empty and round-trip metadata only", async () => {
      const empty = await fetch(`${base}/v1/connections`);
      assert.equal(empty.status, 200);
      assert.deepEqual(await json(empty), { connections: [] });

      const put = await fetch(`${base}/v1/connections/acme`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "github",
          accountLabel: "octocat",
          scopes: ["repo"],
          refreshToken: "integration-refresh-token",
          accessToken: "integration-access-token",
          expiresAt: "2099-01-01T00:00:00Z",
        }),
      });
      assert.equal(put.status, 204);
      assert.equal(await put.text(), "");

      const listed = await fetch(`${base}/v1/connections`);
      assert.equal(listed.status, 200);
      const text = await listed.text();
      assert.ok(!text.includes("integration-refresh-token"), "refresh token must never be listed");
      assert.ok(!text.includes("integration-access-token"), "access token must never be listed");
      assert.ok(!text.includes("v1."), "ciphertext must never be listed");
      const body = JSON.parse(text) as { connections: Array<Record<string, unknown>> };
      assert.equal(body.connections.length, 1);
      const record = body.connections[0];
      assert.equal(record.slug, "acme");
      assert.equal(record.provider, "github");
      assert.equal(record.accountLabel, "octocat");
      assert.deepEqual(record.scopes, ["repo"]);
      assert.equal(record.expiresAt, "2099-01-01T00:00:00.000Z");
      assert.equal(typeof record.updatedAt, "string");
      assert.deepEqual(Object.keys(record).sort(), ["accountLabel", "expiresAt", "provider", "scopes", "slug", "updatedAt"]);
    });

    await t.test("token endpoint returns the cached access token while it is fresh", async () => {
      const response = await fetch(`${base}/v1/connections/acme/token`, { method: "POST" });
      assert.equal(response.status, 200);
      assert.deepEqual(await json(response), {
        accessToken: "integration-access-token",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    });

    await t.test("a github-shaped connection without refreshToken returns its stored access token", async () => {
      const put = await fetch(`${base}/v1/connections/github-only`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "github",
          accountLabel: "octocat",
          scopes: [],
          accessToken: "github-access-only-token",
        }),
      });
      assert.equal(put.status, 204);
      const response = await fetch(`${base}/v1/connections/github-only/token`, { method: "POST" });
      assert.equal(response.status, 200);
      assert.deepEqual(await json(response), { accessToken: "github-access-only-token", expiresAt: null });
      const deleted = await fetch(`${base}/v1/connections/github-only`, { method: "DELETE" });
      assert.equal(deleted.status, 204);
    });

    await t.test("delete removes the connection and token lookups become 404", async () => {
      const deleted = await fetch(`${base}/v1/connections/acme`, { method: "DELETE" });
      assert.equal(deleted.status, 204);
      assert.deepEqual(await json(await fetch(`${base}/v1/connections`)), { connections: [] });

      const missing = await fetch(`${base}/v1/connections/acme/token`, { method: "POST" });
      assert.equal(missing.status, 404);
      assert.equal(((await json(missing)) as { error: { code: string } }).error.code, "CONNECTOR_NOT_FOUND");
    });

    await t.test("validation failures use the error envelope", async () => {
      const cases: Array<{ path: string; method: string; body?: unknown; status: number; code: string }> = [
        { path: "/v1/connections/ACME", method: "PUT", body: {}, status: 400, code: "INVALID_SLUG" },
        { path: "/v1/connections/acme", method: "PUT", body: "{not json", status: 400, code: "INVALID_BODY" },
        {
          path: "/v1/connections/acme",
          method: "PUT",
          body: { provider: "google", accountLabel: "x", scopes: [], refreshToken: "r" },
          status: 400,
          code: "INVALID_PROVIDER",
        },
        { path: "/v1/connections", method: "POST", status: 405, code: "METHOD_NOT_ALLOWED" },
        { path: "/v1/nope", method: "GET", status: 404, code: "NOT_FOUND" },
      ];
      for (const item of cases) {
        const response = await fetch(`${base}${item.path}`, {
          method: item.method,
          ...(item.body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: typeof item.body === "string" ? item.body : JSON.stringify(item.body) }),
        });
        assert.equal(response.status, item.status, `${item.method} ${item.path}`);
        const body = (await response.json()) as { error: { code: string; message: string } };
        assert.equal(body.error.code, item.code);
        assert.equal(typeof body.error.message, "string");
      }
    });
  } finally {
    await stopWrangler(spawned);
  }
});

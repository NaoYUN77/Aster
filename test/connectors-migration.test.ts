import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrokerClient } from "../src/connectors/broker-client.js";
import { encryptCredential } from "../src/connectors/crypto.js";
import { migrateLocalCredentials } from "../src/connectors/migrate.js";
import { FileSecretProvider } from "../src/connectors/secrets.js";
import { ConnectorStore } from "../src/connectors/store.js";
import { BrokerTokenVault } from "../src/connectors/vault.js";

const KEY = "33".repeat(32);
const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const BASE = "https://broker.example.test";

async function setup(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const directory = await mkdtemp(join(tmpdir(), "aster-migrate-"));
  const secretDir = join(directory, "secrets");
  await mkdir(secretDir, { recursive: true });
  await writeFile(join(secretDir, "credential_master_key"), KEY);
  const store = new ConnectorStore(join(directory, "connectors.sqlite"), { now: () => new Date(NOW) });
  const calls: { url: string; method: string; body: string | undefined }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    return handler(String(input), init ?? {});
  }) as typeof fetch;
  const vault = new BrokerTokenVault({
    client: new BrokerClient({
      baseUrl: BASE,
      accessClientId: "access-client-id",
      accessClientSecret: "access-client-secret",
      timeoutMs: 5_000,
      fetch: fetchImpl,
    }),
    now: () => NOW,
  });
  return {
    directory,
    store,
    vault,
    calls,
    secrets: new FileSecretProvider(secretDir),
    async close() {
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function localToken(connectionId: string, token: object): string {
  return encryptCredential(Buffer.from(KEY, "hex"), JSON.stringify(token), `connection:${connectionId}:oauth`);
}

test("migration copies a local ciphertext to the broker and then clears it locally", async () => {
  const env = await setup(() => new Response(null, { status: 204 }));
  try {
    const { connection } = env.store.create({ ownerId: "owner", provider: "github", slug: "work" });
    env.store.setConnected(connection.id, { accountLabel: "octocat", scopes: ["read:user"] });
    env.store.saveCredential(connection.id, {
      ciphertext: localToken(connection.id, {
        access_token: "gho_local_access",
        refresh_token: "ghr_local_refresh",
        expires_at: NOW + 3_600_000,
      }),
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
    });

    const result = await migrateLocalCredentials({ store: env.store, vault: env.vault, secrets: env.secrets });
    assert.deepEqual(result, { migrated: 1, total: 1 });
    assert.equal(env.calls.length, 1);
    assert.equal(env.calls[0]!.method, "PUT");
    assert.equal(env.calls[0]!.url, `${BASE}/v1/connections/work`);
    assert.deepEqual(JSON.parse(env.calls[0]!.body!), {
      provider: "github",
      accountLabel: "octocat",
      scopes: ["read:user"],
      refreshToken: "ghr_local_refresh",
      accessToken: "gho_local_access",
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
    });
    assert.equal(env.store.credential(connection.id), undefined, "the local ciphertext is gone after a successful copy");
    assert.equal(env.store.get("owner", "work")?.status, "connected");
  } finally {
    await env.close();
  }
});

test("a broker failure keeps the local credential and reports only counts", async () => {
  const env = await setup(() => new Response("broker said no", { status: 500 }));
  try {
    const { connection } = env.store.create({ ownerId: "owner", provider: "github", slug: "work" });
    env.store.saveCredential(connection.id, {
      ciphertext: localToken(connection.id, {
        access_token: "gho_keep",
        refresh_token: "ghr_keep",
        expires_at: NOW + 3_600_000,
      }),
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
    });

    await assert.rejects(
      migrateLocalCredentials({ store: env.store, vault: env.vault, secrets: env.secrets }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "CONNECTOR_UPSTREAM_UNAVAILABLE");
        assert.match((error as Error).message, /0 of 1/);
        const text = `${(error as Error).message} ${JSON.stringify(error)}`;
        assert.equal(text.includes("gho_keep"), false);
        assert.equal(text.includes("ghr_keep"), false);
        assert.equal(text.includes("broker said no"), false);
        return true;
      },
    );
    assert.notEqual(env.store.credential(connection.id), undefined, "the local credential is untouched");
  } finally {
    await env.close();
  }
});

test("a partial migration clears only the rows that reached the broker", async () => {
  let puts = 0;
  const env = await setup(() => {
    puts += 1;
    return new Response(null, { status: puts === 1 ? 204 : 500 });
  });
  try {
    const first = env.store.create({ ownerId: "owner", provider: "github", slug: "one" }).connection;
    const second = env.store.create({ ownerId: "owner", provider: "github", slug: "two" }).connection;
    for (const connection of [first, second]) {
      env.store.saveCredential(connection.id, {
        ciphertext: localToken(connection.id, {
          access_token: `access-${connection.slug}`,
          refresh_token: `refresh-${connection.slug}`,
          expires_at: NOW + 3_600_000,
        }),
        expiresAt: new Date(NOW + 3_600_000).toISOString(),
      });
    }

    await assert.rejects(
      migrateLocalCredentials({ store: env.store, vault: env.vault, secrets: env.secrets }),
      /1 of 2/,
    );
    assert.equal(env.store.credential(first.id), undefined);
    assert.notEqual(env.store.credential(second.id), undefined);
  } finally {
    await env.close();
  }
});

test("a local token without a refresh token is not migrated", async () => {
  const env = await setup(() => new Response(null, { status: 204 }));
  try {
    const { connection } = env.store.create({ ownerId: "owner", provider: "github", slug: "work" });
    env.store.saveCredential(connection.id, {
      ciphertext: localToken(connection.id, { access_token: "only-access" }),
      expiresAt: null,
    });
    await assert.rejects(
      migrateLocalCredentials({ store: env.store, vault: env.vault, secrets: env.secrets }),
      { code: "CONNECTOR_AUTH_EXPIRED" },
    );
    assert.equal(env.calls.length, 0);
    assert.notEqual(env.store.credential(connection.id), undefined);
  } finally {
    await env.close();
  }
});

test("nothing to migrate does not read the master key", async () => {
  const env = await setup(() => new Response(null, { status: 204 }));
  try {
    const emptySecrets = new FileSecretProvider(join(env.directory, "no-such-directory"));
    const result = await migrateLocalCredentials({ store: env.store, vault: env.vault, secrets: emptySecrets });
    assert.deepEqual(result, { migrated: 0, total: 0 });
    assert.equal(env.calls.length, 0);
  } finally {
    await env.close();
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConnectorStore } from "../src/connectors/store.js";

test("connections are owner-scoped, slug-addressable and survive a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-connector-store-"));
  const path = join(directory, "connectors.sqlite");
  try {
    const first = new ConnectorStore(path);
    const github = first.create({ ownerId: "owner", provider: "github", slug: "work" });
    assert.equal(github.created, true);
    assert.equal(github.connection.status, "pending");
    const replay = first.create({ ownerId: "owner", provider: "github", slug: "work" });
    assert.equal(replay.created, false);
    assert.equal(replay.connection.id, github.connection.id);
    first.create({ ownerId: "owner", provider: "github", slug: "personal" });
    assert.equal(first.create({ ownerId: "someone", provider: "github", slug: "work" }).created, true,
      "the same slug is scoped to one owner");
    assert.throws(() => first.create({ ownerId: "owner", provider: "gmail", slug: "work" }), {
      code: "CONNECTOR_ALREADY_EXISTS",
    });
    first.setConnected(github.connection.id, { accountLabel: "octocat", scopes: ["read:user"] });
    assert.equal(first.get("owner", "work")?.status, "connected");
    first.close();

    const second = new ConnectorStore(path);
    try {
      const loaded = second.get("owner", "work");
      assert.equal(loaded?.accountLabel, "octocat");
      assert.deepEqual(loaded?.scopes, ["read:user"]);
      assert.equal(second.list("owner").length, 2);
      assert.ok(second.definitions().some((definition) => definition.provider === "gmail"));
    } finally {
      second.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OAuth state is one-time and expires; credentials are upserted per connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-connector-sessions-"));
  let now = new Date("2026-11-18T00:00:00.000Z");
  const store = new ConnectorStore(join(directory, "connectors.sqlite"), { now: () => now });
  try {
    const { connection } = store.create({ ownerId: "owner", provider: "gmail", slug: "mail" });
    store.createOAuthSession({
      state: "state-one",
      connectionId: connection.id,
      ownerId: "owner",
      provider: "gmail",
      codeVerifier: "verifier",
      redirectUri: "https://example.test/callback",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    const consumed = store.consumeOAuthSession("state-one");
    assert.equal(consumed?.connectionId, connection.id);
    assert.equal(store.consumeOAuthSession("state-one"), undefined, "a replayed state is refused");
    assert.equal(store.consumeOAuthSession("unknown"), undefined);

    now = new Date(now.getTime() + 61_000);
    store.createOAuthSession({
      state: "state-expired",
      connectionId: connection.id,
      ownerId: "owner",
      provider: "gmail",
      codeVerifier: "verifier",
      redirectUri: "https://example.test/callback",
      scopes: [],
      expiresAt: new Date(now.getTime() - 1_000).toISOString(),
    });
    assert.equal(store.consumeOAuthSession("state-expired"), undefined);

    store.saveCredential(connection.id, { ciphertext: "first", expiresAt: null });
    store.saveCredential(connection.id, { ciphertext: "second", expiresAt: "2027-01-01T00:00:00.000Z" });
    assert.deepEqual(store.credential(connection.id), {
      ciphertext: "second",
      expiresAt: "2027-01-01T00:00:00.000Z",
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { Inbox } from "../src/inbox.js";
import { readConfig } from "../src/config.js";
import type { TextRequest } from "../src/messages.js";
import { createProviderModels, PROVIDERS, requireModel } from "../src/providers.js";
import { splitReply } from "../src/messages.js";

/** One inbound request as the host hands it to the durable inbox. */
const request: TextRequest = {
  requestId: "web:1",
  conversationId: "owner",
  senderId: "owner",
  text: "hello",
};

test("reply chunking preserves text including Unicode surrogate pairs", () => {
  const text = "你".repeat(3999) + "😀" + "a".repeat(8000);
  const chunks = splitReply(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 4000 && chunk.isWellFormed()));
});

test("inbox rejects request-content conflicts without advancing offset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-inbox-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  try {
    inbox.accept(13, request);
    inbox.accept(13, request);
    assert.throws(() => inbox.accept(14, { ...request, text: "different" }));
    assert.equal(inbox.offset, 13);
    // A transport may reset its cursor; the stored checkpoint is still the only authority.
    inbox.accept(2);
    assert.equal(inbox.offset, 2);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart preserves confirmed segments and quarantines only the interrupted send", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-inbox-"));
  const path = join(directory, "inbox.sqlite");
  let inbox = new Inbox(path);
  try {
    inbox.accept(13, request);
    inbox.saveReply(request.requestId, "a".repeat(8001));
    inbox.beginPart(request.requestId, 0);
    inbox.confirmPart(request.requestId, 0, "101");
    inbox.beginPart(request.requestId, 1);
    inbox.close();
    inbox = new Inbox(path);
    inbox.recover();
    assert.equal(inbox.offset, 13);
    assert.equal(inbox.next(), undefined);
    assert.equal(inbox.blocked()[0]?.part, 1);
    assert.equal(inbox.nextPart(request.requestId)?.part, 2);
    inbox.resolvePart(request.requestId, 1, "retry");
    assert.equal(inbox.nextPart(request.requestId)?.part, 1);
    inbox.beginPart(request.requestId, 1);
    inbox.confirmPart(request.requestId, 1, "102");
    inbox.beginPart(request.requestId, 2);
    inbox.confirmPart(request.requestId, 2, "103");
    assert.equal(inbox.next(), undefined);
    assert.equal(inbox.blocked().length, 0);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("inbox keeps identical text under different request IDs as separate requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-duplicate-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  try {
    inbox.accept(1, { ...request, requestId: "web:1" });
    inbox.accept(2, { ...request, requestId: "web:2" });
    const first = inbox.next();
    inbox.saveReply(first!.requestId, "first");
    inbox.beginPart(first!.requestId, 0);
    inbox.confirmPart(first!.requestId, 0, "1");
    assert.equal(inbox.next()?.requestId, "web:2");
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("configuration failures name the missing or invalid setting", () => {
  assert.throws(() => readConfig({}), /Missing configuration: MODEL_PROVIDER/);
  assert.throws(() => readConfig({ MODEL_PROVIDER: "other" }), /MODEL_PROVIDER must be one of: anthropic, openai/);
  assert.throws(() => readConfig({ MODEL_PROVIDER: "openai" }), /Missing configuration: OPENAI_API_KEY/);
  assert.throws(() => readConfig({ MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "key" }), /Missing configuration: MODEL_ID/);
});

test("the provider registry only names providers shipped with pi-ai", () => {
  const builtin = new Set(builtinProviders().map((provider) => provider.id));
  for (const [id, entry] of Object.entries(PROVIDERS)) {
    assert.ok(builtin.has(id), `registered provider ${id} is not built into pi-ai`);
    assert.match(entry.apiKeyEnv, /^[A-Z0-9_]+_API_KEY$/, `${id} must name an API-key variable`);
  }
});

test("a registered provider requires only its own API key", () => {
  const config = readConfig({
    MODEL_PROVIDER: "deepseek",
    MODEL_ID: "deepseek-flash",
    DEEPSEEK_API_KEY: "secret",
  });
  assert.equal(config.provider, "deepseek");
  assert.equal(config.deepseekWebApiKey, undefined);
  assert.equal(readConfig({
    MODEL_PROVIDER: "deepseek",
    MODEL_ID: "deepseek-flash", DEEPSEEK_API_KEY: "secret", DEEPSEEK_WEB_API_KEY: " web-secret ",
  }).deepseekWebApiKey, "web-secret");
  assert.throws(() => readConfig({
    MODEL_PROVIDER: "deepseek", MODEL_ID: "deepseek-flash",
  }), /Missing configuration: DEEPSEEK_API_KEY/);
});

test("an unknown model id is rejected with provider examples", () => {
  assert.throws(
    () => requireModel(createProviderModels("deepseek"), "deepseek", "not-a-model"),
    /Unknown MODEL_ID "not-a-model" for MODEL_PROVIDER=deepseek; examples: /,
  );
});

test("inbox timestamps record when a request arrived, was answered, and was last attempted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-timestamps-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  try {
    inbox.accept(1, request);
    const received = inbox.next();
    assert.ok(received?.receivedAt, "receivedAt is set when the request is accepted");
    assert.equal(received.repliedAt, null);
    assert.ok(!Number.isNaN(Date.parse(received.receivedAt!)));

    inbox.saveReply(request.requestId, "hello back");
    const replied = inbox.next();
    assert.equal(replied?.repliedAt?.startsWith(received.receivedAt!.slice(0, 10)), true);
    assert.ok(Date.parse(replied.repliedAt!) >= Date.parse(received.receivedAt!));

    const part = inbox.nextPart(request.requestId);
    assert.ok(part?.createdAt, "delivery parts carry their creation time");
    assert.ok(part.updatedAt);
    inbox.beginPart(request.requestId, 0);
    const sending = inbox.nextPart(request.requestId);
    assert.equal(sending, undefined, "beginPart moved the part out of pending");
    inbox.failPart(request.requestId, 0, "failed", "WEB_400");
    const [blocked] = inbox.blocked() as { receivedAt: string; updatedAt: string }[];
    assert.ok(blocked?.updatedAt, "the attempt time survives on a blocked delivery");
    assert.ok(Date.parse(blocked.updatedAt) >= Date.parse(part.updatedAt!));
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("opening a database written before timestamps keeps the old rows unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-migrate-"));
  const path = join(directory, "inbox.sqlite");
  // The schema as shipped before timestamps existed, including one already-delivered request and the
  // legacy single-identity table a pre-web build left behind.
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE checkpoint (id INTEGER PRIMARY KEY CHECK (id = 1), offset INTEGER NOT NULL);
    INSERT INTO checkpoint VALUES (1, 5);
    CREATE TABLE identity (id INTEGER PRIMARY KEY CHECK (id = 1), botId TEXT NOT NULL, ownerId TEXT NOT NULL);
    CREATE TABLE inbox (requestId TEXT PRIMARY KEY, conversationId TEXT NOT NULL, senderId TEXT NOT NULL,
      text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reply TEXT);
    CREATE TABLE deliveries (requestId TEXT NOT NULL REFERENCES inbox(requestId) ON DELETE CASCADE,
      part INTEGER NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', messageId TEXT, error TEXT,
      PRIMARY KEY (requestId, part));
    CREATE TABLE failures (requestId TEXT PRIMARY KEY REFERENCES inbox(requestId) ON DELETE CASCADE, code TEXT NOT NULL);
    INSERT INTO inbox VALUES ('web:4', 'owner', 'owner', 'old question', 'sent', 'old answer');
    INSERT INTO deliveries VALUES ('web:4', 0, 'old answer', 'sent', '77', NULL);
  `);
  legacy.close();

  const inbox = new Inbox(path);
  let current: Inbox | undefined = inbox;
  try {
    // Migration must not invent a time for a row the process never saw arrive.
    assert.equal(inbox.offset, 5);
    inbox.accept(6, { ...request, requestId: "web:5" });
    const rows = new DatabaseSync(path);
    try {
      assert.equal(rows.prepare("SELECT receivedAt FROM inbox WHERE requestId = ?").get("web:4")?.["receivedAt"], null);
      assert.equal(rows.prepare("SELECT createdAt FROM deliveries WHERE requestId = ?").get("web:4")?.["createdAt"], null);
      assert.ok(rows.prepare("SELECT receivedAt FROM inbox WHERE requestId = ?").get("web:5")?.["receivedAt"]);
    } finally {
      rows.close();
    }
    // Reopening an already-migrated database must stay a no-op.
    inbox.close();
    current = new Inbox(path);
    assert.equal(current.offset, 6);
  } finally {
    current?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a request is identified by its content, survives a restart, and can be discarded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-inbox-identity-"));
  const path = join(directory, "inbox.sqlite");
  let inbox = new Inbox(path);
  try {
    const request = {
      requestId: "slack:T1:Ev1",
      conversationId: "C0CHANNEL12",
      senderId: "U0OWNER123",
      text: "and then?",
    };
    inbox.accept(1, request);
    // A redelivery of the same request is the same request; changing its content is a different one.
    inbox.accept(1, request);
    assert.throws(() => inbox.accept(1, { ...request, text: "something else" }), /different content/);

    inbox.close();
    inbox = new Inbox(path);
    const stored = inbox.next();
    assert.equal(stored?.requestId, "slack:T1:Ev1");
    assert.equal(stored?.conversationId, "C0CHANNEL12");
    assert.equal(stored?.senderId, "U0OWNER123");
    assert.equal(stored?.text, "and then?");

    // A refused request is forgotten: it is neither delivered nor retried.
    inbox.discard("slack:T1:Ev1");
    assert.equal(inbox.next(), undefined);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("prune retains the newest 100 sent requests and every unfinished request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-prune-"));
  const path = join(directory, "inbox.sqlite");
  const inbox = new Inbox(path);
  try {
    // 120 completed requests: the oldest 20 must be pruned, including their deliveries and diagnostics.
    for (let index = 0; index < 120; index++) {
      const id = `web:${1000 + index}`;
      inbox.accept(1000 + index, { ...request, requestId: id });
      inbox.saveReply(id, `reply ${index}`, index === 0 ? "TEST_FAILURE" : undefined);
      inbox.beginPart(id, 0);
      inbox.confirmPart(id, 0, String(index));
    }
    const unfinished = ["web:5000", "web:5001", "web:5002", "web:5003"];
    inbox.accept(5000, { ...request, requestId: unfinished[0]! }); // pending
    inbox.accept(5001, { ...request, requestId: unfinished[1]! });
    inbox.saveReply(unfinished[1]!, "ready"); // ready, not yet sent
    inbox.accept(5002, { ...request, requestId: unfinished[2]! });
    inbox.saveReply(unfinished[2]!, "failed"); // explicit failure
    inbox.beginPart(unfinished[2]!, 0);
    inbox.failPart(unfinished[2]!, 0, "failed", "WEB_403");
    inbox.accept(5003, { ...request, requestId: unfinished[3]! });
    inbox.saveReply(unfinished[3]!, "uncertain"); // unknown outcome
    inbox.beginPart(unfinished[3]!, 0);
    inbox.failPart(unfinished[3]!, 0, "uncertain", "TIMEOUT");

    inbox.prune();

    const db = new DatabaseSync(path);
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM inbox WHERE status = 'sent'").get() as { count: number }).count, 100);
      assert.equal(db.prepare("SELECT requestId FROM inbox WHERE requestId = ?").get("web:1000"), undefined);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE requestId = ?").get("web:1000")?.["count"], 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM failures WHERE requestId = ?").get("web:1000")?.["count"], 0);
      assert.ok(db.prepare("SELECT requestId FROM inbox WHERE requestId = ?").get("web:1020"));
      for (const id of ["web:5000", "web:5001", "web:5002", "web:5003"])
        assert.ok(db.prepare("SELECT requestId FROM inbox WHERE requestId = ?").get(id), `unfinished request ${id} must survive`);
    } finally {
      db.close();
    }

    assert.equal(inbox.diagnostics().some((row) => row.code === "TEST_FAILURE"), false);
    assert.deepEqual(inbox.blocked().map((row) => row.requestId), [unfinished[2], unfinished[3]]);
    assert.equal(inbox.next()?.requestId, unfinished[0]);
    inbox.saveReply(unfinished[0]!, "pending done");
    inbox.beginPart(unfinished[0]!, 0);
    inbox.confirmPart(unfinished[0]!, 0, "5000");
    assert.equal(inbox.next()?.requestId, unfinished[1]);
  } finally {
    inbox.close();
  }
  await rm(directory, { recursive: true, force: true });
});

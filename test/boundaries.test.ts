import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { GrammyError } from "grammy";
import type { Update } from "grammy/types";
import { Inbox } from "../src/inbox.js";
import { readConfig } from "../src/config.js";
import { splitReply } from "../src/messages.js";
import { serveTelegram, toRequest } from "../src/telegram.js";

const update: Update = {
  update_id: 12,
  message: {
    message_id: 7, date: 1, text: "hello",
    chat: { id: 42, type: "private", first_name: "Owner" },
    from: { id: 42, is_bot: false, first_name: "Owner" },
  },
};
const request = toRequest(update, "42", "99")!;

test("Telegram boundary admits only owner private text and namespaces identifiers", () => {
  assert.deepEqual(request, {
    requestId: "telegram:99:12", conversationId: "42", senderId: "42", text: "hello",
  });
  assert.equal(toRequest(update, "43", "99"), undefined);
  assert.equal(toRequest({ ...update, message: { ...update.message!, chat: { id: -1, type: "group", title: "Group" } } }, "42", "99"), undefined);
  assert.notEqual(toRequest(update, "42", "100")!.requestId, request.requestId);
});

test("reply chunking preserves text including Unicode surrogate pairs", () => {
  const text = "你".repeat(3999) + "😀" + "a".repeat(8000);
  const chunks = splitReply(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 4000 && chunk.isWellFormed()));
});

test("inbox rejects identity and request-content conflicts without advancing offset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-inbox-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  try {
    inbox.bindIdentity("99", "42");
    assert.throws(() => inbox.bindIdentity("100", "42"));
    assert.throws(() => inbox.bindIdentity("99", "43"));
    inbox.accept(13, request);
    inbox.accept(13, request);
    assert.throws(() => inbox.accept(14, { ...request, text: "different" }));
    assert.equal(inbox.offset, 13);
    // Telegram may reset the update sequence after a week without updates.
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

test("reconciling partial delivery sends stored remainder without rerunning agent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-delivery-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  const config = { token: "fake", ownerId: "42", provider: "openai", model: "fake", dataDir: directory };
  let executions = 0;
  const firstShutdown = new AbortController();
  const sent: string[] = [];
  try {
    inbox.accept(13, request);
    await serveTelegram(config, "99", inbox, async () => { executions++; return "a".repeat(4000) + "remaining"; }, firstShutdown.signal, {
      send: async (_chat, text) => {
        if (sent.length === 1) throw new Error("lost response");
        sent.push(text);
        return "101";
      },
      updates: async () => { firstShutdown.abort(); return []; },
    });
    assert.equal(executions, 1);
    assert.equal(inbox.blocked()[0]?.part, 1);
    inbox.resolvePart(request.requestId, 1, "retry");
    const secondShutdown = new AbortController();
    await serveTelegram(config, "99", inbox, async () => { throw new Error("must not rerun"); }, secondShutdown.signal, {
      send: async (_chat, text) => { sent.push(text); return "102"; },
      updates: async () => { secondShutdown.abort(); return []; },
    });
    assert.deepEqual(sent, ["a".repeat(4000), "remaining"]);
    assert.equal(executions, 1);
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
    inbox.accept(1, { ...request, requestId: "telegram:99:1" });
    inbox.accept(2, { ...request, requestId: "telegram:99:2" });
    const first = inbox.next();
    inbox.saveReply(first!.requestId, "first");
    inbox.beginPart(first!.requestId, 0);
    inbox.confirmPart(first!.requestId, 0, "1");
    assert.equal(inbox.next()?.requestId, "telegram:99:2");
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("configuration failures name the missing or invalid setting", () => {
  assert.throws(() => readConfig({}), /Missing configuration: TELEGRAM_OWNER_ID/);
  assert.throws(() => readConfig({ TELEGRAM_OWNER_ID: "not-a-number" }), /positive numeric user ID/);
  assert.throws(() => readConfig({ TELEGRAM_OWNER_ID: "42" }), /Missing configuration: MODEL_PROVIDER/);
  assert.throws(() => readConfig({ TELEGRAM_OWNER_ID: "42", MODEL_PROVIDER: "other" }), /anthropic or openai/);
  assert.throws(() => readConfig({ TELEGRAM_OWNER_ID: "42", MODEL_PROVIDER: "openai" }), /Missing configuration: OPENAI_API_KEY/);
  assert.throws(() => readConfig({
    TELEGRAM_OWNER_ID: "42", MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "key",
  }), /Missing configuration: TELEGRAM_BOT_TOKEN/);
});

test("oversized input is refused explicitly instead of being silently dropped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-input-limit-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  const config = { token: "fake", ownerId: "42", provider: "openai", model: "fake", dataDir: directory };
  try {
    inbox.accept(1, { ...request, text: "x".repeat(16_001) });
    const shutdown = new AbortController();
    const sent: string[] = [];
    let executions = 0;
    await serveTelegram(config, "99", inbox, async () => { executions++; return "must not run"; }, shutdown.signal, {
      send: async (_chat, text) => { sent.push(text); return "1"; },
      updates: async () => { shutdown.abort(); return []; },
    });
    assert.equal(executions, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /消息过长/);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual confirmation marks only the named segment sent and continues with later parts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-confirm-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  try {
    inbox.accept(13, request);
    inbox.saveReply(request.requestId, "a".repeat(4001) + "b".repeat(4001) + "tail");
    inbox.beginPart(request.requestId, 0);
    inbox.confirmPart(request.requestId, 0, "101");
    inbox.beginPart(request.requestId, 1);
    inbox.failPart(request.requestId, 1, "uncertain", "TIMEOUT");
    inbox.resolvePart(request.requestId, 1, "sent");
    assert.equal(inbox.nextPart(request.requestId)?.part, 2);
    assert.equal(inbox.next()?.status, "ready", "the request stays ready for the remaining part, not pending");
    assert.equal(inbox.blocked().length, 0);
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
      const id = `telegram:99:${1000 + index}`;
      inbox.accept(1000 + index, { ...request, requestId: id });
      inbox.saveReply(id, `reply ${index}`, index === 0 ? "TEST_FAILURE" : undefined);
      inbox.beginPart(id, 0);
      inbox.confirmPart(id, 0, String(index));
    }
    const unfinished = ["telegram:99:5000", "telegram:99:5001", "telegram:99:5002", "telegram:99:5003"];
    inbox.accept(5000, { ...request, requestId: unfinished[0]! }); // pending
    inbox.accept(5001, { ...request, requestId: unfinished[1]! });
    inbox.saveReply(unfinished[1]!, "ready"); // ready, not yet sent
    inbox.accept(5002, { ...request, requestId: unfinished[2]! });
    inbox.saveReply(unfinished[2]!, "failed"); // explicit failure
    inbox.beginPart(unfinished[2]!, 0);
    inbox.failPart(unfinished[2]!, 0, "failed", "TELEGRAM_403");
    inbox.accept(5003, { ...request, requestId: unfinished[3]! });
    inbox.saveReply(unfinished[3]!, "uncertain"); // unknown outcome
    inbox.beginPart(unfinished[3]!, 0);
    inbox.failPart(unfinished[3]!, 0, "uncertain", "TIMEOUT");

    inbox.prune();

    const db = new DatabaseSync(path);
    try {
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM inbox WHERE status = 'sent'").get() as { count: number }).count, 100);
      assert.equal(db.prepare("SELECT requestId FROM inbox WHERE requestId = ?").get("telegram:99:1000"), undefined);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM deliveries WHERE requestId = ?").get("telegram:99:1000")?.["count"], 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM failures WHERE requestId = ?").get("telegram:99:1000")?.["count"], 0);
      assert.ok(db.prepare("SELECT requestId FROM inbox WHERE requestId = ?").get("telegram:99:1020"));
      for (const id of ["telegram:99:5000", "telegram:99:5001", "telegram:99:5002", "telegram:99:5003"])
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

test("Telegram rejection is failed while a transport failure is uncertain, and neither resends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-send-errors-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  const config = { token: "fake", ownerId: "42", provider: "openai", model: "fake", dataDir: directory };
  try {
    inbox.accept(1, { ...request, requestId: "telegram:99:1" });
    inbox.accept(2, { ...request, requestId: "telegram:99:2" });
    inbox.accept(3, { ...request, requestId: "telegram:99:3" });
    const shutdown = new AbortController();
    let executions = 0;
    let sends = 0;
    await serveTelegram(config, "99", inbox, async (job) => {
      executions++;
      return `reply ${job.requestId}`;
    }, shutdown.signal, {
      send: async () => {
        sends++;
        if (sends === 1) throw new GrammyError("rejected", { ok: false, error_code: 403, description: "bot was blocked" }, "sendMessage", {});
        if (sends === 2) throw new Error("socket hang up");
        return "103";
      },
      updates: async () => { shutdown.abort(); return []; },
    });
    assert.equal(executions, 3, "a blocked delivery must not stop later independent requests");
    const rows = inbox.blocked();
    assert.deepEqual(rows.map((row) => [row.requestId, row.status, row.error]), [
      ["telegram:99:1", "failed", "TELEGRAM_403"],
      ["telegram:99:2", "uncertain", "EXECUTION_ERROR"],
    ]);
    assert.equal(sends, 3, "blocked parts are not retried automatically");
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

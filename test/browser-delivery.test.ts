import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { InputFile } from "grammy";
import type { readConfig } from "../src/config.js";
import { Inbox } from "../src/inbox.js";
import { serveTelegram, TelegramClient, validateTelegramReply } from "../src/telegram.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64");
const request = { requestId: "telegram:99:1", conversationId: "42", senderId: "42", text: "screenshot" };
const config = (dataDir: string): ReturnType<typeof readConfig> => ({
  token: "fake", ownerId: "42", provider: "openai", model: "fake", dataDir,
  mcpConfigPath: join(dataDir, "mcp.json"), mcpConfigExplicit: false, telegramApiRoot: undefined,
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pa-browser-delivery-"));
  const shots = join(directory, "browser", "shots");
  await mkdir(join(shots, "request"), { recursive: true });
  const photo = join(shots, "request", "screen.png");
  await writeFile(photo, png);
  return { directory, shots, photo, path: join(directory, "inbox.sqlite") };
}

function deliveries(path: string) {
  const db = new DatabaseSync(path);
  try {
    return db.prepare("SELECT part, type, path, text, status, messageId FROM deliveries ORDER BY part").all();
  } finally {
    db.close();
  }
}

test("interrupted photo delivery is quarantined; retry reuses saved files without executing the reply", async () => {
  const { directory, photo, shots, path } = await fixture();
  const secondPhoto = join(shots, "second.png");
  await writeFile(secondPhoto, png);
  let inbox = new Inbox(path);
  let executions = 0;
  const sentPhotos: string[] = [];
  const stop = new AbortController();
  try {
    inbox.accept(2, request);
    await serveTelegram(config(directory), "99", inbox, async () => {
      executions++;
      return { text: "a".repeat(4001), photos: [photo, secondPhoto] as readonly string[] };
    }, stop.signal, {
      updates: async () => { stop.abort(); return []; },
      send: async () => {
        assert.equal(deliveries(path).length, 4, "all text and photo parts must be committed before the first send");
        return "text-id";
      },
      sendPhoto: async (_chat, saved, signal) => {
        assert.equal(signal, stop.signal);
        sentPhotos.push(saved);
        stop.abort();
        throw new Error("connection interrupted after upload");
      },
    });
    assert.equal(executions, 1);
    assert.equal(inbox.blocked()[0]?.part, 2);
    assert.equal(inbox.blocked()[0]?.status, "uncertain");
    assert.deepEqual(deliveries(path).map((row) => row.status), ["sent", "sent", "uncertain", "pending"]);
    inbox.close();
    inbox = new Inbox(path);
    inbox.recover();
    assert.equal(inbox.next(), undefined);
    inbox.resolvePart(request.requestId, 2, "retry");
    const retryStop = new AbortController();
    await serveTelegram(config(directory), "99", inbox, async () => {
      executions++;
      throw new Error("reply must not run on delivery retry");
    }, retryStop.signal, {
      updates: async () => { retryStop.abort(); return []; },
      send: async () => { throw new Error("confirmed text must not be sent again"); },
      sendPhoto: async (_chat, saved) => { sentPhotos.push(saved); return String(sentPhotos.length); },
    });
    assert.equal(executions, 1);
    assert.deepEqual(sentPhotos, [await realpath(photo), await realpath(photo), await realpath(secondPhoto)]);
    assert.equal(inbox.blocked().length, 0);
    assert.equal(inbox.next(), undefined);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy delivery rows migrate to text and recovery can send without a photo-capable client", async () => {
  const { directory, path } = await fixture();
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE inbox (requestId TEXT PRIMARY KEY, conversationId TEXT NOT NULL, senderId TEXT NOT NULL,
      text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reply TEXT);
    CREATE TABLE deliveries (requestId TEXT NOT NULL REFERENCES inbox(requestId) ON DELETE CASCADE,
      part INTEGER NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', messageId TEXT, error TEXT,
      PRIMARY KEY (requestId, part));
    INSERT INTO inbox VALUES ('legacy', '42', '42', 'old request', 'ready', 'old reply');
    INSERT INTO deliveries VALUES ('legacy', 0, 'old reply', 'pending', NULL, NULL);
    INSERT INTO inbox VALUES ('unsegmented', '42', '42', 'older request', 'ready', 'older reply');
  `);
  old.close();
  let inbox = new Inbox(path);
  try {
    inbox.recover();
    inbox.close();
    inbox = new Inbox(path);
    inbox.recover();
    const rows = deliveries(path);
    assert.ok(rows.every((row) => row.type === "text" && row.path === null));
    const sent: string[] = [];
    const stop = new AbortController();
    await serveTelegram(config(directory), "99", inbox, async () => { throw new Error("must not execute"); }, stop.signal, {
      updates: async () => { stop.abort(); return []; },
      send: async (_chat, text) => { sent.push(text); return "1"; },
    });
    assert.deepEqual(sent, ["old reply", "older reply"]);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("photo boundary rejects traversal, non-PNG content, excess count, oversize files and symlink escapes", async () => {
  const { directory, shots, photo } = await fixture();
  const signal = new AbortController().signal;
  try {
    assert.deepEqual(await validateTelegramReply({ text: "valid", photos: [photo] }, directory, signal), {
      text: "valid", photos: [await realpath(photo)],
    });
    const outside = join(directory, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "outside.png"), png);
    const lookalike = join(directory, "browser", "shots-other");
    await mkdir(lookalike);
    await writeFile(join(lookalike, "outside.png"), png);
    const fake = join(shots, "fake.png");
    await writeFile(fake, "not a PNG");
    const wrongExtension = join(shots, "picture.jpg");
    await writeFile(wrongExtension, png);
    const large = join(shots, "large.png");
    const file = await open(large, "w");
    try {
      await file.write(png);
      await file.truncate(8 * 1024 * 1024 + 1);
    } finally { await file.close(); }
    const folder = join(shots, "directory.png");
    await mkdir(folder);
    const escaped = join(shots, "escape");
    await symlink(outside, escaped, "junction");
    for (const candidate of [
      [relative(directory, photo)], [join(outside, "outside.png")], [join(lookalike, "outside.png")],
      [join(shots, "..", "..", "outside", "outside.png")], [join(escaped, "outside.png")],
      [fake], [wrongExtension], [large], [folder], [join(shots, "missing.png")],
      [photo, photo, photo, photo], "not an array", [123],
    ]) {
      await assert.rejects(validateTelegramReply({ text: "invalid", photos: candidate }, directory, signal),
        { code: "REPLY_ATTACHMENT_INVALID" }, String(candidate));
    }
    await assert.rejects(validateTelegramReply({ text: "" }, directory, signal), { code: "REPLY_INVALID" });
    const linkedData = join(directory, "linked-data");
    await mkdir(join(linkedData, "browser"), { recursive: true });
    await symlink(shots, join(linkedData, "browser", "shots"), "junction");
    await assert.rejects(validateTelegramReply({ text: "invalid", photos: [join(linkedData, "browser", "shots", "request", "screen.png")] }, linkedData, signal),
      { code: "REPLY_ATTACHMENT_INVALID" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid host attachments produce a persisted business failure and later requests still execute", async () => {
  const { directory, path } = await fixture();
  const outside = join(directory, "outside.png");
  await writeFile(outside, png);
  const inbox = new Inbox(path);
  try {
    inbox.accept(2, request);
    inbox.accept(3, { ...request, requestId: "telegram:99:2" });
    const stop = new AbortController();
    const sent: string[] = [];
    let executions = 0;
    await serveTelegram(config(directory), "99", inbox, async (job) => {
      executions++;
      return job.requestId === request.requestId ? { text: "unsafe reply", photos: [outside] } : "second reply";
    }, stop.signal, {
      updates: async () => { stop.abort(); return []; },
      send: async (_chat, text) => { sent.push(text); return String(sent.length); },
      sendPhoto: async () => { assert.fail("invalid attachment must not be sent"); },
    });
    assert.equal(executions, 2);
    assert.match(sent[0]!, /未能完成/);
    assert.equal(sent[1], "second reply");
    assert.ok(deliveries(path).every((row) => row.type === "text"));
    assert.equal(inbox.diagnostics()[0]?.code, "REPLY_ATTACHMENT_INVALID");
    assert.equal(inbox.blocked().length, 0);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing photo method or deleted stored file is an explicit failed delivery", async () => {
  for (const missingMethod of [true, false]) {
    const { directory, photo, path } = await fixture();
    const inbox = new Inbox(path);
    try {
      inbox.accept(2, request);
      inbox.saveReply(request.requestId, "saved", undefined, [photo]);
      if (!missingMethod) await rm(photo);
      const stop = new AbortController();
      await serveTelegram(config(directory), "99", inbox, async () => { throw new Error("must not execute"); }, stop.signal, {
        updates: async () => { stop.abort(); return []; },
        send: async () => "1",
        ...(!missingMethod ? { sendPhoto: async () => { assert.fail("missing file must not be sent"); } } : {}),
      });
      assert.equal(inbox.blocked()[0]?.status, "failed");
      assert.equal(inbox.blocked()[0]?.error, missingMethod ? "TELEGRAM_PHOTO_UNSUPPORTED" : "REPLY_ATTACHMENT_INVALID");
    } finally {
      inbox.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("TelegramClient sends an InputFile and propagates upload cancellation", async () => {
  const client = new TelegramClient("fake");
  const controller = new AbortController();
  const api = (client as unknown as { api: { sendPhoto: (...args: unknown[]) => Promise<unknown> } }).api;
  let receivedSignal: { aborted: boolean; addEventListener: (event: string, listener: () => void) => void } | undefined;
  api.sendPhoto = async (chat, photo, _options, signal) => {
    assert.equal(chat, "42");
    assert.ok(photo instanceof InputFile);
    receivedSignal = signal as typeof receivedSignal;
    return new Promise((_resolve, reject) => {
      receivedSignal!.addEventListener("abort", () => reject(new Error("upload aborted")));
      controller.abort();
    });
  };
  await assert.rejects(client.sendPhoto("42", "screen.png", controller.signal), /upload aborted/);
  assert.equal(receivedSignal?.aborted, true);
  let calls = 0;
  api.sendPhoto = async () => { calls++; return { message_id: 12 }; };
  await assert.rejects(client.sendPhoto("42", "screen.png", controller.signal), { name: "AbortError" });
  assert.equal(calls, 0);
  assert.equal(await client.sendPhoto("42", "screen.png", new AbortController().signal), "12");
});

test("shutdown during reply execution leaves the request pending without creating delivery parts", async () => {
  const { directory, photo, path } = await fixture();
  const inbox = new Inbox(path);
  try {
    inbox.accept(2, request);
    const stop = new AbortController();
    await serveTelegram(config(directory), "99", inbox, async () => {
      stop.abort();
      return { text: "cancelled reply", photos: [photo] };
    }, stop.signal, {
      updates: async () => { assert.fail("must stop"); },
      send: async () => { assert.fail("must not send"); },
    });
    assert.equal(inbox.next()?.status, "pending");
    assert.equal(deliveries(path).length, 0);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("process recovery marks an in-flight photo uncertain without changing the stored path", async () => {
  const { directory, photo, path } = await fixture();
  let inbox = new Inbox(path);
  try {
    inbox.accept(2, request);
    inbox.saveReply(request.requestId, "saved", undefined, [photo]);
    inbox.beginPart(request.requestId, 0);
    inbox.confirmPart(request.requestId, 0, "1");
    inbox.beginPart(request.requestId, 1);
    inbox.close();
    inbox = new Inbox(path);
    inbox.recover();
    assert.equal(inbox.next(), undefined);
    assert.equal(inbox.blocked()[0]?.error, "PROCESS_INTERRUPTED");
    assert.equal(deliveries(path)[1]?.path, photo);
    inbox.resolvePart(request.requestId, 1, "retry");
    assert.equal(inbox.nextPart(request.requestId)?.type, "photo");
    assert.equal(inbox.nextPart(request.requestId)?.path, photo);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});

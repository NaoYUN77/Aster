import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Update } from "grammy/types";
import { readConfig } from "../src/config.js";
import { Inbox } from "../src/inbox.js";
import { serveTelegram, TelegramClient, toRequest } from "../src/telegram.js";
import { MAX_AUDIO_BYTES, SttError, type AudioReference } from "../src/stt.js";

const reference: AudioReference = { kind: "voice", fileId: "file-id", durationSeconds: 4, fileSize: 3 };
const update: Update = {
  update_id: 12,
  message: {
    message_id: 7, date: 1, voice: { file_id: "file-id", file_unique_id: "unique", duration: 4, file_size: 3 },
    chat: { id: 42, type: "private", first_name: "Owner" },
    from: { id: 42, is_bot: false, first_name: "Owner" },
  },
};
const request = toRequest(update, "42", "99")!;
const config = readConfig({
  TELEGRAM_BOT_TOKEN: "fake", TELEGRAM_OWNER_ID: "42", MODEL_PROVIDER: "deepseek", MODEL_ID: "deepseek-flash", DEEPSEEK_API_KEY: "fake",
  STT_API_URL: "https://stt.example/transcriptions", STT_API_KEY: "synthetic", STT_MODEL: "whisper-1",
});
const audio = { bytes: new Uint8Array([1, 2, 3]), filename: "audio.ogg" };

async function withInbox(run: (inbox: Inbox, path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "aster-stt-"));
  const path = join(directory, "inbox.sqlite");
  const inbox = new Inbox(path);
  try { await run(inbox, path); } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("Telegram voice/audio is accepted only for owner private messages and metadata errors produce rejected requests", () => {
  assert.deepEqual(request, { requestId: "telegram:99:12", conversationId: "42", senderId: "42", text: "", audio: reference });
  assert.equal(toRequest(update, "43", "99"), undefined);
  assert.equal(toRequest({ ...update, message: { ...update.message!, chat: { id: -1, type: "group", title: "Group" } } }, "42", "99"), undefined);
  const { voice: _voice, ...message } = update.message!;
  const music = { ...update, message: { ...message, caption: "not part of the prompt", audio: { ...update.message!.voice!, title: "song" } } } as Update;
  assert.deepEqual(toRequest(music, "42", "99")?.audio, { ...reference, kind: "audio" });
  for (const media of [null, {}, { file_id: "x", duration: "4" }, { file_id: "x", duration: 1, file_size: -1 }]) {
    const bad = { ...update, message: { ...message, voice: media } } as unknown as Update;
    assert.equal(toRequest(bad, "42", "99")?.audio?.invalid, true);
  }
});

test("download uses the configured Telegram root and bounded bytes; rejects paths and redirects before credentials can leave", async (t) => {
  const client = new TelegramClient("__vault_TELEGRAM_BOT_TOKEN__", "https://tg.example/prefix");
  const api = (client as unknown as { api: { getFile: () => Promise<unknown> } }).api;
  let metadata: unknown = { file_path: "voice/file_123.oga", file_size: 3 };
  t.mock.method(api, "getFile", async () => metadata);
  let downloads = 0;
  let response = () => new Response(new Uint8Array([1, 2, 3]));
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    downloads++;
    assert.equal(url, "https://tg.example/prefix/file/bot__vault_TELEGRAM_BOT_TOKEN__/voice/file_123.oga");
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal);
    return response();
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await client.download(reference, signal), audio);
  metadata = { file_path: "https://evil/file.ogg" };
  await assert.rejects(client.download(reference, signal), { code: "STT_INVALID_FILE_PATH" });
  metadata = { file_path: "voice/file_123.oga", file_size: MAX_AUDIO_BYTES + 1 };
  await assert.rejects(client.download(reference, signal), { code: "STT_AUDIO_TOO_LARGE" });
  assert.equal(downloads, 1);
  metadata = { file_path: "voice/file_123.oga" };
  response = () => new Response(null, { status: 302, headers: { location: "https://evil" } });
  await assert.rejects(client.download(reference, signal), { code: "STT_DOWNLOAD_FAILED" });
  response = () => new Response("x", { headers: { "content-length": String(MAX_AUDIO_BYTES + 1) } });
  await assert.rejects(client.download(reference, signal), { code: "STT_RESPONSE_TOO_LARGE" });
});

test("polling persists audio and offset before download, passes saved transcript to the same agent, and keeps identical sends distinct", async () => {
  await withInbox(async (inbox) => {
    const stop = new AbortController();
    let polls = 0;
    let downloads = 0;
    let transcriptions = 0;
    const agentRequests: string[] = [];
    const sent: string[] = [];
    await serveTelegram(config, "99", inbox, async (job) => {
      assert.equal(job.text, "打开今天的待办");
      assert.equal(inbox.next()?.text, job.text, "transcript is persisted before the agent sees it");
      assert.equal(inbox.next()?.transcriptionStatus, "done");
      agentRequests.push(job.requestId);
      return "agent reply";
    }, stop.signal, {
      updates: async () => {
        if (polls++ === 0) return [update, { ...update, update_id: 13 }];
        stop.abort(); return [];
      },
      download: async () => { downloads++; assert.equal(inbox.offset, 14); return audio; },
      send: async (_chat, text) => { sent.push(text); return String(sent.length); },
    }, async () => { transcriptions++; return "打开今天的待办"; });
    assert.equal(downloads, 2);
    assert.equal(transcriptions, 2);
    assert.deepEqual(agentRequests, ["telegram:99:12", "telegram:99:13"]);
    assert.deepEqual(sent, Array(2).fill("识别文本：\n打开今天的待办\n\nagent reply"));
    assert.equal(inbox.next(), undefined);
  });
});

test("disabled, invalid, oversized, download and transcription failures save clear notices and never call the agent", async () => {
  const cases = ["STT_NOT_CONFIGURED", "STT_INVALID_AUDIO", "STT_AUDIO_TOO_LARGE", "STT_DOWNLOAD_FAILED", "STT_HTTP_401", "STT_EMPTY_TRANSCRIPT", "STT_TIMEOUT"];
  for (const code of cases) await withInbox(async (inbox) => {
    const media = code === "STT_INVALID_AUDIO" ? { ...reference, invalid: true as const }
      : code === "STT_AUDIO_TOO_LARGE" ? { ...reference, durationSeconds: 601 } : reference;
    inbox.accept(13, { ...request, audio: media });
    const stop = new AbortController();
    const sent: string[] = [];
    let downloads = 0;
    await serveTelegram(code === "STT_NOT_CONFIGURED" ? { ...config, stt: undefined } : config, "99", inbox,
      async () => { throw new Error("must not call agent"); }, stop.signal, {
        updates: async () => { stop.abort(); return []; },
        send: async (_chat, text) => { sent.push(text); return "1"; },
        download: async () => { downloads++; if (code === "STT_DOWNLOAD_FAILED") throw new SttError(code); return audio; },
      }, async () => { throw new SttError(code); });
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /语音|音频|识别/);
    assert.deepEqual(inbox.diagnostics().map((row) => row.code), [code]);
    if (["STT_NOT_CONFIGURED", "STT_INVALID_AUDIO", "STT_AUDIO_TOO_LARGE"].includes(code)) assert.equal(downloads, 0);
  });
});

test("restart reuses a saved transcript and delivery retry never retranscribes or reexecutes agent", async () => {
  await withInbox(async (inbox, path) => {
    inbox.accept(13, request);
    inbox.beginTranscription(request.requestId);
    inbox.saveTranscript(request.requestId, "saved transcript");
    inbox.accept(13, request); // redelivery compares the original file reference, not the derived text
    assert.throws(() => inbox.accept(14, { ...request, audio: { ...reference, fileId: "other" } }), /reused/);
    assert.equal(inbox.offset, 13);
    const reopened = new Inbox(path);
    let executions = 0;
    try {
      reopened.recover();
      const stop = new AbortController();
      await serveTelegram(config, "99", reopened, async (job) => {
        executions++; assert.equal(job.text, "saved transcript"); return "answer";
      }, stop.signal, {
        download: async () => { throw new Error("no redownload"); },
        updates: async () => { stop.abort(); return []; },
        send: async () => { throw new Error("connection lost"); },
      });
      assert.equal(reopened.blocked()[0]?.status, "uncertain");
      reopened.resolvePart(request.requestId, 0, "retry");
      const retryStop = new AbortController();
      const sent: string[] = [];
      await serveTelegram(config, "99", reopened, async () => { throw new Error("no agent replay"); }, retryStop.signal, {
        updates: async () => { retryStop.abort(); return []; },
        send: async (_chat, text) => { sent.push(text); return "1"; },
      });
      assert.equal(executions, 1);
      assert.deepEqual(sent, ["识别文本：\nsaved transcript\n\nanswer"]);
    } finally { reopened.close(); }
  });
});

test("interrupted billable STT is recovered as unknown with no replay; later text still runs", async () => {
  await withInbox(async (inbox, path) => {
    inbox.accept(13, request);
    const stop = new AbortController();
    await serveTelegram(config, "99", inbox, async () => { throw new Error("no agent"); }, stop.signal, {
      updates: async () => { throw new Error("no poll"); }, send: async () => { throw new Error("no send"); }, download: async () => audio,
    }, async () => { stop.abort(); throw stop.signal.reason; });
    assert.equal(inbox.next()?.transcriptionStatus, "running");
    const recovered = new Inbox(path);
    try {
      recovered.recover();
      assert.equal(recovered.next()?.transcriptionStatus, "uncertain");
      recovered.accept(14, { ...request, requestId: "telegram:99:13", audio: undefined, text: "next question" });
      const nextStop = new AbortController();
      const sent: string[] = [];
      await serveTelegram(config, "99", recovered, async (job) => {
        assert.equal(job.text, "next question"); return "text answer";
      }, nextStop.signal, {
        updates: async () => { nextStop.abort(); return []; },
        send: async (_chat, text) => { sent.push(text); return String(sent.length); },
        download: async () => { throw new Error("no STT replay"); },
      });
      assert.equal(sent.length, 2);
      assert.match(sent[0]!, /可能已处理或计费/);
      assert.equal(sent[1], "text answer");
      assert.equal(recovered.diagnostics()[0]?.code, "STT_UNCERTAIN");
    } finally { recovered.close(); }
  });
});

test("pending downloads survive restart and failed notices survive interruption without running STT", async () => {
  await withInbox(async (inbox, path) => {
    inbox.accept(13, request);
    const reopened = new Inbox(path);
    try {
      reopened.recover();
      assert.equal(reopened.next()?.transcriptionStatus, "pending");
      reopened.failTranscription(request.requestId, "STT_DOWNLOAD_FAILED");
    } finally { reopened.close(); }
    const recovered = new Inbox(path);
    try {
      recovered.recover();
      const stop = new AbortController();
      const sent: string[] = [];
      await serveTelegram(config, "99", recovered, async () => { throw new Error("no agent"); }, stop.signal, {
        updates: async () => { stop.abort(); return []; },
        download: async () => { throw new Error("no retry after terminal failure"); },
        send: async (_chat, text) => { sent.push(text); return "1"; },
      });
      assert.equal(sent.length, 1);
      assert.match(sent[0]!, /STT_DOWNLOAD_FAILED/);
      assert.equal(recovered.next(), undefined);
    } finally { recovered.close(); }
  });
});

test("local transcript persistence failures are fatal and cannot turn into an STT failure notice", async (t) => {
  await withInbox(async (inbox) => {
    inbox.accept(13, request);
    t.mock.method(inbox, "saveTranscript", () => { throw new Error("disk full"); });
    await assert.rejects(serveTelegram(config, "99", inbox, async () => { throw new Error("no agent"); }, new AbortController().signal, {
      updates: async () => [], send: async () => { throw new Error("no send"); }, download: async () => audio,
    }, async () => "transcript"), /disk full/);
    assert.equal(inbox.next()?.transcriptionStatus, "running");
    assert.deepEqual(inbox.diagnostics(), []);
  });
});

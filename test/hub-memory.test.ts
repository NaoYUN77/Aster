import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openAgent } from "../src/agent.js";
import { readConfig, readMemoryConfig } from "../src/config.js";
import { HubStore, memberMemoryRoot } from "../src/hubs.js";
import type { TextRequest } from "../src/messages.js";

const context = BACKGROUND_CONTEXT;
const running = new AbortController().signal;
const OWNER = "U0OWNER123";
const MEMBER = "U0MEMBER123";
const CHANNEL = "C0CHANNEL12";

function teamConfig(dataDir: string) {
  const full = {
    CHANNEL: "slack",
    SLACK_BOT_TOKEN: "xoxb-1234567890123456789012",
    SLACK_APP_TOKEN: "xapp-1234567890123456789012",
    SLACK_OWNER_ID: OWNER,
    SLACK_ALLOWED_USERS: MEMBER,
    SLACK_ALLOWED_CHANNELS: CHANNEL,
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    OPENAI_API_KEY: "offline-test",
    DATA_DIR: dataDir,
  };
  // Memory stays on: this test is about where its work runs, not about the pipeline itself.
  return { ...readConfig(full), memory: readMemoryConfig(full) } as ReturnType<typeof readConfig>;
}

function memberRequest(over: Partial<TextRequest> = {}): TextRequest {
  return {
    requestId: "slack:T1:Ev1",
    conversationId: CHANNEL,
    senderId: MEMBER,
    text: "What did we agree on?",
    ...over,
  };
}

/** Every memory work line names the conversation it belongs to; that is what has to be right. */
function conversationsIn(lines: readonly string[], event: string): number[] {
  const prefix = `Memory ${event}: `;
  return lines.filter((line) => line.startsWith(prefix)).map((line) => {
    const parsed = JSON.parse(line.slice(prefix.length)) as { conversationId?: number };
    assert.ok(typeof parsed.conversationId === "number", "a memory work line names its conversation");
    return parsed.conversationId;
  });
}

test("memory work runs in the member's Hub, and the owner's still runs in the root", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-hub-memory-"));
  const hubStore = new HubStore(join(directory, "hubs.sqlite"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  const lines: string[] = [];
  const original = console.error;
  try {
    const faux = fauxProvider({ provider: "openai" });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(Array.from({ length: 4 }, () => () => fauxAssistantMessage("an answer")));

    app = await openAgent(teamConfig(directory), models, undefined, { hubStore });
    console.error = (...args: unknown[]) => { lines.push(args.map((value) => String(value)).join(" ")); };

    assert.equal(await app.reply(memberRequest(), running), "an answer");
    const hub = hubStore.member(MEMBER);
    assert.ok(hub !== undefined, "the member's Hub was created");

    // The Hub's own archive is initialized against the member's store root, not the owner's.
    const memberWork = conversationsIn(lines, "memory.prepare");
    assert.deepEqual(memberWork, [hub.conversationId], "the member's request prepared against their Hub");

    // A follow-up runs in the thread's fork: its memory work belongs to the fork's conversation,
    // which is a different context from the Hub even though it reads the Hub's long-term memory.
    lines.length = 0;
    const anchor = "1700000000.000100";
    assert.equal(await app.reply(memberRequest({ requestId: "slack:T1:Ev9", threadTs: anchor }), running), "an answer");
    const forkId = hubStore.thread(CHANNEL, anchor)?.fork;
    assert.ok(forkId !== undefined && forkId !== hub.conversationId, "the follow-up opened its own fork");
    assert.deepEqual(conversationsIn(lines, "memory.prepare"), [forkId], "the follow-up prepared against the fork");
    assert.equal(conversationsIn(lines, "memory.upgrade").includes(hub.conversationId), false,
      "the fork's initialization did not re-initialize the Hub");

    lines.length = 0;
    assert.equal(
      await app.reply(memberRequest({ requestId: "slack:T1:Ev2", senderId: OWNER, text: "hello" }), running),
      "an answer",
    );
    const ownerWork = conversationsIn(lines, "memory.prepare");
    assert.equal(ownerWork.length, 1);
    assert.notEqual(ownerWork[0], hub.conversationId, "the owner's request is not prepared against a member's Hub");
    assert.equal(hubStore.member(OWNER), undefined, "the owner owns no member Hub");
  } finally {
    console.error = original;
    try { await app?.close(); } finally { hubStore.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test("a member's store root is derived from their member id, outside the owner's data", () => {
  // The path itself is the isolation: two members, two directories, neither under the other.
  assert.equal(memberMemoryRoot("/data", MEMBER), `/data/memory/members/${MEMBER}`);
  assert.notEqual(memberMemoryRoot("/data", MEMBER), memberMemoryRoot("/data", "U0OTHER1234"));
  assert.notEqual(memberMemoryRoot("/data", MEMBER), "/data");
});

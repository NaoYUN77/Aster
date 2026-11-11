import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openAgent } from "../src/agent.js";
import { readConfig, readMemoryConfig } from "../src/config.js";
import { FORK_CLOSED_NOTICE, HubStore, MAX_FORK_ROUNDS } from "../src/hubs.js";
import type { TextRequest } from "../src/messages.js";

const context = BACKGROUND_CONTEXT;
const running = new AbortController().signal;
const OWNER = "U0OWNER123";
const MEMBER = "U0MEMBER123";
const CHANNEL = "C0CHANNEL12";
/** Two different threads in the same channel: the second one is a new topic, not a continuation. */
const FIRST_THREAD = "1700000000.000100";
const SECOND_THREAD = "1700000000.000200";

/**
 * The team configuration: a shared channel with one allowed member, and memory switched off so these
 * tests exercise Hub routing alone — per-member memory isolation has its own tests.
 */
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
    MEMORY_ENABLED: "0",
  };
  return { ...readConfig(full), memory: readMemoryConfig(full) } as ReturnType<typeof readConfig>;
}

function modelFixture() {
  const faux = fauxProvider({ provider: "openai" });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

function memberRequest(over: Partial<TextRequest> = {}): TextRequest {
  return {
    requestId: "slack:T1:Ev1",
    conversationId: CHANNEL,
    senderId: MEMBER,
    text: "Which deploy window did we agree on?",
    ...over,
  };
}

/** The tools the model was offered, read from the system message the harness builds. */
function toolNames(transcript: { messages: readonly { role: string; toolsAdded?: readonly { name: string }[] }[] }): string[] {
  return transcript.messages.flatMap((message) => message.role === "system" ? message.toolsAdded?.map(({ name }) => name) ?? [] : []);
}

test("each member answers in their own Hub, and only the owner's Hub keeps a shell", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-hub-routing-"));
  const hubStore = new HubStore(join(directory, "hubs.sqlite"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const fixture = modelFixture();
    const offered: string[][] = [];
    fixture.faux.setResponses([
      (transcript) => { offered.push(toolNames(transcript)); return fauxAssistantMessage("member answer"); },
      (transcript) => { offered.push(toolNames(transcript)); return fauxAssistantMessage("owner answer"); },
      () => fauxAssistantMessage("owner thread answer"),
    ]);
    app = await openAgent(teamConfig(directory), fixture.models, undefined, { hubStore });

    assert.equal(await app.reply(memberRequest(), running), "member answer");
    assert.equal(
      await app.reply(memberRequest({ requestId: "slack:T1:Ev2", senderId: OWNER, text: "hello" }), running),
      "owner answer",
    );
    // The owner answers inside a thread too, but their Hub is neither forked nor capped.
    assert.equal(
      await app.reply(memberRequest({ requestId: "slack:T1:Ev3", senderId: OWNER, threadTs: FIRST_THREAD }), running),
      "owner thread answer",
    );

    const hub = hubStore.member(MEMBER);
    assert.ok(hub !== undefined, "a member who asked gets a Hub of their own");
    assert.equal(hubStore.member(OWNER), undefined, "the owner keeps the root conversation that already exists");
    assert.equal(hubStore.thread(CHANNEL, FIRST_THREAD), undefined, "the owner's Hub opens no thread record");

    // The member's Hub is its own conversation, with a working directory of its own.
    const workspace = join(directory, "workspace", "members", MEMBER);
    assert.equal((await stat(workspace)).isDirectory(), true, "the member's Hub gets its own workspace");

    // Both shells are one capability on two hosts, so a member's Hub is offered neither; the owner's
    // root conversation keeps everything it had.
    assert.equal(offered[0]?.includes("bash"), false, "a member's Hub is not offered bash");
    assert.equal(offered[0]?.includes("powershell"), false, "nor the other shell");
    assert.equal(offered[0]?.includes("reminder_create"), false, "nor a reminder that would reach the owner");
    assert.ok(offered[0]?.includes("read"), "an ordinary read tool stays available");
    assert.equal(offered[1]?.includes("bash"), true, "the owner's Hub is unchanged");
  } finally {
    try { await app?.close(); } finally { hubStore.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test("a follow-up forks the member's Hub, and five rounds close the thread with the host's notice", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-hub-fork-"));
  const hubStore = new HubStore(join(directory, "hubs.sqlite"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const fixture = modelFixture();
    let calls = 0;
    fixture.faux.setResponses(Array.from({ length: 8 }, (_, index) => () => {
      calls += 1;
      return fauxAssistantMessage(`answer ${index}`);
    }));
    app = await openAgent(teamConfig(directory), fixture.models, undefined, { hubStore });

    assert.equal(await app.reply(memberRequest(), running), "answer 0", "the question itself runs in the Hub");
    const hub = hubStore.member(MEMBER)!;

    assert.equal(await app.reply(memberRequest({ requestId: "slack:T1:Ev2", threadTs: FIRST_THREAD }), running), "answer 1");
    const opened = hubStore.thread(CHANNEL, FIRST_THREAD)!;
    assert.equal(opened.rounds, 1);
    assert.ok(opened.fork !== undefined, "the first follow-up opens a fork");
    assert.notEqual(opened.fork, hub.conversationId, "the fork is a conversation of its own, not the Hub");

    let last = "";
    for (const event of ["Ev3", "Ev4", "Ev5", "Ev6"]) {
      last = await app.reply(memberRequest({ requestId: `slack:T1:${event}`, threadTs: FIRST_THREAD }), running);
    }
    // The last allowed answer closes the thread and carries the notice as its closing line.
    assert.equal(last, `answer 5\n\n${FORK_CLOSED_NOTICE}`);
    const closed = hubStore.thread(CHANNEL, FIRST_THREAD)!;
    assert.equal(closed.rounds, MAX_FORK_ROUNDS);
    assert.equal(closed.closed, true);

    // A further follow-up is answered by the host alone: no model call, no new work.
    assert.equal(await app.reply(memberRequest({ requestId: "slack:T1:Ev7", threadTs: FIRST_THREAD }), running), FORK_CLOSED_NOTICE);
    assert.equal(calls, 6, "the notice never reaches the model");

    // A new question in the same channel is a new thread: it forks the Hub again and starts at round one.
    assert.equal(await app.reply(memberRequest({ requestId: "slack:T1:Ev8", threadTs: SECOND_THREAD }), running), "answer 6");
    const fresh = hubStore.thread(CHANNEL, SECOND_THREAD)!;
    assert.equal(fresh.rounds, 1);
    assert.equal(fresh.closed, false);
    assert.notEqual(fresh.fork, closed.fork, "each thread gets its own fork");
    assert.notEqual(fresh.fork, hub.conversationId);
  } finally {
    try { await app?.close(); } finally { hubStore.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test("a closed thread hands its own turns back to its Hub, and the Hub answers from them", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-hub-summary-"));
  const hubStore = new HubStore(join(directory, "hubs.sqlite"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const fixture = modelFixture();
    let hubTranscript = "";
    fixture.faux.setResponses([
      () => fauxAssistantMessage("answer 0"),
      // Five rounds in the thread, then a new question in the Hub itself.
      ...Array.from({ length: 5 }, (_, index) => () => fauxAssistantMessage(`thread answer ${index + 1}`)),
      (transcript) => {
        hubTranscript = transcript.messages.flatMap((message) => [
          ...(typeof message.content === "string" ? [message.content] : []),
          ...(Array.isArray(message.content)
            ? message.content.flatMap((part) => part.type === "text" ? [part.text] : [])
            : []),
        ]).join("\n");
        return fauxAssistantMessage("continuing from the thread");
      },
    ]);
    app = await openAgent(teamConfig(directory), fixture.models, undefined, { hubStore });

    await app.reply(memberRequest(), running);
    for (const event of ["Ev2", "Ev3", "Ev4", "Ev5", "Ev6"]) {
      await app.reply(memberRequest({ requestId: `slack:T1:${event}`, threadTs: FIRST_THREAD }), running);
    }
    assert.equal(hubStore.thread(CHANNEL, FIRST_THREAD)!.closed, true);

    // The next question is asked in the Hub, not in the thread: the Hub must already know what the
    // thread settled, or "接着刚才那个话题" would depend on the member repeating themselves.
    assert.equal(
      await app.reply(memberRequest({ requestId: "slack:T1:Ev7", text: "接着刚才那个话题" }), running),
      "continuing from the thread",
    );
    assert.match(hubTranscript, /5 轮追问已结束/);
    assert.match(hubTranscript, /thread answer 5/, "the thread's last answer is what the Hub keeps");
    assert.match(hubTranscript, /thread answer 1/, "and the thread's first one too");
    assert.doesNotMatch(hubTranscript, /thread answer 0/, "the Hub's own history is not duplicated into it");
  } finally {
    try { await app?.close(); } finally { hubStore.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test("a redelivered follow-up counts as one round, so a replay cannot end a thread early", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pa-hub-replay-"));
  const hubStore = new HubStore(join(directory, "hubs.sqlite"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const fixture = modelFixture();
    fixture.faux.setResponses(Array.from({ length: 4 }, () => () => fauxAssistantMessage("answer")));
    app = await openAgent(teamConfig(directory), fixture.models, undefined, { hubStore });

    await app.reply(memberRequest(), running);
    const followUp = memberRequest({ requestId: "slack:T1:Ev2", threadTs: FIRST_THREAD });
    await app.reply(followUp, running);
    // Slack redelivers an envelope it never saw acknowledged; the same request id is the same round.
    await app.reply(followUp, running);
    assert.equal(hubStore.thread(CHANNEL, FIRST_THREAD)!.rounds, 1);
    assert.equal(hubStore.thread(CHANNEL, FIRST_THREAD)!.closed, false);
  } finally {
    try { await app?.close(); } finally { hubStore.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConfig, readStyleConfig } from "../src/config.js";
import { Inbox } from "../src/inbox.js";
import { normalizeEmojiName } from "../src/reactions.js";
import {
  REACTIONS_READ_SCOPE,
  readScopes,
  styleStartupLine,
  toStyleEvent,
  type SlackStylePolicy,
} from "../src/slack.js";
import {
  ASK_SKIPPED_RATE,
  ASK_WINDOW_MS,
  POSITIVE_REACTIONS,
  SIGNALS_PER_SCOPE,
  STYLE_ASK_TEXT,
  StyleLearning,
  StyleStore,
  type StyleEvent,
} from "../src/style.js";

// Shaped like Slack tokens so the configuration reader accepts them, assembled at runtime so the
// literal never trips the secret scanner in scripts/ci/gate-policy.mjs.
const FAKE_BOT_TOKEN = ["xoxb", "test", "fixture", "not-a-credential"].join("-");
const FAKE_APP_TOKEN = ["xapp", "test", "fixture", "not-a-credential"].join("-");

const OWNER = "U0OWNER123";
const BOT = "U0BOT4567";
const MEMBER = "U0MEMBER123";
const STRANGER = "U0STRANGE12";
const CHANNEL = "C0CHANNEL12";
const MESSAGE = "1700000000.000300";

/** One delivered reply the reaction can land on. Attribution is a host lookup, never a payload field. */
const ATTRIBUTED = { requestId: "slack:T1:Ev1", part: 0, conversationId: "D0DM", senderId: OWNER };

const policy = (overrides: Partial<SlackStylePolicy> = {}, log: string[] = []) => ({
  ownerId: OWNER,
  botId: BOT,
  allowedUsers: [MEMBER],
  allowedChannels: [CHANNEL],
  log: (line: string) => log.push(line),
  attribute: () => ATTRIBUTED,
  ...overrides,
});

/** A reaction envelope as Slack delivers it, before this process has decided anything about it. */
function reactionEvent(event: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: "T1",
    event_id: "Ev1",
    event: {
      type: "reaction_added",
      user: OWNER,
      reaction: "thumbsup",
      item_user: BOT,
      item: { type: "message", channel: "D0DM", ts: MESSAGE },
      event_ts: "1700000000.000400",
      ...event,
    },
  };
}

async function withStore(run: (store: StyleStore) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "aster-style-"));
  const store = new StyleStore(join(directory, "style.sqlite"));
  try {
    await run(store);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/** An Inbox holding one delivered reply, which is what makes a reaction attributable at all. */
async function withInbox(run: (inbox: Inbox) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "aster-style-inbox-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  inbox.bindIdentity("slack", BOT, OWNER);
  try {
    inbox.accept(1, { requestId: "slack:T1:Ev1", conversationId: "D0DM", senderId: OWNER, text: "hi" });
    inbox.saveReply("slack:T1:Ev1", "answer");
    inbox.confirmPart("slack:T1:Ev1", 0, MESSAGE);
    await run(inbox);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/** A learning rig whose clock and asks the test drives; `start` fixes "now" so windows are exact. */
function rig(options: {
  readonly mode?: "off" | "observe" | "ask";
  readonly store?: StyleStore;
  readonly inert?: boolean;
  readonly start?: number;
  readonly failing?: boolean;
} = {}) {
  const asked: { channel: string; text: string; threadTs?: string }[] = [];
  const lines: string[] = [];
  let time = options.start ?? Date.parse("2026-11-11T00:00:00.000Z");
  const learning = new StyleLearning({
    mode: options.mode ?? "ask",
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.inert === undefined ? {} : { inert: options.inert }),
    send: async (channel, text, _signal, threadTs) => {
      if (options.failing === true) {
        throw Object.assign(new Error("Slack chat.postMessage was refused (NOT_IN_CHANNEL)"), { code: "SLACK_NOT_IN_CHANNEL" });
      }
      asked.push({ channel, text, threadTs });
      return "1700000000.000500";
    },
    log: (line) => lines.push(line),
    now: () => time,
  });
  return { asked, lines, learning, advance: (ms: number) => { time += ms; }, now: () => time };
}

const signal = (event: Partial<StyleEvent> = {}): StyleEvent => ({
  eventId: "style:T1:Ev1",
  kind: "added",
  channel: "D0DM",
  subjectId: OWNER,
  reactorId: OWNER,
  messageId: MESSAGE,
  requestId: "slack:T1:Ev1",
  emoji: "thinking_face",
  polarity: "other",
  ...event,
});

const shutdown = new AbortController().signal;

test("STYLE_LEARNING is off unless it is named, and an unknown value is a refused boot", () => {
  assert.deepEqual(readStyleConfig({}), { mode: "off" });
  assert.deepEqual(readStyleConfig({ STYLE_LEARNING: "" }), { mode: "off" });
  assert.deepEqual(readStyleConfig({ STYLE_LEARNING: " observe " }), { mode: "observe" });
  assert.deepEqual(readStyleConfig({ STYLE_LEARNING: "ASK" }), { mode: "ask" });
  assert.throws(() => readStyleConfig({ STYLE_LEARNING: "auto" }), /STYLE_LEARNING must be one of:/);
  // Every configuration carries it, so no deployment records reactions by accident.
  const model = { MODEL_PROVIDER: "deepseek", MODEL_ID: "deepseek-flash", DEEPSEEK_API_KEY: "key" };
  assert.deepEqual(readConfig({ TELEGRAM_BOT_TOKEN: "token", TELEGRAM_OWNER_ID: "42", ...model }).style, { mode: "off" });
  assert.deepEqual(readConfig({
    ...model, CHANNEL: "slack", SLACK_BOT_TOKEN: FAKE_BOT_TOKEN, SLACK_APP_TOKEN: FAKE_APP_TOKEN,
    SLACK_OWNER_ID: OWNER, STYLE_LEARNING: "observe",
  }).style, { mode: "observe" });
});

test("bot scopes come from Slack's own header, and a missing one grants nothing", () => {
  assert.deepEqual(readScopes(new Headers({ "x-oauth-scopes": "chat:write, im:history, reactions:read" })),
    ["chat:write", "im:history", "reactions:read"]);
  assert.deepEqual(readScopes(new Headers()), [], "no header is not a grant");
  assert.deepEqual(readScopes(undefined), []);
  assert.equal(readScopes(new Headers({ "x-oauth-scopes": "REACTIONS:READ" })).includes(REACTIONS_READ_SCOPE), true);
});

test("the startup line names the degraded state instead of staying quiet about it", () => {
  assert.match(styleStartupLine("off", true), /STYLE_LEARNING: off/);
  assert.match(styleStartupLine("off", false), /STYLE_LEARNING: off/);
  // Missing the scope is why nothing arrives, and it is printed whether or not the feature is enabled.
  assert.match(styleStartupLine("observe", false), /STYLE_INERT: missing scope reactions:read/);
  assert.match(styleStartupLine("ask", false), /STYLE_INERT: missing scope reactions:read/);
  assert.match(styleStartupLine("observe", true), /STYLE_OBSERVING/);
  assert.match(styleStartupLine("ask", true), /STYLE_ASKING: enabled, max 1 ask \/ 12h per scope/);
});

test("every refusal of a reaction has its own reason code, and none carries the payload", () => {
  const rejects: [string, Record<string, unknown>, Partial<SlackStylePolicy>][] = [
    ["STYLE_NOT_BOT_REPLY", reactionEvent({ item_user: MEMBER }), {}],
    ["STYLE_RECEIPT", reactionEvent({ user: BOT }), {}],
    // The reactor is somebody the bot answers, but the Inbox says the reply was not theirs.
    ["STYLE_REACTOR_MISMATCH", reactionEvent({ user: MEMBER }), { attribute: () => ({ ...ATTRIBUTED, conversationId: CHANNEL, senderId: OWNER }) }],
    ["STYLE_NOT_ALLOWED", reactionEvent({ user: STRANGER }), {}],
    ["STYLE_NO_TARGET", reactionEvent(), { attribute: () => undefined }],
    // An allowed member reacting in a channel nobody configured is still nobody we answer to.
    ["STYLE_NOT_ALLOWED", reactionEvent({ user: MEMBER }), { attribute: () => ({ ...ATTRIBUTED, senderId: MEMBER, conversationId: "C0ELSEWHERE1" }) }],
  ];
  for (const [reason, payload, overrides] of rejects) {
    const log: string[] = [];
    assert.equal(toStyleEvent(payload, policy(overrides, log)), undefined, reason);
    assert.deepEqual(log, [`Slack reaction dropped: ${reason}`], reason);
  }
  // The emoji name is untrusted input: refused as itself before anything is stored.
  const bad: string[] = [];
  assert.equal(toStyleEvent(reactionEvent({ reaction: "thumbs up" }), policy({}, bad)), undefined);
  assert.deepEqual(bad, ["Slack reaction dropped: STYLE_EMOJI_INVALID"]);
  // Transport noise — other event types, a reaction on a file, missing ids, malformed envelopes —
  // is not a rejected member, so it never logs.
  const quiet: string[] = [];
  const silent: unknown[] = [
    { ...reactionEvent(), event: { ...(reactionEvent().event as object), type: "message" } },
    { ...reactionEvent(), event: { type: "reaction_added", user: OWNER, item: { type: "file", file: "F1" } } },
    { ...reactionEvent(), event: { type: "reaction_added", user: OWNER } },
    { ...reactionEvent(), event: { type: "reaction_added", user: OWNER, item: { type: "message" } } },
    { ...reactionEvent(), event_id: undefined },
    { ...reactionEvent(), team_id: undefined },
    { ...reactionEvent(), type: "url_verification" },
    "not an object",
  ];
  for (const payload of silent) assert.equal(toStyleEvent(payload, policy({}, quiet)), undefined, JSON.stringify(payload));
  assert.deepEqual(quiet, []);
});

test("an accepted reaction is attributed by the host, not by anything in the payload", () => {
  const log: string[] = [];
  assert.deepEqual(toStyleEvent(reactionEvent(), policy({}, log)), {
    eventId: "style:T1:Ev1",
    kind: "added",
    channel: "D0DM",
    subjectId: OWNER,
    reactorId: OWNER,
    messageId: MESSAGE,
    requestId: "slack:T1:Ev1",
    part: 0,
    emoji: "thumbsup",
    polarity: "positive",
  });
  assert.deepEqual(log, []);
  // A member's reaction in an allowed channel works the same way, and stays their own scope.
  const member = toStyleEvent(reactionEvent({ user: MEMBER }), policy({
    attribute: () => ({ requestId: "slack:T1:Ev9", part: 1, conversationId: CHANNEL, senderId: MEMBER }),
  }));
  assert.deepEqual(member && { channel: member.channel, subjectId: member.subjectId, reactorId: member.reactorId },
    { channel: CHANNEL, subjectId: MEMBER, reactorId: MEMBER });
  // Custom emoji are named like standard ones, never appear on the positive list, and normalize.
  const custom = toStyleEvent(reactionEvent({ reaction: ":Party-Parrot:" }), policy());
  assert.equal(custom?.emoji, "party-parrot");
  assert.equal(custom?.polarity, "other");
  // Removing is recorded as itself: it withdraws, it never asks.
  assert.equal(toStyleEvent(reactionEvent({ type: "reaction_removed" }), policy())?.kind, "removed");
  // A reaction on a threaded reply carries the thread, so the question lands where the reply was.
  const threaded = toStyleEvent(reactionEvent(), policy({
    attribute: () => ({ ...ATTRIBUTED, threadTs: "1700000000.000100" }),
  }));
  assert.equal(threaded?.threadTs, "1700000000.000100");
});

test("the positive list decides only whether to disturb the user, never what to change", () => {
  for (const emoji of ["+1", "thumbsup", "heart", "tada", "100", "fire", "pray", "clap", "white_check_mark"]) {
    assert.ok(POSITIVE_REACTIONS.has(emoji), emoji);
  }
  // Two shorthands for the same thing, one on the list and one off it: the list is a courtesy to the
  // user's attention, not an attempt to say what they meant.
  assert.equal(POSITIVE_REACTIONS.has("thumbsup_all"), false);
  assert.equal(POSITIVE_REACTIONS.has("sob"), false, "even an unhappy-looking one is only 'ask', never 'negative'");
  assert.equal(normalizeEmojiName(":Party-Parrot:"), "party-parrot");
  assert.equal(normalizeEmojiName("thumbs up"), undefined, "untrusted input is refused at the boundary");
});

test("a reaction on a pruned or undelivered message attributes to nothing", async () => {
  await withInbox(async (inbox) => {
    assert.deepEqual(inbox.attributedByMessageId(MESSAGE), {
      requestId: "slack:T1:Ev1", part: 0, conversationId: "D0DM", senderId: OWNER,
    });
    assert.equal(inbox.attributedByMessageId("1700000000.999999"), undefined, "a reaction on nothing");
    // Pruning is what puts a delivered message out of reach; a reaction on one then has no target.
    for (let round = 0; round < 120; round += 1) {
      const requestId = `slack:T1:Ev-p${round}`;
      inbox.accept(100 + round, { requestId, conversationId: "D0DM", senderId: OWNER, text: "filler" });
      inbox.saveReply(requestId, "answer");
      inbox.confirmPart(requestId, 0, `1700000001.000${round}`);
    }
    inbox.prune();
    assert.equal(inbox.attributedByMessageId(MESSAGE), undefined);
    // A reply that is still being delivered has no message id to react to either.
    inbox.accept(999, { requestId: "slack:T1:Ev-pending", conversationId: "D0DM", senderId: OWNER, text: "x" });
    inbox.saveReply("slack:T1:Ev-pending", "answer");
    assert.equal(inbox.attributedByMessageId("1700000000.000300"), undefined);
  });
});

test("a stored signal asks once per scope per window, and silence is never chased", async () => {
  await withStore(async (store) => {
    const rig_ = rig({ store });
    await rig_.learning.handle(signal(), shutdown);
    assert.deepEqual(rig_.asked.map(({ channel }) => channel), ["D0DM"]);
    assert.equal(rig_.asked[0]?.text, STYLE_ASK_TEXT);
    assert.deepEqual(rig_.lines, ["STYLE_ASK"]);

    // Second reaction, same scope, inside the window: recorded, not asked, and it says why.
    await rig_.learning.handle(signal({ eventId: "style:T1:Ev2" }), shutdown);
    assert.equal(rig_.asked.length, 1);
    assert.deepEqual(rig_.lines, ["STYLE_ASK", "STYLE_ASK_SKIPPED_RATE"]);
    const rows = store.recent(10);
    assert.equal(rows.length, 2, "both reactions are on the record");
    assert.deepEqual(rows.map((row) => row.reason).filter(Boolean), [ASK_SKIPPED_RATE]);

    // Still inside 12h: nothing asks. Not answering is itself an answer.
    rig_.advance(ASK_WINDOW_MS - 1);
    await rig_.learning.handle(signal({ eventId: "style:T1:Ev3" }), shutdown);
    assert.equal(rig_.asked.length, 1);

    // Outside the window the scope may be asked again.
    rig_.advance(2);
    await rig_.learning.handle(signal({ eventId: "style:T1:Ev4" }), shutdown);
    assert.equal(rig_.asked.length, 2);
    // Another scope is its own budget: asking the owner says nothing about the member.
    await rig_.learning.handle(signal({
      eventId: "style:T1:Ev5", channel: CHANNEL, subjectId: MEMBER, reactorId: MEMBER,
    }), shutdown);
    assert.equal(rig_.asked.length, 3);
  });
});

test("a positive reaction is recorded and never asks, however often it keeps happening", async () => {
  await withStore(async (store) => {
    const rig_ = rig({ store });
    for (let round = 0; round < 3; round += 1) {
      await rig_.learning.handle(signal({ eventId: `style:T1:Ev${round}`, emoji: "tada", polarity: "positive" }), shutdown);
      rig_.advance(ASK_WINDOW_MS);
    }
    assert.deepEqual(rig_.asked, [], "there is nothing to change, so the user is never disturbed");
    assert.deepEqual(rig_.lines, []);
    assert.equal(store.recent(10).length, 3, "and it is still on the record");
  });
});

test("`observe` records and never asks; only `ask` sends the question", async () => {
  await withStore(async (store) => {
    const observing = rig({ store, mode: "observe" });
    await observing.learning.handle(signal(), shutdown);
    assert.deepEqual(observing.asked, []);
    assert.deepEqual(observing.lines, []);
    assert.equal(store.recent(10).length, 1, "proving the events arrive is what observe is for");
    assert.equal(store.askedAt("D0DM", OWNER), undefined, "nothing was asked, so nothing was marked");

    const asking = rig({ store, mode: "ask" });
    await asking.learning.handle(signal({ eventId: "style:T1:Ev-ask" }), shutdown);
    assert.equal(asking.asked.length, 1);
  });
});

test("taking the reaction back withdraws the question, so the next one may ask again", async () => {
  await withStore(async (store) => {
    const rig_ = rig({ store });
    await rig_.learning.handle(signal(), shutdown);
    assert.equal(rig_.asked.length, 1);
    assert.ok(store.askedAt("D0DM", OWNER) !== undefined);
    // The one place a stale mark could pin the scope quiet forever is a removal; it clears it.
    rig_.advance(60_000);
    await rig_.learning.handle(signal({ eventId: "style:T1:Ev-removed", kind: "removed" }), shutdown);
    assert.equal(store.askedAt("D0DM", OWNER), undefined, "the mark went with the reaction");
    assert.equal(rig_.asked.length, 1, "removing never itself asks");
    await rig_.learning.handle(signal({ eventId: "style:T1:Ev-again" }), shutdown);
    assert.equal(rig_.asked.length, 2, "so the same message can ask once more");
  });
});

test("a redelivered envelope records one row and asks once", async () => {
  await withStore(async (store) => {
    const rig_ = rig({ store });
    await rig_.learning.handle(signal(), shutdown);
    await rig_.learning.handle(signal(), shutdown);
    assert.equal(rig_.asked.length, 1, "Slack redelivers; the event id is the idempotency key");
    assert.equal(store.recent(10).length, 1);
  });
});

test("a failed ask marks nothing, so the next reaction still gets its question", async () => {
  await withStore(async (store) => {
    const failing = rig({ store, failing: true });
    await failing.learning.handle(signal(), shutdown);
    assert.equal(store.askedAt("D0DM", OWNER), undefined, "the user heard nothing, so the scope is not quiet");
    assert.deepEqual(failing.lines, ["Style ask failed: SLACK_NOT_IN_CHANNEL"]);
    const retry = rig({ store, start: failing.now() });
    await retry.learning.handle(signal({ eventId: "style:T1:Ev2" }), shutdown);
    assert.equal(retry.asked.length, 1);
  });
});

test("an interrupted run asks nothing rather than asking after the shutdown began", async () => {
  await withStore(async (store) => {
    const abort = new AbortController();
    abort.abort();
    const rig_ = rig({ store });
    await rig_.learning.handle(signal(), abort.signal);
    assert.deepEqual(rig_.asked, []);
    assert.equal(store.recent(10).length, 1, "the signal was already stored, which is the part that must survive");
  });
});

test("a scope keeps a bounded number of rows no matter how much it reacts", async () => {
  await withStore(async (store) => {
    for (let round = 0; round < SIGNALS_PER_SCOPE + 25; round += 1) {
      store.record(signal({ eventId: `style:T1:Ev${round}` }),
        new Date(Date.parse("2026-11-11T00:00:00.000Z") + round).toISOString());
    }
    assert.deepEqual(store.scopeCounts(), [
      { channel: "D0DM", subjectId: OWNER, rows: SIGNALS_PER_SCOPE, askedAt: null },
    ]);
    // The newest survive, so the bound costs only evidence nobody acts on.
    const rows = store.recent(SIGNALS_PER_SCOPE + 25);
    assert.equal(rows.length, SIGNALS_PER_SCOPE);
    assert.equal(rows[0]?.eventId, `style:T1:Ev${SIGNALS_PER_SCOPE + 24}`);
    assert.equal(rows.at(-1)?.eventId, "style:T1:Ev25");
    assert.equal(store.lastObservedAt(), rows[0]?.observedAt, "and the runtime probe reads the newest");
  });
});

test("an inert deployment records that reactions are arriving but cannot ask", async () => {
  await withStore(async (store) => {
    const rig_ = rig({ store, inert: true });
    assert.equal(rig_.learning.inert, true);
    await rig_.learning.handle(signal(), shutdown);
    assert.deepEqual(rig_.asked, [], "without reactions:read there are no events to ask about");
    assert.deepEqual(rig_.lines, [
      "STYLE_EVENT_SILENT: signals are recorded but asking is disabled (missing scope reactions:read)",
    ]);
    assert.equal(store.recent(10).length, 1, "the signal is still worth keeping: it proves events arrive");
    // Said once, not once per reaction: the log stays bounded.
    await rig_.learning.handle(signal({ eventId: "style:T1:Ev2" }), shutdown);
    assert.equal(rig_.lines.length, 1);
  });
});

test("a deployment that enabled asking also sees the missing scope, and never asks anyway", async () => {
  await withStore(async (store) => {
    const rig_ = rig({ store, inert: true, mode: "ask" });
    await rig_.learning.handle(signal(), shutdown);
    assert.deepEqual(rig_.asked, []);
    assert.deepEqual(rig_.lines, [
      "STYLE_EVENT_SILENT: signals are recorded but asking is disabled (missing scope reactions:read)",
    ]);
  });
});

test("with learning off the host says reactions are being delivered and dropped", async () => {
  const rig_ = rig({ mode: "off" });
  await rig_.learning.handle(signal(), shutdown);
  await rig_.learning.handle(signal({ eventId: "style:T1:Ev2" }), shutdown);
  assert.deepEqual(rig_.asked, []);
  assert.deepEqual(rig_.lines, [
    "STYLE_EVENT_SILENT: reactions are delivered but nothing is recorded (STYLE_LEARNING=off)",
  ]);
});

test("an existing signal database reopens with its rows intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-style-reopen-"));
  const path = join(directory, "style.sqlite");
  try {
    const first = new StyleStore(path);
    first.record(signal(), "2026-11-11T00:00:00.000Z");
    first.markAsked("style:T1:Ev1", "2026-11-11T00:00:00.000Z");
    first.close();
    const reopened = new StyleStore(path);
    try {
      // A new deployment reading an old volume finds the table already there and its rows still good.
      assert.equal(reopened.recent(10).length, 1);
      assert.equal(reopened.askedAt("D0DM", OWNER), "2026-11-11T00:00:00.000Z");
      assert.equal(reopened.lastObservedAt(), "2026-11-11T00:00:00.000Z");
      // And recording still works afterwards, which is what "the migration is a no-op" means here.
      assert.equal(reopened.record(signal({ eventId: "style:T1:Ev2" }), "2026-11-11T00:00:01.000Z"), true);
      assert.equal(reopened.recent(10).length, 2);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("answering buys the scope quiet, and the preference itself stays the model's job", async () => {
  await withStore(async (store) => {
    const rig_ = rig({ store });
    await rig_.learning.handle(signal(), shutdown);
    assert.equal(rig_.asked.length, 1);
    // The answer reaches the host as one ordinary message; there is no new channel for it.
    store.markAnswered("D0DM", OWNER, new Date(rig_.now()).toISOString());
    rig_.advance(30 * 60 * 1000);
    await rig_.learning.handle(signal({ eventId: "style:T1:Ev2" }), shutdown);
    assert.equal(rig_.asked.length, 1, "only accounting: no second question right after an answer");
    assert.equal(store.recent(10).length, 2, "but the reaction still went on the record");
  });
});

test("the ask text names what is uncertain and makes not answering explicit", () => {
  // Host text, not model output: it is the one thing the user sees without paying for a round.
  assert.equal(STYLE_ASK_TEXT, "你贴的表情我不确定是满意还是不满意。要我改什么吗？回一句就行，不理我也没关系。");
  assert.doesNotMatch(STYLE_ASK_TEXT, /\n/);
  assert.ok(STYLE_ASK_TEXT.length <= 120);
  assert.ok(STYLE_ASK_TEXT.length > 20);
});

test("a store failure is named in the log and still reaches the caller", async () => {
  const rig_ = rig({
    mode: "ask",
    store: { record: () => { throw new Error("disk full"); } } as unknown as StyleStore,
  });
  // Named before it propagates: the envelope stays unacknowledged and the reason has to be visible.
  await assert.rejects(rig_.learning.handle(signal(), shutdown), /disk full/);
  assert.deepEqual(rig_.lines, ["STYLE_STORE_FAILED: EXECUTION_ERROR"]);
  assert.deepEqual(rig_.asked, [], "nothing is ever asked on the strength of an unstored signal");
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Inbox } from "../src/inbox.js";
import { normalizeEmojiName } from "../src/reactions.js";
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

const OWNER = "U0OWNER123";
const MEMBER = "U0MEMBER123";
const CHANNEL = "C0CHANNEL12";
const MESSAGE = "1700000000.000300";

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
  try {
    inbox.accept(1, { requestId: "web:T1:Ev1", conversationId: "D0DM", senderId: OWNER, text: "hi" });
    inbox.saveReply("web:T1:Ev1", "answer");
    inbox.confirmPart("web:T1:Ev1", 0, MESSAGE);
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
        throw Object.assign(new Error("host send was refused (NOT_IN_CHANNEL)"), { code: "HOST_NOT_IN_CHANNEL" });
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
  requestId: "web:T1:Ev1",
  emoji: "thinking_face",
  polarity: "other",
  ...event,
});

const shutdown = new AbortController().signal;

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
      requestId: "web:T1:Ev1", part: 0, conversationId: "D0DM", senderId: OWNER,
    });
    assert.equal(inbox.attributedByMessageId("1700000000.999999"), undefined, "a reaction on nothing");
    // Pruning is what puts a delivered message out of reach; a reaction on one then has no target.
    for (let round = 0; round < 120; round += 1) {
      const requestId = `web:T1:Ev-p${round}`;
      inbox.accept(100 + round, { requestId, conversationId: "D0DM", senderId: OWNER, text: "filler" });
      inbox.saveReply(requestId, "answer");
      inbox.confirmPart(requestId, 0, `1700000001.000${round}`);
    }
    inbox.prune();
    assert.equal(inbox.attributedByMessageId(MESSAGE), undefined);
    // A reply that is still being delivered has no message id to react to either.
    inbox.accept(999, { requestId: "web:T1:Ev-pending", conversationId: "D0DM", senderId: OWNER, text: "x" });
    inbox.saveReply("web:T1:Ev-pending", "answer");
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
    assert.equal(rig_.asked.length, 1, "A redelivered event is the same row; the event id is the idempotency key");
    assert.equal(store.recent(10).length, 1);
  });
});

test("a failed ask marks nothing, so the next reaction still gets its question", async () => {
  await withStore(async (store) => {
    const failing = rig({ store, failing: true });
    await failing.learning.handle(signal(), shutdown);
    assert.equal(store.askedAt("D0DM", OWNER), undefined, "the user heard nothing, so the scope is not quiet");
    assert.deepEqual(failing.lines, ["Style ask failed: HOST_NOT_IN_CHANNEL"]);
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

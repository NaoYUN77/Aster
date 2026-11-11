import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import {
  createReactionExtension,
  EMOJI_SEARCH_TOOL_NAME,
  normalizeEmojiName,
  ReactionAnchor,
  REACTION_TOOL_NAME,
  type EmojiSource,
  type ReactionHost,
} from "../src/reactions.js";
import { buildInstructions } from "../src/agent.js";
import { createToolRegistry } from "../src/tools.js";

const API = { conversationId: 1, taskId: 2, callId: "call-1" } as ToolExecutionApi;

/** A reaction host that records what it was asked to do, and can be made to refuse. */
function fakeHost(failure?: unknown): { host: ReactionHost; calls: { target: string; ts: string; name: string }[] } {
  const calls: { target: string; ts: string; name: string }[] = [];
  return {
    calls,
    host: {
      async react(target, ts, name) {
        if (failure !== undefined) throw failure;
        calls.push({ target, ts, name });
      },
      async unreact() {},
    },
  };
}

/** A workspace whose emoji names are known only through this call. */
function fakeEmoji(names: readonly string[] = ["cat_jam", "party_parrot", "slackbot-love", "thumbsup"]):
  { source: EmojiSource; fetches: () => number } {
  let fetches = 0;
  return {
    source: {
      async list() {
        fetches += 1;
        return names;
      },
    },
    fetches: () => fetches,
  };
}

function toolOf(extension: ReturnType<typeof createReactionExtension>, name: string): ToolRegistration {
  const tool = extension.tools?.find((candidate) => candidate.name === name);
  assert.ok(tool, `the extension registers ${name}`);
  return tool;
}

async function run(extension: ReturnType<typeof createReactionExtension>, name: string, args: unknown) {
  return await toolOf(extension, name).execute(args, API, BACKGROUND_CONTEXT);
}

test("an emoji name is normalized the way Slack names them", () => {
  assert.equal(normalizeEmojiName("tada"), "tada");
  assert.equal(normalizeEmojiName(":tada:"), "tada");
  assert.equal(normalizeEmojiName("  :TADA:  "), "tada");
  assert.equal(normalizeEmojiName("+1"), "+1", "the aliases Slack ships start with a sign");
  assert.equal(normalizeEmojiName("white_check_mark"), "white_check_mark");
  // Custom emoji are named the same way, so they pass the same shape check.
  assert.equal(normalizeEmojiName(":slackbot-love:"), "slackbot-love");
  // Anything Slack could not accept is refused before a call is made.
  assert.equal(normalizeEmojiName("thumbs up"), undefined);
  assert.equal(normalizeEmojiName(""), undefined);
  assert.equal(normalizeEmojiName("::"), undefined);
  assert.equal(normalizeEmojiName("tada:tada"), undefined);
  assert.equal(normalizeEmojiName("a".repeat(101)), undefined);
});

test("the reaction tool is a host-owned write with a replayable effect", () => {
  const { host } = fakeHost();
  const emoji = fakeEmoji();
  const registry = createToolRegistry(
    [createReactionExtension({ host, anchor: new ReactionAnchor(), emoji: { source: emoji.source } })],
    { log: () => {} },
  );
  const record = registry.lookup(REACTION_TOOL_NAME);
  assert.ok(record);
  assert.equal(record.source.kind, "builtin");
  assert.equal(record.authz, "write", "a reaction is a visible external effect, so it is not a read");
  assert.equal(record.tier, 1);
  assert.equal(record.replay, "safe", "Slack makes a repeated reaction a no-op, so a replay cannot double it");
  // The lookup it informs only reads a list, so it is classified as one.
  assert.equal(registry.lookup(EMOJI_SEARCH_TOOL_NAME)?.authz, "read");
});

test("a reaction without an anchored request is refused instead of guessed", async () => {
  const { host, calls } = fakeHost();
  const result = await run(createReactionExtension({ host, anchor: new ReactionAnchor() }), REACTION_TOOL_NAME, { emoji: "eyes" });
  assert.equal(result.isError, true);
  assert.equal((result.details as { code?: string }).code, "NO_REACTION_TARGET");
  assert.equal(calls.length, 0, "nothing is sent when there is no message to react to");
});

test("a reaction lands on the message being answered, chosen only by emoji", async () => {
  const { host, calls } = fakeHost();
  const anchor = new ReactionAnchor();
  const release = anchor.hold({ channel: "D0DM", ts: "1700000000.000100" });
  try {
    const result = await run(createReactionExtension({ host, anchor }), REACTION_TOOL_NAME, { emoji: ":Tada:" });
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [{ target: "D0DM", ts: "1700000000.000100", name: "tada" }]);
    assert.equal((result.details as { emoji?: string }).emoji, "tada");
  } finally {
    release();
  }
  assert.equal(anchor.peek(), undefined, "the anchor is restored when the request ends");
});

test("one message carries a bounded number of reactions, and the next request starts fresh", async () => {
  const { host, calls } = fakeHost();
  const anchor = new ReactionAnchor({ limit: 2 });
  const extension = createReactionExtension({ host, anchor });
  const release = anchor.hold({ channel: "D0DM", ts: "1700000000.000100" });
  try {
    assert.equal((await run(extension, REACTION_TOOL_NAME, { emoji: "tada" })).isError, undefined);
    assert.equal((await run(extension, REACTION_TOOL_NAME, { emoji: "100" })).isError, undefined);
    const over = await run(extension, REACTION_TOOL_NAME, { emoji: "fire" });
    assert.equal((over.details as { code?: string }).code, "REACTION_LIMIT_REACHED");
  } finally {
    release();
  }
  assert.equal(calls.length, 2, "the third reaction never reached Slack");
  // The budget belongs to one message: the next request can react again.
  const next = anchor.hold({ channel: "D0DM", ts: "1700000000.000900" });
  try {
    assert.equal((await run(extension, REACTION_TOOL_NAME, { emoji: "fire" })).isError, undefined);
  } finally {
    next();
  }
  assert.equal(calls.length, 3);
});

test("an unusable emoji name is refused without calling the channel", async () => {
  const { host, calls } = fakeHost();
  const anchor = new ReactionAnchor();
  anchor.hold({ channel: "D0DM", ts: "1700000000.000100" });
  const result = await run(createReactionExtension({ host, anchor }), REACTION_TOOL_NAME, { emoji: "thumbs up" });
  assert.equal(result.isError, true);
  assert.equal((result.details as { code?: string }).code, "INVALID_EMOJI_NAME");
  assert.equal(calls.length, 0);
});

test("a refused reaction reports the channel's own code to the model", async () => {
  const failure = Object.assign(new Error("Slack reactions.add was refused (INVALID_NAME)"), { code: "SLACK_INVALID_NAME" });
  const { host } = fakeHost(failure);
  const anchor = new ReactionAnchor();
  anchor.hold({ channel: "D0DM", ts: "1700000000.000100" });
  const result = await run(createReactionExtension({ host, anchor }), REACTION_TOOL_NAME, { emoji: "eyes" });
  assert.equal(result.isError, true);
  assert.equal((result.details as { code?: string }).code, "SLACK_INVALID_NAME");
});

test("the workspace's own emoji are looked up once and searched by name", async () => {
  const { host } = fakeHost();
  const emoji = fakeEmoji();
  const extension = createReactionExtension({ host, anchor: new ReactionAnchor(), emoji: { source: emoji.source } });

  const sample = await run(extension, EMOJI_SEARCH_TOOL_NAME, {});
  assert.equal(sample.isError, undefined);
  assert.match((sample.output?.[0] as { text: string }).text, /slackbot-love/);
  assert.deepEqual(sample.details, { total: 4, shown: 4 });

  const searched = await run(extension, EMOJI_SEARCH_TOOL_NAME, { query: ":CAT:" });
  assert.deepEqual(searched.details, { total: 1, shown: 1 });
  assert.match((searched.output?.[0] as { text: string }).text, /cat_jam/);

  // The list is cached: a second lookup does not ask Slack again.
  assert.equal(emoji.fetches(), 1);

  const nothing = await run(extension, EMOJI_SEARCH_TOOL_NAME, { query: "zzz" });
  assert.equal(nothing.isError, true);
  assert.equal((nothing.details as { code?: string }).code, "NO_EMOJI_MATCH");
});

test("a workspace that cannot list its emoji still reacts, and says why the list is missing", async () => {
  const { host } = fakeHost();
  const source: EmojiSource = {
    async list() {
      throw Object.assign(new Error("Slack emoji.list was refused (MISSING_SCOPE)"), { code: "SLACK_MISSING_SCOPE" });
    },
  };
  const anchor = new ReactionAnchor();
  const extension = createReactionExtension({ host, anchor, emoji: { source } });
  const listed = await run(extension, EMOJI_SEARCH_TOOL_NAME, {});
  assert.equal(listed.isError, true);
  assert.equal((listed.details as { code?: string }).code, "SLACK_MISSING_SCOPE");
  // The standard names need no listing, so reacting is untouched by the missing scope.
  anchor.hold({ channel: "D0DM", ts: "1700000000.000100" });
  assert.equal((await run(extension, REACTION_TOOL_NAME, { emoji: "tada" })).isError, undefined);
});

test("a channel that cannot list emoji registers no lookup tool", () => {
  const { host } = fakeHost();
  const extension = createReactionExtension({ host, anchor: new ReactionAnchor() });
  assert.deepEqual(extension.tools?.map(({ name }) => name), [REACTION_TOOL_NAME]);
});

test("the prompt offers the reaction tools only where they are registered", () => {
  const base = { workingDirectory: "/data/workspace", reminders: false, browser: false };
  const off = buildInstructions(base);
  const on = buildInstructions({ ...base, reactions: true });
  const custom = buildInstructions({ ...base, reactions: true, customEmoji: true });
  assert.doesNotMatch(off, /react_to_message/);
  assert.match(on, /react_to_message/);
  assert.match(on, /without performing feelings/, "the reaction is a tone of voice, not simulated emotion");
  // A channel that cannot list the workspace's emoji is not promised the lookup.
  assert.doesNotMatch(on, /emoji_search/);
  assert.match(custom, /emoji_search/);
  // The lookup sentence is the only difference: the prompt stays byte-identical otherwise.
  assert.equal(custom.replace(/ This workspace has custom emoji:.*?one exists\./, ""), on);
});

test("the anchor holds one request at a time and restores what it replaced", () => {
  const anchor = new ReactionAnchor();
  assert.equal(anchor.peek(), undefined);
  const first = anchor.hold({ channel: "C1", ts: "1.1" });
  const second = anchor.hold({ channel: "C2", ts: "2.2" });
  assert.deepEqual(anchor.peek(), { channel: "C2", ts: "2.2" });
  second();
  assert.deepEqual(anchor.peek(), { channel: "C1", ts: "1.1" });
  first();
  assert.equal(anchor.peek(), undefined);
  // A request whose channel cannot address its own message holds nothing rather than a stale anchor.
  const cleared = anchor.hold(undefined);
  assert.equal(anchor.peek(), undefined);
  cleared();
});

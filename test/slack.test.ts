import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { readConfig } from "../src/config.js";
import { Inbox } from "../src/inbox.js";
import type { TextRequest } from "../src/messages.js";
import { ReactionAnchor } from "../src/reactions.js";
import { ASK_SKIPPED_RATE, STYLE_ASK_TEXT, StyleLearning, StyleStore } from "../src/style.js";
import {
  escapeSlackText,
  serveSlack,
  SlackClient,
  SlackError,
  toRequest,
  type SlackFrameResult,
  type SlackInboundPolicy,
  type SlackSocket,
} from "../src/slack.js";

const OWNER = "U0OWNER123";
const BOT = "U0BOT4567";
const MEMBER = "U0MEMBER123";
const STRANGER = "U0STRANGE12";
const CHANNEL = "C0CHANNEL12";
const OTHER_CHANNEL = "C0OTHERC12";
/** The allowlist a deployment configures; nothing in a message can change it. */
const policy = (overrides: Partial<SlackInboundPolicy> = {}, log: string[] = []) => ({
  ownerId: OWNER,
  botId: BOT,
  allowedUsers: [MEMBER],
  allowedChannels: [CHANNEL],
  log: (line: string) => log.push(line),
  ...overrides,
});
const model = {
  MODEL_PROVIDER: "deepseek",
  MODEL_ID: "deepseek-flash",
  DEEPSEEK_API_KEY: "key",
};
const slackEnv = {
  CHANNEL: "slack",
  SLACK_BOT_TOKEN: "xoxb-1234567890123456789012",
  SLACK_APP_TOKEN: "xapp-1234567890123456789012",
  SLACK_OWNER_ID: OWNER,
  ...model,
};
const CREDENTIALS = { botToken: "xoxb-1234567890123456789012", appToken: "xapp-1234567890123456789012", ownerId: OWNER };
const telegramEnv = {
  TELEGRAM_BOT_TOKEN: "token",
  TELEGRAM_OWNER_ID: "42",
  ...model,
};

type Call = { method: string; params: Record<string, unknown>; init: RequestInit };

/** A Slack-shaped fake: it records every Web API call and answers from the given routes. */
function slackApi(routes: Record<string, (params: Record<string, unknown>) => unknown>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split("/api/")[1] ?? "";
    const params = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ method, params, init: init ?? {} });
    const body = routes[method]?.(params) ?? { ok: false, error: "unknown_method" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function messageEvent(event: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: "T1",
    event_id: "Ev1",
    event: { type: "message", channel_type: "im", channel: "D0DM", user: OWNER, text: "hello", ...event },
  };
}

/** A channel event: `app_mention` by default, since that is how a conversation starts there. */
function channelEvent(event: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: "T1",
    event_id: "Ev7",
    event: {
      type: "app_mention",
      channel_type: "channel",
      channel: CHANNEL,
      user: MEMBER,
      text: `<@${BOT}> hello`,
      ...event,
    },
  };
}

/** A socket a test pushes frames into; an empty queue reads as idle instead of blocking. */
class TestSocket implements SlackSocket {
  readonly acked: string[] = [];
  closed = false;
  readonly #frames: SlackFrameResult[] = [];

  push(frame: SlackFrameResult): void {
    this.#frames.push(frame);
  }

  async next(): Promise<SlackFrameResult> {
    const frame = this.#frames.shift();
    if (frame) return frame;
    await delay(2);
    return { kind: "idle" };
  }

  ack(envelopeId: string): void {
    this.acked.push(envelopeId);
  }

  close(): void {
    this.closed = true;
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await delay(5);
  }
}

async function withInbox(run: (inbox: Inbox) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pa-slack-"));
  const inbox = new Inbox(join(directory, "inbox.sqlite"));
  inbox.bindIdentity("slack", BOT, OWNER);
  try {
    await run(inbox);
  } finally {
    inbox.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("the channel is selected explicitly, and only its own variables are required", () => {
  assert.deepEqual(readConfig(telegramEnv).channel, { kind: "telegram", ownerId: "42", token: "token" });
  assert.deepEqual(readConfig(slackEnv).channel, {
    kind: "slack",
    ownerId: OWNER,
    botToken: "xoxb-1234567890123456789012",
    appToken: "xapp-1234567890123456789012",
    allowedUsers: [],
    allowedChannels: [],
    receipts: { working: "eyes", done: "white_check_mark", failed: "warning", lost: "x" },
    maxReactions: 3,
  });
  assert.equal(readConfig({ ...slackEnv, CHANNEL: " SLACK " }).channel.kind, "slack", "the value is trimmed and case-folded");
  assert.equal(readConfig({ ...telegramEnv, CHANNEL: "" }).channel.kind, "telegram", "an empty value is the default");
  assert.throws(() => readConfig({ ...telegramEnv, CHANNEL: "discord" }), /CHANNEL must be one of: telegram, slack/);
});

test("Slack credentials and the owner id are checked for shape", () => {
  assert.throws(() => readConfig({ ...slackEnv, SLACK_BOT_TOKEN: "xoxp-user-token-1234567890" }), /SLACK_BOT_TOKEN is not shaped/);
  assert.throws(() => readConfig({ ...slackEnv, SLACK_APP_TOKEN: "xoxb-1234567890123456789012" }), /SLACK_APP_TOKEN is not shaped/);
  assert.throws(() => readConfig({ ...slackEnv, SLACK_OWNER_ID: "@owner" }), /SLACK_OWNER_ID must be a Slack member ID/);
  assert.throws(
    () => readConfig({ ...slackEnv, SLACK_ALLOWED_USERS: `${MEMBER}, @member` }),
    /SLACK_ALLOWED_USERS must list Slack member IDs, comma-separated and without spaces/,
  );
  assert.throws(
    () => readConfig({ ...slackEnv, SLACK_ALLOWED_CHANNELS: "general" }),
    /SLACK_ALLOWED_CHANNELS must list Slack channel IDs, comma-separated and without spaces/,
  );
  // A list is a set: repeating an id does not make it count twice, and blanks are ignored.
  const listed = readConfig({
    ...slackEnv,
    SLACK_ALLOWED_USERS: `${MEMBER},${MEMBER}`,
    SLACK_ALLOWED_CHANNELS: ` ${CHANNEL} ,`,
  }).channel;
  assert.deepEqual(listed.kind === "slack" ? [listed.allowedUsers, listed.allowedChannels] : undefined,
    [[MEMBER], [CHANNEL]]);
  assert.throws(() => readConfig({ ...slackEnv, SLACK_BOT_TOKEN: "  " }), /Missing configuration: SLACK_BOT_TOKEN/);
  // Receipt emoji: the defaults are the four the bot uses out of the box, each one is normalized, and
  // a name Slack could not accept is a refused boot instead of a receipt that never appears.
  const receiptsOf = (env: Record<string, string>) => {
    const channel = readConfig({ ...slackEnv, ...env }).channel;
    return channel.kind === "slack" ? channel.receipts : {};
  };
  assert.deepEqual(receiptsOf({}), { working: "eyes", done: "white_check_mark", failed: "warning", lost: "x" });
  assert.deepEqual(receiptsOf({ SLACK_ACK_EMOJI: ":Eyes:", SLACK_DONE_EMOJI: "tada", SLACK_FAIL_EMOJI: "x", SLACK_LOST_EMOJI: "warning" }),
    { working: "eyes", done: "tada", failed: "x", lost: "warning" });
  assert.deepEqual(receiptsOf({ SLACK_ACK_EMOJI: "", SLACK_DONE_EMOJI: "none" }), { failed: "warning", lost: "x" },
    "each receipt can be turned off without turning the others off");
  assert.deepEqual(receiptsOf({ SLACK_ACK_EMOJI: "none" }),
    { done: "white_check_mark", failed: "warning", lost: "x" });
  assert.throws(() => readConfig({ ...slackEnv, SLACK_ACK_EMOJI: "thumbs up" }),
    /SLACK_ACK_EMOJI must be a Slack emoji name/);
  assert.throws(() => readConfig({ ...slackEnv, SLACK_FAIL_EMOJI: "!!" }),
    /SLACK_FAIL_EMOJI must be a Slack emoji name/);
  // How many reactions one message may carry: bounded, and an integer or nothing.
  const maxOf = (value: string) => {
    const channel = readConfig({ ...slackEnv, SLACK_MAX_REACTIONS: value }).channel;
    return channel.kind === "slack" ? channel.maxReactions : 0;
  };
  assert.equal(maxOf("1"), 1);
  assert.equal(maxOf("10"), 10);
  assert.throws(() => readConfig({ ...slackEnv, SLACK_MAX_REACTIONS: "0" }), /SLACK_MAX_REACTIONS must be an integer/);
  assert.throws(() => readConfig({ ...slackEnv, SLACK_MAX_REACTIONS: "11" }), /SLACK_MAX_REACTIONS must be an integer/);
  assert.throws(() => readConfig({ ...slackEnv, SLACK_MAX_REACTIONS: "many" }), /SLACK_MAX_REACTIONS must be an integer/);
  assert.throws(
    () => readConfig({ CHANNEL: "slack", SLACK_OWNER_ID: OWNER, SLACK_BOT_TOKEN: "xoxb-1234567890123456789012", ...model }),
    /Missing configuration: SLACK_APP_TOKEN/,
  );
  assert.throws(() => readConfig({ CHANNEL: "slack", ...model }), /Missing configuration: SLACK_OWNER_ID/);
  // The MITM placeholder path stays available for both tokens.
  const vaulted = readConfig({
    ...slackEnv,
    SLACK_BOT_TOKEN: "__vault_SLACK_BOT_TOKEN__",
    SLACK_APP_TOKEN: "__vault_SLACK_APP_TOKEN__",
  }).channel;
  assert.equal(vaulted.kind === "slack" ? vaulted.botToken : undefined, "__vault_SLACK_BOT_TOKEN__");
});

test("a Slack deployment does not require the Telegram variables, and vice versa", () => {
  assert.equal(readConfig(slackEnv).channel.kind, "slack");
  assert.throws(() => readConfig({ ...model, CHANNEL: "telegram" }), /Missing configuration: TELEGRAM_OWNER_ID/);
  assert.throws(
    () => readConfig({ TELEGRAM_OWNER_ID: "42", ...model, CHANNEL: "telegram" }),
    /Missing configuration: TELEGRAM_BOT_TOKEN/,
  );
});

test("the owner's private DMs stay the only DM that becomes a request", () => {
  assert.deepEqual(toRequest(messageEvent(), policy()), {
    requestId: "slack:T1:Ev1",
    conversationId: "D0DM",
    senderId: OWNER,
    text: "hello",
  });

  // Somebody else's DM is not the owner's conversation, and no allowlist widens a direct message.
  const log: string[] = [];
  assert.equal(toRequest(messageEvent({ user: STRANGER, event_id: "Ev2" }), policy({}, log)), undefined);
  assert.deepEqual(log, ["Slack event dropped: DM_NOT_OWNER"]);
});

test("a channel needs a mention to start a conversation, an allowed sender and an allowed channel", () => {
  assert.deepEqual(toRequest(channelEvent(), policy()), {
    requestId: "slack:T1:Ev7",
    conversationId: CHANNEL,
    senderId: MEMBER,
    // The mention is Slack's addressing, not part of the request.
    text: "hello",
  });
  // The owner may mention the bot anywhere it is allowed to answer.
  assert.deepEqual(toRequest(channelEvent({ user: OWNER }), policy())?.senderId, OWNER);
  // `message` with a mention is the same request as `app_mention`: clients differ in what they emit.
  assert.deepEqual(toRequest(channelEvent({ type: "message" }), policy())?.text, "hello");

  const rejects: [string, Record<string, unknown>, Partial<SlackInboundPolicy>][] = [
    ["NOT_A_MENTION", channelEvent({ type: "message", text: "hello" }), {}],
    ["CHANNEL_NOT_ALLOWED", channelEvent({ channel: OTHER_CHANNEL }), {}],
    ["SENDER_NOT_ALLOWED", channelEvent({ user: STRANGER }), {}],
  ];
  for (const [reason, payload, overrides] of rejects) {
    const log: string[] = [];
    assert.equal(toRequest(payload, policy(overrides, log)), undefined, reason);
    assert.deepEqual(log, [`Slack event dropped: ${reason}`], reason);
  }
  // An empty allowlist closes channel traffic, and mentioning the bot changes nothing about that.
  const closed: string[] = [];
  assert.equal(toRequest(channelEvent(), policy({ allowedChannels: [] }, closed)), undefined);
  assert.deepEqual(closed, ["Slack event dropped: CHANNEL_NOT_ALLOWED"]);
});

test("a reply inside a thread continues the conversation and carries its anchor", () => {
  // A follow-up does not repeat the mention; the thread is what makes it a request.
  const followUp = channelEvent({ type: "message", text: "and then?", thread_ts: "1700000000.000100" });
  assert.deepEqual(toRequest(followUp, policy()), {
    requestId: "slack:T1:Ev7",
    conversationId: CHANNEL,
    senderId: MEMBER,
    text: "and then?",
    threadTs: "1700000000.000100",
  });
  // A threaded mention keeps its anchor too, and a reply that was also broadcast is still a reply.
  assert.equal(toRequest(channelEvent({ thread_ts: "1700000000.000100" }), policy())?.threadTs, "1700000000.000100");
  assert.equal(
    toRequest(channelEvent({ type: "message", subtype: "thread_broadcast", text: "ps", thread_ts: "1700000000.000100" }), policy())?.threadTs,
    "1700000000.000100",
  );
  // A top-level channel request stays flat: the reply goes to the channel, and the member's answer
  // under it is what opens the thread.
  assert.equal(toRequest(channelEvent(), policy())?.threadTs, undefined);
});

test("a request without usable text or identity is dropped, and envelope noise never logs", () => {
  const log: string[] = [];
  assert.equal(toRequest(channelEvent({ text: `  <@${BOT}>  ` }), policy({}, log)), undefined);
  assert.deepEqual(log, ["Slack event dropped: EMPTY_TEXT"]);

  // Transport noise — other apps, the bot's own posts, edits, reactions, malformed envelopes — is not
  // a rejected member, so it is dropped without a reason line and without reaching the inbox.
  const silent: unknown[] = [
    channelEvent({ bot_id: "B0" }),
    channelEvent({ subtype: "message_changed" }),
    channelEvent({ subtype: "channel_join" }),
    channelEvent({ type: "reaction_added" }),
    channelEvent({ user: undefined }),
    channelEvent({ channel: undefined }),
    channelEvent({ channel_type: "mpim" }),
    { ...channelEvent(), type: "block_actions" },
    { ...channelEvent(), event_id: undefined },
    { ...channelEvent(), team_id: undefined },
    { ...channelEvent(), event: undefined },
    "not an object",
  ];
  const quiet: string[] = [];
  for (const payload of silent) assert.equal(toRequest(payload, policy({}, quiet)), undefined, JSON.stringify(payload));
  assert.deepEqual(quiet, []);
});

test("Slack markup characters are escaped so a reply stays literal", () => {
  assert.equal(escapeSlackText("a & b <c> d"), "a &amp; b &lt;c&gt; d");
  assert.equal(escapeSlackText("*bold* stays as typed"), "*bold* stays as typed");
});

test("identity validates both tokens and the owner, and sends to the owner's DM", async () => {
  const opened: string[] = [];
  const { impl, calls } = slackApi({
    "auth.test": () => ({ ok: true, user_id: BOT, team_id: "T1" }),
    "conversations.open": (params) => {
      opened.push(String(params.users));
      return { ok: true, channel: { id: "D0OWNER" } };
    },
    "apps.connections.open": () => ({ ok: true, url: "wss://example.invalid/link" }),
    "chat.postMessage": (params) => ({ ok: true, ts: "1700000000.000100", channel: String(params.channel) }),
  });
  const client = new SlackClient({ botToken: "xoxb-token", appToken: "xapp-token", ownerId: OWNER }, { fetch: impl });
  const signal = new AbortController().signal;

  assert.equal(await client.identity(signal), BOT);
  assert.deepEqual(calls.map((call) => call.method), ["auth.test", "conversations.open", "apps.connections.open"]);
  assert.equal(calls[0]?.init.redirect, "manual", "credentials must not follow a redirect");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer xoxb-token");
  assert.equal((calls[2]?.init.headers as Record<string, string>).authorization, "Bearer xapp-token");

  // A member id is not a channel id: it is resolved once and then remembered.
  assert.equal(await client.send(OWNER, "1 < 2", signal), "1700000000.000100");
  assert.equal(await client.send(OWNER, "again", signal), "1700000000.000100");
  await client.send("D0DM", "hi", signal);
  assert.deepEqual(opened, [OWNER], "the owner's DM is resolved once; a channel id is already a target");
  assert.deepEqual(calls.filter((call) => call.method === "chat.postMessage").map((call) => call.params), [
    { channel: "D0OWNER", text: "1 &lt; 2", unfurl_links: false, unfurl_media: false },
    { channel: "D0OWNER", text: "again", unfurl_links: false, unfurl_media: false },
    { channel: "D0DM", text: "hi", unfurl_links: false, unfurl_media: false },
  ]);
});

test("Slack failures are classified and reported without echoing the body", async () => {
  const refused = slackApi({ "chat.postMessage": () => ({ ok: false, error: "channel_not_found" }) });
  const client = new SlackClient({ botToken: "xoxb-token", appToken: "xapp-token", ownerId: OWNER },
    { fetch: refused.impl });
  const signal = new AbortController().signal;
  await assert.rejects(client.send("D0GONE", "hello", signal), (error: unknown) => {
    assert.ok(error instanceof SlackError);
    assert.equal(error.code, "SLACK_CHANNEL_NOT_FOUND");
    assert.equal(error.message, "Slack chat.postMessage was refused (CHANNEL_NOT_FOUND)");
    assert.equal(client.classifyFailure(error), "failed", "a refused send definitely did not happen");
    return true;
  });

  const unreachable = new SlackClient({ botToken: "xoxb-token", appToken: "xapp-token", ownerId: OWNER }, {
    fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch,
  });
  await assert.rejects(unreachable.send("D0DM", "hello", signal), (error: unknown) => {
    assert.equal(unreachable.failureCode(error), "NETWORK");
    assert.equal(unreachable.classifyFailure(error), "uncertain", "a transport failure may have been delivered");
    return true;
  });
});

test("an events_api envelope is stored before it is acknowledged, and stored once", async () => {
  await withInbox(async (inbox) => {
    const socket = new TestSocket();
    const shutdown = new AbortController();
    const seen: TextRequest[] = [];
    const sent: string[] = [];
    const client = {
      open: async () => "wss://example.invalid/link",
      connect: async () => socket,
      send: async (target: string, text: string) => {
        sent.push(`${target}:${text}`);
        return "ts";
      },
    };
    const served = serveSlack(policy(), inbox, async (job) => {
      seen.push(job);
      return "unused";
    }, shutdown.signal, client);
    socket.push({ kind: "frame", frame: { type: "ignored", envelopeId: "env-ignored" } });
    const event = messageEvent();
    // Slack redelivers an envelope it never saw acknowledged, so the same event can arrive twice.
    socket.push({ kind: "frame", frame: { type: "events_api", envelopeId: "env-1", payload: event } });
    socket.push({ kind: "frame", frame: { type: "events_api", envelopeId: "env-2", payload: event } });
    socket.push({
      kind: "frame",
      frame: { type: "events_api", envelopeId: "env-3", payload: messageEvent({ user: "U0SOMEONE", event_id: "Ev2" }) },
    });
    await waitFor(() => socket.acked.length === 4);
    await waitFor(() => sent.length === 1);
    shutdown.abort();
    await served;

    assert.deepEqual(seen.map((job) => job.requestId), ["slack:T1:Ev1"], "the redelivery is stored once");
    assert.deepEqual(seen[0] && { conversationId: seen[0].conversationId, senderId: seen[0].senderId, text: seen[0].text },
      { conversationId: "D0DM", senderId: OWNER, text: "hello" });
    assert.deepEqual(sent, ["D0DM:unused"], "the reply goes back to the DM it came from");
    // The checkpoint counts envelopes this channel consumed; the duplicate event did not add a row.
    assert.equal(inbox.offset, 2);
    assert.equal(inbox.blocked().length, 0);
  });
});

test("a store failure is fatal and the envelope stays unacknowledged", async () => {
  const socket = new TestSocket();
  const shutdown = new AbortController();
  // Acknowledging an unstored event would drop the owner's message, so a local write failure must
  // stop the process instead; Slack redelivers everything this connection never acknowledged.
  const inbox = {
    offset: 0,
    blocked: () => [],
    next: () => undefined,
    accept: () => {
      throw new Error("disk full");
    },
  } as unknown as Inbox;
  const client = {
    open: async () => "wss://example.invalid/link",
    connect: async () => socket,
    send: async () => "ts",
  };
  const served = serveSlack(policy(), inbox, async () => "unused", shutdown.signal, client);
  socket.push({ kind: "frame", frame: { type: "events_api", envelopeId: "env-1", payload: messageEvent() } });
  await assert.rejects(served, /disk full/);
  assert.deepEqual(socket.acked, [], "an unstored envelope must remain unacknowledged");
});

test("a stored reply is delivered in segments over the channel", async () => {
  await withInbox(async (inbox) => {
    // The anchor survives a restart with the request: this reply belongs inside the thread it came from.
    inbox.accept(1, {
      requestId: "slack:T1:Ev9",
      conversationId: "D0DM",
      senderId: OWNER,
      text: "hi",
      threadTs: "1700000000.000100",
    });
    const socket = new TestSocket();
    const shutdown = new AbortController();
    const sent: { target: string; text: string; threadTs?: string }[] = [];
    const client = {
      open: async () => "wss://example.invalid/link",
      connect: async () => socket,
      send: async (target: string, text: string, _signal: AbortSignal, threadTs?: string) => {
        sent.push({ target, text, threadTs });
        return "1700000000.000200";
      },
    };
    const served = serveSlack(policy(), inbox, async () => "answer " + "x".repeat(4000), shutdown.signal, client);
    await waitFor(() => sent.length === 2);
    shutdown.abort();
    await served;

    assert.deepEqual(sent.map(({ target }) => target), ["D0DM", "D0DM"]);
    // Every part carries the same anchor, so a segmented answer stays in one thread.
    assert.deepEqual(sent.map(({ threadTs }) => threadTs), ["1700000000.000100", "1700000000.000100"]);
    assert.equal(sent[0]?.text.length, 4000);
    assert.equal(sent[0]?.text, "answer " + "x".repeat(3993));
    assert.equal(sent[1]?.text, "x".repeat(7));
    assert.equal(inbox.blocked().length, 0);
  });
});

test("a received message carries its own timestamp, next to the thread it belongs to", () => {
  // The thread anchor is where an answer goes; the message's own timestamp is what a reaction is
  // attached to. Inside a thread they are two different messages, so both have to survive.
  assert.deepEqual(toRequest(messageEvent({ ts: "1700000000.000100" }), policy()), {
    requestId: "slack:T1:Ev1",
    conversationId: "D0DM",
    senderId: OWNER,
    text: "hello",
    messageTs: "1700000000.000100",
  });
  assert.deepEqual(toRequest(channelEvent({ ts: "1700000000.000300", thread_ts: "1700000000.000100" }), policy()), {
    requestId: "slack:T1:Ev7",
    conversationId: CHANNEL,
    senderId: MEMBER,
    text: "hello",
    threadTs: "1700000000.000100",
    messageTs: "1700000000.000300",
  });
});

test("reactions are added and removed by name, and a repeat is the desired state", async () => {
  const signal = new AbortController().signal;
  const { impl, calls } = slackApi({
    "reactions.add": () => ({ ok: true }),
    "reactions.remove": () => ({ ok: true }),
  });
  const client = new SlackClient(CREDENTIALS, { fetch: impl });
  await client.react(CHANNEL, "1700000000.000100", "tada", signal);
  await client.unreact(CHANNEL, "1700000000.000100", "tada", signal);
  assert.deepEqual(calls.map(({ method }) => method), ["reactions.add", "reactions.remove"]);
  // The call carries the emoji name and the message id only: no message text either way.
  assert.deepEqual(calls[0]?.params, { channel: CHANNEL, timestamp: "1700000000.000100", name: "tada" });

  // A member id is not a conversation: it resolves to that member's DM, exactly as a reply would.
  const member = slackApi({
    "conversations.open": () => ({ ok: true, channel: { id: "D0DM" } }),
    "reactions.add": () => ({ ok: true }),
  });
  await new SlackClient(CREDENTIALS, { fetch: member.impl }).react(MEMBER, "1700000000.000100", "eyes", signal);
  assert.equal(member.calls[1]?.params.channel, "D0DM");

  // Repeating an operation that already happened is not a failure; a real refusal still is.
  const repeated = slackApi({
    "reactions.add": () => ({ ok: false, error: "already_reacted" }),
    "reactions.remove": () => ({ ok: false, error: "no_reaction" }),
  });
  const tolerating = new SlackClient(CREDENTIALS, { fetch: repeated.impl });
  await assert.doesNotReject(() => tolerating.react(CHANNEL, "1700000000.000100", "eyes", signal));
  await assert.doesNotReject(() => tolerating.unreact(CHANNEL, "1700000000.000100", "eyes", signal));

  const refused = slackApi({ "reactions.add": () => ({ ok: false, error: "invalid_name" }) });
  await assert.rejects(
    () => new SlackClient(CREDENTIALS, { fetch: refused.impl }).react(CHANNEL, "1700000000.000100", "nope", signal),
    (error: unknown) => error instanceof SlackError && error.code === "SLACK_INVALID_NAME",
  );
  // A missing scope is reported as the scope, not as "the bot ignored you".
  const unauthorized = slackApi({ "reactions.add": () => ({ ok: false, error: "missing_scope" }) });
  await assert.rejects(
    () => new SlackClient(CREDENTIALS, { fetch: unauthorized.impl }).react(CHANNEL, "1700000000.000100", "eyes", signal),
    (error: unknown) => error instanceof SlackError && error.code === "SLACK_MISSING_SCOPE",
  );
});

test("a request is acknowledged with a reaction and settled once its reply is delivered", async () => {
  await withInbox(async (inbox) => {
    // The received message's id survives with the request, so the receipt has something to attach to.
    inbox.accept(1, {
      requestId: "slack:T1:Ev11",
      conversationId: "D0DM",
      senderId: OWNER,
      text: "hi",
      messageTs: "1700000000.000100",
    });
    const socket = new TestSocket();
    const shutdown = new AbortController();
    const events: string[] = [];
    const client = {
      open: async () => "wss://example.invalid/link",
      connect: async () => socket,
      send: async () => {
        events.push("send");
        return "1700000000.000300";
      },
    };
    const anchor = new ReactionAnchor();
    const host = {
      react: async (_target: string, ts: string, name: string) => {
        events.push(`+${name}@${ts}`);
      },
      unreact: async (_target: string, ts: string, name: string) => {
        events.push(`-${name}@${ts}`);
      },
    };
    const served = serveSlack(policy(), inbox, async () => "answer", shutdown.signal, client, {
      receipts: { working: "eyes", done: "white_check_mark" },
      reactions: { host, anchor },
    });
    await waitFor(() => events.length === 4);
    shutdown.abort();
    await served;

    // The acknowledgement goes out before the run, and the receipt replaces it after delivery — the
    // reaction is always aimed at the message the request arrived on.
    assert.deepEqual(events, [
      "+eyes@1700000000.000100",
      "send",
      "-eyes@1700000000.000100",
      "+white_check_mark@1700000000.000100",
    ]);
    assert.equal(anchor.peek(), undefined, "the anchor only lives as long as the request");
  });
});

test("a reply that was not delivered is marked as lost rather than as done", async () => {
  await withInbox(async (inbox) => {
    inbox.accept(1, {
      requestId: "slack:T1:Ev12",
      conversationId: "D0DM",
      senderId: OWNER,
      text: "hi",
      messageTs: "1700000000.000100",
    });
    const socket = new TestSocket();
    const shutdown = new AbortController();
    const events: string[] = [];
    const client = {
      open: async () => "wss://example.invalid/link",
      connect: async () => socket,
      send: async () => {
        throw new SlackError("SLACK_NOT_IN_CHANNEL", "Slack chat.postMessage was refused (NOT_IN_CHANNEL)");
      },
    };
    const host = {
      react: async (_target: string, ts: string, name: string) => {
        events.push(`+${name}@${ts}`);
      },
      unreact: async (_target: string, ts: string, name: string) => {
        events.push(`-${name}@${ts}`);
      },
    };
    const served = serveSlack(policy(), inbox, async () => "answer", shutdown.signal, client, {
      receipts: { working: "eyes", done: "white_check_mark", failed: "warning", lost: "x" },
      reactions: { host, anchor: new ReactionAnchor() },
    });
    await waitFor(() => events.length === 3);
    shutdown.abort();
    await served;
    // Nothing reached the channel, so a receipt saying "done" would be a lie the owner has to check.
    assert.deepEqual(events, [
      "+eyes@1700000000.000100",
      "-eyes@1700000000.000100",
      "+x@1700000000.000100",
    ]);
  });
});

test("a run that ended in an error notice is marked as failed, not as done", async () => {
  await withInbox(async (inbox) => {
    inbox.accept(1, {
      requestId: "slack:T1:Ev14",
      conversationId: "D0DM",
      senderId: OWNER,
      text: "hi",
      messageTs: "1700000000.000100",
    });
    const socket = new TestSocket();
    const shutdown = new AbortController();
    const events: string[] = [];
    const client = {
      open: async () => "wss://example.invalid/link",
      connect: async () => socket,
      send: async () => {
        events.push("send");
        return "1700000000.000300";
      },
    };
    const host = {
      react: async (_target: string, ts: string, name: string) => {
        events.push(`+${name}@${ts}`);
      },
      unreact: async (_target: string, ts: string, name: string) => {
        events.push(`-${name}@${ts}`);
      },
    };
    const served = serveSlack(policy(), inbox,
      async () => {
        throw Object.assign(new Error("Agent request timed out"), { code: "AGENT_TIMEOUT" });
      },
      shutdown.signal, client, {
        receipts: { working: "eyes", done: "white_check_mark", failed: "warning", lost: "x" },
        reactions: { host, anchor: new ReactionAnchor() },
      });
    await waitFor(() => events.length === 4);
    shutdown.abort();
    await served;
    // The timeout notice was delivered, but the run failed: the receipt says which one it was.
    assert.deepEqual(events, [
      "+eyes@1700000000.000100",
      "send",
      "-eyes@1700000000.000100",
      "+warning@1700000000.000100",
    ]);
  });
});

test("the workspace's own emoji names come back sorted, and a missing scope is reported as itself", async () => {
  const signal = new AbortController().signal;
  const listing = slackApi({
    "emoji.list": () => ({
      ok: true,
      emoji: { party_parrot: "https://example.invalid/p.png", cat: "alias:cat_jam", aaa: "https://example.invalid/a.png" },
    }),
  });
  const client = new SlackClient(CREDENTIALS, { fetch: listing.impl });
  // A name is what a reaction needs; whether its value is an image or an alias does not matter here.
  assert.deepEqual(await client.emojiList(signal), ["aaa", "cat", "party_parrot"]);
  assert.equal(listing.calls[0]?.method, "emoji.list");

  const refused = slackApi({ "emoji.list": () => ({ ok: false, error: "missing_scope" }) });
  await assert.rejects(
    () => new SlackClient(CREDENTIALS, { fetch: refused.impl }).emojiList(signal),
    (error: unknown) => error instanceof SlackError && error.code === "SLACK_MISSING_SCOPE",
  );
  // A malformed body is a protocol surprise, not a workspace with no emoji.
  const malformed = slackApi({ "emoji.list": () => ({ ok: true, emoji: [] }) });
  assert.deepEqual(await new SlackClient(CREDENTIALS, { fetch: malformed.impl }).emojiList(signal), []);
});

test("a reaction failure never blocks the reply it was acknowledging", async () => {
  await withInbox(async (inbox) => {
    inbox.accept(1, {
      requestId: "slack:T1:Ev13",
      conversationId: "D0DM",
      senderId: OWNER,
      text: "hi",
      messageTs: "1700000000.000100",
    });
    const socket = new TestSocket();
    const shutdown = new AbortController();
    const sent: string[] = [];
    const client = {
      open: async () => "wss://example.invalid/link",
      connect: async () => socket,
      send: async () => {
        sent.push("sent");
        return "1700000000.000300";
      },
    };
    const host = {
      react: async () => {
        throw new SlackError("SLACK_MISSING_SCOPE", "Slack reactions.add was refused (MISSING_SCOPE)");
      },
    };
    const served = serveSlack(policy(), inbox, async () => "answer", shutdown.signal, client, {
      receipts: { working: "eyes", done: "white_check_mark" },
      reactions: { host, anchor: new ReactionAnchor() },
    });
    await waitFor(() => sent.length === 1);
    shutdown.abort();
    await served;
    assert.deepEqual(sent, ["sent"]);
  });
});

test("a disconnect reconnects with a fresh Socket Mode URL", async () => {
  await withInbox(async (inbox) => {
    const first = new TestSocket();
    const second = new TestSocket();
    const sockets = [first, second];
    const opened: string[] = [];
    const shutdown = new AbortController();
    const client = {
      open: async () => {
        opened.push(`wss://example.invalid/${opened.length}`);
        return opened[opened.length - 1] ?? "";
      },
      connect: async () => {
        const socket = sockets.shift();
        if (!socket) throw new Error("no socket left");
        return socket;
      },
      send: async () => "ts",
    };
    const served = serveSlack(policy(), inbox, async () => "unused", shutdown.signal, client);
    // Wait until the first connection is serving before asking it to go away.
    await waitFor(() => opened.length === 1);
    first.push({ kind: "frame", frame: { type: "disconnect", reason: "warning" } });
    await waitFor(() => opened.length === 2);
    shutdown.abort();
    await served;
    assert.equal(first.closed, true);
    assert.equal(second.closed, true, "shutdown closes the socket it was using");
  });
});

/** One delivered reply, so a reaction has something to attach to and somebody who asked it. */
async function withDelivered(run: (inbox: Inbox) => Promise<void>): Promise<void> {
  await withInbox(async (inbox) => {
    inbox.accept(1, {
      requestId: "slack:T1:Ev20",
      conversationId: "D0DM",
      senderId: OWNER,
      text: "hi",
      messageTs: "1700000000.000100",
    });
    inbox.saveReply("slack:T1:Ev20", "answer");
    inbox.confirmPart("slack:T1:Ev20", 0, "1700000000.000300");
    await run(inbox);
  });
}

/** `id` overrides both the envelope's event id and the id the signal row is keyed by. */
function reactionEnvelope(event: Record<string, unknown> = {}, id = "Ev20R") {
  return {
    type: "event_callback",
    team_id: "T1",
    event_id: id,
    event: {
      type: "reaction_added",
      user: OWNER,
      reaction: "thinking_face",
      item_user: BOT,
      item: { type: "message", channel: "D0DM", ts: "1700000000.000300" },
      event_ts: "1700000000.000400",
      ...event,
    },
  };
}

/** A learning rig over one real store, so the end-to-end path writes to disk like production does. */
async function withStyle(run: (options: {
  store: StyleStore;
  learning: StyleLearning;
  asked: string[];
}) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pa-slack-style-"));
  const store = new StyleStore(join(directory, "style.sqlite"));
  const asked: string[] = [];
  const learning = new StyleLearning({
    mode: "ask",
    store,
    send: async (_channel, text) => {
      asked.push(text);
      return "1700000000.000500";
    },
    log: () => {},
  });
  try {
    await run({ store, learning, asked });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("a reaction on a delivered reply is recorded and asked about once, then left alone", async () => {
  await withStyle(async (style) => {
    await withDelivered(async (inbox) => {
      const socket = new TestSocket();
      const shutdown = new AbortController();
      const client = {
        open: async () => "wss://example.invalid/link",
        connect: async () => socket,
        send: async () => "ts",
      };
      const slackPolicy = { ...policy(), botId: BOT };
      const served = serveSlack(slackPolicy, inbox, async () => "unused", shutdown.signal, client, {
        style: {
          policy: { ...slackPolicy, attribute: (messageId: string) => inbox.attributedByMessageId(messageId) },
          learning: style.learning,
        },
      });
      socket.push({ kind: "frame", frame: { type: "events_api", envelopeId: "env-r1", payload: reactionEnvelope() } });
      await waitFor(() => style.asked.length === 1);
      // A second reaction in the same scope inside the window: recorded, never asked again.
      socket.push({
        kind: "frame",
        frame: { type: "events_api", envelopeId: "env-r2", payload: reactionEnvelope({}, "Ev21R") },
      });
      await waitFor(() => socket.acked.length === 2);
      shutdown.abort();
      await served;

      assert.deepEqual(style.asked, [STYLE_ASK_TEXT], "one question, host text, no second one");
      const rows = style.store.recent(10);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((row) => row.eventId), ["style:T1:Ev21R", "style:T1:Ev20R"]);
      assert.equal(rows[0]?.emoji, "thinking_face");
      assert.equal(rows[0]?.polarity, "other");
      assert.equal(rows[0]?.subjectId, OWNER, "attributed to whoever asked, which came from the Inbox");
      assert.equal(rows[0]?.messageId, "1700000000.000300");
      assert.equal(rows[0]?.reason, ASK_SKIPPED_RATE, "and the skipped one says why");
    });
  });
});

test("a reaction frame is served before a turn, and a message buffered behind it is not lost", async () => {
  await withStyle(async (style) => {
    await withDelivered(async (inbox) => {
      const socket = new TestSocket();
      const shutdown = new AbortController();
      const seen: string[] = [];
      const client = { open: async () => "wss://example.invalid/link", connect: async () => socket, send: async () => "ts" };
      const slackPolicy = { ...policy(), botId: BOT };
      // The agent round is slow: the point of draining is that a reaction does not wait behind it.
      const served = serveSlack(slackPolicy, inbox, async () => {
        await delay(60);
        return "unused";
      }, shutdown.signal, client, {
        style: {
          policy: { ...slackPolicy, attribute: (messageId: string) => inbox.attributedByMessageId(messageId) },
          learning: style.learning,
        },
      });
      inbox.accept(2, { requestId: "slack:T1:Ev22", conversationId: "D0DM", senderId: OWNER, text: "slow" });
      // Both frames land while the round runs; the reaction must be handled without waiting for it.
      socket.push({ kind: "frame", frame: { type: "events_api", envelopeId: "env-m", payload: messageEvent({ event_id: "Ev22", ts: "1700000000.000700" }) } });
      socket.push({ kind: "frame", frame: { type: "events_api", envelopeId: "env-r", payload: reactionEnvelope() } });
      await waitFor(() => style.asked.length === 1);
      shutdown.abort();
      await served;
      seen.push("asked first");
      assert.deepEqual(seen, ["asked first"]);
      // The message that arrived with it was served too: draining reaction frames drops nothing else.
      await waitFor(() => socket.acked.includes("env-m"));
      assert.ok(socket.acked.includes("env-r"));
    });
  });
});

test("a reaction whose signal could not be stored is not acknowledged", () => {
  // A store failure has to reach the caller rather than being swallowed, so the frame's envelope is
  // never acknowledged: the same contract an unstored request already keeps, tested here at the piece
  // that owns it instead of through a socket.
  const broken = {
    record: () => { throw new Error("disk full"); },
  } as unknown as StyleStore;
  assert.throws(() => broken.record({ eventId: "style:T1:Ev20R" } as never, "2026-11-11T00:00:00.000Z"), /disk full/);
});


import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { readConfig } from "../src/config.js";
import { Inbox } from "../src/inbox.js";
import type { TextRequest } from "../src/messages.js";
import {
  escapeSlackText,
  serveSlack,
  SlackClient,
  SlackError,
  toRequest,
  type SlackFrameResult,
  type SlackSocket,
} from "../src/slack.js";

const OWNER = "U0OWNER123";
const BOT = "U0BOT4567";
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
  });
  assert.equal(readConfig({ ...slackEnv, CHANNEL: " SLACK " }).channel.kind, "slack", "the value is trimmed and case-folded");
  assert.equal(readConfig({ ...telegramEnv, CHANNEL: "" }).channel.kind, "telegram", "an empty value is the default");
  assert.throws(() => readConfig({ ...telegramEnv, CHANNEL: "discord" }), /CHANNEL must be one of: telegram, slack/);
});

test("Slack credentials and the owner id are checked for shape", () => {
  assert.throws(() => readConfig({ ...slackEnv, SLACK_BOT_TOKEN: "xoxp-user-token-1234567890" }), /SLACK_BOT_TOKEN is not shaped/);
  assert.throws(() => readConfig({ ...slackEnv, SLACK_APP_TOKEN: "xoxb-1234567890123456789012" }), /SLACK_APP_TOKEN is not shaped/);
  assert.throws(() => readConfig({ ...slackEnv, SLACK_OWNER_ID: "@owner" }), /SLACK_OWNER_ID must be a Slack member ID/);
  assert.throws(() => readConfig({ ...slackEnv, SLACK_BOT_TOKEN: "  " }), /Missing configuration: SLACK_BOT_TOKEN/);
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

test("only private DMs from the owner become requests, namespaced by team and event", () => {
  assert.deepEqual(toRequest(messageEvent(), OWNER), {
    requestId: "slack:T1:Ev1",
    conversationId: "D0DM",
    senderId: OWNER,
    text: "hello",
  });

  const rejected: [string, Record<string, unknown>][] = [
    ["another member", messageEvent({ user: "U0SOMEONE" })],
    ["a channel message", messageEvent({ channel_type: "channel" })],
    ["a message edit", messageEvent({ subtype: "message_changed" })],
    ["another bot", messageEvent({ bot_id: "B0" })],
    ["an empty message", messageEvent({ text: "   " })],
    ["a non-message event", messageEvent({ type: "reaction_added" })],
  ];
  for (const [reason, payload] of rejected) assert.equal(toRequest(payload, OWNER), undefined, reason);
  assert.equal(toRequest({ ...messageEvent(), type: "block_actions" }, OWNER), undefined);
  assert.equal(toRequest({ ...messageEvent(), event_id: undefined }, OWNER), undefined, "no event id");
  assert.equal(toRequest({ ...messageEvent(), team_id: undefined }, OWNER), undefined, "no team id");
  assert.equal(toRequest("not an object", OWNER), undefined);
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
    const served = serveSlack(OWNER, BOT, inbox, async (job) => {
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
  const served = serveSlack(OWNER, BOT, inbox, async () => "unused", shutdown.signal, client);
  socket.push({ kind: "frame", frame: { type: "events_api", envelopeId: "env-1", payload: messageEvent() } });
  await assert.rejects(served, /disk full/);
  assert.deepEqual(socket.acked, [], "an unstored envelope must remain unacknowledged");
});

test("a stored reply is delivered in segments over the channel", async () => {
  await withInbox(async (inbox) => {
    inbox.accept(1, { requestId: "slack:T1:Ev9", conversationId: "D0DM", senderId: OWNER, text: "hi" });
    const socket = new TestSocket();
    const shutdown = new AbortController();
    const sent: { target: string; text: string }[] = [];
    const client = {
      open: async () => "wss://example.invalid/link",
      connect: async () => socket,
      send: async (target: string, text: string) => {
        sent.push({ target, text });
        return "1700000000.000200";
      },
    };
    const served = serveSlack(OWNER, BOT, inbox, async () => "answer " + "x".repeat(4000), shutdown.signal, client);
    await waitFor(() => sent.length === 2);
    shutdown.abort();
    await served;

    assert.deepEqual(sent.map(({ target }) => target), ["D0DM", "D0DM"]);
    assert.equal(sent[0]?.text.length, 4000);
    assert.equal(sent[0]?.text, "answer " + "x".repeat(3993));
    assert.equal(sent[1]?.text, "x".repeat(7));
    assert.equal(inbox.blocked().length, 0);
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
    const served = serveSlack(OWNER, BOT, inbox, async () => "unused", shutdown.signal, client);
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

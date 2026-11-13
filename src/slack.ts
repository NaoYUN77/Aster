import { setTimeout as delay } from "node:timers/promises";
import { deliverNext, type DeliveryChannel, type DeliveryReactions, type ReplyFn } from "./channel.js";
import { errorCode } from "./errors.js";
import type { Inbox } from "./inbox.js";
import type { TextRequest } from "./messages.js";
import type { ReactionAnchor, ReactionHost, ReceiptEmojis } from "./reactions.js";
import { normalizeEmojiName } from "./reactions.js";
import { POSITIVE_REACTIONS, type StyleEvent, type StyleLearning } from "./style.js";
import type { StyleConfig } from "./config.js";

const API_ROOT = "https://slack.com/api";
const CALL_TIMEOUT_MS = 30_000;
/** Slack responses are small; anything larger is a protocol surprise, not a message to forward. */
const RESPONSE_LIMIT_BYTES = 512 * 1024;
/** How long the serve loop waits for a frame before it looks at the Inbox again. */
const FRAME_WAIT_MS = 1_000;
/** Frames buffered while the loop is busy; overflowing it reconnects instead of growing without bound. */
const MAX_BUFFERED_FRAMES = 1_024;
/** A Slack member id is not a conversation id and has to be resolved into the member's DM channel. */
const MEMBER_ID = /^[UW][A-Z0-9]{6,15}$/;

/**
 * Slack reports application errors with HTTP 200 and an `error` code, so the code — not the status —
 * decides whether a send definitely did not happen.
 */
const REJECTED = new Set([
  "SLACK_ACCOUNT_INACTIVE",
  "SLACK_CANT_DM",
  "SLACK_CHANNEL_NOT_FOUND",
  "SLACK_INVALID_AUTH",
  "SLACK_IS_ARCHIVED",
  "SLACK_MSG_TOO_LONG",
  "SLACK_NOT_IN_CHANNEL",
  "SLACK_TOKEN_REVOKED",
  "SLACK_USER_NOT_FOUND",
]);

/** A Slack Web API or Socket Mode failure. `code` is log-safe; `message` never carries a body. */
export class SlackError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SlackError";
  }
}

export type SlackFrame =
  | { readonly type: "hello" }
  | { readonly type: "events_api"; readonly envelopeId: string; readonly payload: unknown }
  | { readonly type: "disconnect"; readonly reason: string }
  /** A delivery this service does not process, such as a slash command: acknowledged, then dropped. */
  | { readonly type: "ignored"; readonly envelopeId: string };

export type SlackFrameResult =
  | { readonly kind: "frame"; readonly frame: SlackFrame }
  | { readonly kind: "idle" }
  | { readonly kind: "closed" };

export interface SlackSocket {
  /** The next frame, or that none arrived in time, or that the connection is gone. */
  next(timeoutMs: number): Promise<SlackFrameResult>;
  /** Answers an envelope so Slack stops redelivering it. Called only after the event is stored. */
  ack(envelopeId: string): void;
  close(): void;
}

export type SlackDependencies = {
  readonly fetch?: typeof fetch;
  readonly connect?: (url: string, signal: AbortSignal) => Promise<SlackSocket>;
};

export class SlackClient implements DeliveryChannel {
  readonly label = "Slack";
  readonly #botToken: string;
  readonly #appToken: string;
  readonly #ownerId: string;
  readonly #fetch: typeof fetch;
  readonly #connect: (url: string, signal: AbortSignal) => Promise<SlackSocket>;
  /** Resolved DM channels, keyed by member id. */
  readonly #direct = new Map<string, string>();

  constructor(options: { botToken: string; appToken: string; ownerId: string }, dependencies: SlackDependencies = {}) {
    this.#botToken = options.botToken;
    this.#appToken = options.appToken;
    this.#ownerId = options.ownerId;
    this.#fetch = dependencies.fetch ?? fetch;
    this.#connect = dependencies.connect ?? liveSocket;
  }

  /**
   * Validates both tokens and the configured owner before the service reports itself started: the
   * bot token through `auth.test`, the owner by resolving their DM, and the app token by opening —
   * and discarding — one Socket Mode URL.
   */
  async identity(signal: AbortSignal): Promise<string> {
    const auth = await this.#call("auth.test", {}, this.#botToken, signal);
    const botId = text(auth.user_id);
    if (!botId) throw new SlackError("SLACK_PROTOCOL", "auth.test did not return a user id");
    // Proactive sends target the same DM, so a wrong owner id fails here, not at the first reminder.
    await this.#directMessage(this.#ownerId, signal);
    await this.open(signal);
    return botId;
  }

  /**
   * The bot scopes this installation actually holds, as Slack reports them in `auth.test`'s
   * `x-oauth-scopes` header. Whether reaction events can arrive at all is decided by Slack's own
   * grant, not by configuration, so this is what the startup self-check reads.
   */
  async scopes(signal: AbortSignal): Promise<readonly string[]> {
    const auth = await this.#call("auth.test", {}, this.#botToken, signal, true);
    return readScopes(auth.headers);
  }

  /** One single-use Socket Mode URL. Reconnects call this again; the previous URL stops working. */
  async open(signal: AbortSignal): Promise<string> {
    const opened = await this.#call("apps.connections.open", {}, this.#appToken, signal);
    const url = text(opened.url);
    if (!url) throw new SlackError("SLACK_PROTOCOL", "apps.connections.open did not return a URL");
    return url;
  }

  connect(url: string, signal: AbortSignal): Promise<SlackSocket> {
    return this.#connect(url, signal);
  }

  async send(target: string, text_: string, signal: AbortSignal, threadTs?: string): Promise<string> {
    const channel = await this.#resolveTarget(target, signal);
    // Slack renders `text` as mrkdwn, so markup characters are escaped to keep the reply literal.
    const posted = await this.#call("chat.postMessage", {
      channel,
      text: escapeSlackText(text_),
      unfurl_links: false,
      unfurl_media: false,
      ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
    }, this.#botToken, signal);
    const ts = text(posted.ts);
    if (!ts) throw new SlackError("SLACK_PROTOCOL", "chat.postMessage did not return a timestamp");
    return ts;
  }

  classifyFailure(error: unknown): "failed" | "uncertain" {
    return classifyFailure(error);
  }

  failureCode(error: unknown): string {
    return failureCode(error);
  }

  /** Attaches an emoji reaction to one message. `target` resolves exactly as a reply's target does. */
  async react(target: string, ts: string, name: string, signal: AbortSignal): Promise<void> {
    await this.#reaction("reactions.add", target, ts, name, signal, "already_reacted");
  }

  /** Removes a reaction this bot added. A reaction that is already gone is the desired end state. */
  async unreact(target: string, ts: string, name: string, signal: AbortSignal): Promise<void> {
    await this.#reaction("reactions.remove", target, ts, name, signal, "no_reaction");
  }

  async #reaction(
    method: string,
    target: string,
    ts: string,
    name: string,
    signal: AbortSignal,
    done: string,
  ): Promise<void> {
    const channel = await this.#resolveTarget(target, signal);
    try {
      // The emoji name and the message id are the whole call: no text of either side ever travels.
      await this.#call(method, { channel, timestamp: ts, name }, this.#botToken, signal);
    } catch (error) {
      // Repeating an operation that already happened is the desired state, not a failure.
      if (error instanceof SlackError && error.code === `SLACK_${done.toUpperCase()}`) return;
      throw error;
    }
  }

  /**
   * Every emoji name this workspace can react with, including the custom uploads and the aliases that
   * point at them. Needs `emoji:read`; without it Slack refuses the call and the caller reports that
   * instead of pretending the standard names are all there is.
   */
  async emojiList(signal: AbortSignal): Promise<readonly string[]> {
    const listed = await this.#call("emoji.list", {}, this.#botToken, signal);
    const emoji = listed.emoji;
    if (emoji === null || typeof emoji !== "object" || Array.isArray(emoji)) return [];
    // Only the names matter: a value is either an image URL or `alias:<name>`, and both are usable
    // names in `reactions.add`. The values never leave this function.
    return Object.keys(emoji).sort();
  }

  /** A member id has to become its DM channel id; a channel id is already a target. */
  async #resolveTarget(target: string, signal: AbortSignal): Promise<string> {
    if (!MEMBER_ID.test(target)) return target;
    return await this.#directMessage(target, signal);
  }

  async #directMessage(memberId: string, signal: AbortSignal): Promise<string> {
    const known = this.#direct.get(memberId);
    if (known !== undefined) return known;
    const opened = await this.#call("conversations.open", { users: memberId }, this.#botToken, signal);
    const channel = isRecord(opened.channel) ? text(opened.channel.id) : undefined;
    if (!channel) throw new SlackError("SLACK_PROTOCOL", "conversations.open did not return a channel");
    this.#direct.set(memberId, channel);
    return channel;
  }

  async #call(
    method: string,
    params: Record<string, unknown>,
    token: string,
    signal: AbortSignal,
    keepHeaders = false,
  ): Promise<Record<string, unknown> & { headers?: Headers }> {
    let response: Response;
    try {
      response = await this.#fetch(`${API_ROOT}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(params),
        // Credentials must never be carried to another host by a redirect.
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new SlackError("TIMEOUT", `Slack ${method} timed out`);
      }
      throw new SlackError("NETWORK", `Slack ${method} could not be reached`);
    }
    if (!response.ok) {
      throw new SlackError(`SLACK_HTTP_${response.status}`, `Slack ${method} answered with status ${response.status}`);
    }
    const body = await readBody(response, method);
    if (body.ok !== true) {
      const reason = typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? body.error.toUpperCase() : "UNKNOWN";
      throw new SlackError(`SLACK_${reason}`, `Slack ${method} was refused (${reason})`);
    }
    // Only a caller that asked for the headers keeps them, and only the one it names is ever read.
    return keepHeaders ? { ...body, headers: response.headers } : body;
  }
}

async function readBody(response: Response, method: string): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (raw.length > RESPONSE_LIMIT_BYTES) throw new SlackError("SLACK_TOO_LARGE", `Slack ${method} answered with an oversized body`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SlackError("SLACK_PROTOCOL", `Slack ${method} did not answer with JSON`);
  }
  if (!isRecord(parsed)) throw new SlackError("SLACK_PROTOCOL", `Slack ${method} did not answer with an object`);
  return parsed;
}

/** `failed` only for a refusal that means nothing was delivered; every other outcome is unknown. */
export function classifyFailure(error: unknown): "failed" | "uncertain" {
  return error instanceof SlackError && REJECTED.has(error.code) ? "failed" : "uncertain";
}

export function failureCode(error: unknown): string {
  return error instanceof SlackError ? error.code : errorCode(error);
}

/**
 * Bot scopes from one `auth.test` response header. A missing or unreadable header is not a grant of
 * anything, so it reads as an empty list and the caller degrades instead of assuming.
 */
export function readScopes(headers: Headers | undefined): readonly string[] {
  const raw = headers?.get("x-oauth-scopes");
  if (typeof raw !== "string") return [];
  return raw.split(",").map((scope) => scope.trim().toLowerCase()).filter((scope) => scope !== "");
}

/** The scope Slack requires before it will deliver any reaction event. */
export const REACTIONS_READ_SCOPE = "reactions:read";

/**
 * Startup reading of what reaction feedback is actually able to do. It is printed whether or not
 * anybody enabled it: a deployment that turned `ask` on without the scope has to be told the feature
 * is inert, not left producing silence nobody can explain.
 */
export function styleStartupLine(
  mode: StyleConfig["mode"],
  canAsk: boolean,
): string {
  if (mode === "off") return "STYLE_LEARNING: off; reactions recorded only when STYLE_LEARNING=observe or ask";
  if (!canAsk) return `STYLE_INERT: missing scope ${REACTIONS_READ_SCOPE}; reaction events are not delivered, so nothing is recorded or asked`;
  if (mode === "observe") return "STYLE_OBSERVING: recording reaction signals; no question is sent (STYLE_LEARNING=observe)";
  return "STYLE_ASKING: enabled, max 1 ask / 12h per scope";
}

/** Slack renders `text` as mrkdwn; escaping its three markup characters keeps a reply literal. */
export function escapeSlackText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Who may drive the bot, and where. Built from configuration; never derived from message content. */
export type SlackInboundPolicy = {
  readonly ownerId: string;
  readonly botId: string;
  /** Members allowed to drive the bot besides the owner. */
  readonly allowedUsers: readonly string[];
  /** Channels the bot answers in. */
  readonly allowedChannels: readonly string[];
  /** Diagnostics for a dropped event: a fixed reason code, never the message text. */
  readonly log?: (line: string) => void;
};

/**
 * Maps one Events API callback to a request. Identity comes from Slack's own `user` field — the
 * transport's identifier — so no message text can claim to be someone else, and the allowlists decide
 * who may start work and where. Private DMs stay owner-only. In a channel, an explicit mention starts
 * a conversation while a reply inside a thread continues one, carrying the thread anchor so the answer
 * lands where the question was asked. Everything else is dropped with a reason code.
 */
export function toRequest(payload: unknown, policy: SlackInboundPolicy): TextRequest | undefined {
  const drop = (reason: string): undefined => {
    policy.log?.(`Slack event dropped: ${reason}`);
    return undefined;
  };
  if (!isRecord(payload) || payload.type !== "event_callback") return;
  const eventId = text(payload.event_id);
  const teamId = text(payload.team_id);
  const event = payload.event;
  if (!eventId || !teamId || !isRecord(event)) return;
  // Another app's message or a bot's own post is never a user request; an edit is not a new question.
  // `thread_broadcast` is a real reply that also reached the channel, so it stays a request.
  if (event.bot_id !== undefined) return;
  if (event.subtype !== undefined && event.subtype !== "thread_broadcast") return;
  const channel = text(event.channel);
  const sender = text(event.user);
  const raw = typeof event.text === "string" ? event.text : "";
  if (!channel || !sender) return;
  const mentioned = raw.includes(`<@${policy.botId}>`);
  if (event.channel_type === "im") {
    if (event.type !== "message") return;
    if (sender !== policy.ownerId) return drop("DM_NOT_OWNER");
  } else if (event.channel_type === "channel" || event.channel_type === "group") {
    if (event.type !== "message" && event.type !== "app_mention") return;
    if (!policy.allowedChannels.includes(channel)) return drop("CHANNEL_NOT_ALLOWED");
    if (sender !== policy.ownerId && !policy.allowedUsers.includes(sender)) return drop("SENDER_NOT_ALLOWED");
    // A plain channel message counts only as a follow-up inside a thread: the mention is what starts a
    // conversation, and requiring it keeps the bot from answering every message in the channel.
    if (!mentioned && typeof event.thread_ts !== "string") return drop("NOT_A_MENTION");
  } else return;
  // Slack addresses the bot as `<@U…>`; the model needs the request, not the address.
  const content = raw.split(`<@${policy.botId}>`).join("").trim();
  if (!content) return drop("EMPTY_TEXT");
  const threadTs = text(event.thread_ts);
  // The message's own timestamp is what a reaction is attached to; the thread anchor is where an
  // answer goes. A message inside a thread has both, and they are different messages.
  const messageTs = text(event.ts);
  return {
    requestId: `slack:${teamId}:${eventId}`,
    conversationId: channel,
    senderId: sender,
    text: content,
    ...(threadTs === undefined ? {} : { threadTs }),
    ...(messageTs === undefined ? {} : { messageTs }),
  };
}

/** `added` → `removed`; anything else is not a reaction event this host handles. */
const STYLE_KINDS = new Map<string, "added" | "removed">([
  ["reaction_added", "added"],
  ["reaction_removed", "removed"],
]);

/**
 * Attributing a reaction is a host lookup: Slack names the message that was reacted to, and the
 * Inbox is what knows which request that message answered and who asked it. Nothing in the payload
 * supplies either, so no part of the payload can claim to be somebody else's feedback.
 */
export type StyleAttribution = {
  readonly requestId: string;
  readonly part?: number;
  readonly conversationId: string;
  readonly senderId: string;
  /** Where the answer landed; absent for a flat reply. The question belongs in the same place. */
  readonly threadTs?: string;
};

export type SlackStylePolicy = SlackInboundPolicy & {
  /** Slack member id of this app's bot user: a reaction on someone else's message is not feedback. */
  readonly botId: string;
  /** Looks up the delivered message a reaction landed on. */
  readonly attribute: (messageId: string) => StyleAttribution | undefined;
};

/**
 * Maps one reaction event to a style signal. Separate from `toRequest` on purpose: a reaction has no
 * top-level `event.channel` and no text, so the request path drops it before it reaches an allowlist,
 * and forcing it through there would give the model a "request" for something nobody asked in words.
 *
 * Every refusal has its own reason code and none carries the emoji, the message or a channel name:
 * the interesting part of a dropped reaction is why, and the payload is external input throughout.
 */
export function toStyleEvent(payload: unknown, policy: SlackStylePolicy): StyleEvent | undefined {
  const drop = (reason: string): undefined => {
    policy.log?.(`Slack reaction dropped: ${reason}`);
    return undefined;
  };
  if (!isRecord(payload) || payload.type !== "event_callback") return;
  const eventId = text(payload.event_id);
  const teamId = text(payload.team_id);
  const event = payload.event;
  if (!eventId || !teamId || !isRecord(event)) return;
  const kind = typeof event.type === "string" ? STYLE_KINDS.get(event.type) : undefined;
  // Only these two reach the allowlists; every other event type stays transport noise.
  if (kind === undefined) return;
  // Reactions attach to files too, and those are nothing this process ever answered: only a reaction
  // on a message can be feedback, and anything malformed along the way stays transport noise.
  const item = event.item;
  if (!isRecord(item) || item.type !== "message") return;
  const messageId = text(item.ts);
  const reactorId = text(event.user);
  if (!messageId || !reactorId) return;
  if (reactorId === policy.botId) return drop("STYLE_RECEIPT");
  // `item_user` is the author of the reacted-to message: unless that is this bot, the reaction is
  // somebody reacting to somebody else entirely and there is no reply of ours to account for.
  if (text(event.item_user) !== policy.botId) return drop("STYLE_NOT_BOT_REPLY");
  const attributed = policy.attribute(messageId);
  if (attributed === undefined) return drop("STYLE_NO_TARGET");
  const channel = attributed.conversationId;
  // The same two allowlists the reply went through, applied to whoever reacted and to where the reply
  // was made: only the owner and the allowed members may have feedback taken into account at all.
  const permitted = reactorId === policy.ownerId
    || (policy.allowedUsers.includes(reactorId) && policy.allowedChannels.includes(channel));
  if (!permitted) return drop("STYLE_NOT_ALLOWED");
  // Who asked the reply comes from the Inbox, so no payload can claim another member's feedback: the
  // reactor has to be that same person. Checked after the allowlists, so being unknown to this
  // deployment is reported rather than being mistaken for reacting to the wrong reply.
  if (reactorId !== attributed.senderId) return drop("STYLE_REACTOR_MISMATCH");
  const reaction = typeof event.reaction === "string" ? event.reaction : "";
  const emoji = normalizeEmojiName(reaction);
  // Slack never sends a name it could not accept, so a rejected one is malformed input, not a
  // reaction to record. Custom emoji normalize exactly like the standard ones.
  if (emoji === undefined) return drop("STYLE_EMOJI_INVALID");
  const polarity = POSITIVE_REACTIONS.has(emoji) ? "positive" : "other";
  const threadTs = text(attributed.threadTs);
  return {
    eventId: `style:${teamId}:${eventId}`,
    kind,
    channel,
    subjectId: attributed.senderId,
    reactorId,
    messageId,
    requestId: attributed.requestId,
    ...(attributed.part === undefined ? {} : { part: attributed.part }),
    emoji,
    polarity,
    ...(threadTs === undefined ? {} : { threadTs }),
  };
}

function parseFrame(raw: string): SlackFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;
  const envelopeId = text(parsed.envelope_id);
  if (parsed.type === "hello") return { type: "hello" };
  if (parsed.type === "disconnect") {
    return { type: "disconnect", reason: typeof parsed.reason === "string" ? parsed.reason : "unknown" };
  }
  if (parsed.type === "events_api" && envelopeId) return { type: "events_api", envelopeId, payload: parsed.payload };
  if (envelopeId) return { type: "ignored", envelopeId };
  return;
}

/**
 * Node's global WebSocket, wrapped so the rest of the module depends on `SlackSocket` only. Frames
 * are buffered until read; a buffer overflow closes the connection, which makes Slack redeliver every
 * envelope this process has not acknowledged yet.
 */
function liveSocket(url: string, signal: AbortSignal): Promise<SlackSocket> {
  return new Promise<SlackSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    const frames: SlackFrame[] = [];
    let waiters: ((result: SlackFrameResult) => void)[] = [];
    let closed = false;
    let opened = false;

    const deliver = (result: SlackFrameResult) => {
      const waiter = waiters.shift();
      if (waiter) waiter(result);
    };
    const finish = () => {
      closed = true;
      const pending = waiters;
      waiters = [];
      for (const waiter of pending) waiter({ kind: "closed" });
    };
    const abort = () => socket.close();

    socket.addEventListener("open", () => {
      opened = true;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) socket.close();
      resolve(handle);
    });
    socket.addEventListener("message", (event) => {
      const frame = parseFrame(String(event.data));
      if (frame === undefined) return;
      if (waiters.length) deliver({ kind: "frame", frame });
      else if (frames.length < MAX_BUFFERED_FRAMES) frames.push(frame);
      else {
        // The loop fell behind. Dropping acknowledged-only work is safe: unacknowledged envelopes
        // come back on the next connection, and the stored request id makes that idempotent.
        console.error("Slack socket buffer overflowed; reconnecting instead of dropping envelopes");
        socket.close();
      }
    });
    socket.addEventListener("error", () => {
      finish();
      if (!opened) reject(new SlackError("NETWORK", "Slack socket could not be opened"));
    });
    socket.addEventListener("close", () => {
      finish();
      if (!opened) reject(new SlackError("NETWORK", "Slack socket closed before it was opened"));
    });

    const handle: SlackSocket = {
      next(timeoutMs: number): Promise<SlackFrameResult> {
        const frame = frames.shift();
        if (frame) return Promise.resolve({ kind: "frame", frame });
        if (closed) return Promise.resolve({ kind: "closed" });
        return new Promise<SlackFrameResult>((resolveNext) => {
          const timer = setTimeout(() => {
            waiters = waiters.filter((waiter) => waiter !== settle);
            resolveNext({ kind: "idle" });
          }, timeoutMs);
          const settle = (result: SlackFrameResult) => {
            clearTimeout(timer);
            resolveNext(result);
          };
          waiters.push(settle);
        });
      },
      ack(envelopeId: string): void {
        if (closed) return;
        socket.send(JSON.stringify({ envelope_id: envelopeId }));
      },
      close(): void {
        socket.close();
      },
    };
  });
}

/**
 * What a Slack deployment adds to delivery: the emoji receipts the owner asked for, and the reaction
 * host plus the anchor the model's reaction tool works through. Both absent means reactions are off,
 * which is also what a channel with no reaction concept (Telegram) keeps.
 */
export type SlackReactions = {
  readonly receipts?: ReceiptEmojis;
  readonly reactions?: { readonly host: ReactionHost; readonly anchor: ReactionAnchor };
  /**
   * Reaction feedback. Absent means nothing is recorded: a reaction frame is then acknowledged like
   * any other unhandled envelope instead of being queued up behind a model round.
   */
  readonly style?: { readonly policy: SlackStylePolicy; readonly learning: StyleLearning };
};

/**
 * Serves the allowed members' Slack traffic over Socket Mode: no inbound endpoint, so the bot works
 * behind NAT. The loop owns the socket, and shares agent work and reply delivery with every other
 * channel. `policy` decides who may drive the bot and where; it is configuration, never message text.
 */
export async function serveSlack(
  policy: SlackInboundPolicy,
  inbox: Inbox,
  reply: ReplyFn,
  signal: AbortSignal,
  client: Pick<SlackClient, "send" | "open" | "connect">,
  options: SlackReactions = {},
): Promise<void> {
  if (inbox.blocked().length) console.error("Some replies need delivery reconciliation; run npm run deliveries -- list.");
  // Reactions stay off unless the deployment configured them: with no host there is nothing to call,
  // and the model's reaction tool is not installed either.
  const host = options.reactions?.host;
  const style = options.style;
  const reactions: DeliveryReactions = {
    ...(options.receipts === undefined ? {} : { receipts: options.receipts }),
    ...(options.reactions === undefined ? {} : { anchor: options.reactions.anchor }),
  };
  const channel: DeliveryChannel = {
    label: "Slack",
    send: (target, text, partSignal, threadTs) => client.send(target, text, partSignal, threadTs),
    ...(host === undefined ? {} : {
      react: (target: string, ts: string, name: string, partSignal: AbortSignal) => host.react(target, ts, name, partSignal),
      ...(host.unreact === undefined ? {} : {
        unreact: (target: string, ts: string, name: string, partSignal: AbortSignal) =>
          host.unreact!(target, ts, name, partSignal),
      }),
    }),
    classifyFailure,
    failureCode,
  };
  let socket: SlackSocket | undefined;
  let failures = 0;
  // Frames read during a turn wait here; the loop serves them before it reads the socket again.
  const pending: SlackFrame[] = [];
  /**
   * Records one reaction and only then acknowledges its envelope. A store failure is fatal and leaves
   * the envelope unacknowledged, exactly as an unstored request does: Slack redelivers it and the
   * event id keeps that from asking twice.
   */
  const settleReaction = async (payload: unknown, envelopeId: string): Promise<void> => {
    if (socket === undefined || style === undefined) return;
    const event = toStyleEvent(payload, style.policy);
    if (event !== undefined) await style.learning.handle(event, signal);
    socket.ack(envelopeId);
  };
  /**
   * Serves the reaction frames that arrived while the loop was busy, before another turn starts: a
   * model round runs for minutes, and a reaction buffered behind one would otherwise be answered long
   * after it happened. Anything else is left for the ordinary path, so draining drops no message.
   */
  const drain = async (): Promise<void> => {
    if (socket === undefined || style === undefined) return;
    for (let result = await socket.next(0); result.kind === "frame"; result = await socket.next(0)) {
      const frame = result.frame;
      if (frame.type !== "events_api" || !isReactionEnvelope(frame.payload)) {
        pending.push(frame);
        continue;
      }
      await settleReaction(frame.payload, frame.envelopeId);
    }
  };
  while (!signal.aborted) {
    await drain();
    if (await deliverNext(inbox, reply, signal, channel, reactions)) continue;
    if (socket === undefined) {
      try {
        socket = await client.connect(await client.open(signal), signal);
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        const seconds = Math.min(30, 2 ** Math.min(++failures, 5));
        console.error(`Slack socket retry in ${seconds}s (${failureCode(error)})`);
        await delay(seconds * 1000, undefined, { signal }).catch((error: unknown) => {
          if (!signal.aborted) throw error;
        });
        continue;
      }
    }
    // A frame read during the turn is served first: nothing that arrived while the model was running
    // waits behind another socket read.
    const next = pending.shift();
    const result = next === undefined ? await socket.next(FRAME_WAIT_MS) : { kind: "frame", frame: next } as const;
    if (result.kind === "idle") continue;
    if (result.kind === "closed") {
      console.error("Slack socket closed; reconnecting");
      socket = undefined;
      continue;
    }
    const frame = result.frame;
    if (frame.type === "disconnect") {
      // Slack is retiring this connection; a new URL is required for the next one.
      console.error(`Slack asked for a reconnect (${frame.reason})`);
      socket.close();
      socket = undefined;
      continue;
    }
    if (frame.type === "ignored") {
      socket.ack(frame.envelopeId);
      continue;
    }
    if (frame.type !== "events_api") continue;
    // A reaction read here, rather than during a drain, is settled the same way — the two paths must
    // not disagree about what a reaction means.
    if (style !== undefined && isReactionEnvelope(frame.payload)) {
      await settleReaction(frame.payload, frame.envelopeId);
      continue;
    }
    // Store the request before acknowledging it. Slack redelivers an unacknowledged envelope, and
    // the stored request id keeps that redelivery from being processed twice. A store failure is
    // fatal, exactly as it is on the polling channel: acknowledging would silently drop the owner's
    // message, while an unacknowledged envelope comes back after the restart.
    const request = toRequest(frame.payload, policy);
    if (request) inbox.accept(inbox.offset + 1, request);
    socket.ack(frame.envelopeId);
  }
  socket?.close();
}

/**
 * True when an envelope carries one of the two reaction events. Used only to decide whether a frame is
 * served before a turn or left for the ordinary path — the real validation is `toStyleEvent`'s.
 */
function isReactionEnvelope(payload: unknown): boolean {
  if (!isRecord(payload) || payload.type !== "event_callback") return false;
  const event = payload.event;
  if (!isRecord(event) || typeof event.type !== "string") return false;
  return event.type === "reaction_added" || event.type === "reaction_removed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

import type { Inbox, Job } from "./inbox.js";
import type { TextRequest } from "./messages.js";
import type { ReactionAnchor, ReceiptEmojis } from "./reactions.js";

/**
 * One conversation surface. Telegram and Slack implement the same four operations, so reply
 * segmentation, delivery bookkeeping and failure recording stay channel-independent; only transport
 * and error classification differ.
 */
export interface DeliveryChannel {
  /** Operator-facing name for log lines. */
  readonly label: string;
  /**
   * Sends one already-segmented message part and returns the channel's message id. `threadTs` is the
   * anchor to answer inside when the request arrived in a thread; a channel that has no threads
   * ignores it, and an absent anchor means a flat message.
   */
  send(target: string, text: string, signal: AbortSignal, threadTs?: string): Promise<string>;
  /**
   * Optional: attaches an emoji reaction to the message a request arrived on — an acknowledgement of
   * the request, never a substitute for delivering its reply. A channel that cannot address the
   * message it received leaves both of these out, and the reaction features stay off.
   */
  react?(target: string, ts: string, name: string, signal: AbortSignal): Promise<void>;
  /** Optional: removes a reaction this process added; one that is already gone is not an error. */
  unreact?(target: string, ts: string, name: string, signal: AbortSignal): Promise<void>;
  /** `failed` means the channel rejected the send; `uncertain` means the outcome is unknown. */
  classifyFailure(error: unknown): "failed" | "uncertain";
  /** A short, log-safe code for this error. Never carries message text or credentials. */
  failureCode(error: unknown): string;
}

/**
 * Reaction bookkeeping for one channel: the receipts this deployment asked for, and the anchor the
 * model's reaction tool reads. Absent means the channel never reacts.
 */
export type DeliveryReactions = {
  readonly receipts?: ReceiptEmojis;
  readonly anchor?: ReactionAnchor;
};

export type ReplyFn = (request: TextRequest, signal: AbortSignal) => Promise<string>;

/** A single inbound request may carry this much text before the host refuses it. */
export const MAX_REQUEST_CHARS = 16_000;

/**
 * Processes at most one pending Inbox request: run the agent, then send every part that is still
 * pending. Returns false when the Inbox had nothing to do, so the caller keeps ownership of waiting
 * (long polling on Telegram, socket events on Slack). A fatal session error is rethrown.
 */
export async function deliverNext(
  inbox: Inbox,
  reply: ReplyFn,
  signal: AbortSignal,
  channel: DeliveryChannel,
  reactions: DeliveryReactions = {},
): Promise<boolean> {
  const job = inbox.next();
  if (!job) return false;
  // The anchor lives exactly as long as this request may run, so the model's reaction tool can only
  // ever reach the message this request arrived on — including from a fork answering inside a thread.
  const release = reactions.anchor?.hold(target(job));
  const react = reactionSender(channel, job, signal, channel.react);
  const unreact = reactionSender(channel, job, signal, channel.unreact);
  try {
    const working = react === undefined ? undefined : reactions.receipts?.working;
    // The acknowledgement comes first: while a long run works, it is the only signal the sender has.
    await quietly(channel, working === undefined ? undefined : () => react!(working));
    let errorCode: string | undefined;
    let text: string;
    if (job.status === "pending") {
      try {
        text = job.text.length > MAX_REQUEST_CHARS
          ? "消息过长，请拆分后再发送。"
          : await reply(job, signal);
      } catch (error) {
        if (signal.aborted) return true;
        // The Session will reject every later request; a failure notice would only hide that.
        if (isFatal(error)) throw error;
        errorCode = channel.failureCode(error);
        console.error(`Agent request failed: ${job.requestId} (${errorCode})`);
        const partial = errorCode === "AGENT_TRUNCATED" && error instanceof Error && "partialReply" in error
          && typeof error.partialReply === "string" ? error.partialReply.trim() : "";
        text = partial
          ? `${partial}\n\n（回复因长度限制被截断，内容不完整。请拆分请求后重试。）`
          : errorCode === "AGENT_TIMEOUT"
            ? "本次处理超时，已请求停止执行。已执行的操作可能仍然生效，请先核对结果。"
            : errorCode === "AGENT_LOOP_DETECTED"
              ? "检测到重复调用循环，已停止本次处理。已执行的操作可能仍然生效，请调整请求后重试。"
              : "本次处理未能完成。已执行的操作可能仍然生效，请先核对结果。";
      }
      inbox.saveReply(job.requestId, text, errorCode);
    }
    if (signal.aborted) return true;
    let part = inbox.nextPart(job.requestId);
    let delivered = true;
    while (part && !signal.aborted) {
      inbox.beginPart(job.requestId, part.part);
      let messageId: string;
      try {
        // Every part of one reply carries the same anchor, so a segmented answer stays in one thread.
        messageId = await channel.send(job.conversationId, part.text, signal, job.threadTs);
      } catch (error) {
        // An explicit rejection means not sent. Transport failures remain ambiguous.
        const status = channel.classifyFailure(error);
        inbox.failPart(job.requestId, part.part, status, channel.failureCode(error));
        console.error(`${channel.label} delivery ${status}: ${job.requestId}, part ${part.part}`);
        delivered = false;
        break;
      }
      // Local state is authoritative: a write failure must stop the process, not look like a send failure.
      inbox.confirmPart(job.requestId, part.part, messageId);
      part = inbox.nextPart(job.requestId);
    }
    // The acknowledgement is replaced by the receipt that matches how the run actually ended: the
    // reply was delivered, the reply was an error notice, or the reply never went out. A shutdown in
    // the middle leaves the acknowledgement alone instead of claiming an outcome nobody verified.
    const settled = signal.aborted ? undefined
      : !delivered ? reactions.receipts?.lost
        : errorCode !== undefined ? reactions.receipts?.failed
          : reactions.receipts?.done;
    if (settled !== undefined) {
      if (working !== undefined && unreact !== undefined) await quietly(channel, () => unreact(working));
      if (react !== undefined) await quietly(channel, () => react(settled));
    }
    inbox.prune();
    return true;
  } finally {
    release?.();
  }
}

/** The delivery target a reaction is attached to; absent when this request has no addressable message. */
function target(job: Job): { channel: string; ts: string } | undefined {
  return job.messageTs === undefined ? undefined : { channel: job.conversationId, ts: job.messageTs };
}

/**
 * A one-argument sender that attaches (or removes) a reaction on the message this request arrived on,
 * or undefined when the channel has no such method or the request has no message id. The channel's own
 * object is the receiver, so a class method keeps its `this`.
 */
function reactionSender(
  channel: DeliveryChannel,
  job: Job,
  signal: AbortSignal,
  method: DeliveryChannel["react"] | DeliveryChannel["unreact"],
): ((name: string) => Promise<void>) | undefined {
  const anchor = target(job);
  if (anchor === undefined || method === undefined) return undefined;
  return (name: string) => method.call(channel, anchor.channel, anchor.ts, name, signal);
}

/** A reaction is acknowledgement, never delivery: a failure is logged by code and never blocks a reply. */
async function quietly(channel: DeliveryChannel, attach: (() => Promise<void>) | undefined): Promise<void> {
  if (attach === undefined) return;
  try {
    await attach();
  } catch (error) {
    console.error(`${channel.label} reaction failed: ${channel.failureCode(error)}`);
  }
}

function isFatal(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "AGENT_SESSION_FAILED";
}

import type { Inbox } from "./inbox.js";
import type { TextRequest } from "./messages.js";

/**
 * One conversation surface. Telegram and Slack implement the same four operations, so reply
 * segmentation, delivery bookkeeping and failure recording stay channel-independent; only transport
 * and error classification differ.
 */
export interface DeliveryChannel {
  /** Operator-facing name for log lines. */
  readonly label: string;
  /** Sends one already-segmented message part and returns the channel's message id. */
  send(target: string, text: string, signal: AbortSignal): Promise<string>;
  /** `failed` means the channel rejected the send; `uncertain` means the outcome is unknown. */
  classifyFailure(error: unknown): "failed" | "uncertain";
  /** A short, log-safe code for this error. Never carries message text or credentials. */
  failureCode(error: unknown): string;
}

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
): Promise<boolean> {
  const job = inbox.next();
  if (!job) return false;
  if (job.status === "pending") {
    let text: string;
    let errorCode: string | undefined;
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
  while (part && !signal.aborted) {
    inbox.beginPart(job.requestId, part.part);
    let messageId: string;
    try {
      messageId = await channel.send(job.conversationId, part.text, signal);
    } catch (error) {
      // An explicit rejection means not sent. Transport failures remain ambiguous.
      const status = channel.classifyFailure(error);
      inbox.failPart(job.requestId, part.part, status, channel.failureCode(error));
      console.error(`${channel.label} delivery ${status}: ${job.requestId}, part ${part.part}`);
      break;
    }
    // Local state is authoritative: a write failure must stop the process, not look like a send failure.
    inbox.confirmPart(job.requestId, part.part, messageId);
    part = inbox.nextPart(job.requestId);
  }
  inbox.prune();
  return true;
}

function isFatal(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "AGENT_SESSION_FAILED";
}

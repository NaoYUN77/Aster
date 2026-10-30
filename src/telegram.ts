import { open, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Api, GrammyError, InputFile } from "grammy";
import { AbortController as TelegramAbortController, type AbortSignal as TelegramSignal } from "abort-controller";
import type { Update } from "grammy/types";
import type { readConfig } from "./config.js";
import type { Inbox } from "./inbox.js";
import type { TextRequest } from "./messages.js";

async function telegramCall<T>(signal: AbortSignal, call: (signal: TelegramSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const controller = new TelegramAbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await call(controller.signal);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export class TelegramClient {
  private readonly api: Api;

  constructor(token: string, apiRoot?: string) {
    this.api = new Api(token, {
      ...(apiRoot ? { apiRoot } : {}),
    });
  }

  async identity(signal: AbortSignal): Promise<string> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const me = await telegramCall(bounded, (cancel) => this.api.getMe(cancel));
    const webhook = await telegramCall(bounded, (cancel) => this.api.getWebhookInfo(cancel));
    if (webhook.url) throw new Error("Telegram webhook is active; remove it before starting long polling");
    return String(me.id);
  }

  updates(offset: number, signal: AbortSignal): Promise<Update[]> {
    return telegramCall(AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
      (cancel) => this.api.getUpdates({ offset, timeout: 25, limit: 10, allowed_updates: ["message"] }, cancel));
  }

  async send(chatId: string, text: string, signal: AbortSignal): Promise<string> {
    const message = await telegramCall(AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      (cancel) => this.api.sendMessage(chatId, text, {}, cancel));
    return String(message.message_id);
  }

  async sendPhoto(chatId: string, path: string, signal: AbortSignal): Promise<string> {
    const message = await telegramCall(AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      (cancel) => this.api.sendPhoto(chatId, new InputFile(path), {}, cancel));
    return String(message.message_id);
  }
}

export type TelegramReply = string | { text: string; photos?: readonly string[] };

function replyError(message: string, code = "REPLY_ATTACHMENT_INVALID"): Error {
  return Object.assign(new Error(message), { code });
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

/** Host reply boundary: persist canonical paths only after checking every attachment. */
export async function validateTelegramReply(
  reply: unknown,
  dataDir: string,
  signal: AbortSignal,
): Promise<{ text: string; photos: readonly string[] }> {
  signal.throwIfAborted();
  const result = typeof reply === "string" ? { text: reply } : reply;
  if (!result || typeof result !== "object" || !("text" in result)
    || typeof result.text !== "string" || !result.text.trim()) {
    throw replyError("Reply must contain non-empty text", "REPLY_INVALID");
  }
  const photos = "photos" in result ? result.photos : undefined;
  if (photos !== undefined && (!Array.isArray(photos) || photos.length > 3)) {
    throw replyError("Reply may contain at most three PNG photos");
  }
  const paths: string[] = [];
  if (photos?.length) {
    try {
      const configuredRoot = resolve(dataDir, "browser", "shots");
      const root = join(await realpath(dataDir), "browser", "shots");
      // A symlink in the root itself must not turn the authorized directory into another tree.
      if (relative(root, await realpath(root)) !== "") throw replyError("Screenshot root escapes its data directory");
      for (const path of photos) {
        signal.throwIfAborted();
        if (typeof path !== "string" || !isAbsolute(path) || (!inside(configuredRoot, path) && !inside(root, path))
          || extname(path).toLowerCase() !== ".png") throw replyError("Photo must be an absolute PNG path inside browser/shots");
        const canonical = await realpath(path);
        if (!inside(root, canonical) || extname(canonical).toLowerCase() !== ".png") {
          throw replyError("Photo resolves outside browser/shots or is not PNG");
        }
        const info = await stat(canonical);
        if (!info.isFile() || info.size > 8 * 1024 * 1024) throw replyError("Photo must be a regular file of at most 8 MiB");
        const file = await open(canonical, "r");
        try {
          const opened = await file.stat();
          if (!opened.isFile() || opened.size > 8 * 1024 * 1024) throw replyError("Photo must be a regular file of at most 8 MiB");
          const signature = Buffer.alloc(8);
          const { bytesRead } = await file.read(signature, 0, signature.length, 0);
          if (bytesRead !== 8 || !signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
            throw replyError("Photo does not contain a PNG signature");
          }
        } finally {
          await file.close();
        }
        paths.push(canonical);
      }
    } catch (error) {
      signal.throwIfAborted();
      throw replyError(error instanceof Error ? error.message : "Photo could not be validated");
    }
  }
  signal.throwIfAborted();
  return { text: result.text, photos: paths };
}

function updateIdOf(update: Update): number | undefined {
  const id = update.update_id;
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

function numericId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))) return String(Number(value));
  return undefined;
}

export function toRequest(update: Update, ownerId: string, botId: string): TextRequest | undefined {
  const updateId = updateIdOf(update);
  const message = update.message;
  if (updateId === undefined || !message || message.chat?.type !== "private"
    || typeof message.text !== "string" || !message.text) return;
  const conversationId = numericId(message.chat.id);
  const senderId = numericId(message.from?.id);
  if (!conversationId || !senderId || senderId !== ownerId) return;
  return {
    requestId: `telegram:${botId}:${updateId}`,
    conversationId,
    senderId,
    text: message.text,
  };
}

export function failureCode(error: unknown): string {
  if (error instanceof GrammyError) return `TELEGRAM_${error.error_code}`;
  if (error instanceof Error && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z_]{0,63}$/.test(error.code)) return error.code;
  if (error instanceof Error && error.name === "TimeoutError") return "TIMEOUT";
  return "EXECUTION_ERROR";
}

function isFatal(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "AGENT_SESSION_FAILED";
}

export async function serveTelegram(
  config: ReturnType<typeof readConfig>,
  botId: string,
  inbox: Inbox,
  reply: (request: TextRequest, signal: AbortSignal) => Promise<TelegramReply>,
  signal: AbortSignal,
  client: Pick<TelegramClient, "updates" | "send"> & Partial<Pick<TelegramClient, "sendPhoto">>,
): Promise<void> {
  if (inbox.blocked().length) console.error("Some replies need delivery reconciliation; run npm run deliveries -- list.");
  let pollFailures = 0;
  while (!signal.aborted) {
    const job = inbox.next();
    if (job) {
      if (job.status === "pending") {
        let text: string;
        let photos: readonly string[] = [];
        let errorCode: string | undefined;
        try {
          const result = await validateTelegramReply(job.text.length > 16_000
            ? "消息过长，请拆分后再发送。"
            : await reply(job, signal), config.dataDir, signal);
          text = result.text;
          photos = result.photos;
        } catch (error) {
          if (signal.aborted) return;
          // The Session will reject every later request; a failure notice would only hide that.
          if (isFatal(error)) throw error;
          errorCode = failureCode(error);
          console.error(`Agent request failed: ${job.requestId} (${errorCode})`);
          const partial = errorCode === "AGENT_TRUNCATED" && error instanceof Error && "partialReply" in error
            && typeof error.partialReply === "string" ? error.partialReply.trim() : "";
          text = partial
            ? `${partial}\n\n（回复因长度限制被截断，内容不完整。请拆分请求后重试。）`
            : errorCode === "AGENT_TIMEOUT"
              ? "本次处理超时，已请求停止执行。已执行的操作可能仍然生效，请先核对结果。"
              : errorCode === "REPLY_ATTACHMENT_INVALID"
                ? "本次处理未能完成：截图附件校验失败。已执行的操作可能仍然生效，请先核对结果。"
                : "本次处理未能完成。已执行的操作可能仍然生效，请先核对结果。";
        }
        inbox.saveReply(job.requestId, text, errorCode, photos);
      }
      if (signal.aborted) return;
      let part = inbox.nextPart(job.requestId);
      while (part && !signal.aborted) {
        if (part.type === "photo") {
          let validationError: unknown;
          try {
            if (!client.sendPhoto) throw replyError("Telegram client cannot send photos", "TELEGRAM_PHOTO_UNSUPPORTED");
            // Saved files may have disappeared or changed since the reply was committed.
            await validateTelegramReply({ text: "photo", photos: [part.path] }, config.dataDir, signal);
          } catch (error) {
            validationError = error;
          }
          // Shutdown before an upload starts leaves its saved part pending for recovery.
          if (signal.aborted) return;
          if (validationError) {
            inbox.beginPart(job.requestId, part.part);
            inbox.failPart(job.requestId, part.part, "failed", failureCode(validationError));
            console.error(`Telegram delivery failed: ${job.requestId}, part ${part.part}`);
            break;
          }
        }
        inbox.beginPart(job.requestId, part.part);
        let messageId: string;
        try {
          messageId = part.type === "photo"
            ? await client.sendPhoto!(job.conversationId, part.path, signal)
            : await client.send(job.conversationId, part.text, signal);
        } catch (error) {
          // Explicit Telegram 4xx rejection means not sent. Transport failures remain ambiguous.
          const status = error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500 ? "failed" : "uncertain";
          inbox.failPart(job.requestId, part.part, status, failureCode(error));
          console.error(`Telegram delivery ${status}: ${job.requestId}, part ${part.part}`);
          break;
        }
        // Local state is authoritative: a write failure must stop the process, not look like a send failure.
        inbox.confirmPart(job.requestId, part.part, messageId);
        part = inbox.nextPart(job.requestId);
      }
      inbox.prune();
      continue;
    }

    let updates: Update[];
    try {
      updates = await client.updates(inbox.offset, signal);
      pollFailures = 0;
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof GrammyError && error.error_code < 500 && error.error_code !== 429) throw error;
      const seconds = error instanceof GrammyError && error.error_code === 429
        ? Math.min(60, Math.max(1, error.parameters.retry_after ?? 5))
        : Math.min(30, 2 ** Math.min(++pollFailures, 5));
      console.error(`Telegram polling retry in ${seconds}s (${failureCode(error)})`);
      await delay(seconds * 1000, undefined, { signal }).catch((error: unknown) => {
        if (!signal.aborted) throw error;
      });
      continue;
    }
    for (const update of updates) {
      const updateId = updateIdOf(update);
      if (updateId === undefined) {
        // Without a usable id there is no checkpoint value to advance; skip instead of persisting NaN.
        console.error("Skipping Telegram update without a valid update_id");
        continue;
      }
      inbox.accept(updateId + 1, toRequest(update, config.ownerId, botId));
    }
  }
}

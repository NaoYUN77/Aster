import { Agent as HttpsAgent } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { Api, GrammyError } from "grammy";
import { AbortController as TelegramAbortController, type AbortSignal as TelegramSignal } from "abort-controller";
import type { Update } from "grammy/types";
import { deliverNext, type DeliveryChannel, type ReplyFn } from "./channel.js";
import { hasProxyEnv } from "./config.js";
import { errorCode } from "./errors.js";
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

export class TelegramClient implements DeliveryChannel {
  readonly label = "Telegram";
  private readonly api: Api;

  constructor(token: string, apiRoot?: string, env: NodeJS.ProcessEnv = process.env) {
    this.api = new Api(token, {
      ...(apiRoot ? { apiRoot } : {}),
      ...(hasProxyEnv(env) ? {
        // grammY constructs its own https.Agent without proxyEnv, so NODE_USE_ENV_PROXY=1 on the
        // global agent alone does not route Bot API calls through HTTPS_PROXY.
        baseFetchConfig: { agent: new HttpsAgent({ keepAlive: true, proxyEnv: env }) },
      } : {}),
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

  classifyFailure(error: unknown): "failed" | "uncertain" {
    return classifySendFailure(error);
  }

  failureCode(error: unknown): string {
    return failureCode(error);
  }
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

/** `TELEGRAM_<status>` for a Bot API rejection, otherwise the shared channel-independent code. */
export function failureCode(error: unknown): string {
  if (error instanceof GrammyError) return `TELEGRAM_${error.error_code}`;
  return errorCode(error);
}

/** An explicit Bot API 4xx rejection means the message was not delivered; anything else is unknown. */
export function classifySendFailure(error: unknown): "failed" | "uncertain" {
  return error instanceof GrammyError && error.error_code >= 400 && error.error_code < 500 ? "failed" : "uncertain";
}

function isFatal(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "AGENT_SESSION_FAILED";
}

export async function serveTelegram(
  ownerId: string,
  botId: string,
  inbox: Inbox,
  reply: ReplyFn,
  signal: AbortSignal,
  client: Pick<TelegramClient, "updates" | "send">,
): Promise<void> {
  if (inbox.blocked().length) console.error("Some replies need delivery reconciliation; run npm run deliveries -- list.");
  const channel: DeliveryChannel = {
    label: "Telegram",
    send: (chatId, text, partSignal) => client.send(chatId, text, partSignal),
    classifyFailure: classifySendFailure,
    failureCode,
  };
  let pollFailures = 0;
  while (!signal.aborted) {
    // Agent work and reply delivery are shared with the other channels; this loop only owns polling.
    if (await deliverNext(inbox, reply, signal, channel)) continue;

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
      inbox.accept(updateId + 1, toRequest(update, ownerId, botId));
    }
  }
}

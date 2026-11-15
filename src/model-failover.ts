import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import type { Models, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai/models";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";

/**
 * The message the whole chain ends with. It is deliberately stable and free of provider text: the
 * chat surface shows it verbatim, while the per-model reasons stay in the process log.
 */
export const MODEL_UNAVAILABLE_MESSAGE = "模型暂时不可用";

/** One configured member of the model chain. Kept structural so config parsing needs no pi-ai types. */
export type ModelRef = {
  readonly provider: string;
  readonly modelId: string;
};

export const MODEL_FAILOVER_DEFAULTS = {
  /** No single model request may occupy the run longer than this; the next model takes over. */
  requestTimeoutMs: 90_000,
} as const;

export function modelLabel(model: Pick<Model<Api>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function sameModel(model: Model<Api>, ref: ModelRef): boolean {
  return model.provider === ref.provider && model.id === ref.modelId;
}

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}

function errorAssistant(model: Model<Api>, message: string, stopReason: "error" | "aborted" = "error"): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason,
    errorMessage: message,
    timestamp: Date.now(),
  };
}

/**
 * Error text patterns. The order in `classifyModelFailure` is the policy:
 *
 * - the caller's abort and a context overflow are never followed by another model;
 * - a content/safety refusal is a property of the request, not of the provider;
 * - an exhausted quota or a 429 moves on immediately (Jay's rule), without asking the durable
 *   retry loop to treat it as ordinary rate limiting;
 * - an inaccessible model (auth, missing model, region) moves on;
 * - a malformed request or an unsupported parameter stops the chain;
 * - transport, timeout and 5xx failures move on;
 * - anything unrecognised stops the chain rather than spending another provider's quota.
 */
const CONTENT_POLICY = /content.?(?:filter|policy)|safety.?(?:system|filter)|moderation|flagged/i;
const QUOTA_OR_RATE_LIMIT = new RegExp(
  [
    "(?<![a-z0-9])(?:402|429)(?![a-z0-9])",
    "rate.?limit",
    "too many requests",
    "quota",
    "insufficient_quota",
    "out of budget",
    "billing",
    "available balance",
    "usage limit",
    "GoUsageLimitError",
    "FreeUsageLimitError",
    '"code"\\s*:\\s*"?1308(?![0-9])',
  ].join("|"),
  "i",
);
const MODEL_INACCESSIBLE = new RegExp(
  [
    "(?<![a-z0-9])(?:401|403|404|410)(?![a-z0-9])",
    "model.{0,24}(?:not found|not available|not supported|does not exist|no longer available)",
    "no such model",
    "unknown model",
    "invalid model",
    "model.{0,16}access",
    "invalid.{0,12}(?:api.?key|token)",
    "unauthori[sz]ed",
    "forbidden",
    "authentication",
    "permission denied",
    "access denied",
  ].join("|"),
  "i",
);
const INVALID_REQUEST = new RegExp(
  [
    "(?<![a-z0-9])(?:400|413|422)(?![a-z0-9])",
    "invalid.?(?:request|parameter|argument)",
    "bad request",
    "validation",
    "unsupported.?(?:parameter|value)",
    "max_tokens",
    "temperature",
    "tool_choice",
    "does not support",
    "not supported for",
  ].join("|"),
  "i",
);
const TRANSIENT = new RegExp(
  [
    "(?<![a-z0-9])(?:500|502|503|504|520|524|529)(?![a-z0-9])",
    "overloaded",
    "server.?busy",
    "high demand",
    "at capacity",
    "server.?error",
    "internal.?error",
    "service.?(?:is.?)?(?:temporarily.?)?unavailable",
    "timeout",
    "timed out",
    "ETIMEDOUT",
    "deadline exceeded",
    "network.?error",
    "connection.?(?:error|refused|lost|reset|closed)",
    "ECONN(?:REFUSED|RESET|ABORTED)",
    "ENOTFOUND",
    "EAI_AGAIN",
    "getaddrinfo",
    "socket hang up",
    "fetch failed",
    "other side closed",
    "upstream.?connect",
    "reset before headers",
    "stream.?(?:disconnected|interrupted|ended)",
    "ended without",
    "terminated",
  ].join("|"),
  "i",
);

export type ModelFailureVerdict =
  | { readonly action: "switch"; readonly reason: string }
  | { readonly action: "stop"; readonly reason: string };

/**
 * Decide what one failed model call means. `message.errorMessage` is the only provider text
 * available downstream, so this is intentionally conservative: an unrecognised failure stops the
 * chain and leaves the original error visible instead of silently trying another account.
 */
export function classifyModelFailure(message: AssistantMessage, model: Model<Api>): ModelFailureVerdict {
  if (message.stopReason === "aborted") return { action: "stop", reason: "aborted" };
  const text = message.errorMessage?.trim() ?? "";
  if (text === "") return { action: "stop", reason: "unknown" };
  // Compaction owns overflow: another model would only hide a request that does not fit.
  if (isContextOverflow(message, model.contextWindow)) return { action: "stop", reason: "context-overflow" };
  if (CONTENT_POLICY.test(text)) return { action: "stop", reason: "content-policy" };
  if (QUOTA_OR_RATE_LIMIT.test(text)) return { action: "switch", reason: "quota-or-rate-limit" };
  if (MODEL_INACCESSIBLE.test(text)) return { action: "switch", reason: "model-inaccessible" };
  if (INVALID_REQUEST.test(text)) return { action: "stop", reason: "invalid-request" };
  if (TRANSIENT.test(text)) return { action: "switch", reason: "transient" };
  return { action: "stop", reason: "unknown" };
}

/** Image blocks can appear in a user turn or in a tool result. */
function hasImageContent(context: Context): boolean {
  return context.messages.some((message) => {
    if (message.role === "system") return false;
    return Array.isArray(message.content) && message.content.some((block) => block.type === "image");
  });
}

/**
 * A response produced by one provider/model can carry signatures and reasoning blocks that only
 * that upstream understands. Before another model sees the transcript, drop the provider-private
 * parts; the visible text, tool calls and tool results stay exactly as they are.
 */
export function contextForModel(context: Context, model: Model<Api>): Context {
  let changed = false;
  const messages = context.messages.map((message): Message => {
    if (message.role !== "assistant") return message;
    if (message.provider === model.provider && message.model === model.id) return message;
    const content: AssistantMessage["content"] = [];
    for (const block of message.content) {
      if (block.type === "thinking") {
        changed = true;
        continue;
      }
      if (block.type === "text" && block.textSignature !== undefined) {
        const { textSignature: _signature, ...rest } = block;
        content.push(rest);
        changed = true;
        continue;
      }
      if (block.type === "toolCall" && (block.thoughtSignature !== undefined || block.namespace !== undefined)) {
        const { thoughtSignature: _thought, namespace: _namespace, ...rest } = block;
        content.push(rest);
        changed = true;
        continue;
      }
      content.push(block);
    }
    return { ...message, content };
  });
  return changed ? { ...context, messages } : context;
}

/** Options for a fallback attempt: keep what the model supports, clamp the output budget. */
function optionsForModel(
  options: ModelsSimpleStreamOptions | undefined,
  model: Model<Api>,
): ModelsSimpleStreamOptions | undefined {
  if (options === undefined) return undefined;
  let changed = false;
  const next: ModelsSimpleStreamOptions = { ...options };
  if (next.maxTokens !== undefined && next.maxTokens > model.maxTokens) {
    next.maxTokens = model.maxTokens;
    changed = true;
  }
  if (!model.reasoning && next.reasoning !== undefined) {
    delete next.reasoning;
    changed = true;
  }
  if (!model.reasoning && next.thinkingBudgets !== undefined) {
    delete next.thinkingBudgets;
    changed = true;
  }
  return changed ? next : options;
}

/** Log-safe provider detail: one bounded line, with bearer credentials removed. */
function safeDetail(text: string | undefined): string {
  if (text === undefined) return "";
  return text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/\s+/g, " ").trim().slice(0, 400);
}

export type ModelFailoverOptions = {
  /** Structured log sink; defaults to stderr. Switching is never announced in chat. */
  readonly log?: (line: string) => void;
};

type AttemptFailure = {
  readonly message: AssistantMessage;
  readonly model: Model<Api>;
  readonly reason: string;
};

function unavailable(last: Model<Api>): AssistantMessage {
  return errorAssistant(last, MODEL_UNAVAILABLE_MESSAGE);
}

/**
 * Wrap a `Models` collection so a failed primary call continues with the next configured model.
 *
 * Only calls whose model belongs to `chain` are managed; every other method and every other model
 * passes through untouched. Once a call has moved past a model it never goes back to it, and the
 * wrapper keeps no state between calls: the next request starts at its own first chain entry.
 *
 * Streaming events are held until an attempt ends, then replayed only if it succeeded. A failed
 * attempt therefore never leaks a partial answer or a second `start` event to the durable harness.
 */
export function createModelFailover(
  models: Models,
  chain: readonly Model<Api>[],
  options: ModelFailoverOptions = {},
): Models {
  if (chain.length < 2) return models;
  const log = options.log ?? ((line: string) => console.error(line));

  const startIndex = (requested: Model<Api>): number =>
    chain.findIndex((model) => model.provider === requested.provider && model.id === requested.id);

  const noteSkip = (model: Model<Api>, context: Context): boolean => {
    if (!hasImageContent(context) || model.input.includes("image")) return false;
    log(`Model failover: ${modelLabel(model)} skipped (context carries images and this model is text-only)`);
    return true;
  };

  const remember = (
    failures: AttemptFailure[],
    model: Model<Api>,
    message: AssistantMessage,
    verdict: ModelFailureVerdict,
    hasNext: boolean,
  ) => {
    failures.push({ message, model, reason: verdict.reason });
    const outcome = verdict.action === "stop" ? "not switching" : hasNext ? "trying the next model" : "no model left";
    log(
      `Model failover: ${modelLabel(model)} failed (${verdict.reason}); ${outcome}`
      + (message.errorMessage === undefined ? "" : `: ${safeDetail(message.errorMessage)}`),
    );
  };

  const giveUp = (model: Model<Api>): AssistantMessage => {
    log(`Model failover: every configured model failed; reporting ${MODEL_UNAVAILABLE_MESSAGE}`);
    return unavailable(model);
  };

  const streamSimple = (
    requested: Model<Api>,
    context: Context,
    streamOptions?: ModelsSimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const start = startIndex(requested);
    if (start < 0) return models.streamSimple(requested, context, streamOptions);

    const output = createAssistantMessageEventStream();
    let lastModel = requested;
    void (async () => {
      const failures: AttemptFailure[] = [];
      for (let index = start; index < chain.length; index++) {
        const model = chain[index]!;
        lastModel = model;
        if (streamOptions?.signal?.aborted) {
          const aborted = errorAssistant(model, "Request was aborted", "aborted");
          output.push({ type: "error", reason: "aborted", error: aborted });
          output.end(aborted);
          return;
        }
        if (index > start && noteSkip(model, context)) continue;
        const attemptContext = index === start ? context : contextForModel(context, model);
        const attemptOptions = index === start ? streamOptions : optionsForModel(streamOptions, model);
        let stream: AssistantMessageEventStream;
        try {
          stream = models.streamSimple(model, attemptContext, attemptOptions);
        } catch (error) {
          const thrown = errorAssistant(model, errorMessage(error));
          const verdict = classifyModelFailure(thrown, model);
          remember(failures, model, thrown, verdict, index + 1 < chain.length);
          if (verdict.action === "switch" && index + 1 < chain.length) continue;
          if (verdict.action === "switch") {
            const failure = giveUp(model);
            output.push({ type: "error", reason: "error", error: failure });
            output.end(failure);
          } else {
            output.push({ type: "error", reason: "error", error: thrown });
            output.end(thrown);
          }
          return;
        }
        const terminal = await terminalEvent(stream, model);
        if (terminal.type === "done") {
          if (failures.length > 0) log(`Model failover: answered by ${modelLabel(model)}`);
          output.push(terminal);
          output.end(terminal.message);
          return;
        }
        if (terminal.reason === "aborted" || streamOptions?.signal?.aborted) {
          output.push(terminal);
          output.end(terminal.error);
          return;
        }
        const verdict = classifyModelFailure(terminal.error, model);
        remember(failures, model, terminal.error, verdict, index + 1 < chain.length);
        if (verdict.action === "switch" && index + 1 < chain.length) continue;
        if (verdict.action === "switch") {
          const failure = giveUp(model);
          output.push({ type: "error", reason: "error", error: failure });
          output.end(failure);
        } else {
          output.push(terminal);
          output.end(terminal.error);
        }
        return;
      }
      const failure = giveUp(lastModel);
      output.push({ type: "error", reason: "error", error: failure });
      output.end(failure);
    })().catch((error: unknown) => {
      const failure = errorAssistant(lastModel, errorMessage(error));
      output.push({ type: "error", reason: "error", error: failure });
      output.end(failure);
    });
    return output;
  };

  const completeSimple = async (
    requested: Model<Api>,
    context: Context,
    completeOptions?: ModelsSimpleStreamOptions,
  ): Promise<AssistantMessage> => {
    const start = startIndex(requested);
    if (start < 0) return models.completeSimple(requested, context, completeOptions);

    const failures: AttemptFailure[] = [];
    let lastModel = requested;
    for (let index = start; index < chain.length; index++) {
      const model = chain[index]!;
      lastModel = model;
      if (completeOptions?.signal?.aborted) return errorAssistant(model, "Request was aborted", "aborted");
      if (index > start && noteSkip(model, context)) continue;
      const attemptContext = index === start ? context : contextForModel(context, model);
      const attemptOptions = index === start ? completeOptions : optionsForModel(completeOptions, model);
      let message: AssistantMessage;
      try {
        message = await models.completeSimple(model, attemptContext, attemptOptions);
      } catch (error) {
        if (completeOptions?.signal?.aborted) throw error;
        message = errorAssistant(model, errorMessage(error));
        const verdict = classifyModelFailure(message, model);
        remember(failures, model, message, verdict, index + 1 < chain.length);
        if (verdict.action === "switch" && index + 1 < chain.length) continue;
        if (verdict.action === "switch") return giveUp(model);
        if (failures.length === 1) throw error;
        return message;
      }
      if (message.stopReason !== "error" && message.stopReason !== "aborted") {
        if (failures.length > 0) log(`Model failover: answered by ${modelLabel(model)}`);
        return message;
      }
      if (message.stopReason === "aborted" || completeOptions?.signal?.aborted) return message;
      const verdict = classifyModelFailure(message, model);
      remember(failures, model, message, verdict, index + 1 < chain.length);
      if (verdict.action === "switch" && index + 1 < chain.length) continue;
      if (verdict.action === "switch") return giveUp(model);
      return message;
    }
    return giveUp(lastModel);
  };

  return new Proxy(models, {
    get(target, property, receiver) {
      if (property === "streamSimple") return streamSimple;
      if (property === "completeSimple") return completeSimple;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Models;
}

type TerminalEvent = Extract<AssistantMessageEvent, { type: "done" } | { type: "error" }>;

/** Consume a response stream without forwarding anything and return its terminal event. */
async function terminalEvent(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
): Promise<TerminalEvent> {
  let terminal: TerminalEvent | undefined;
  for await (const event of stream) {
    if (event.type === "done" || event.type === "error") terminal = event;
  }
  if (terminal !== undefined) return terminal;
  // A stream that ended without a terminal event is a broken provider contract; surface it as one.
  return { type: "error", reason: "error", error: errorAssistant(model, "Model response ended without a terminal event") };
}

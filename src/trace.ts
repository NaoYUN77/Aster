// Langfuse Cloud tracing for one agent request and everything it executes.
//
// Interface
//   startTrace(config)                    install the process-wide runtime; undefined when disabled
//   beginRequest(meta)                    start the root observation for one user request
//   recordGeneration(...)                 one LLM generation, from the existing response hook
//   recordRegistryDecision(...)           one authorization decision, allow or deny
//   beginToolExecution(meta)              start one admitted tool execution; end it when it settles
//   recordLoopGuard(...)                  warning/halt evidence, correlated to its request
//   TraceRuntime.close()                  end abandoned observations, flush, release Langfuse
//
// Inputs: host-observed identifiers (conversation, request, task, call, session) and lengths,
// counts and error codes. Message text, tool arguments, file contents and tool results are never
// attached: a tool execution carries the argument names, their count and the serialized size of the
// call, never a value. Credentials, authorization headers and provider error messages never enter
// the trace either.
//
// Errors: tracing is diagnostics. A construction or export failure disables tracing and is logged
// once; it never propagates into a tool call, hook or shutdown path.
//
// Side effects: OpenTelemetry spans exported to Langfuse over OTLP. Nothing is written to disk.

import type { SpanContext, TracerProvider } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  LangfuseOtelSpanAttributes,
  setLangfuseTracerProvider,
  startObservation,
  type LangfuseSpan,
} from "@langfuse/tracing";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationId, HookApi, TaskId } from "@earendil-works/pi-durable";
import { hasProxyEnv, type TraceConfig } from "./config.js";

/** Active request observations are bounded; the oldest is ended as unknown. */
const ACTIVE_LIMIT = 256;
/** One observation may not grow without bound through events. */
const MAX_EVENTS_PER_SPAN = 256;
/** Argument names are a bounded summary of the call, never its payload. */
const MAX_ARGUMENT_NAMES = 24;
const MAX_ARGUMENT_NAMES_CHARS = 512;
const FLUSH_TIMEOUT_MS = 5_000;

export type TraceFields = Readonly<Record<string, string | number | boolean | undefined>>;
export type TraceOutcome = "ok" | "error" | "aborted" | "unknown" | "halted";
export type TraceSpanKind = "span" | "tool" | "agent";

/** One admitted tool execution, described at the boundary: identity, policy and sizes, never values. */
export type ToolExecutionMeta = {
  readonly tool: string;
  /** Where the implementation came from: `builtin:<extension>`, `mcp:<server>` or `plugin:<name>`. */
  readonly source: string;
  readonly trust: string;
  readonly authz: string;
  readonly replay: string;
  readonly tier: number;
  /** Argument names, not argument values. */
  readonly argNames: readonly string[];
  /** Serialized size of the whole call, so an oversized argument is visible without its content. */
  readonly argsBytes: number;
  readonly conversationId: ConversationId;
  readonly taskId: TaskId;
  readonly callId?: string;
};

type Identity = {
  readonly conversationId: ConversationId;
  readonly taskId: TaskId;
  readonly callId?: string;
};

type CompactFields = Record<string, string | number | boolean>;

function compact(fields: TraceFields): CompactFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as CompactFields;
}

function levelFor(outcome: TraceOutcome): "DEFAULT" | "WARNING" | "ERROR" {
  if (outcome === "ok") return "DEFAULT";
  if (outcome === "aborted" || outcome === "halted") return "WARNING";
  return "ERROR";
}

/** Fixed text only: an SDK error may quote a URL or payload. */
function errorLabel(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "unknown";
}

export class TraceSpan {
  readonly #observation: LangfuseSpan;
  readonly #log: (line: string) => void;
  readonly traceId: string;
  readonly spanId: string;
  readonly spanContext: SpanContext;
  readonly #startedAt = performance.now();
  #ended = false;
  #haltCode: string | undefined;
  #events = 0;
  #truncated = false;

  private constructor(observation: LangfuseSpan, log: (line: string) => void) {
    this.#observation = observation;
    this.#log = log;
    this.spanContext = observation.otelSpan.spanContext();
    this.traceId = this.spanContext.traceId;
    this.spanId = this.spanContext.spanId;
  }

  static start(options: {
    readonly name: string;
    readonly kind?: TraceSpanKind;
    readonly fields?: TraceFields;
    readonly parent?: SpanContext;
    readonly sessionId?: string;
    readonly log?: (line: string) => void;
  }): TraceSpan {
    const name = options.name.slice(0, 128);
    const attributes = { metadata: compact(options.fields ?? {}) };
    const parent = options.parent === undefined ? {} : { parentSpanContext: options.parent };
    let observation: LangfuseSpan;
    switch (options.kind ?? "span") {
      case "tool":
        observation = startObservation(name, attributes, { asType: "tool", ...parent });
        break;
      case "agent":
        observation = startObservation(name, attributes, { asType: "agent", ...parent });
        break;
      default:
        observation = startObservation(name, attributes, parent);
    }
    if (options.sessionId !== undefined) {
      observation.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_SESSION_ID, options.sessionId.slice(0, 200));
    }
    if (options.parent === undefined) {
      observation.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_NAME, name);
    }
    return new TraceSpan(observation, options.log ?? console.error);
  }

  get haltedCode(): string | undefined {
    return this.#haltCode;
  }

  markHalted(code: string): void {
    this.#haltCode = code;
  }

  event(name: string, fields: TraceFields = {}): void {
    if (this.#ended) return;
    if (this.#events >= MAX_EVENTS_PER_SPAN) {
      if (this.#truncated) return;
      this.#truncated = true;
      this.#emit("events.truncated", { droppedAfter: MAX_EVENTS_PER_SPAN });
      return;
    }
    this.#events += 1;
    this.#emit(name, fields);
  }

  end(outcome: TraceOutcome, fields: TraceFields = {}): void {
    if (this.#ended) return;
    this.#ended = true;
    const finalOutcome = this.#haltCode !== undefined && outcome !== "unknown" && outcome !== "aborted"
      ? "halted"
      : outcome;
    const errorCode = typeof fields.errorCode === "string" ? fields.errorCode : undefined;
    // A halt is a business outcome the host may surface as success; its code still belongs in the trace.
    const statusCode = errorCode ?? (finalOutcome === "halted" ? this.#haltCode : undefined);
    try {
      this.#observation.update({
        level: levelFor(finalOutcome),
        ...(statusCode === undefined ? {} : { statusMessage: statusCode.slice(0, 128) }),
        metadata: {
          ...compact(fields),
          ...(errorCode === undefined ? {} : { errorCode: errorCode.slice(0, 128) }),
          outcome: finalOutcome,
          durationMs: Math.max(0, Math.round(performance.now() - this.#startedAt)),
        },
      });
      this.#observation.end();
    } catch (error) {
      this.#report(error);
    }
  }

  #emit(name: string, fields: TraceFields): void {
    try {
      startObservation(name.slice(0, 128), { metadata: compact(fields) }, {
        asType: "event",
        parentSpanContext: this.spanContext,
      });
    } catch (error) {
      this.#report(error);
    }
  }

  #report(error: unknown): void {
    this.#log(`Langfuse trace span failed: ${errorLabel(error)}`);
  }
}

/** Span creation is diagnostics too: an SDK failure must not break the operation it observes. */
function startSpan(options: Parameters<typeof TraceSpan.start>[0]): TraceSpan | undefined {
  try {
    return TraceSpan.start(options);
  } catch (error) {
    (options.log ?? console.error)(`Langfuse trace span failed: ${errorLabel(error)}`);
    return undefined;
  }
}

export type TraceDependencies = {
  /** Test seam: export into another provider instead of a Langfuse processor. */
  readonly tracerProvider?: TracerProvider;
};

export class TraceRuntime {
  readonly #provider: TracerProvider;
  readonly #ownsProvider: boolean;
  readonly #log: (line: string) => void;
  readonly #requests = new Map<string, TraceSpan>();
  #closing = false;

  constructor(provider: TracerProvider, log: (line: string) => void, ownsProvider: boolean) {
    this.#provider = provider;
    this.#log = log;
    this.#ownsProvider = ownsProvider;
  }

  beginRequest(options: {
    readonly conversationId: string | number;
    readonly requestId?: string;
    readonly fields?: TraceFields;
  }): TraceSpan | undefined {
    if (this.#closing) return undefined;
    const key = String(options.conversationId);
    const previous = this.#requests.get(key);
    if (previous !== undefined) {
      this.#requests.delete(key);
      previous.end("unknown", { abandoned: true, reason: "superseded" });
    }
    evict(this.#requests);
    const span = startSpan({
      name: "agent.request",
      kind: "agent",
      sessionId: key,
      fields: {
        conversationId: key,
        ...(options.requestId === undefined ? {} : { requestId: options.requestId.slice(0, 200) }),
        ...options.fields,
      },
      log: this.#log,
    });
    if (span === undefined) return undefined;
    this.#requests.set(key, span);
    return span;
  }

  requestFor(conversationId: ConversationId): TraceSpan | undefined {
    return this.#requests.get(String(conversationId));
  }

  recordGeneration(message: AssistantMessage, api: Pick<HookApi, "conversationId" | "taskId">): void {
    if (this.#closing) return;
    const parent = this.requestFor(api.conversationId);
    if (parent === undefined) return;
    try {
      const usage = message.usage;
      const observation = startObservation("llm.generation", {
        model: (message.responseModel ?? message.model).slice(0, 128),
        modelParameters: {
          provider: message.provider.slice(0, 128),
          api: message.api,
          ...(message.thinkingLevel === undefined ? {} : { thinkingLevel: message.thinkingLevel }),
        },
        usageDetails: {
          input: usage.input,
          output: usage.output,
          total: usage.totalTokens,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
        },
        ...(usage.cost.total > 0 ? { costDetails: { totalCost: usage.cost.total } } : {}),
        metadata: generationMetadata(message),
        ...(message.stopReason === "error"
          ? { level: "ERROR" as const, statusMessage: "MODEL_ERROR" }
          : {}),
      }, {
        asType: "generation",
        parentSpanContext: parent.spanContext,
        startTime: new Date(message.timestamp),
      });
      observation.end(message.durationMs === undefined
        ? undefined
        : new Date(message.timestamp + Math.max(0, message.durationMs)));
    } catch (error) {
      this.#report(error);
    }
  }

  /**
   * One tool call that passed review, as its own span under the active request. The span measures
   * the execution itself: it opens after authorization and the caller ends it when the tool
   * settles, so its duration and outcome are the tool's, not the review's. A call with no active
   * request (background work) is not traced, exactly like a registry decision.
   */
  beginToolExecution(meta: ToolExecutionMeta): TraceSpan | undefined {
    if (this.#closing) return undefined;
    const parent = this.requestFor(meta.conversationId);
    if (parent === undefined) return undefined;
    return startSpan({
      name: "tool.execution",
      kind: "tool",
      parent: parent.spanContext,
      fields: {
        tool: meta.tool.slice(0, 128),
        source: meta.source.slice(0, 128),
        trust: meta.trust,
        authz: meta.authz,
        replay: meta.replay,
        tier: meta.tier,
        taskId: String(meta.taskId),
        ...(meta.callId === undefined ? {} : { callId: meta.callId.slice(0, 128) }),
        argNames: meta.argNames.slice(0, MAX_ARGUMENT_NAMES).join(",").slice(0, MAX_ARGUMENT_NAMES_CHARS),
        argCount: meta.argNames.length,
        argsBytes: meta.argsBytes,
      },
      log: this.#log,
    });
  }

  recordLoopGuard(
    call: Identity & { tool: string; count: number; reason?: string },
    code: "LOOP_GUARD_WARNING" | "LOOP_GUARD_HALT",
  ): void {
    const span = this.requestFor(call.conversationId);
    if (span === undefined) return;
    span.event(code === "LOOP_GUARD_HALT" ? "loop_guard.halt" : "loop_guard.warning", {
      tool: call.tool.slice(0, 128),
      count: call.count,
      ...(call.reason === undefined ? {} : { reason: call.reason }),
    });
    if (code === "LOOP_GUARD_HALT") span.markHalted("AGENT_LOOP_DETECTED");
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const span of [...this.#requests.values()]) span.end("unknown", { abandoned: true, reason: "closed" });
    this.#requests.clear();
    setLangfuseTracerProvider(null);
    if (!this.#ownsProvider) return;
    const shutdown = (this.#provider as { shutdown?: () => Promise<void> }).shutdown;
    if (typeof shutdown !== "function") return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        shutdown.call(this.#provider),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
    } catch (error) {
      this.#report(error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #report(error: unknown): void {
    this.#log(`Langfuse tracing failed: ${errorLabel(error)}`);
  }
}

function evict(map: Map<string, TraceSpan>): void {
  while (map.size >= ACTIVE_LIMIT) {
    const oldest = map.entries().next();
    if (oldest.done) return;
    const [key, span] = oldest.value;
    map.delete(key);
    span.end("unknown", { abandoned: true, reason: "evicted" });
  }
}

/** Boundary metadata only. Prompt text, commands, paths and outputs stay out of the trace. */
function generationMetadata(message: AssistantMessage): CompactFields {
  let textItems = 0;
  let thinkingItems = 0;
  let toolCalls = 0;
  let textBytes = 0;
  let thinkingBytes = 0;
  for (const item of message.content) {
    if (item.type === "text") {
      textItems += 1;
      textBytes += Buffer.byteLength(item.text, "utf8");
    } else if (item.type === "thinking") {
      thinkingItems += 1;
      thinkingBytes += Buffer.byteLength(item.thinking, "utf8");
    } else if (item.type === "toolCall") {
      toolCalls += 1;
    }
  }
  return {
    provider: message.provider.slice(0, 128),
    api: message.api,
    model: message.model.slice(0, 128),
    ...(message.responseModel === undefined ? {} : { responseModel: message.responseModel.slice(0, 128) }),
    stopReason: message.stopReason,
    outputItems: message.content.length,
    textItems,
    thinkingItems,
    toolCalls,
    textBytes,
    thinkingBytes,
  };
}

let activeRuntime: TraceRuntime | undefined;

/**
 * The Langfuse SDK's default exporter builds its own keep-alive agent, which bypasses Node's global
 * proxy configuration. In MITM deployments that means OTLP traffic never reaches the proxy and the
 * vault placeholders inside Authorization are never substituted. Build the same OTLP request with a
 * proxy-aware agent instead. Authentication headers match the SDK's request; configureEnvProxy() has
 * already put the proxy credentials into process.env.
 */
function proxyAwareExporter(keys: {
  readonly publicKey: string;
  readonly secretKey: string;
  readonly baseUrl?: string;
}): OTLPTraceExporter {
  const baseUrl = (keys.baseUrl ?? "https://cloud.langfuse.com").replace(/\/+$/, "");
  return new OTLPTraceExporter({
    url: `${baseUrl}/api/public/otel/v1/traces`,
    headers: {
      Authorization: `Basic ${Buffer.from(`${keys.publicKey}:${keys.secretKey}`, "utf8").toString("base64")}`,
      "x-langfuse-public-key": keys.publicKey,
      "x-langfuse-ingestion-version": "4",
    },
    // Same env parsing as the Langfuse SDK's default exporter.
    timeoutMillis: Number(process.env.LANGFUSE_TIMEOUT || 5) * 1_000,
    httpAgentOptions: { keepAlive: true, proxyEnv: process.env },
  });
}

/**
 * Replace the process-wide runtime. Disabled or incomplete configuration closes the previous one
 * and leaves every tracing call a no-op.
 */
export function startTrace(
  config: TraceConfig,
  log: (line: string) => void = console.error,
  dependencies: TraceDependencies = {},
): TraceRuntime | undefined {
  const previous = activeRuntime;
  activeRuntime = undefined;
  if (previous !== undefined) void previous.close();
  if (!config.enabled) return undefined;
  let provider = dependencies.tracerProvider;
  let ownsProvider = false;
  if (provider === undefined) {
    if (config.publicKey === undefined || config.secretKey === undefined) {
      log("Langfuse tracing disabled: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are both required");
      return undefined;
    }
    const publicKey = config.publicKey;
    const secretKey = config.secretKey;
    try {
      const processor = new LangfuseSpanProcessor({
        publicKey,
        secretKey,
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        // The trace never carries media; disabling upload avoids any attempt to fetch it.
        mediaUploadEnabled: false,
        ...(hasProxyEnv(process.env)
          ? { exporter: proxyAwareExporter({ publicKey, secretKey, baseUrl: config.baseUrl }) }
          : {}),
      });
      provider = new NodeTracerProvider({ spanProcessors: [processor] });
      ownsProvider = true;
    } catch (error) {
      log(`Langfuse tracing disabled: ${errorLabel(error)}`);
      return undefined;
    }
  }
  setLangfuseTracerProvider(provider);
  const runtime = new TraceRuntime(provider, log, ownsProvider);
  activeRuntime = runtime;
  return runtime;
}

export function beginRequest(options: {
  readonly conversationId: string | number;
  readonly requestId?: string;
  readonly fields?: TraceFields;
}): TraceSpan | undefined {
  return activeRuntime?.beginRequest(options);
}

export function recordGeneration(
  message: AssistantMessage,
  api: Pick<HookApi, "conversationId" | "taskId">,
): void {
  activeRuntime?.recordGeneration(message, api);
}

export function recordRegistryDecision(
  fields: {
    tool: string;
    decision: "allow" | "deny";
    code: string;
    authz?: string;
    state?: string;
    authority: string;
    conversationId: ConversationId;
    taskId: TaskId;
  },
): void {
  const span = activeRuntime?.requestFor(fields.conversationId);
  if (span === undefined) return;
  span.event("registry.decision", {
    tool: fields.tool.slice(0, 128),
    decision: fields.decision,
    code: fields.code,
    authz: fields.authz,
    state: fields.state,
    authority: fields.authority,
  });
}

export function recordLoopGuard(
  call: Identity & { tool: string; count: number; reason?: string },
  code: "LOOP_GUARD_WARNING" | "LOOP_GUARD_HALT",
): void {
  activeRuntime?.recordLoopGuard(call, code);
}

/** Undefined when tracing is off, no request is active, or the span could not be created. */
export function beginToolExecution(meta: ToolExecutionMeta): TraceSpan | undefined {
  return activeRuntime?.beginToolExecution(meta);
}

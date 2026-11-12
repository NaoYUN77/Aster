import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ConfigurationError, readTraceConfig } from "../src/config.js";
import {
  beginRequest,
  beginToolExecution,
  recordGeneration,
  recordLoopGuard,
  recordRegistryDecision,
  startTrace,
} from "../src/trace.js";

function setup() {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { exporter, provider };
}

function spanByName(spans: readonly ReadableSpan[], name: string): ReadableSpan {
  const span = spans.find((candidate) => candidate.name === name);
  assert.ok(span, `missing span ${name}; got ${spans.map(({ name }) => name).join(", ")}`);
  return span;
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "PROMPT_SECRET final answer" }],
    api: "chat",
    provider: "openai",
    model: "faux-1",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now() - 50,
    durationMs: 50,
    ...overrides,
  };
}

test("trace config reads Langfuse keys and keeps tracing optional", () => {
  assert.deepEqual(readTraceConfig({}), { enabled: false });

  const configured = readTraceConfig({
    LANGFUSE_PUBLIC_KEY: "pk-test",
    LANGFUSE_SECRET_KEY: "sk-test",
    LANGFUSE_HOST: "https://langfuse.example",
  });
  assert.deepEqual(configured, {
    enabled: true,
    publicKey: "pk-test",
    secretKey: "sk-test",
    baseUrl: "https://langfuse.example",
  });

  assert.equal(readTraceConfig({
    LANGFUSE_PUBLIC_KEY: "pk-test",
    LANGFUSE_SECRET_KEY: "sk-test",
    LANGFUSE_TRACING_ENABLED: "0",
  }).enabled, false);

  // An explicit request without keys stays enabled so startTrace can explain why it is a no-op.
  assert.deepEqual(readTraceConfig({ LANGFUSE_TRACING_ENABLED: "1" }), { enabled: true });

  assert.throws(
    () => readTraceConfig({ LANGFUSE_TRACING_ENABLED: "yes" }),
    (error: unknown) => error instanceof ConfigurationError,
  );
});

test("a request and its registry decisions share one trace and nest", () => {
  const { exporter, provider } = setup();
  let logs = 0;
  const runtime = startTrace({ enabled: true }, () => { logs += 1; }, { tracerProvider: provider });
  assert.ok(runtime);

  const request = beginRequest({
    conversationId: 1,
    requestId: "telegram:1:req-1",
    fields: { textBytes: 123 },
  });
  assert.ok(request);
  recordRegistryDecision({
    tool: "read",
    decision: "allow",
    code: "TOOL_ALLOWED",
    authority: "owner",
    conversationId: 1 as ConversationId,
    taskId: 1 as TaskId,
  });
  request.end("ok", { replyBytes: 2 });

  const spans = exporter.getFinishedSpans();
  const requestSpan = spanByName(spans, "agent.request");
  const decision = spanByName(spans, "registry.decision");

  assert.equal(decision.spanContext().traceId, request.traceId, "the decision joins the request trace");
  assert.equal(decision.parentSpanContext?.spanId, request.spanId);
  assert.equal(requestSpan.attributes["langfuse.observation.metadata.textBytes"], "123");
  assert.equal(requestSpan.attributes["langfuse.observation.metadata.outcome"], "\"ok\"");
  assert.equal(decision.attributes["langfuse.observation.metadata.decision"], "\"allow\"");
  assert.equal(requestSpan.attributes["langfuse.observation.input"], undefined, "metadata only by default");
  assert.equal(logs, 0, "no tracing warnings during a healthy export");

  return runtime.close();
});

test("an LLM generation joins the request trace without uploading prompt or output text", () => {
  const { exporter, provider } = setup();
  const runtime = startTrace({ enabled: true }, () => {}, { tracerProvider: provider });
  assert.ok(runtime);
  const request = beginRequest({ conversationId: 2, requestId: "telegram:2:req-1" });
  assert.ok(request);

  recordGeneration(assistantMessage({
    content: [
      { type: "thinking", thinking: "THINKING_SECRET" },
      { type: "text", text: "PROMPT_SECRET body" },
      { type: "toolCall", id: "tool-1", name: "bash", arguments: {} },
    ],
    errorMessage: "PROVIDER_SECRET error text",
  }), { conversationId: 2 as ConversationId, taskId: 2 as TaskId });
  request.end("ok", { replyBytes: 4 });

  const generation = spanByName(exporter.getFinishedSpans(), "llm.generation");
  assert.equal(generation.spanContext().traceId, request.traceId);
  assert.equal(generation.parentSpanContext?.spanId, request.spanId);
  assert.equal(generation.attributes["langfuse.observation.type"], "generation");
  assert.equal(generation.attributes["langfuse.observation.model.name"], "faux-1");
  assert.match(String(generation.attributes["langfuse.observation.usage_details"]), /"total":30/);
  assert.equal(generation.attributes["langfuse.observation.metadata.stopReason"], "\"stop\"");
  assert.equal(generation.attributes["langfuse.observation.metadata.toolCalls"], "1");

  const exported = JSON.stringify(generation.attributes);
  for (const secret of ["PROMPT_SECRET", "THINKING_SECRET", "PROVIDER_SECRET"]) {
    assert.equal(exported.includes(secret), false, `${secret} must not be exported`);
  }

  return runtime.close();
});

test("loop guard halt ends the request as halted without exporting tool arguments", () => {
  const { exporter, provider } = setup();
  const runtime = startTrace({ enabled: true }, () => {}, { tracerProvider: provider });
  assert.ok(runtime);
  const request = beginRequest({ conversationId: 3 });
  assert.ok(request);

  recordLoopGuard({
    conversationId: 3 as ConversationId,
    taskId: 3 as TaskId,
    callId: "call-3",
    tool: "bash",
    count: 6,
  }, "LOOP_GUARD_HALT");
  request.end("ok", { replyBytes: 1 });

  const halt = spanByName(exporter.getFinishedSpans(), "loop_guard.halt");
  assert.equal(halt.parentSpanContext?.spanId, request.spanId);
  assert.equal(halt.attributes["langfuse.observation.metadata.count"], "6");
  const requestSpan = spanByName(exporter.getFinishedSpans(), "agent.request");
  assert.equal(requestSpan.attributes["langfuse.observation.metadata.outcome"], "\"halted\"");
  assert.equal(requestSpan.attributes["langfuse.observation.status_message"], "AGENT_LOOP_DETECTED");

  return runtime.close();
});

test("the real Langfuse processor exports only the observations we create", async () => {
  const exporter = new InMemorySpanExporter();
  const processor = new LangfuseSpanProcessor({
    publicKey: "pk-test",
    secretKey: "sk-test",
    exporter,
    exportMode: "immediate",
    mediaUploadEnabled: false,
  });
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  const runtime = startTrace({ enabled: true }, () => {}, { tracerProvider: provider });
  assert.ok(runtime);

  const request = beginRequest({ conversationId: 4, fields: { textBytes: 7 } });
  assert.ok(request);
  request.end("ok", { replyBytes: 2 });
  await processor.forceFlush();

  const spans = exporter.getFinishedSpans();
  assert.equal(spans.length, 1);
  assert.equal(spans[0]!.name, "agent.request");
  assert.equal(spans[0]!.attributes["langfuse.observation.type"], "agent");

  await runtime.close();
});

test("Langfuse export crosses the configured proxy so MITM can substitute credentials", async () => {
  const seen: { url?: string; authorization?: string; publicKey?: string } = {};
  const proxy = createServer((request, response) => {
    seen.url = request.url;
    const authorization = request.headers.authorization;
    seen.authorization = Array.isArray(authorization) ? authorization[0] : authorization;
    const publicKey = request.headers["x-langfuse-public-key"];
    seen.publicKey = Array.isArray(publicKey) ? publicKey[0] : publicKey;
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address() as AddressInfo;
  const proxyKeys = ["HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"] as const;
  const saved = Object.fromEntries(proxyKeys.map((key) => [key, process.env[key]]));
  // Windows environment names are case-insensitive, so clear both spellings before assigning.
  for (const key of proxyKeys) delete process.env[key];
  process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
  try {
    const runtime = startTrace({
      enabled: true,
      publicKey: "__vault_LANGFUSE_PUBLIC_KEY__",
      secretKey: "__vault_LANGFUSE_SECRET_KEY__",
      baseUrl: "http://langfuse.invalid",
    });
    assert.ok(runtime);
    const request = beginRequest({ conversationId: 8 });
    assert.ok(request);
    request.end("ok", { replyBytes: 1 });
    await runtime.close();
  } finally {
    for (const key of proxyKeys) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }

  assert.equal(seen.url, "http://langfuse.invalid/api/public/otel/v1/traces");
  assert.equal(
    seen.authorization,
    `Basic ${Buffer.from("__vault_LANGFUSE_PUBLIC_KEY__:__vault_LANGFUSE_SECRET_KEY__", "utf8").toString("base64")}`,
    "credentials stay encoded so the MITM proxy can decode and substitute them",
  );
  assert.equal(seen.publicKey, "__vault_LANGFUSE_PUBLIC_KEY__");
});

test("an exporter failure never escapes the tracing boundary", async () => {
  const logs: string[] = [];
  const exporter: SpanExporter = {
    export() {
      throw new Error("offline");
    },
    shutdown() {
      return Promise.resolve();
    },
  };
  const processor = new LangfuseSpanProcessor({
    publicKey: "pk-test",
    secretKey: "sk-test",
    exporter,
    exportMode: "immediate",
    mediaUploadEnabled: false,
  });
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  const runtime = startTrace({ enabled: true }, (line) => logs.push(line), { tracerProvider: provider });
  assert.ok(runtime);

  const request = beginRequest({ conversationId: 6 });
  assert.ok(request);
  assert.doesNotThrow(() => {
    request.end("ok", { replyBytes: 1 });
    recordGeneration(assistantMessage(), { conversationId: 6 as ConversationId, taskId: 6 as TaskId });
    recordLoopGuard({
      conversationId: 6 as ConversationId,
      taskId: 6 as TaskId,
      callId: "call-6",
      tool: "bash",
      count: 6,
    }, "LOOP_GUARD_WARNING");
  });
  await assert.doesNotReject(runtime.close());
});

test("an admitted tool execution gets its own span without uploading arguments or results", async () => {
  const { exporter, provider } = setup();
  const logs: string[] = [];
  const runtime = startTrace({ enabled: true }, (line) => logs.push(line), { tracerProvider: provider });
  assert.ok(runtime);
  const request = beginRequest({ conversationId: 9, requestId: "slack:9:req-1" });
  assert.ok(request);

  const execution = beginToolExecution({
    tool: "bash",
    source: "builtin:coding-tools",
    trust: "trusted",
    authz: "write",
    replay: "unsafe",
    tier: 1,
    argNames: ["command", "timeoutMs"],
    argsBytes: 42,
    conversationId: 9 as ConversationId,
    taskId: 5 as TaskId,
    callId: "call-9",
  });
  assert.ok(execution);
  // 20ms against a 10ms floor below: the sleep only has to be long enough that a late timer cannot
  // round the span's duration under the assertion on a loaded runner.
  await new Promise((resolve) => setTimeout(resolve, 20));
  execution.end("ok", { resultBytes: 128, outputItems: 1, diagnostics: 0 });
  request.end("ok", { replyBytes: 3 });

  const span = spanByName(exporter.getFinishedSpans(), "tool.execution");
  assert.equal(span.spanContext().traceId, request.traceId);
  assert.equal(span.parentSpanContext?.spanId, request.spanId, "execution hangs under the request");
  assert.equal(span.attributes["langfuse.observation.type"], "tool");
  assert.equal(span.attributes["langfuse.observation.metadata.tool"], "\"bash\"");
  assert.equal(span.attributes["langfuse.observation.metadata.source"], "\"builtin:coding-tools\"");
  assert.equal(span.attributes["langfuse.observation.metadata.authz"], "\"write\"");
  assert.equal(span.attributes["langfuse.observation.metadata.argNames"], "\"command,timeoutMs\"");
  assert.equal(span.attributes["langfuse.observation.metadata.argCount"], "2");
  assert.equal(span.attributes["langfuse.observation.metadata.argsBytes"], "42");
  assert.equal(span.attributes["langfuse.observation.metadata.resultBytes"], "128");
  assert.equal(span.attributes["langfuse.observation.metadata.outcome"], "\"ok\"");
  assert.equal(span.attributes["langfuse.observation.level"], "DEFAULT");
  assert.ok(Number(span.attributes["langfuse.observation.metadata.durationMs"]) >= 10, "duration is the execution's, not the review's");
  assert.equal(span.attributes["langfuse.observation.input"], undefined, "never the arguments");
  assert.equal(span.attributes["langfuse.observation.output"], undefined, "never the result");
  assert.equal(logs.length, 0, "no tracing warnings during a healthy export");

  return runtime.close();
});

test("a failed execution ends as an error with its host code, and background calls are not traced", async () => {
  const { exporter, provider } = setup();
  const runtime = startTrace({ enabled: true }, () => {}, { tracerProvider: provider });
  assert.ok(runtime);
  const unattached = beginToolExecution({
    tool: "bash",
    source: "builtin:coding-tools",
    trust: "trusted",
    authz: "write",
    replay: "unsafe",
    tier: 1,
    argNames: ["command"],
    argsBytes: 8,
    conversationId: 10 as ConversationId,
    taskId: 6 as TaskId,
  });
  assert.equal(unattached, undefined, "a call with no active request is not traced");

  const request = beginRequest({ conversationId: 10 });
  assert.ok(request);
  const execution = beginToolExecution({
    tool: "mcp__box__browser_fetch",
    source: "mcp:box",
    trust: "untrusted",
    authz: "write",
    replay: "unsafe",
    tier: 2,
    argNames: ["url"],
    argsBytes: 30,
    conversationId: 10 as ConversationId,
    taskId: 6 as TaskId,
    callId: "call-10",
  });
  assert.ok(execution);
  execution.end("error", { errorCode: "MCP_TIMEOUT", resultBytes: 0, outputItems: 0, diagnostics: 1 });
  request.end("ok", { replyBytes: 3 });

  const span = spanByName(exporter.getFinishedSpans(), "tool.execution");
  assert.equal(span.attributes["langfuse.observation.type"], "tool");
  assert.equal(span.attributes["langfuse.observation.metadata.tool"], "\"mcp__box__browser_fetch\"");
  assert.equal(span.attributes["langfuse.observation.metadata.source"], "\"mcp:box\"");
  assert.equal(span.attributes["langfuse.observation.metadata.trust"], "\"untrusted\"");
  assert.equal(span.attributes["langfuse.observation.metadata.errorCode"], "\"MCP_TIMEOUT\"");
  assert.equal(span.attributes["langfuse.observation.metadata.outcome"], "\"error\"");
  assert.equal(span.attributes["langfuse.observation.metadata.diagnostics"], "1");
  assert.equal(span.attributes["langfuse.observation.level"], "ERROR");
  assert.equal(span.attributes["langfuse.observation.status_message"], "MCP_TIMEOUT");

  return runtime.close();
});

test("disabled tracing is a no-op and a requested but keyless runtime logs once", async () => {
  assert.equal(startTrace({ enabled: false }), undefined);
  assert.equal(beginRequest({ conversationId: 5 }), undefined);
  assert.doesNotThrow(() => recordGeneration(assistantMessage(), {
    conversationId: 5 as ConversationId,
    taskId: 5 as TaskId,
  }));

  const logs: string[] = [];
  assert.equal(startTrace({ enabled: true }, (line) => logs.push(line)), undefined);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY/);
});

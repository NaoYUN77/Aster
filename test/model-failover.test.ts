import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Api, AssistantMessage, Context, Message, Model } from "@earendil-works/pi-ai";
import { readMemoryConfig, readModelFailoverConfig, readConfig } from "../src/config.js";
import { openAgent } from "../src/agent.js";
import type { TextRequest } from "../src/messages.js";
import { createModelFailover, MODEL_UNAVAILABLE_MESSAGE } from "../src/model-failover.js";
import { resolveModelChain } from "../src/providers.js";

const CONTEXT: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function fixture(options: { fallbackContextWindow?: number } = {}) {
  const primary = fauxProvider({
    provider: "primary",
    models: [{ id: "primary-1", contextWindow: 200_000, maxTokens: 8_192, input: ["text", "image"] }],
  });
  const fallback = fauxProvider({
    provider: "fallback",
    models: [{
      id: "fallback-1",
      contextWindow: options.fallbackContextWindow ?? 200_000,
      maxTokens: 4_096,
      input: ["text"],
    }],
  });
  const models = createModels();
  models.setProvider(primary.provider);
  models.setProvider(fallback.provider);
  const chain = resolveModelChain(models, { provider: "primary", modelId: "primary-1" }, [
    { provider: "fallback", modelId: "fallback-1" },
  ]) as Model<Api>[];
  return { models, primary, fallback, chain };
}

function failed(errorMessage: string): AssistantMessage {
  return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

test("MODEL_FALLBACKS absent is off, and a timeout alone is refused", () => {
  const known = () => true;
  assert.equal(readModelFailoverConfig({}, { provider: "magpie", modelId: "primary" }, known), undefined);
  assert.equal(
    readModelFailoverConfig({ MODEL_FALLBACKS: "  " }, { provider: "magpie", modelId: "primary" }, known),
    undefined,
  );
  assert.throws(
    () => readModelFailoverConfig({ MODEL_REQUEST_TIMEOUT_MS: "90000" }, { provider: "magpie", modelId: "primary" }, known),
    /requires MODEL_FALLBACKS/,
  );
});

test("a fallback provider's own key variable is required at startup", () => {
  assert.throws(
    () => readConfig({
      TELEGRAM_BOT_TOKEN: "offline-test",
      TELEGRAM_OWNER_ID: "1",
      MODEL_PROVIDER: "openai",
      MODEL_ID: "gpt",
      OPENAI_API_KEY: "offline-test",
      MODEL_FALLBACKS: "deepseek:deepseek-chat",
    }),
    /Missing configuration: DEEPSEEK_API_KEY/,
  );
});

test("MODEL_FALLBACKS parses provider:model and keeps a colon inside the model id", () => {
  const config = readModelFailoverConfig(
    { MODEL_FALLBACKS: "magpie:commandcode/deepseek/deepseek-v4.1-flash, other:vendor/model:free" },
    { provider: "magpie", modelId: "opencode-go/deepseek-v4.1-flash" },
    (id) => id === "magpie" || id === "other",
  );
  assert.deepEqual(config, {
    fallbacks: [
      { provider: "magpie", modelId: "commandcode/deepseek/deepseek-v4.1-flash" },
      { provider: "other", modelId: "vendor/model:free" },
    ],
    requestTimeoutMs: 90_000,
  });
});

test("MODEL_FALLBACKS rejects malformed, unknown, duplicated and primary entries", () => {
  const primaryRef = { provider: "magpie", modelId: "primary" };
  const parse = (value: string) => () =>
    readModelFailoverConfig({ MODEL_FALLBACKS: value }, primaryRef, (id) => id === "magpie");
  assert.throws(parse("magpie"), /must be provider:model/);
  assert.throws(parse(":model"), /must be provider:model/);
  assert.throws(parse("magpie:"), /must be provider:model/);
  assert.throws(parse("magpie:a b"), /without spaces/);
  assert.throws(parse("elsewhere:model"), /unknown provider/);
  assert.throws(parse("magpie:one,magpie:one"), /more than once/);
  assert.throws(parse("magpie:primary"), /primary model/);
  assert.throws(
    () => readModelFailoverConfig(
      { MODEL_FALLBACKS: "magpie:a", MODEL_REQUEST_TIMEOUT_MS: "soon" },
      primaryRef,
      (id) => id === "magpie",
    ),
    /MODEL_REQUEST_TIMEOUT_MS must be an integer/,
  );
});

test("a 429 on the primary switches immediately and the fallback answers", async () => {
  const { models, primary, fallback, chain } = fixture();
  primary.setResponses([failed("429: {\"error\":\"rate limited\"}")]);
  fallback.setResponses([fauxAssistantMessage("fallback answer")]);
  const wrapped = createModelFailover(models, chain, { log: () => {} });

  const answer = await wrapped.completeSimple(chain[0]!, CONTEXT);

  assert.equal(answer.stopReason, "stop");
  assert.equal(answer.provider, "fallback");
  assert.equal(answer.model, "fallback-1");
  assert.equal(primary.state.callCount, 1);
  assert.equal(fallback.state.callCount, 1);
});

test("streaming failover replays only the successful attempt", async () => {
  const { models, primary, fallback, chain } = fixture();
  primary.setResponses([failed("503: service unavailable")]);
  fallback.setResponses([fauxAssistantMessage("streamed answer")]);
  const wrapped = createModelFailover(models, chain, { log: () => {} });

  const answer = await wrapped.streamSimple(chain[0]!, CONTEXT).result();

  assert.equal(answer.stopReason, "stop");
  assert.equal(answer.provider, "fallback");
  assert.equal(primary.state.callCount, 1);
  assert.equal(fallback.state.callCount, 1);
});

test("a 401, a missing model and a timeout all switch", async () => {
  for (const message of [
    "401: invalid api key",
    "404: model not found: primary-1",
    "Request timed out",
  ]) {
    const { models, primary, fallback, chain } = fixture();
    primary.setResponses([failed(message)]);
    fallback.setResponses([fauxAssistantMessage("ok")]);
    const wrapped = createModelFailover(models, chain, { log: () => {} });
    const answer = await wrapped.completeSimple(chain[0]!, CONTEXT);
    assert.equal(answer.provider, "fallback", message);
  }
});

test("an invalid request, a content refusal and an overflow stay on the primary", async () => {
  for (const message of [
    "400: invalid_request_error: invalid parameter: temperature",
    "content_policy_violation: request refused",
    "prompt is too long: 300000 tokens > 200000 maximum",
  ]) {
    const { models, primary, fallback, chain } = fixture();
    primary.setResponses([failed(message)]);
    fallback.setResponses([fauxAssistantMessage("should not be used")]);
    const wrapped = createModelFailover(models, chain, { log: () => {} });
    const answer = await wrapped.completeSimple(chain[0]!, CONTEXT);
    assert.equal(answer.stopReason, "error", message);
    assert.equal(answer.errorMessage, message);
    assert.equal(fallback.state.callCount, 0, message);
  }
});

test("the whole chain failing reports one stable message without provider text", async () => {
  const { models, primary, fallback, chain } = fixture();
  primary.setResponses([failed("429: quota exceeded")]);
  fallback.setResponses([failed("503: overloaded")]);
  const wrapped = createModelFailover(models, chain, { log: () => {} });

  const answer = await wrapped.completeSimple(chain[0]!, CONTEXT);

  assert.equal(answer.stopReason, "error");
  assert.equal(answer.errorMessage, MODEL_UNAVAILABLE_MESSAGE);
  assert.equal(primary.state.callCount, 1);
  assert.equal(fallback.state.callCount, 1);
});

test("cross-model context drops foreign thinking signatures but keeps visible text", async () => {
  const { models, primary, fallback, chain } = fixture();
  const history: Message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private reasoning", thinkingSignature: "primary-signature" },
      { type: "text", text: "visible answer", textSignature: "primary-text-signature" },
    ],
    api: "openai-completions",
    provider: "primary",
    model: "primary-1",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 1,
  };
  const context: Context = { messages: [history, ...CONTEXT.messages] };
  let seen: readonly Message[] = [];
  primary.setResponses([failed("429: rate limited")]);
  fallback.setResponses([(transcript) => {
    seen = transcript.messages;
    return fauxAssistantMessage("fallback answer");
  }]);
  const wrapped = createModelFailover(models, chain, { log: () => {} });

  await wrapped.completeSimple(chain[0]!, context);

  const assistant = seen.find((message) => message.role === "assistant")!;
  assert.equal(assistant.role, "assistant");
  assert.deepEqual(assistant.content, [{ type: "text", text: "visible answer" }]);
});

test("a fallback gets the output budget it actually supports", async () => {
  const { models, primary, fallback, chain } = fixture();
  let seenMaxTokens: number | undefined;
  primary.setResponses([failed("429: rate limited")]);
  fallback.setResponses([(_transcript, options) => {
    seenMaxTokens = options?.maxTokens;
    return fauxAssistantMessage("fallback answer");
  }]);
  const wrapped = createModelFailover(models, chain, { log: () => {} });

  await wrapped.completeSimple(chain[0]!, CONTEXT, { maxTokens: 8_192 });

  assert.equal(seenMaxTokens, 4_096);
});

test("a text-only fallback is skipped for an image context", async () => {
  const { models, primary, fallback, chain } = fixture();
  primary.setResponses([failed("429: rate limited")]);
  fallback.setResponses([fauxAssistantMessage("should not be used")]);
  const wrapped = createModelFailover(models, chain, { log: () => {} });
  const withImage: Context = {
    messages: [{
      role: "user",
      content: [{ type: "text", text: "what is this" }, { type: "image", data: "AA==", mimeType: "image/png" }],
      timestamp: 1,
    }],
  };

  const answer = await wrapped.completeSimple(chain[0]!, withImage);

  assert.equal(answer.errorMessage, MODEL_UNAVAILABLE_MESSAGE);
  assert.equal(fallback.state.callCount, 0);
});

test("a fallback with a smaller context window is refused at startup", () => {
  const { models, chain } = fixture();
  const small = fauxProvider({
    provider: "small",
    models: [{ id: "small-1", contextWindow: 32_000, maxTokens: 1_024 }],
  });
  models.setProvider(small.provider);
  assert.equal(chain.length, 2);
  assert.throws(
    () => resolveModelChain(models, { provider: "primary", modelId: "primary-1" }, [
      { provider: "small", modelId: "small-1" },
    ]),
    /smaller context window/,
  );
});

test("an unknown fallback model is refused at startup", () => {
  const { models } = fixture();
  assert.throws(
    () => resolveModelChain(models, { provider: "primary", modelId: "primary-1" }, [
      { provider: "fallback", modelId: "missing" },
    ]),
    /Unknown MODEL_ID "missing" in MODEL_FALLBACKS/,
  );
});

test("a chain of one leaves every call unwrapped", () => {
  const { models, chain } = fixture();
  const wrapped = createModelFailover(models, [chain[0]!], { log: () => {} });
  assert.equal(wrapped, models);
});

test("one durable turn fails over, settles done and replays the same answer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-model-failover-"));
  const signal = new AbortController().signal;
  const faux = fauxProvider({
    provider: "openai",
    models: [{ id: "faux-1", contextWindow: 200_000 }, { id: "faux-2", contextWindow: 200_000 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([failed("429: rate limited"), fauxAssistantMessage("answered by the fallback")]);
  const config = {
    ...readConfig({
      TELEGRAM_BOT_TOKEN: "offline-test",
      TELEGRAM_OWNER_ID: "1",
      MODEL_PROVIDER: "openai",
      MODEL_ID: "faux-1",
      OPENAI_API_KEY: "offline-test",
      MODEL_FALLBACKS: "openai:faux-2",
      DATA_DIR: directory,
    }),
    memory: { ...readMemoryConfig({}), enabled: false },
  };
  const request: TextRequest = {
    requestId: "telegram:failover:1",
    conversationId: "telegram:failover",
    senderId: "1",
    text: "answer this",
  };
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    app = await openAgent(config, models);
    assert.equal(await app.reply(request, signal), "answered by the fallback");
    assert.equal(faux.state.callCount, 2);
    // The durable submission settled `done`, so a replay returns the stored answer instead of
    // submitting the request again.
    assert.equal(await app.reply(request, signal), "answered by the fallback");
    assert.equal(faux.state.callCount, 2);
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("a durable turn whose whole chain fails surfaces MODEL_UNAVAILABLE", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-model-unavailable-"));
  const signal = new AbortController().signal;
  const faux = fauxProvider({
    provider: "openai",
    models: [{ id: "faux-1", contextWindow: 200_000 }, { id: "faux-2", contextWindow: 200_000 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([failed("429: rate limited"), failed("503: overloaded")]);
  const config = {
    ...readConfig({
      TELEGRAM_BOT_TOKEN: "offline-test",
      TELEGRAM_OWNER_ID: "1",
      MODEL_PROVIDER: "openai",
      MODEL_ID: "faux-1",
      OPENAI_API_KEY: "offline-test",
      MODEL_FALLBACKS: "openai:faux-2",
      DATA_DIR: directory,
    }),
    memory: { ...readMemoryConfig({}), enabled: false },
  };
  const request: TextRequest = {
    requestId: "telegram:unavailable:1",
    conversationId: "telegram:unavailable",
    senderId: "1",
    text: "answer this",
  };
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    app = await openAgent(config, models);
    await assert.rejects(
      app.reply(request, signal),
      (error: unknown) => (error as { code?: string }).code === "MODEL_UNAVAILABLE",
    );
    assert.equal(faux.state.callCount, 2);
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Message, Model } from "@earendil-works/pi-ai";
import { readMemoryConfig, readModelFailoverConfig, readConfig } from "../src/config.js";
import { openAgent } from "../src/agent.js";
import type { TextRequest } from "../src/messages.js";
import {
  createModelFailover,
  createModelSwitchStore,
  MODEL_INCOMPATIBLE_MESSAGE,
  MODEL_UNAVAILABLE_MESSAGE,
} from "../src/model-failover.js";
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

type FauxInput = ("text" | "image")[];

/**
 * Three real-looking catalog members: an OpenCode primary, a Command Code fallback, and a manual
 * extra that is outside the configured chain. Separate faux providers keep per-model call counts
 * and scripted responses apart.
 */
function manualFixture(options: { manualInput?: FauxInput } = {}) {
  const primary = fauxProvider({
    provider: "opencode",
    models: [{
      id: "opencode-go/deepseek-v4.1-flash",
      contextWindow: 200_000,
      maxTokens: 8_192,
      input: ["text", "image"],
    }],
  });
  const fallback = fauxProvider({
    provider: "commandcode",
    models: [{
      id: "commandcode/deepseek/deepseek-v4.1-flash",
      contextWindow: 200_000,
      maxTokens: 8_192,
      input: ["text", "image"],
    }],
  });
  const manual = fauxProvider({
    provider: "gemini",
    models: [
      {
        id: "commandcode/google/gemini-3.8-flash",
        contextWindow: 200_000,
        maxTokens: 8_192,
        input: options.manualInput ?? ["text", "image"],
      },
      {
        id: "commandcode/claude-sonnet-5-5",
        contextWindow: 200_000,
        maxTokens: 8_192,
        input: ["text", "image"],
      },
    ],
  });
  const models = createModels();
  models.setProvider(primary.provider);
  models.setProvider(fallback.provider);
  models.setProvider(manual.provider);
  const chain = resolveModelChain(models, { provider: "opencode", modelId: "opencode-go/deepseek-v4.1-flash" }, [
    { provider: "commandcode", modelId: "commandcode/deepseek/deepseek-v4.1-flash" },
  ]) as Model<Api>[];
  return { models, primary, fallback, manual, chain };
}

const IMAGE_CONTEXT: Context = {
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "what is this" },
      { type: "image", data: "AA==", mimeType: "image/png" },
    ],
    timestamp: 1,
  }],
};

async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
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

test("a successful switch is sticky across calls and survives a new store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-sticky-"));
  const path = join(directory, "model-selection.json");
  const { models, primary, fallback, chain } = fixture();
  const state = createModelSwitchStore(path, { log: () => {} });
  const wrapped = createModelFailover(models, chain, { log: () => {}, state });
  try {
    primary.setResponses([failed("429: rate limited")]);
    fallback.setResponses([fauxAssistantMessage("fallback first")]);
    assert.equal((await wrapped.completeSimple(chain[0]!, CONTEXT)).model, "fallback-1");
    assert.deepEqual(state.active(), { provider: "fallback", modelId: "fallback-1", kind: "auto" });

    // A primary that would answer is not tried: the session stays on the fallback.
    fallback.setResponses([fauxAssistantMessage("fallback second")]);
    assert.equal((await wrapped.completeSimple(chain[0]!, CONTEXT)).model, "fallback-1");
    assert.equal(primary.state.callCount, 1);

    // A new wrapper reading the same file is sticky too, which is what a process restart sees.
    const reopened = createModelSwitchStore(path, { log: () => {} });
    assert.deepEqual(reopened.active(), { provider: "fallback", modelId: "fallback-1", kind: "auto" });
    const afterRestart = createModelFailover(models, chain, { log: () => {}, state: reopened });
    fallback.setResponses([fauxAssistantMessage("fallback after restart")]);
    assert.equal((await afterRestart.completeSimple(chain[0]!, CONTEXT)).model, "fallback-1");
    assert.equal(primary.state.callCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a manual switch back through another store instance takes effect at once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-sticky-manual-"));
  const path = join(directory, "model-selection.json");
  const { models, primary, fallback, chain } = fixture();
  const state = createModelSwitchStore(path, { log: () => {} });
  const wrapped = createModelFailover(models, chain, { log: () => {}, state });
  try {
    primary.setResponses([failed("429: rate limited")]);
    fallback.setResponses([fauxAssistantMessage("fallback answer")]);
    assert.equal((await wrapped.completeSimple(chain[0]!, CONTEXT)).model, "fallback-1");

    // The chat-side switch back clears the selection through its own store instance; the running
    // wrapper must see that without a restart.
    createModelSwitchStore(path, { log: () => {} }).clear();

    primary.setResponses([fauxAssistantMessage("primary answer")]);
    assert.equal((await wrapped.completeSimple(chain[0]!, CONTEXT)).provider, "primary");
    assert.equal(state.active(), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a 90s timeout switch is sticky too", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-sticky-timeout-"));
  const path = join(directory, "model-selection.json");
  const { models, primary, fallback, chain } = fixture();
  const state = createModelSwitchStore(path, { log: () => {} });
  const wrapped = createModelFailover(models, chain, { log: () => {}, state });
  try {
    primary.setResponses([failed("Request timed out")]);
    fallback.setResponses([fauxAssistantMessage("fallback answer")]);
    await wrapped.completeSimple(chain[0]!, CONTEXT);
    assert.deepEqual(state.active(), { provider: "fallback", modelId: "fallback-1", kind: "auto" });

    fallback.setResponses([fauxAssistantMessage("fallback again")]);
    assert.equal((await wrapped.completeSimple(chain[0]!, CONTEXT)).model, "fallback-1");
    assert.equal(primary.state.callCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a sticky text-only fallback is not bypassed by an image request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-sticky-image-"));
  const path = join(directory, "model-selection.json");
  const { models, primary, fallback, chain } = fixture();
  const state = createModelSwitchStore(path, { log: () => {} });
  const wrapped = createModelFailover(models, chain, { log: () => {}, state });
  try {
    primary.setResponses([failed("429: rate limited")]);
    fallback.setResponses([fauxAssistantMessage("fallback answer")]);
    await wrapped.completeSimple(chain[0]!, CONTEXT);

    primary.setResponses([fauxAssistantMessage("the primary must not answer")]);
    const withImage: Context = {
      messages: [{
        role: "user",
        content: [{ type: "text", text: "what is this" }, { type: "image", data: "AA==", mimeType: "image/png" }],
        timestamp: 1,
      }],
    };
    const answer = await wrapped.completeSimple(chain[0]!, withImage);
    assert.equal(answer.errorMessage, MODEL_UNAVAILABLE_MESSAGE);
    // Only the first call's failed primary attempt; stickiness never sends this request to it.
    assert.equal(primary.state.callCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a whole-chain failure does not pin the session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-sticky-failed-"));
  const path = join(directory, "model-selection.json");
  const { models, primary, fallback, chain } = fixture();
  const state = createModelSwitchStore(path, { log: () => {} });
  const wrapped = createModelFailover(models, chain, { log: () => {}, state });
  try {
    primary.setResponses([failed("429: rate limited")]);
    fallback.setResponses([failed("503: overloaded")]);
    assert.equal((await wrapped.completeSimple(chain[0]!, CONTEXT)).errorMessage, MODEL_UNAVAILABLE_MESSAGE);
    assert.equal(state.active(), undefined);

    primary.setResponses([fauxAssistantMessage("primary recovered")]);
    const next = await wrapped.completeSimple(chain[0]!, CONTEXT);
    assert.equal(next.provider, "primary");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stored selection outside the chain is discarded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-sticky-stale-"));
  const path = join(directory, "model-selection.json");
  writeFileSync(path, JSON.stringify({ version: 1, model: { provider: "gone", modelId: "gone" } }));
  const state = createModelSwitchStore(path, { log: () => {} });
  const { models, chain } = fixture();
  try {
    createModelFailover(models, chain, { log: () => {}, state });
    assert.equal(state.active(), undefined);
    assert.equal(existsSync(path), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a malformed selection file is ignored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-sticky-bad-"));
  const path = join(directory, "model-selection.json");
  writeFileSync(path, "not json");
  const state = createModelSwitchStore(path, { log: () => {} });
  try {
    assert.equal(state.active(), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a manual selection outside the chain is the first attempt and stays manual", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-manual-head-"));
  const path = join(directory, "model-selection.json");
  const { models, primary, fallback, manual, chain } = manualFixture();
  const state = createModelSwitchStore(path, { log: () => {} });
  state.set({ provider: "gemini", modelId: "commandcode/google/gemini-3.8-flash", kind: "manual" });
  const wrapped = createModelFailover(models, chain, { log: () => {}, state });
  try {
    manual.setResponses([fauxAssistantMessage("gemini answer")]);
    primary.setResponses([fauxAssistantMessage("primary must not answer")]);
    const answer = await wrapped.completeSimple(chain[0]!, CONTEXT);
    assert.equal(answer.model, "commandcode/google/gemini-3.8-flash");
    assert.equal(primary.state.callCount, 0);
    assert.equal(fallback.state.callCount, 0);
    assert.deepEqual(state.active(), {
      provider: "gemini",
      modelId: "commandcode/google/gemini-3.8-flash",
      kind: "manual",
    });

    // A new wrapper (restart) validates the same manual selection against the catalog and keeps it.
    const reopened = createModelFailover(models, chain, {
      log: () => {},
      state: createModelSwitchStore(path, { log: () => {} }),
    });
    manual.setResponses([fauxAssistantMessage("gemini after restart")]);
    assert.equal((await reopened.completeSimple(chain[0]!, CONTEXT)).model, "commandcode/google/gemini-3.8-flash");
    assert.equal(primary.state.callCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failing manual selection falls back, records the actual model and says so in the answer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-manual-fail-"));
  const path = join(directory, "model-selection.json");
  const { models, primary, fallback, manual, chain } = manualFixture();
  const state = createModelSwitchStore(path, { log: () => {} });
  state.set({ provider: "gemini", modelId: "commandcode/google/gemini-3.8-flash", kind: "manual" });
  const wrapped = createModelFailover(models, chain, { log: () => {}, state });
  try {
    manual.setResponses([failed("429: rate limited")]);
    primary.setResponses([fauxAssistantMessage("primary answer")]);
    const events = await drain(wrapped.streamSimple(chain[0]!, CONTEXT));
    const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
    assert.equal(done.type, "done");
    assert.equal(done.message.provider, "opencode");
    const text = done.message.content
      .flatMap((block) => block.type === "text" ? [block.text] : [])
      .join("");
    assert.match(text, /commandcode\/google\/gemini-3\.8-flash 不可用，本次由 opencode\/opencode-go\/deepseek-v4\.1-flash 回答/);
    assert.equal(manual.state.callCount, 1);
    assert.equal(primary.state.callCount, 1);
    // The primary is the default chain's head, so the manual pin is gone: the next request starts
    // from the ordinary default chain.
    assert.equal(state.active(), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failing manual selection falls further to a fallback and that model becomes auto-sticky", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-manual-fallback-"));
  const path = join(directory, "model-selection.json");
  const { models, primary, fallback, manual, chain } = manualFixture();
  const state = createModelSwitchStore(path, { log: () => {} });
  state.set({ provider: "gemini", modelId: "commandcode/google/gemini-3.8-flash", kind: "manual" });
  const wrapped = createModelFailover(models, chain, { log: () => {}, state });
  try {
    manual.setResponses([failed("503: overloaded")]);
    primary.setResponses([failed("429: rate limited")]);
    fallback.setResponses([fauxAssistantMessage("fallback answer")]);
    const answer = await wrapped.completeSimple(chain[0]!, CONTEXT);
    assert.equal(answer.provider, "commandcode");
    assert.deepEqual(state.active(), {
      provider: "commandcode",
      modelId: "commandcode/deepseek/deepseek-v4.1-flash",
      kind: "auto",
    });

    // Automatic stickiness stays silent: the next answer is plain, with no note.
    fallback.setResponses([fauxAssistantMessage("plain answer")]);
    const next = await wrapped.completeSimple(chain[0]!, CONTEXT);
    assert.equal(next.content.length, 1);
    assert.equal(primary.state.callCount, 1);
    assert.equal(manual.state.callCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a manual text-only selection refuses an image request instead of silently switching", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-manual-image-"));
  const path = join(directory, "model-selection.json");
  const { models, primary, fallback, manual, chain } = manualFixture({ manualInput: ["text"] });
  const state = createModelSwitchStore(path, { log: () => {} });
  state.set({ provider: "gemini", modelId: "commandcode/google/gemini-3.8-flash", kind: "manual" });
  const wrapped = createModelFailover(models, chain, { log: () => {}, state });
  try {
    const answer = await wrapped.completeSimple(chain[0]!, IMAGE_CONTEXT);
    assert.equal(answer.errorMessage, MODEL_INCOMPATIBLE_MESSAGE);
    assert.equal(manual.state.callCount, 0);
    assert.equal(primary.state.callCount, 0);
    assert.equal(fallback.state.callCount, 0);

    const events = await drain(wrapped.streamSimple(chain[0]!, IMAGE_CONTEXT));
    const terminal = events.at(-1) as Extract<AssistantMessageEvent, { type: "error" }>;
    assert.equal(terminal.type, "error");
    assert.equal(terminal.error.errorMessage, MODEL_INCOMPATIBLE_MESSAGE);
    assert.equal(manual.state.callCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a manual selection that is gone or outside the chat scope is cleared at startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-manual-stale-"));
  const path = join(directory, "model-selection.json");
  const { models, chain } = manualFixture();
  try {
    const gone = createModelSwitchStore(path, { log: () => {} });
    gone.set({ provider: "gone", modelId: "gone", kind: "manual" });
    createModelFailover(models, chain, { log: () => {}, state: gone });
    assert.equal(gone.active(), undefined);

    const outOfScope = createModelSwitchStore(path, { log: () => {} });
    outOfScope.set({ provider: "gemini", modelId: "commandcode/claude-sonnet-5-5", kind: "manual" });
    createModelFailover(models, chain, { log: () => {}, state: outOfScope });
    assert.equal(outOfScope.active(), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a manual selection of a chain fallback starts there and does not retry the primary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-manual-chain-"));
  const path = join(directory, "model-selection.json");
  const { models, primary, fallback, chain } = manualFixture();
  const state = createModelSwitchStore(path, { log: () => {} });
  state.set({ provider: "commandcode", modelId: "commandcode/deepseek/deepseek-v4.1-flash", kind: "manual" });
  const wrapped = createModelFailover(models, chain, { log: () => {}, state });
  try {
    fallback.setResponses([fauxAssistantMessage("fallback answer")]);
    primary.setResponses([fauxAssistantMessage("primary must not answer")]);
    const answer = await wrapped.completeSimple(chain[0]!, CONTEXT);
    assert.equal(answer.provider, "commandcode");
    assert.equal(primary.state.callCount, 0);
    assert.equal(state.active()?.kind, "manual");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("$model is answered by the host without calling a model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-model-command-agent-"));
  const signal = new AbortController().signal;
  const faux = fauxProvider({
    provider: "openai",
    models: [{ id: "faux-1", contextWindow: 200_000 }, { id: "faux-2", contextWindow: 200_000 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
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
  const base: TextRequest = {
    requestId: "telegram:model-command:1",
    conversationId: "telegram:model-command",
    senderId: "1",
    text: "$model",
  };
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    app = await openAgent(config, models);
    assert.match(await app.reply(base, signal), /当前模型：openai\/faux-1/);
    assert.match(
      await app.reply({ ...base, requestId: "telegram:model-command:2", text: "$model primary" }, signal),
      /已经是主模型/,
    );
    assert.match(
      await app.reply({ ...base, requestId: "telegram:model-command:3", text: "$model list" }, signal),
      /没有可切的模型/,
    );
    assert.equal(faux.state.callCount, 0);
    assert.equal(existsSync(join(directory, "model-selection.json")), false);
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
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
  const byModel = (primaryText: string, fallbackText: string) =>
    (_transcript: unknown, _options: unknown, _state: unknown, model: { id: string }) =>
      fauxAssistantMessage(model.id === "faux-2" ? fallbackText : primaryText);
  faux.setResponses([
    failed("429: rate limited"),
    byModel("answered by the primary", "answered by the fallback"),
    byModel("second primary answer", "second fallback answer"),
  ]);
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
    // A new request starts directly on the fallback; the primary is not tried again.
    const next: TextRequest = { ...request, requestId: "telegram:failover:2", text: "answer again" };
    assert.equal(await app.reply(next, signal), "second fallback answer");
    assert.equal(faux.state.callCount, 3);
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("a sticky fallback survives a process restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-model-sticky-restart-"));
  const signal = new AbortController().signal;
  const faux = fauxProvider({
    provider: "openai",
    models: [{ id: "faux-1", contextWindow: 200_000 }, { id: "faux-2", contextWindow: 200_000 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
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
  const base: TextRequest = {
    requestId: "telegram:restart:1",
    conversationId: "telegram:restart",
    senderId: "1",
    text: "answer this",
  };
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    faux.setResponses([
      failed("429: rate limited"),
      (_transcript, _options, _state, model) =>
        fauxAssistantMessage(model.id === "faux-2" ? "fallback before restart" : "primary before restart"),
    ]);
    app = await openAgent(config, models);
    assert.equal(await app.reply(base, signal), "fallback before restart");
    await app.close();
    app = undefined;
    assert.equal(existsSync(join(directory, "model-selection.json")), true);

    faux.setResponses([(_transcript, _options, _state, model) =>
      fauxAssistantMessage(model.id === "faux-2" ? "fallback after restart" : "primary after restart")]);
    app = await openAgent(config, models);
    assert.equal(await app.reply({ ...base, requestId: "telegram:restart:2" }, signal), "fallback after restart");
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

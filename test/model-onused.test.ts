import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createModelFailover, createModelSwitchStore, type ModelUsedEvent } from "../src/model-failover.js";
import { resolveModelChain } from "../src/providers.js";

const CONTEXT: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function fixture() {
  const primary = fauxProvider({
    provider: "primary",
    models: [
      { id: "opencode-go/deepseek-main", name: "DeepSeek Main", contextWindow: 200_000, maxTokens: 8_192, input: ["text"] },
      { id: "opencode-go/deepseek-manual", name: "DeepSeek Manual", contextWindow: 200_000, maxTokens: 8_192, input: ["text"] },
    ],
  });
  const fallback = fauxProvider({
    provider: "fallback",
    models: [{ id: "commandcode/deepseek-backup", name: "DeepSeek Backup", contextWindow: 200_000, maxTokens: 8_192, input: ["text"] }],
  });
  const models = createModels();
  models.setProvider(primary.provider);
  models.setProvider(fallback.provider);
  const chain = resolveModelChain(models, { provider: "primary", modelId: "opencode-go/deepseek-main" }, [
    { provider: "fallback", modelId: "commandcode/deepseek-backup" },
  ]) as Model<Api>[];
  return { primary, fallback, models, chain };
}

test("onModelUsed reports the answering model for primary, automatic and degraded manual requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-onused-"));
  try {
    // Primary path.
    {
      const { primary, models, chain } = fixture();
      primary.setResponses([fauxAssistantMessage("primary answer")]);
      const events: ModelUsedEvent[] = [];
      const wrapped = createModelFailover(models, chain, { onModelUsed: (event) => events.push(event) });
      await wrapped.completeSimple(chain[0]!, CONTEXT);
      assert.deepEqual(events, [{
        requested: { provider: "primary", modelId: "opencode-go/deepseek-main", kind: "primary" },
        actual: { provider: "primary", modelId: "opencode-go/deepseek-main" },
        kind: "primary",
        degraded: false,
      }]);
    }

    // Automatic failover: the primary 429s, the fallback answers, no manual selection existed.
    {
      const { primary, fallback, models, chain } = fixture();
      primary.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limited" })]);
      fallback.setResponses([fauxAssistantMessage("backup answer")]);
      const events: ModelUsedEvent[] = [];
      const state = createModelSwitchStore(join(directory, "auto.json"), { log: () => {} });
      const wrapped = createModelFailover(models, chain, { state, onModelUsed: (event) => events.push(event) });
      await wrapped.completeSimple(chain[0]!, CONTEXT);
      const event = events.at(-1)!;
      assert.deepEqual(event.actual, { provider: "fallback", modelId: "commandcode/deepseek-backup" });
      assert.equal(event.kind, "primary");
      assert.equal(event.degraded, false, "an automatic fallback is not a manual degradation");
    }

    // Manual selection fails, a chain member answers: degraded is true and requested names the choice.
    {
      const { primary, models, chain } = fixture();
      primary.setResponses([
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limited" }),
        fauxAssistantMessage("primary picked up"),
      ]);
      const state = createModelSwitchStore(join(directory, "manual.json"), { log: () => {} });
      state.set({ provider: "primary", modelId: "opencode-go/deepseek-manual", kind: "manual" });
      const events: ModelUsedEvent[] = [];
      const wrapped = createModelFailover(models, chain, { state, onModelUsed: (event) => events.push(event) });
      await wrapped.completeSimple(chain[0]!, CONTEXT);
      const event = events.at(-1)!;
      assert.deepEqual(event.requested, {
        provider: "primary",
        modelId: "opencode-go/deepseek-manual",
        kind: "manual",
      });
      assert.deepEqual(event.actual, { provider: "primary", modelId: "opencode-go/deepseek-main" });
      assert.equal(event.kind, "manual");
      assert.equal(event.degraded, true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { readConfig } from "../src/config.js";
import { createProviderModels, PROVIDERS, requireModel } from "../src/providers.js";
import { splitReply } from "../src/messages.js";

test("reply chunking preserves text including Unicode surrogate pairs", () => {
  const text = "你".repeat(3999) + "😀" + "a".repeat(8000);
  const chunks = splitReply(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 4000 && chunk.isWellFormed()));
});

test("configuration failures name the missing or invalid setting", () => {
  assert.throws(() => readConfig({}), /Missing configuration: MODEL_PROVIDER/);
  assert.throws(() => readConfig({ MODEL_PROVIDER: "other" }), /MODEL_PROVIDER must be one of: anthropic, openai/);
  assert.throws(() => readConfig({ MODEL_PROVIDER: "openai" }), /Missing configuration: OPENAI_API_KEY/);
  assert.throws(() => readConfig({ MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "key" }), /Missing configuration: MODEL_ID/);
});

test("the provider registry only names providers shipped with pi-ai", () => {
  const builtin = new Set(builtinProviders().map((provider) => provider.id));
  for (const [id, entry] of Object.entries(PROVIDERS)) {
    assert.ok(builtin.has(id), `registered provider ${id} is not built into pi-ai`);
    assert.match(entry.apiKeyEnv, /^[A-Z0-9_]+_API_KEY$/, `${id} must name an API-key variable`);
  }
});

test("a registered provider requires only its own API key", () => {
  const config = readConfig({
    MODEL_PROVIDER: "deepseek",
    MODEL_ID: "deepseek-flash",
    DEEPSEEK_API_KEY: "secret",
  });
  assert.equal(config.provider, "deepseek");
  assert.equal(config.deepseekWebApiKey, undefined);
  assert.equal(readConfig({
    MODEL_PROVIDER: "deepseek",
    MODEL_ID: "deepseek-flash", DEEPSEEK_API_KEY: "secret", DEEPSEEK_WEB_API_KEY: " web-secret ",
  }).deepseekWebApiKey, "web-secret");
  assert.throws(() => readConfig({
    MODEL_PROVIDER: "deepseek", MODEL_ID: "deepseek-flash",
  }), /Missing configuration: DEEPSEEK_API_KEY/);
});

test("an unknown model id is rejected with provider examples", () => {
  assert.throws(
    () => requireModel(createProviderModels("deepseek"), "deepseek", "not-a-model"),
    /Unknown MODEL_ID "not-a-model" for MODEL_PROVIDER=deepseek; examples: /,
  );
});

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { modelBaseUrl, readProviderConfig, validateProviderConfig, type CustomProviderDeclaration } from "../src/provider-config.js";
import { PROVIDER_IDS } from "../src/providers.js";

const CATALOG_ONLY = {
  id: "magpie",
  label: "magpie gateway",
  baseUrl: "http://10.1.4.9:3425/v1",
  apiKeyEnv: "MAGPIE_API_KEY",
  catalog: { path: "/models" },
};

const VALID_MODEL = {
  id: "commandcode/deepseek/deepseek-v4-flash",
  api: "openai-completions",
  contextWindow: 1_000_000,
  maxTokens: 384_000,
  cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
};

function withProvider(provider: unknown): Record<string, unknown> {
  return { providers: [provider] };
}

function errorOf(raw: unknown): string | undefined {
  return validateProviderConfig(raw, PROVIDER_IDS).error;
}

function declared(raw: unknown = withProvider(CATALOG_ONLY)): CustomProviderDeclaration {
  const result = validateProviderConfig(raw, PROVIDER_IDS);
  assert.equal(result.error, undefined);
  return result.providers[0]!;
}

test("a declared provider keeps its stated fields and fills documented catalog defaults", () => {
  const provider = declared(withProvider({
    ...CATALOG_ONLY,
    baseUrl: "http://10.1.4.9:3425/v1/",
    models: [VALID_MODEL],
  }));
  assert.equal(provider.id, "magpie");
  assert.equal(provider.label, "magpie gateway");
  // Trailing slashes are dropped so the catalog path and inference URL join exactly.
  assert.equal(provider.baseUrl, "http://10.1.4.9:3425/v1");
  assert.equal(provider.apiKeyEnv, "MAGPIE_API_KEY");
  assert.deepEqual(provider.catalog, {
    path: "/models",
    timeoutMs: 10_000,
    apiPreference: ["anthropic-messages", "openai-completions", "openai-responses"],
    defaultApi: "openai-completions",
  });
  assert.equal(provider.models.length, 1);
  // A declared model states everything itself; it never inherits a catalog default.
  assert.deepEqual(provider.models[0]!.cost, { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 });
  assert.equal(provider.models[0]!.name, undefined);
});

test("a provider label defaults to its id and a static model list needs no catalog", () => {
  const provider = declared(withProvider({ id: "local", label: undefined, baseUrl: "https://models.example.com", apiKeyEnv: "LOCAL_API_KEY", models: [VALID_MODEL] }));
  assert.equal(provider.label, "local");
  assert.equal(provider.catalog, undefined);
});

test("unknown keys are rejected everywhere, and a credential-shaped key says where keys belong", () => {
  assert.match(errorOf({ providers: [CATALOG_ONLY], extra: 1 })!, /unknown key extra/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, headers: {} }))!, /unknown key headers/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, apiKey: "sk-secret" }))!, /credentials are read from the environment/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, api_token: "x" }))!, /credentials are read from the environment/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, catalog: { path: "/models", secret: "x" } }))!, /unknown key secret/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, models: [{ ...VALID_MODEL, token: "x" }] }))!, /credentials are read from the environment/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, models: [{ ...VALID_MODEL, cost: { ...VALID_MODEL.cost, tier: 1 } }] }))!, /unknown key tier/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, models: [{ ...VALID_MODEL, compat: { supportsStore: true, nope: true } }] }))!, /unknown key nope/);
});

test("provider ids are lowercase, unique, and cannot shadow a compiled-in provider", () => {
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, id: "Magpie" }))!, /must match/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, id: "magpie_gw" }))!, /must match/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, id: "1magpie" }))!, /must match/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, id: "deepseek" }))!, /already registered/);
  assert.match(errorOf({ providers: [CATALOG_ONLY, { ...CATALOG_ONLY }] })!, /already registered/);
  // A reserved id handed to the validator as another application's provider is rejected the same way.
  assert.match(validateProviderConfig(withProvider(CATALOG_ONLY), ["magpie"]).error!, /already registered/);
});

test("plain HTTP is allowed only where the address cannot leave the host or its private network", () => {
  for (const baseUrl of [
    "http://localhost:3425/v1",
    "http://127.0.0.1:3425/v1",
    "http://10.1.4.9:3425/v1",
    "http://172.16.4.9:3425/v1",
    "http://192.168.1.4:3425/v1",
    "http://100.66.135.123:3425/v1",
    "http://[::1]:3425/v1",
    "http://models.internal.example",
  ]) {
    const error = errorOf(withProvider({ ...CATALOG_ONLY, baseUrl }));
    if (baseUrl.includes("internal.example")) {
      assert.match(error!, /only for a loopback or private address/, baseUrl);
    } else {
      assert.equal(error, undefined, baseUrl);
    }
  }
  for (const baseUrl of ["http://api.example.com/v1", "http://8.8.8.8/v1", "http://172.32.0.1/v1", "http://199.16.1.1/v1"]) {
    assert.match(errorOf(withProvider({ ...CATALOG_ONLY, baseUrl }))!, /only for a loopback or private address/, baseUrl);
  }
  assert.equal(errorOf(withProvider({ ...CATALOG_ONLY, baseUrl: "https://api.example.com/v1" })), undefined);
});

test("baseUrl and credential names are validated before anything reaches the network", () => {
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, baseUrl: "10.1.4.9:3425/v1" }))!, /absolute URL/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, baseUrl: "ftp://10.1.4.9/v1" }))!, /must use https: or http:/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, baseUrl: "http://user:pass@10.1.4.9:3425/v1" }))!, /must not embed credentials/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, baseUrl: "http://10.1.4.9:3425/v1?x=1" }))!, /query or fragment/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, baseUrl: "http://10.1.4.9:3425/v1#f" }))!, /query or fragment/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, apiKeyEnv: "magpieKey" }))!, /environment variable name/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, apiKeyEnv: "" }))!, /non-empty string/);
});

test("a provider states a separate address only for the protocols that need one", () => {
  const provider = declared(withProvider({
    ...CATALOG_ONLY,
    apiBaseUrls: { "anthropic-messages": "http://10.1.4.9:3425/", "google-generative-ai": "https://models.example.com/v1beta" },
  }));
  assert.deepEqual(provider.apiBaseUrls, {
    "anthropic-messages": "http://10.1.4.9:3425",
    "google-generative-ai": "https://models.example.com/v1beta",
  });
  // Every other protocol keeps the provider's own base URL.
  assert.equal(modelBaseUrl(provider, "anthropic-messages"), "http://10.1.4.9:3425");
  assert.equal(modelBaseUrl(provider, "openai-completions"), provider.baseUrl);
  assert.equal(modelBaseUrl(declared(), "anthropic-messages"), provider.baseUrl);
  // The addresses obey the same policy as the base URL itself.
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, apiBaseUrls: { "anthropic-messages": "10.1.4.9:3425" } }))!, /absolute URL/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, apiBaseUrls: { "anthropic-messages": "http://api.example.com" } }))!, /only for a loopback or private address/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, apiBaseUrls: {} }))!, /non-empty object keyed by protocol/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, apiBaseUrls: { "openai-chat": "http://10.1.4.9:3425" } }))!, /unknown key openai-chat.*expected one of/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, apiBaseUrls: { "anthropic-messages": "" } }))!, /non-empty string/);
});

test("a catalog declaration bounds its path, timeout, and protocol preference", () => {
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, catalog: { path: "models" } }))!, /absolute path/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, catalog: { path: "/../etc/passwd" } }))!, /absolute path/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, catalog: { path: "/models list" } }))!, /absolute path/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, catalog: { path: "/models", timeoutMs: 10 } }))!, /between 1000 and 60000/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, catalog: { path: "/models", timeoutMs: 600_001 } }))!, /between 1000 and 60000/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, catalog: { path: "/models", apiPreference: [] } }))!, /non-empty array/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, catalog: { path: "/models", apiPreference: ["anthropic-messages", "anthropic-messages"] } }))!, /must not repeat/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, catalog: { path: "/models", apiPreference: ["gemini"] } }))!, /must be one of/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, catalog: { path: "/models", defaultApi: "gemini" } }))!, /must be one of/);
  assert.equal(errorOf(withProvider({ ...CATALOG_ONLY, catalog: { path: "/v1/models", timeoutMs: 5_000, apiPreference: ["openai-responses"], defaultApi: "openai-responses" } })), undefined);
});

test("a declared model states its own limits, protocol, and complete pricing", () => {
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, models: [{}] }))!, /\.id must be a non-empty string/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, models: [{ ...VALID_MODEL, id: "x".repeat(129) }] }))!, /1-128 characters/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, models: [{ ...VALID_MODEL, id: "two words" }] }))!, /without spaces/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, models: [{ ...VALID_MODEL, api: "gemini" }] }))!, /must be one of/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, models: [{ ...VALID_MODEL, contextWindow: 0 }] }))!, /between 1 and 20000000/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, models: [{ ...VALID_MODEL, maxTokens: 2_000_000 }] }))!, /between 1 and 1000000/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, models: [{ ...VALID_MODEL, contextWindow: 1_000, maxTokens: 2_000 }] }))!, /must not exceed contextWindow/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, models: [{ ...VALID_MODEL, cost: { input: 1, output: 2, cacheRead: 0 } }] }))!, /cacheWrite/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, models: [{ ...VALID_MODEL, cost: { ...VALID_MODEL.cost, input: -1 } }] }))!, /non-negative number/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, models: [{ ...VALID_MODEL, input: [] }] }))!, /non-empty array of text, image/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, models: [{ ...VALID_MODEL, input: ["audio"] }] }))!, /non-empty array of text, image/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, models: [{ ...VALID_MODEL, compat: {} }] }))!, /non-empty object/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, models: [{ ...VALID_MODEL, compat: { maxTokensField: "max_tokens_v2" } }] }))!, /max_completion_tokens/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, models: [{ ...VALID_MODEL, compat: { thinkingFormat: "nope" } }] }))!, /not a known thinking format/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, models: [VALID_MODEL, VALID_MODEL] }))!, /duplicate model id/);
  const model = declared(withProvider({ ...CATALOG_ONLY, models: [{ ...VALID_MODEL, name: "DeepSeek V4 Flash", reasoning: true, input: ["text", "image"], compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" } }] })).models[0]!;
  assert.equal(model.name, "DeepSeek V4 Flash");
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.deepEqual(model.compat, { supportsDeveloperRole: false, maxTokensField: "max_tokens" });
});

test("a provider must offer at least one source of models, and the file stays bounded", () => {
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, catalog: undefined }))!, /must declare catalog, models, or both/);
  assert.match(errorOf({ providers: [] })!, /non-empty providers array/);
  assert.match(errorOf({})!, /non-empty providers array/);
  assert.match(errorOf([])!, /must be a JSON object/);
  const nine = { providers: Array.from({ length: 9 }, (_, index) => ({ ...CATALOG_ONLY, id: `gw${index}` })) };
  assert.match(errorOf(nine)!, /at most 8 providers/);
  const manyModels = { providers: [{ ...CATALOG_ONLY, models: Array.from({ length: 257 }, (_, index) => ({ ...VALID_MODEL, id: `m${index}` })) }] };
  assert.match(errorOf(manyModels)!, /at most 256 models/);
});

test("catalog defaults are optional and validated when present", () => {
  assert.deepEqual(declared(withProvider({ ...CATALOG_ONLY, modelDefaults: { maxTokens: 8_192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } })).modelDefaults, {
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, modelDefaults: { api: "gemini" } }))!, /must be one of/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, modelDefaults: { context: 1 } }))!, /unknown key context/);
  assert.match(errorOf(withProvider({ ...CATALOG_ONLY, modelDefaults: { cost: { input: 1 } } }))!, /output/);
});

test("the file is optional by default and required when its path is explicit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-providers-"));
  try {
    const path = join(directory, "providers.json");
    assert.deepEqual(await readProviderConfig(path, false, PROVIDER_IDS), { providers: [] });
    assert.match((await readProviderConfig(path, true, PROVIDER_IDS)).error!, /cannot be read/);

    await writeFile(path, JSON.stringify(withProvider(CATALOG_ONLY)));
    const read = await readProviderConfig(path, false, PROVIDER_IDS);
    assert.equal(read.error, undefined);
    assert.equal(read.providers.length, 1);
    assert.equal(read.providers[0]!.id, "magpie");

    // Editors on Windows write a UTF-8 BOM; the same text is still valid JSON.
    await writeFile(path, `\uFEFF${JSON.stringify(withProvider(CATALOG_ONLY))}`);
    assert.equal((await readProviderConfig(path, false, PROVIDER_IDS)).error, undefined);

    await writeFile(path, "{ not json");
    assert.match((await readProviderConfig(path, false, PROVIDER_IDS)).error!, /not valid JSON/);

    await writeFile(path, JSON.stringify({ providers: [{ ...CATALOG_ONLY, apiKey: "sk-live" }] }));
    const rejected = await readProviderConfig(path, false, PROVIDER_IDS);
    assert.match(rejected.error!, /credentials are read from the environment/);
    assert.equal(rejected.providers.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { CatalogError, fetchCatalogModels, mapCatalog } from "../src/provider-catalog.js";
import { validateProviderConfig, type CustomProviderDeclaration } from "../src/provider-config.js";
import { PROVIDER_IDS } from "../src/providers.js";

const BASE = {
  id: "magpie",
  label: "magpie gateway",
  baseUrl: "http://10.1.4.9:3425/v1",
  apiKeyEnv: "MAGPIE_API_KEY",
  catalog: { path: "/models" },
};

function declaration(overrides: Record<string, unknown> = {}): CustomProviderDeclaration {
  const result = validateProviderConfig({ providers: [{ ...BASE, ...overrides }] }, PROVIDER_IDS);
  assert.equal(result.error, undefined);
  return result.providers[0]!;
}

function catalog(entries: unknown[]): Record<string, unknown> {
  return { data: entries };
}

/** A model object shaped like the gateway's own listing, prices included as per-token strings. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "commandcode/deepseek/deepseek-v4-flash",
    object: "model",
    type: "model",
    display_name: "DeepSeek V4 Flash (latest)",
    context_window: 1_000_000,
    max_input_tokens: 1_000_000,
    max_output_tokens: 384_000,
    native_endpoints: ["/v1/chat/completions", "/v1/responses"],
    pricing: { prompt: "0.00000015", completion: "0.0000006", input_cache_read: "0.000000003" },
    reasoning: true,
    modalities: ["text"],
    ...overrides,
  };
}

test("a fetched entry becomes the model metadata pi-ai needs, priced per million tokens", () => {
  const result = mapCatalog(catalog([entry()]), declaration());
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.models, [{
    id: "commandcode/deepseek/deepseek-v4-flash",
    name: "DeepSeek V4 Flash (latest)",
    api: "openai-completions",
    provider: "magpie",
    baseUrl: "http://10.1.4.9:3425/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
  }]);
});

test("the endpoint hints pick the protocol, in the declared preference order", () => {
  const messages = entry({ id: "claude", native_endpoints: ["/v1/messages", "/v1/chat/completions"] });
  assert.equal(mapCatalog(catalog([messages]), declaration()).models[0]!.api, "anthropic-messages");
  const responses = entry({ id: "gpt", native_endpoints: ["/v1/responses"] });
  assert.equal(mapCatalog(catalog([responses]), declaration()).models[0]!.api, "openai-responses");
  // Preference order decides when an entry serves several protocols.
  const chatFirst = declaration({ catalog: { path: "/models", apiPreference: ["openai-completions", "anthropic-messages"] } });
  assert.equal(mapCatalog(catalog([messages]), chatFirst).models[0]!.api, "openai-completions");
  // An entry without endpoint hints falls back to the declared default.
  const noHints = entry({ id: "plain", native_endpoints: undefined });
  assert.equal(mapCatalog(catalog([noHints]), declaration()).models[0]!.api, "openai-completions");
  // modelDefaults.api is a hard override.
  const forced = declaration({ modelDefaults: { api: "openai-responses" } });
  assert.equal(mapCatalog(catalog([messages]), forced).models[0]!.api, "openai-responses");
  // A protocol declared at its own address is fetched onto that address, not the provider's base.
  const split = declaration({ apiBaseUrls: { "anthropic-messages": "http://10.1.4.9:3425" } });
  const mapped = mapCatalog(catalog([entry({ id: "claude", native_endpoints: ["/v1/messages"] }), entry({ id: "chat" })]), split);
  assert.deepEqual(mapped.models.map((model) => [model.api, model.baseUrl]), [
    ["anthropic-messages", "http://10.1.4.9:3425"],
    ["openai-completions", "http://10.1.4.9:3425/v1"],
  ]);
});

test("declared defaults fill only what the endpoint omits", () => {
  const minimal = entry({
    id: "sparse",
    context_window: undefined,
    max_output_tokens: undefined,
    pricing: undefined,
    reasoning: undefined,
    modalities: undefined,
    display_name: undefined,
  });
  const fill = declaration({
    modelDefaults: {
      contextWindow: 128_000,
      maxTokens: 16_384,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      reasoning: false,
      input: ["text", "image"],
    },
  });
  const model = mapCatalog(catalog([minimal]), fill).models[0]!;
  assert.deepEqual(model, {
    id: "sparse",
    name: "sparse",
    api: "openai-completions",
    provider: "magpie",
    baseUrl: "http://10.1.4.9:3425/v1",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  });
  // Compatibility flags describe the OpenAI wire format, so another protocol keeps its own defaults.
  const compat = declaration({ modelDefaults: { compat: { supportsDeveloperRole: false } } });
  assert.deepEqual(mapCatalog(catalog([entry({ id: "chat" })]), compat).models[0]!.compat, { supportsDeveloperRole: false });
  const anthropic = declaration({ modelDefaults: { compat: { supportsDeveloperRole: false } } });
  assert.equal(mapCatalog(catalog([entry({ id: "claude", native_endpoints: ["/v1/messages"] })]), anthropic).models[0]!.compat, undefined);
});

test("an entry this application cannot describe is skipped with a reason, never guessed", () => {
  const cases: Array<[unknown, RegExp]> = [
    [entry({ context_window: undefined, context_length: undefined }), /no context window/],
    [entry({ max_output_tokens: undefined }), /no output token limit/],
    [entry({ pricing: undefined }), /no complete pricing/],
    [entry({ pricing: { input: "0.5" } }), /no complete pricing/],
    [entry({ native_endpoints: ["/v1/embeddings"] }), /no supported chat endpoint/],
    [entry({ id: "  " }), /no usable model id/],
    ["not an object", /not an object/],
    [[], /not an object/],
  ];
  for (const [value, expected] of cases) {
    const result = mapCatalog(catalog([value]), declaration());
    assert.equal(result.models.length, 0, JSON.stringify(value));
    assert.match(result.skipped[0]!, expected);
  }
  const duplicate = mapCatalog(catalog([entry({ id: "same" }), entry({ id: "same" })]), declaration());
  assert.equal(duplicate.models.length, 1);
  assert.match(duplicate.skipped[0]!, /duplicate catalog entry/);
  // A cached read rate the endpoint omits is one it does not bill separately; the core rates are not.
  const noCache = mapCatalog(catalog([entry({ pricing: { prompt: "0.000001", completion: "0.000002" } })]), declaration());
  assert.deepEqual(noCache.models[0]!.cost, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
});

test("a catalog response must be a JSON object with a data array", () => {
  for (const raw of [{}, [], { data: {} }, { models: [] }, null, "text"]) {
    assert.throws(() => mapCatalog(raw, declaration()), (error: unknown) => error instanceof CatalogError && error.code === "PROTOCOL");
  }
});

test("the catalog request is a plain authenticated GET on the provider's own base URL", async () => {
  const seen: Array<{ url: string; method: string; authorization?: string; accept?: string; redirect?: string }> = [];
  const stub = async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      ...(headers.get("authorization") === null ? {} : { authorization: headers.get("authorization")! }),
      ...(headers.get("accept") === null ? {} : { accept: headers.get("accept")! }),
      ...(init?.redirect === undefined ? {} : { redirect: init.redirect }),
    });
    return new Response(JSON.stringify(catalog([entry()])), { headers: { "content-type": "application/json" } });
  };

  const withKey = await fetchCatalogModels(declaration(), { apiKey: "key-value", fetch: stub as typeof fetch });
  assert.equal(withKey.models.length, 1);
  assert.deepEqual(seen[0], {
    url: "http://10.1.4.9:3425/v1/models",
    method: "GET",
    authorization: "Bearer key-value",
    accept: "application/json",
    redirect: "manual",
  });

  seen.length = 0;
  await fetchCatalogModels(declaration({ catalog: { path: "/v2/model-list" } }), { fetch: stub as typeof fetch });
  assert.equal(seen[0]!.url, "http://10.1.4.9:3425/v1/v2/model-list");
  assert.equal(seen[0]!.authorization, undefined);

  seen.length = 0;
  await fetchCatalogModels(declaration({ baseUrl: "https://models.example.com" }), { apiKey: "k", fetch: stub as typeof fetch });
  assert.equal(seen[0]!.url, "https://models.example.com/models");
});

test("catalog failures are local codes, never a response body or a credential", async () => {
  const respond = (init: ResponseInit | undefined, body = "", headers: Record<string, string> = {}) =>
    async () => new Response(body, { ...init, headers: { "content-type": "application/json", ...headers } });

  const failure = async (stub: typeof fetch, expected: string, signal?: AbortSignal) => {
    await assert.rejects(
      fetchCatalogModels(declaration(), { apiKey: "key-value", fetch: stub, ...(signal === undefined ? {} : { signal }) }),
      (error: unknown) => error instanceof CatalogError
        && error.code === expected
        && !error.message.includes("key-value")
        && !error.message.includes("api.exa"),
    );
  };

  await failure(respond({ status: 302, headers: { location: "https://elsewhere.example.com/models" } }), "REDIRECT");
  await failure(respond({ status: 500 }, "server error body"), "HTTP");
  await failure(respond({ status: 401 }, "unauthorized"), "HTTP");
  await failure(async () => { throw new TypeError("fetch failed"); }, "NETWORK");
  await failure(respond(undefined, "{ not json"), "PROTOCOL");
  await failure(respond(undefined, '{"data":[],"data":[]}'), "PROTOCOL");
  await failure(respond(undefined, JSON.stringify({ data: [] }), { "content-length": "9999999" }), "TOO_LARGE");
  await failure(respond(undefined, `{"data":[{"padding":"${"x".repeat(600 * 1024)}"}]}`), "TOO_LARGE");

  const abort = new AbortController();
  abort.abort();
  await failure(respond(undefined, JSON.stringify(catalog([entry()]))), "CANCELLED", abort.signal);

  const slow = async (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  const timedOut = declaration({ catalog: { path: "/models", timeoutMs: 1_000 } });
  await assert.rejects(
    fetchCatalogModels(timedOut, { fetch: slow as typeof fetch }),
    (error: unknown) => error instanceof CatalogError && error.code === "TIMEOUT",
  );
});

test("a provider without a catalog declaration fetches nothing", async () => {
  const staticOnly = declaration({ catalog: undefined, models: [{ id: "m", api: "openai-completions", contextWindow: 1, maxTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const result = await fetchCatalogModels(staticOnly, { fetch: (() => { throw new Error("must not be called"); }) as unknown as typeof fetch });
  assert.deepEqual(result, { models: [], skipped: [] });
});

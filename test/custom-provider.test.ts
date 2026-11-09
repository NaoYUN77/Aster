import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { ConfigurationError, readConfig } from "../src/config.js";
import { validateProviderConfig, type CustomProviderDeclaration } from "../src/provider-config.js";
import {
  createProviderModels,
  findCustomProvider,
  providerApiKeyEnv,
  PROVIDER_IDS,
  refreshProviderCatalog,
  requireModel,
} from "../src/providers.js";

interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization?: string;
  readonly apiKey?: string;
  readonly body: string;
}

type Route = (response: ServerResponse, body: string) => void;

/** A stand-in for the deployment's own gateway: it records what it is asked and answers in kind. */
async function startGateway(routes: Record<string, Route>) {
  const seen: SeenRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const header = (name: string): string | undefined => {
        const value = request.headers[name];
        return Array.isArray(value) ? value[0] : value;
      };
      const authorization = header("authorization");
      const apiKey = header("x-api-key");
      seen.push({
        method: request.method ?? "",
        url: request.url ?? "",
        ...(authorization === undefined ? {} : { authorization }),
        ...(apiKey === undefined ? {} : { apiKey }),
        body,
      });
      const route = routes[(request.url ?? "").split("?")[0]!];
      if (route === undefined) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      route(response, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    // The two shapes a gateway is addressed in: the version-prefixed base the OpenAI-style clients
    // want, and the service root the Anthropic client adds `/v1/messages` to itself.
    baseUrl: `http://127.0.0.1:${port}/v1`,
    rootUrl: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

const CATALOG_ENTRY = {
  id: "vendor/deepseek-v4-flash",
  display_name: "DeepSeek V4 Flash",
  context_window: 1_000_000,
  max_output_tokens: 384_000,
  native_endpoints: ["/v1/chat/completions"],
  pricing: { prompt: "0.00000015", completion: "0.0000006" },
  reasoning: true,
  modalities: ["text"],
};

const MESSAGES_ENTRY = {
  id: "vendor/claude-sonnet-5-5",
  display_name: "Claude Sonnet 5.5",
  context_window: 200_000,
  max_output_tokens: 64_000,
  native_endpoints: ["/v1/messages"],
  pricing: { prompt: "0.000002", completion: "0.00001" },
  modalities: ["text"],
};

const MODELS_BODY = JSON.stringify({ data: [CATALOG_ENTRY, MESSAGES_ENTRY] });

/** SSE, as an OpenAI-compatible endpoint streams a one-word answer. */
function streamChat(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "vendor/deepseek-v4-flash", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
  response.write(chunk({ role: "assistant", content: "" }));
  response.write(chunk({ content: "pong" }));
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "vendor/deepseek-v4-flash",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
  })}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
}

/** SSE, as the Anthropic Messages API streams the same answer. */
function streamMessages(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const event = (name: string, payload: unknown) => response.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
  event("message_start", {
    type: "message_start",
    message: {
      id: "msg_1", type: "message", role: "assistant", model: "vendor/claude-sonnet-5-5",
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 },
    },
  });
  event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } });
  event("content_block_stop", { type: "content_block_stop", index: 0 });
  event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
  event("message_stop", { type: "message_stop" });
  response.end();
}

const ANSWER: Context = { messages: [{ role: "user", content: "ping", timestamp: 0 }] };

function textOf(message: AssistantMessage): string {
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function declarationOf(provider: Record<string, unknown>): CustomProviderDeclaration {
  const result = validateProviderConfig({ providers: [provider] }, PROVIDER_IDS);
  assert.equal(result.error, undefined);
  return result.providers[0]!;
}

async function withApiKey<T>(value: string, run: () => Promise<T>): Promise<T> {
  const saved = process.env.MAGPIE_API_KEY;
  process.env.MAGPIE_API_KEY = value;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.MAGPIE_API_KEY;
    else process.env.MAGPIE_API_KEY = saved;
  }
}

test("a declared provider is described by its own catalog, per model protocol included", async () => {
  const gateway = await startGateway({ "/v1/models": (response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(MODELS_BODY);
  } });
  try {
    const declaration = declarationOf({
      id: "magpie",
      label: "magpie gateway",
      baseUrl: gateway.baseUrl,
      apiBaseUrls: { "anthropic-messages": gateway.rootUrl },
      apiKeyEnv: "MAGPIE_API_KEY",
      catalog: { path: "/models" },
    });
    const models = createProviderModels("magpie", [declaration]);
    await withApiKey("gateway-key", () => refreshProviderCatalog(models, "magpie", declaration));

    // The catalog request is the provider's own, authenticated with the deployment's key.
    assert.equal(gateway.seen.length, 1);
    assert.equal(gateway.seen[0]!.method, "GET");
    assert.equal(gateway.seen[0]!.url, "/v1/models");
    assert.equal(gateway.seen[0]!.authorization, "Bearer gateway-key");

    const listed = models.getModels("magpie");
    assert.deepEqual(listed.map((model) => [model.id, model.api]), [
      ["vendor/deepseek-v4-flash", "openai-completions"],
      ["vendor/claude-sonnet-5-5", "anthropic-messages"],
    ]);
    // Prices, limits, and identity reach the model the base will call.
    assert.deepEqual(listed[0]!.cost, { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 });
    assert.equal(listed[0]!.contextWindow, 1_000_000);
    assert.equal(listed[0]!.name, "DeepSeek V4 Flash");
    assert.equal(listed[0]!.provider, "magpie");
    // Each model carries the address its own protocol is served at.
    assert.equal(listed[0]!.baseUrl, gateway.baseUrl);
    assert.equal(listed[1]!.baseUrl, gateway.rootUrl);
    requireModel(models, "magpie", "vendor/deepseek-v4-flash");
    assert.throws(() => requireModel(models, "magpie", "vendor/nothing"), /Unknown MODEL_ID "vendor\/nothing" for MODEL_PROVIDER=magpie/);
  } finally {
    await gateway.close();
  }
});

test("an inference request carries the deployment credential and the model's own protocol", async () => {
  const gateway = await startGateway({
    "/v1/models": (response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(MODELS_BODY); },
    "/v1/chat/completions": (response) => streamChat(response),
    "/v1/messages": (response) => streamMessages(response),
  });
  try {
    const declaration = declarationOf({
      id: "magpie",
      label: "magpie gateway",
      baseUrl: gateway.baseUrl,
      apiBaseUrls: { "anthropic-messages": gateway.rootUrl },
      apiKeyEnv: "MAGPIE_API_KEY",
      catalog: { path: "/models" },
    });
    const models = createProviderModels("magpie", [declaration]);
    await withApiKey("__vault_MAGPIE_API_KEY__", async () => {
      await refreshProviderCatalog(models, "magpie", declaration);

      const chat = models.getModel("magpie", "vendor/deepseek-v4-flash")!;
      const answer = await models.complete(chat, ANSWER);
      assert.equal(textOf(answer), "pong");
      const completion = gateway.seen[1]!;
      assert.equal(completion.url, "/v1/chat/completions");
      // The deployment placeholder is the credential; only the proxy substitutes it.
      assert.equal(completion.authorization, "Bearer __vault_MAGPIE_API_KEY__");
      const body: unknown = JSON.parse(completion.body);
      assert.equal((body as { model?: unknown }).model, "vendor/deepseek-v4-flash");
      assert.equal((body as { stream?: unknown }).stream, true);

      // The same provider serves a second model over a different wire protocol.
      const messages = models.getModel("magpie", "vendor/claude-sonnet-5-5")!;
      assert.equal(messages.api, "anthropic-messages");
      const reply = await models.complete(messages, ANSWER);
      assert.equal(textOf(reply), "pong");
      const sent = gateway.seen[2]!;
      // The Anthropic client supplies the `/v1/messages` path and its own beta query itself.
      assert.match(sent.url, /^\/v1\/messages(\?.*)?$/);
      assert.equal(sent.apiKey, "__vault_MAGPIE_API_KEY__");
      assert.equal((JSON.parse(sent.body) as { model?: unknown }).model, "vendor/claude-sonnet-5-5");
    });
  } finally {
    await gateway.close();
  }
});

test("a catalog that cannot be read stops startup instead of leaving the model list empty", async () => {
  const gateway = await startGateway({ "/v1/models": (response) => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end('{"error":"upstream unavailable"}');
  } });
  try {
    const declaration = declarationOf({
      id: "magpie",
      label: "magpie gateway",
      baseUrl: gateway.baseUrl,
      apiKeyEnv: "MAGPIE_API_KEY",
      catalog: { path: "/models" },
    });
    const models = createProviderModels("magpie", [declaration]);
    await withApiKey("gateway-key", async () => {
      await assert.rejects(
        refreshProviderCatalog(models, "magpie", declaration),
        (error: unknown) => error instanceof ConfigurationError
          && /Model catalog for provider magpie could not be read/.test(error.message)
          && !error.message.includes("gateway-key"),
      );
    });
    assert.deepEqual(models.getModels("magpie"), []);
  } finally {
    await gateway.close();
  }
});

test("a provider that lists its models statically never calls the network for a catalog", async () => {
  const gateway = await startGateway({});
  try {
    const declaration = declarationOf({
      id: "magpie",
      label: "magpie gateway",
      baseUrl: gateway.baseUrl,
      apiKeyEnv: "MAGPIE_API_KEY",
      models: [{
        id: "vendor/deepseek-v4-flash",
        api: "openai-completions",
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
      }],
    });
    const models = createProviderModels("magpie", [declaration]);
    await refreshProviderCatalog(models, "magpie", declaration);
    assert.deepEqual(models.getModels("magpie").map((model) => model.id), ["vendor/deepseek-v4-flash"]);
    assert.deepEqual(gateway.seen, []);
    requireModel(models, "magpie", "vendor/deepseek-v4-flash");
  } finally {
    await gateway.close();
  }
});

test("configuration reads a declared provider's own credential variable", () => {
  const declaration = declarationOf({
    id: "magpie",
    label: "magpie gateway",
    baseUrl: "http://10.1.4.9:3425/v1",
    apiKeyEnv: "MAGPIE_API_KEY",
    catalog: { path: "/models" },
  });
  const env = {
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_OWNER_ID: "42",
    MODEL_PROVIDER: "magpie",
    MODEL_ID: "vendor/deepseek-v4-flash",
    MAGPIE_API_KEY: "__vault_MAGPIE_API_KEY__",
  };
  assert.equal(readConfig(env, [declaration]).provider, "magpie");
  assert.equal(providerApiKeyEnv("magpie", [declaration]), "MAGPIE_API_KEY");
  assert.equal(providerApiKeyEnv("deepseek", [declaration]), "DEEPSEEK_API_KEY");
  assert.equal(providerApiKeyEnv("nobody", [declaration]), undefined);
  assert.equal(findCustomProvider([declaration], "magpie")?.id, "magpie");
  assert.equal(findCustomProvider([declaration], "deepseek"), undefined);

  // Without the declaration the id is unknown, and the error says where providers come from.
  assert.throws(
    () => readConfig({ ...env, MODEL_PROVIDER: "magpie" }),
    /MODEL_PROVIDER must be one of: anthropic, .*; declared providers come from the provider config file/,
  );
  // With it, the credential variable is still required: a declared provider is not a keyless one.
  const { MAGPIE_API_KEY: _omitted, ...withoutKey } = env;
  assert.throws(() => readConfig(withoutKey, [declaration]), /Missing configuration: MAGPIE_API_KEY/);
  // A malformed vault placeholder is caught before the key is ever used.
  assert.throws(
    () => readConfig({ ...env, MAGPIE_API_KEY: "__vault_magpie_key__" }, [declaration]),
    /MAGPIE_API_KEY has a malformed vault placeholder; expected __vault_MAGPIE_API_KEY__/,
  );
});

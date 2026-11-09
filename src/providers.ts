import { envApiKeyAuth, type Api, type Model, type ProviderStreams } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider, type Models, type Provider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { moonshotaiCnProvider } from "@earendil-works/pi-ai/providers/moonshotai-cn";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { ConfigurationError } from "./errors.js";
import { CatalogError, fetchCatalogModels } from "./provider-catalog.js";
import {
  modelBaseUrl,
  SUPPORTED_APIS,
  type CustomModelDeclaration,
  type CustomProviderDeclaration,
  type SupportedApi,
} from "./provider-config.js";

export interface ProviderEntry {
  readonly label: string;
  /** Environment variable holding the explicit API key. Only the name is stored here. */
  readonly apiKeyEnv: string;
  readonly create: () => Provider;
}

// Explicit API-key providers only. OAuth/subscription, ambient cloud credentials, and providers
// that need extra endpoint settings stay out of the compiled-in registry: they cannot be configured
// with a single key from the environment file this application validates. A provider that needs its
// own endpoint is declared in the provider config file instead, which reaches the same provider
// contract through createProvider().
export const PROVIDERS = {
  anthropic: { label: "Anthropic", apiKeyEnv: "ANTHROPIC_API_KEY", create: anthropicProvider },
  openai: { label: "OpenAI", apiKeyEnv: "OPENAI_API_KEY", create: openaiProvider },
  deepseek: { label: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY", create: deepseekProvider },
  google: { label: "Google Gemini", apiKeyEnv: "GEMINI_API_KEY", create: googleProvider },
  xai: { label: "xAI", apiKeyEnv: "XAI_API_KEY", create: xaiProvider },
  mistral: { label: "Mistral", apiKeyEnv: "MISTRAL_API_KEY", create: mistralProvider },
  groq: { label: "Groq", apiKeyEnv: "GROQ_API_KEY", create: groqProvider },
  moonshotai: { label: "Moonshot AI", apiKeyEnv: "MOONSHOT_API_KEY", create: moonshotaiProvider },
  "moonshotai-cn": { label: "Moonshot AI CN", apiKeyEnv: "MOONSHOT_API_KEY", create: moonshotaiCnProvider },
  minimax: { label: "MiniMax", apiKeyEnv: "MINIMAX_API_KEY", create: minimaxProvider },
  zai: { label: "Z.AI", apiKeyEnv: "ZAI_API_KEY", create: zaiProvider },
  openrouter: { label: "OpenRouter", apiKeyEnv: "OPENROUTER_API_KEY", create: openrouterProvider },
} as const satisfies Record<string, ProviderEntry>;

export type ProviderId = keyof typeof PROVIDERS;

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDERS, value);
}

/** One pi-ai wire-protocol implementation per protocol a declared provider may hand to a model. */
const API_IMPLEMENTATIONS: Readonly<Record<SupportedApi, () => ProviderStreams>> = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
  "google-generative-ai": googleGenerativeAIApi,
};

export function findCustomProvider(
  custom: readonly CustomProviderDeclaration[],
  id: string,
): CustomProviderDeclaration | undefined {
  return custom.find((provider) => provider.id === id);
}

/** The credential environment variable for a provider id, whether it is compiled in or declared. */
export function providerApiKeyEnv(id: string, custom: readonly CustomProviderDeclaration[] = []): string | undefined {
  if (isProviderId(id)) return PROVIDERS[id].apiKeyEnv;
  return findCustomProvider(custom, id)?.apiKeyEnv;
}

/** Model metadata as pi-ai expects it; a declared model states what it needs instead of inheriting. */
function toModel(providerId: string, declaration: CustomProviderDeclaration, model: CustomModelDeclaration): Model<Api> {
  return {
    id: model.id,
    name: model.name ?? model.id,
    api: model.api,
    provider: providerId,
    baseUrl: modelBaseUrl(declaration, model.api),
    reasoning: model.reasoning ?? false,
    input: [...(model.input ?? ["text"])],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.compat === undefined ? {} : { compat: model.compat }),
  };
}

/**
 * Build a declared provider from the base's own primitives: identity, base URL, one API-key auth
 * method, a model list, and the protocol implementations pi-ai ships. The provider therefore obeys
 * the same contract as every built-in provider, including request-time credential resolution, so a
 * deployment placeholder (`__vault_<NAME>__`) reaches the wire unchanged and the proxy substitutes it.
 */
export function createCustomProvider(declaration: CustomProviderDeclaration): Provider {
  const models: Model<Api>[] = declaration.models.map((model) => toModel(declaration.id, declaration, model));
  return createProvider({
    id: declaration.id,
    name: declaration.label,
    baseUrl: declaration.baseUrl,
    // The provider's credential is the host's; a model parameter can never name or supply it.
    auth: { apiKey: envApiKeyAuth(`${declaration.label} API key`, [declaration.apiKeyEnv]) },
    models,
    ...(declaration.catalog === undefined ? {} : {
      // Refreshing is the base's own dynamic-catalog path: the fetch belongs to the provider, and
      // Models.refresh owns publication, persistence, and cancellation.
      fetchModels: async (context) => {
        const credential = context.credential;
        const apiKey = credential !== undefined && credential.type === "api_key" ? credential.key : undefined;
        const result = await fetchCatalogModels(declaration, {
          signal: context.signal,
          ...(apiKey === undefined ? {} : { apiKey }),
        });
        for (const reason of result.skipped) {
          console.error(`Provider ${declaration.id} ignored a catalog entry: ${reason}`);
        }
        return result.models;
      },
    }),
    api: Object.fromEntries(SUPPORTED_APIS.map((api) => [api, API_IMPLEMENTATIONS[api]()])),
  });
}

export function createProviderModels(id: string, custom: readonly CustomProviderDeclaration[] = []): Models {
  const models = createModels();
  const declaration = findCustomProvider(custom, id);
  if (declaration !== undefined) {
    models.setProvider(createCustomProvider(declaration));
    return models;
  }
  const entry: ProviderEntry | undefined = isProviderId(id) ? PROVIDERS[id] : undefined;
  if (entry === undefined) throw new ConfigurationError(`MODEL_PROVIDER is not a known provider: ${id}`);
  models.setProvider(entry.create());
  return models;
}

/**
 * Fetch a declared provider's model catalog before the agent is built. Only the provider this
 * deployment selected is refreshed, and a catalog that cannot be read is a startup error: without it
 * MODEL_ID cannot be checked, and running with an unvalidated model id would fail on first use.
 */
export async function refreshProviderCatalog(
  models: Models,
  providerId: string,
  declaration: CustomProviderDeclaration,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (declaration.catalog === undefined) return;
  const result = await models.refresh({
    providers: [providerId],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result.aborted) {
    throw new ConfigurationError(`Model catalog for provider ${providerId} was not fetched: the request was cancelled`);
  }
  const failure: unknown = result.errors.get(providerId);
  if (failure === undefined) return;
  const detail = failure instanceof CatalogError ? failure.message : "the endpoint did not answer as expected";
  throw new ConfigurationError(`Model catalog for provider ${providerId} could not be read: ${detail}`);
}

/** Fail before any network call when MODEL_ID is not in the provider catalog shipped with pi-ai. */
export function requireModel(models: Models, provider: string, modelId: string): void {
  if (models.getModel(provider, modelId)) return;
  const examples = models.getModels(provider).slice(0, 5).map((model) => model.id);
  const hint = examples.length > 0 ? `; examples: ${examples.join(", ")}` : "";
  throw new ConfigurationError(`Unknown MODEL_ID "${modelId}" for MODEL_PROVIDER=${provider}${hint}`);
}

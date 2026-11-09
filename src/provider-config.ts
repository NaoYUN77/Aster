import { readFile } from "node:fs/promises";

const MAX_PROVIDERS = 8;
const MAX_MODELS = 256;
const DEFAULT_CATALOG_PATH = "/models";
const DEFAULT_CATALOG_TIMEOUT_MS = 10_000;
const MIN_CATALOG_TIMEOUT_MS = 1_000;
const MAX_CATALOG_TIMEOUT_MS = 60_000;
const MAX_BASE_URL_CHARS = 2_048;
const MAX_CONTEXT_WINDOW = 20_000_000;
const MAX_OUTPUT_TOKENS = 1_000_000;
const MAX_COST_PER_MILLION = 1_000_000;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,23}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
// A key name that reads as a credential, so a value mistakenly pasted here gets a pointed message.
const SECRET_LOOKING = /(api[-_]?key|apikey|token|secret|password|credential|authorization|bearer)/i;

/** Wire protocols a declared provider may hand to pi-ai; each has a base implementation to dispatch to. */
export const SUPPORTED_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export type SupportedApi = (typeof SUPPORTED_APIS)[number];

/**
 * Which catalog endpoint implies which protocol. A fetched model advertises the endpoints it serves;
 * the declaration's preference order decides which of them this application uses.
 */
export const CATALOG_ENDPOINT_APIS: Readonly<Record<string, SupportedApi>> = {
  "/v1/chat/completions": "openai-completions",
  "/v1/responses": "openai-responses",
  "/v1/messages": "anthropic-messages",
  "/v1beta/models": "google-generative-ai",
};

/**
 * Anthropic first, then the OpenAI chat API: a gateway's `/v1/messages` is the native path for
 * Anthropic models, while `/v1/responses` through a proxy is the least standardized of the three.
 */
export const DEFAULT_CATALOG_API_PREFERENCE: readonly SupportedApi[] = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
];

const MODALITIES = ["text", "image"] as const;
export type ModelModality = (typeof MODALITIES)[number];

/** Cost rates in US dollars per million tokens, the unit pi-ai catalogs and usage accounting use. */
export type ModelCostDeclaration = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
};

/**
 * A validated subset of pi-ai's OpenAI compatibility flags. Nested settings (chat templates,
 * OpenRouter routing) are out of scope here; a provider that needs them needs its own factory.
 */
export type CompatDeclaration = {
  readonly supportsStore?: boolean;
  readonly supportsDeveloperRole?: boolean;
  readonly supportsReasoningEffort?: boolean;
  readonly supportsUsageInStreaming?: boolean;
  readonly supportsFinishReason?: boolean;
  readonly requiresToolResultName?: boolean;
  readonly requiresAssistantAfterToolResult?: boolean;
  readonly requiresThinkingAsText?: boolean;
  readonly requiresReasoningContentOnAssistantMessages?: boolean;
  readonly maxTokensField?: "max_completion_tokens" | "max_tokens";
  readonly thinkingFormat?:
    | "ant-ling" | "baseten" | "chat-template" | "deepseek" | "openai"
    | "openrouter" | "qwen" | "qwen-chat-template" | "string-thinking" | "together" | "zai";
};

/** One model declared in the file: self-contained, so it never depends on catalog defaults. */
export type CustomModelDeclaration = {
  readonly id: string;
  readonly name?: string;
  readonly api: SupportedApi;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly reasoning?: boolean;
  readonly input?: readonly ModelModality[];
  readonly cost: ModelCostDeclaration;
  readonly compat?: CompatDeclaration;
};

/** Values a fetched catalog entry falls back to when the endpoint omits the field. */
export type CatalogDefaults = {
  /** Forces one protocol for every fetched model; without it the endpoint hints decide. */
  readonly api?: SupportedApi;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly reasoning?: boolean;
  readonly input?: readonly ModelModality[];
  readonly cost?: ModelCostDeclaration;
  /** Applied only to fetched models whose resolved protocol is `openai-completions`. */
  readonly compat?: CompatDeclaration;
};

export type CatalogDeclaration = {
  readonly path: string;
  readonly timeoutMs: number;
  readonly apiPreference: readonly SupportedApi[];
  readonly defaultApi: SupportedApi;
};

export type CustomProviderDeclaration = {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  /**
   * Address for a protocol whose implementation expects a different one than `baseUrl` states. The
   * wire protocols disagree about the version segment: the OpenAI and Gemini clients append their
   * path to a base that already ends in the version (`/v1`, `/v1beta`), while the Anthropic client
   * adds `/v1/messages` itself and therefore needs the service root. A gateway that serves several
   * families under one host must state each address it needs.
   */
  readonly apiBaseUrls?: Readonly<Partial<Record<SupportedApi, string>>>;
  readonly apiKeyEnv: string;
  readonly catalog?: CatalogDeclaration;
  readonly modelDefaults?: CatalogDefaults;
  readonly models: readonly CustomModelDeclaration[];
};

/** The address a model with this protocol is reached at, declared per protocol when it differs. */
export function modelBaseUrl(declaration: CustomProviderDeclaration, api: SupportedApi): string {
  return declaration.apiBaseUrls?.[api] ?? declaration.baseUrl;
}

export type ProviderConfigReadResult = {
  readonly providers: readonly CustomProviderDeclaration[];
  readonly error?: string;
};

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

/**
 * Read and validate the optional provider declaration file. Unlike the MCP file, every problem is a
 * file-level error: a dropped provider silently changes which models exist, and a credential pasted
 * here must fail loudly instead of being ignored. A missing default file means no custom providers;
 * an explicitly configured path must exist.
 */
export async function readProviderConfig(
  path: string,
  explicit: boolean,
  reservedIds: readonly string[],
): Promise<ProviderConfigReadResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !explicit) return { providers: [] };
    return { providers: [], error: `Provider config file cannot be read: ${path}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { providers: [], error: `Provider config is not valid JSON: ${path}` };
  }
  return validateProviderConfig(raw, reservedIds);
}

/** Validate already-parsed JSON. Any problem is the `error`; nothing is partially accepted. */
export function validateProviderConfig(raw: unknown, reservedIds: readonly string[]): ProviderConfigReadResult {
  try {
    return { providers: collectProviders(raw, reservedIds) };
  } catch (error) {
    return { providers: [], error: error instanceof ProviderConfigError ? error.message : "Provider config is invalid" };
  }
}

function collectProviders(raw: unknown, reservedIds: readonly string[]): CustomProviderDeclaration[] {
  if (!isRecord(raw)) throw new ProviderConfigError("Provider config must be a JSON object");
  const unknownRoot = Object.keys(raw).filter((key) => key !== "providers");
  if (unknownRoot.length > 0) throw unknownKey("Provider config", unknownRoot[0]!);
  if (!Array.isArray(raw.providers) || raw.providers.length === 0) {
    throw new ProviderConfigError("Provider config must contain a non-empty providers array");
  }
  if (raw.providers.length > MAX_PROVIDERS) {
    throw new ProviderConfigError(`Provider config allows at most ${MAX_PROVIDERS} providers`);
  }
  const seen = new Set<string>(reservedIds);
  return raw.providers.map((entry, index) => {
    const provider = parseProvider(entry, `providers[${index}]`);
    if (seen.has(provider.id)) {
      throw new ProviderConfigError(`providers[${index}]: provider id ${provider.id} is already registered`);
    }
    seen.add(provider.id);
    return provider;
  });
}

function parseProvider(value: unknown, field: string): CustomProviderDeclaration {
  if (!isRecord(value)) throw new ProviderConfigError(`${field} must be an object`);
  const unknown = Object.keys(value).find((key) => !["id", "label", "baseUrl", "apiBaseUrls", "apiKeyEnv", "catalog", "modelDefaults", "models"].includes(key));
  if (unknown !== undefined) throw unknownKey(field, unknown);

  const id = readString(value.id, `${field}.id`);
  if (!PROVIDER_ID.test(id)) throw new ProviderConfigError(`${field}.id must match [a-z][a-z0-9-]{0,23}`);
  const label = value.label === undefined ? id : readString(value.label, `${field}.label`);
  const apiKeyEnv = readString(value.apiKeyEnv, `${field}.apiKeyEnv`);
  if (!ENV_NAME.test(apiKeyEnv)) {
    throw new ProviderConfigError(`${field}.apiKeyEnv must be an environment variable name such as MAGPIE_API_KEY`);
  }
  const baseUrl = parseBaseUrl(value.baseUrl, `${field}.baseUrl`);
  const apiBaseUrls = value.apiBaseUrls === undefined ? undefined : parseApiBaseUrls(value.apiBaseUrls, `${field}.apiBaseUrls`);
  const catalog = value.catalog === undefined ? undefined : parseCatalog(value.catalog, `${field}.catalog`);
  const modelDefaults = value.modelDefaults === undefined ? undefined : parseCatalogDefaults(value.modelDefaults, `${field}.modelDefaults`);
  const models = value.models === undefined ? [] : parseModels(value.models, `${field}.models`);

  // Without either source a declared provider can never satisfy MODEL_ID, which is a config mistake
  // rather than a runtime condition.
  if (catalog === undefined && models.length === 0) {
    throw new ProviderConfigError(`${field} must declare catalog, models, or both`);
  }
  return {
    id,
    label,
    baseUrl,
    ...(apiBaseUrls === undefined ? {} : { apiBaseUrls }),
    apiKeyEnv,
    ...(catalog === undefined ? {} : { catalog }),
    ...(modelDefaults === undefined ? {} : { modelDefaults }),
    models,
  };
}

/** Per-protocol addresses, keyed by the protocol they replace; every other protocol uses baseUrl. */
function parseApiBaseUrls(value: unknown, field: string): Partial<Record<SupportedApi, string>> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new ProviderConfigError(`${field} must be a non-empty object keyed by protocol`);
  }
  const unknown = Object.keys(value).find((key) => !(SUPPORTED_APIS as readonly string[]).includes(key));
  if (unknown !== undefined) {
    throw new ProviderConfigError(`${field}: unknown key ${unknown}; expected one of: ${SUPPORTED_APIS.join(", ")}`);
  }
  const addresses: Partial<Record<SupportedApi, string>> = {};
  for (const [api, raw] of Object.entries(value)) {
    addresses[api as SupportedApi] = parseBaseUrl(raw, `${field}.${api}`);
  }
  return addresses;
}

function parseBaseUrl(value: unknown, field: string): string {
  const raw = readString(value, field);
  if (raw.length > MAX_BASE_URL_CHARS) throw new ProviderConfigError(`${field} is too long`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderConfigError(`${field} must be an absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProviderConfigError(`${field} must use https: or http:`);
  }
  if (url.username || url.password) throw new ProviderConfigError(`${field} must not embed credentials`);
  if (url.search || url.hash) throw new ProviderConfigError(`${field} must not contain a query or fragment`);
  // https may go anywhere; plain http only where the address cannot leave the host or its private
  // network. The API key travels in a header, so a public http endpoint is never acceptable here.
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) {
    throw new ProviderConfigError(`${field} may use http: only for a loopback or private address`);
  }
  return url.href.replace(/\/+$/, "");
}

function parseCatalog(value: unknown, field: string): CatalogDeclaration {
  if (!isRecord(value)) throw new ProviderConfigError(`${field} must be an object`);
  const unknown = Object.keys(value).find((key) => !["path", "timeoutMs", "apiPreference", "defaultApi"].includes(key));
  if (unknown !== undefined) throw unknownKey(field, unknown);

  const path = value.path === undefined ? DEFAULT_CATALOG_PATH : readString(value.path, `${field}.path`);
  if (!path.startsWith("/") || path.length > 256 || path.includes("..") || /[\s?#]/.test(path)) {
    throw new ProviderConfigError(`${field}.path must be an absolute path such as /models`);
  }
  const timeoutMs = value.timeoutMs === undefined
    ? DEFAULT_CATALOG_TIMEOUT_MS
    : readInteger(value.timeoutMs, `${field}.timeoutMs`, MIN_CATALOG_TIMEOUT_MS, MAX_CATALOG_TIMEOUT_MS);
  const apiPreference = value.apiPreference === undefined
    ? DEFAULT_CATALOG_API_PREFERENCE
    : readApiList(value.apiPreference, `${field}.apiPreference`);
  const defaultApi = value.defaultApi === undefined ? "openai-completions" : readApi(value.defaultApi, `${field}.defaultApi`);
  return { path, timeoutMs, apiPreference, defaultApi };
}

function parseCatalogDefaults(value: unknown, field: string): CatalogDefaults {
  if (!isRecord(value)) throw new ProviderConfigError(`${field} must be an object`);
  const unknown = Object.keys(value).find((key) => !["api", "contextWindow", "maxTokens", "reasoning", "input", "cost", "compat"].includes(key));
  if (unknown !== undefined) throw unknownKey(field, unknown);
  return {
    ...(value.api === undefined ? {} : { api: readApi(value.api, `${field}.api`) }),
    ...(value.contextWindow === undefined ? {} : { contextWindow: readInteger(value.contextWindow, `${field}.contextWindow`, 1, MAX_CONTEXT_WINDOW) }),
    ...(value.maxTokens === undefined ? {} : { maxTokens: readInteger(value.maxTokens, `${field}.maxTokens`, 1, MAX_OUTPUT_TOKENS) }),
    ...(value.reasoning === undefined ? {} : { reasoning: readBoolean(value.reasoning, `${field}.reasoning`) }),
    ...(value.input === undefined ? {} : { input: readModalities(value.input, `${field}.input`) }),
    ...(value.cost === undefined ? {} : { cost: parseCost(value.cost, `${field}.cost`) }),
    ...(value.compat === undefined ? {} : { compat: parseCompat(value.compat, `${field}.compat`) }),
  };
}

function parseModels(value: unknown, field: string): CustomModelDeclaration[] {
  if (!Array.isArray(value)) throw new ProviderConfigError(`${field} must be an array`);
  if (value.length > MAX_MODELS) throw new ProviderConfigError(`${field} allows at most ${MAX_MODELS} models`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const model = parseModel(entry, `${field}[${index}]`);
    if (seen.has(model.id)) throw new ProviderConfigError(`${field}[${index}]: duplicate model id ${model.id}`);
    seen.add(model.id);
    return model;
  });
}

function parseModel(value: unknown, field: string): CustomModelDeclaration {
  if (!isRecord(value)) throw new ProviderConfigError(`${field} must be an object`);
  const unknown = Object.keys(value).find((key) => !["id", "name", "api", "contextWindow", "maxTokens", "reasoning", "input", "cost", "compat"].includes(key));
  if (unknown !== undefined) throw unknownKey(field, unknown);

  const id = readString(value.id, `${field}.id`);
  if (!MODEL_ID.test(id)) throw new ProviderConfigError(`${field}.id must be 1-128 characters without spaces`);
  const contextWindow = readInteger(value.contextWindow, `${field}.contextWindow`, 1, MAX_CONTEXT_WINDOW);
  const maxTokens = readInteger(value.maxTokens, `${field}.maxTokens`, 1, MAX_OUTPUT_TOKENS);
  if (maxTokens > contextWindow) throw new ProviderConfigError(`${field}.maxTokens must not exceed contextWindow`);
  return {
    id,
    ...(value.name === undefined ? {} : { name: readString(value.name, `${field}.name`) }),
    api: readApi(value.api, `${field}.api`),
    contextWindow,
    maxTokens,
    ...(value.reasoning === undefined ? {} : { reasoning: readBoolean(value.reasoning, `${field}.reasoning`) }),
    ...(value.input === undefined ? {} : { input: readModalities(value.input, `${field}.input`) }),
    cost: parseCost(value.cost, `${field}.cost`),
    ...(value.compat === undefined ? {} : { compat: parseCompat(value.compat, `${field}.compat`) }),
  };
}

const COMPAT_FLAGS = [
  "supportsStore",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "supportsFinishReason",
  "requiresToolResultName",
  "requiresAssistantAfterToolResult",
  "requiresThinkingAsText",
  "requiresReasoningContentOnAssistantMessages",
] as const;
const THINKING_FORMATS = [
  "ant-ling", "baseten", "chat-template", "deepseek", "openai",
  "openrouter", "qwen", "qwen-chat-template", "string-thinking", "together", "zai",
] as const;

function parseCompat(value: unknown, field: string): CompatDeclaration {
  if (!isRecord(value) || Object.keys(value).length === 0) throw new ProviderConfigError(`${field} must be a non-empty object`);
  const allowed = new Set<string>([...COMPAT_FLAGS, "maxTokensField", "thinkingFormat"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw unknownKey(field, unknown);
  const compat: Record<string, unknown> = {};
  for (const flag of COMPAT_FLAGS) {
    if (value[flag] !== undefined) compat[flag] = readBoolean(value[flag], `${field}.${flag}`);
  }
  if (value.maxTokensField !== undefined) {
    if (value.maxTokensField !== "max_completion_tokens" && value.maxTokensField !== "max_tokens") {
      throw new ProviderConfigError(`${field}.maxTokensField must be "max_completion_tokens" or "max_tokens"`);
    }
    compat.maxTokensField = value.maxTokensField;
  }
  if (value.thinkingFormat !== undefined) {
    if (typeof value.thinkingFormat !== "string" || !(THINKING_FORMATS as readonly string[]).includes(value.thinkingFormat)) {
      throw new ProviderConfigError(`${field}.thinkingFormat is not a known thinking format`);
    }
    compat.thinkingFormat = value.thinkingFormat;
  }
  return compat as CompatDeclaration;
}

function parseCost(value: unknown, field: string): ModelCostDeclaration {
  if (!isRecord(value)) throw new ProviderConfigError(`${field} must be an object with input, output, cacheRead and cacheWrite`);
  const unknown = Object.keys(value).find((key) => !["input", "output", "cacheRead", "cacheWrite"].includes(key));
  if (unknown !== undefined) throw unknownKey(field, unknown);
  return {
    input: readRate(value.input, `${field}.input`),
    output: readRate(value.output, `${field}.output`),
    cacheRead: readRate(value.cacheRead, `${field}.cacheRead`),
    cacheWrite: readRate(value.cacheWrite, `${field}.cacheWrite`),
  };
}

/** Rates are dollars per million tokens; every field must be stated rather than defaulted. */
function readRate(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_COST_PER_MILLION) {
    throw new ProviderConfigError(`${field} must be a non-negative number of dollars per million tokens`);
  }
  return value;
}

function readModalities(value: unknown, field: string): ModelModality[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => !(MODALITIES as readonly unknown[]).includes(entry))) {
    throw new ProviderConfigError(`${field} must be a non-empty array of ${MODALITIES.join(", ")}`);
  }
  return [...new Set(value as ModelModality[])];
}

function readApi(value: unknown, field: string): SupportedApi {
  if (typeof value !== "string" || !(SUPPORTED_APIS as readonly string[]).includes(value)) {
    throw new ProviderConfigError(`${field} must be one of: ${SUPPORTED_APIS.join(", ")}`);
  }
  return value as SupportedApi;
}

function readApiList(value: unknown, field: string): SupportedApi[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > SUPPORTED_APIS.length) {
    throw new ProviderConfigError(`${field} must be a non-empty array of at most ${SUPPORTED_APIS.length} APIs`);
  }
  const apis = value.map((entry, index) => readApi(entry, `${field}[${index}]`));
  if (new Set(apis).size !== apis.length) throw new ProviderConfigError(`${field} must not repeat an API`);
  return apis;
}

function readInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ProviderConfigError(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new ProviderConfigError(`${field} must be a boolean`);
  return value;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ProviderConfigError(`${field} must be a non-empty string`);
  return value.trim();
}

function unknownKey(field: string, key: string): ProviderConfigError {
  if (SECRET_LOOKING.test(key)) {
    return new ProviderConfigError(`${field}: unknown key ${key}; credentials are read from the environment, never from this file`);
  }
  return new ProviderConfigError(`${field}: unknown key ${key}`);
}

/**
 * True when plain HTTP to this hostname cannot leave the machine or its private network: loopback,
 * RFC 1918, link-local, CGNAT (Tailscale), or an IPv6 unique-local address.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower === "::1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return false;
    const [a, b] = parts as [number, number, number, number];
    return a === 127 || a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127);
  }
  if (/^f[cd][0-9a-f]{2}:/.test(lower) || lower.startsWith("fe80:")) return true;
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import type { Api, Model } from "@earendil-works/pi-ai";
import {
  CATALOG_ENDPOINT_APIS,
  modelBaseUrl,
  type CustomProviderDeclaration,
  type ModelCostDeclaration,
  type ModelModality,
  type SupportedApi,
} from "./provider-config.js";
import { parseStrictJson } from "./strict-json.js";

/** A model list is small; anything larger is a wrong endpoint or a hostile response. */
const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_CATALOG_MODELS = 500;
const DEFAULT_TIMEOUT_MS = 10_000;
const MODALITIES: readonly string[] = ["text", "image"];

export type CatalogErrorCode =
  | "CANCELLED"
  | "TIMEOUT"
  | "NETWORK"
  | "REDIRECT"
  | "HTTP"
  | "TOO_LARGE"
  | "PROTOCOL";

/** Local failure with a message safe to log: no URL query, header, credential, or body content. */
export class CatalogError extends Error {
  readonly code: CatalogErrorCode;

  constructor(code: CatalogErrorCode, message: string) {
    super(message);
    this.name = "CatalogError";
    this.code = code;
  }
}

export type CatalogFetchResult = {
  readonly models: readonly Model<Api>[];
  /** Entries the endpoint listed that this application cannot describe, with a local reason. */
  readonly skipped: readonly string[];
};

export type CatalogFetchOptions = {
  readonly apiKey?: string;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
};

/**
 * Fetch the provider's model list and translate it into the model metadata pi-ai needs. The endpoint
 * hangs off the declared `baseUrl` — the same address the version-prefixed protocols are reached at —
 * so the request travels the same route (proxy, credential placeholder) as every other call to this
 * provider.
 */
export async function fetchCatalogModels(
  declaration: CustomProviderDeclaration,
  options: CatalogFetchOptions = {},
): Promise<CatalogFetchResult> {
  const catalog = declaration.catalog;
  if (catalog === undefined) return { models: [], skipped: [] };

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), catalog.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal === undefined ? deadline.signal : AbortSignal.any([options.signal, deadline.signal]);
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(`${declaration.baseUrl}${catalog.path}`, {
        method: "GET",
        // Inspect redirects instead of following them: the Authorization header must not reach
        // another origin, and a catalog that moved is a configuration problem to fix by hand.
        redirect: "manual",
        headers: {
          accept: "application/json",
          ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
        },
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw new CatalogError("CANCELLED", "model catalog request was cancelled");
      if (deadline.signal.aborted) throw new CatalogError("TIMEOUT", "model catalog request timed out");
      if (error instanceof CatalogError) throw error;
      throw new CatalogError("NETWORK", "model catalog endpoint could not be reached");
    }

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new CatalogError("REDIRECT", "model catalog endpoint answered with a redirect");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new CatalogError("HTTP", `model catalog endpoint answered with status ${response.status}`);
    }

    const raw = await readBoundedJson(response, signal, deadline, options.signal);
    return mapCatalog(raw, declaration);
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
  deadline: AbortController,
  caller: AbortSignal | undefined,
): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > MAX_CATALOG_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new CatalogError("TOO_LARGE", "model catalog response exceeds the size limit");
  }
  if (response.body === null) throw new CatalogError("PROTOCOL", "model catalog response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_CATALOG_BYTES) {
        await reader.cancel().catch(() => {});
        throw new CatalogError("TOO_LARGE", "model catalog response exceeds the size limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    if (caller?.aborted) throw new CatalogError("CANCELLED", "model catalog request was cancelled");
    if (deadline.signal.aborted) throw new CatalogError("TIMEOUT", "model catalog request timed out");
    throw new CatalogError("NETWORK", "model catalog response could not be read");
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return parseStrictJson(bytes, MAX_CATALOG_BYTES);
  } catch {
    throw new CatalogError("PROTOCOL", "model catalog response is not valid JSON");
  }
}

/** Translate an OpenAI-style `{ "data": [ ... ] }` model list. Unusable entries are skipped, not guessed. */
export function mapCatalog(raw: unknown, declaration: CustomProviderDeclaration): CatalogFetchResult {
  if (!isRecord(raw) || !Array.isArray(raw.data)) {
    throw new CatalogError("PROTOCOL", "model catalog response has no data array");
  }
  const models: Model<Api>[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw.data.slice(0, MAX_CATALOG_MODELS)) {
    const result = mapEntry(entry, declaration);
    if ("reason" in result) {
      skipped.push(result.reason);
      continue;
    }
    if (seen.has(result.model.id)) {
      skipped.push(`${result.model.id}: duplicate catalog entry`);
      continue;
    }
    seen.add(result.model.id);
    models.push(result.model);
  }
  return { models, skipped };
}

function mapEntry(entry: unknown, declaration: CustomProviderDeclaration): { model: Model<Api> } | { reason: string } {
  if (!isRecord(entry)) return { reason: "catalog entry is not an object" };
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!id || /\s/.test(id) || id.length > 128) return { reason: "catalog entry has no usable model id" };
  const defaults = declaration.modelDefaults;
  const catalog = declaration.catalog;

  const endpoints = Array.isArray(entry.native_endpoints)
    ? entry.native_endpoints.filter((endpoint): endpoint is string => typeof endpoint === "string")
    : undefined;
  const fromEndpoints = endpoints === undefined
    ? undefined
    : (catalog?.apiPreference ?? []).find((api) => endpoints.some((endpoint) => CATALOG_ENDPOINT_APIS[endpoint] === api));
  // An entry that advertises endpoints and none of them is a chat protocol is not a chat model.
  if (defaults?.api === undefined && endpoints !== undefined && fromEndpoints === undefined) {
    return { reason: `${id}: no supported chat endpoint` };
  }
  const api: SupportedApi = defaults?.api ?? fromEndpoints ?? catalog?.defaultApi ?? "openai-completions";

  const contextWindow = readPositiveInteger(entry.context_window) ?? readPositiveInteger(entry.context_length) ?? defaults?.contextWindow;
  if (contextWindow === undefined) return { reason: `${id}: catalog entry has no context window` };
  const maxTokens = readPositiveInteger(entry.max_output_tokens) ?? defaults?.maxTokens;
  if (maxTokens === undefined) return { reason: `${id}: catalog entry has no output token limit` };
  const cost = costFromPricing(entry.pricing) ?? defaults?.cost;
  if (cost === undefined) return { reason: `${id}: catalog entry has no complete pricing` };

  const name = typeof entry.display_name === "string" && entry.display_name.trim() !== "" ? entry.display_name.trim() : id;
  const reasoning = typeof entry.reasoning === "boolean" ? entry.reasoning : defaults?.reasoning ?? false;
  const input = modalities(entry.modalities) ?? defaults?.input ?? ["text"];
  // Compatibility flags describe an OpenAI-style wire format, so they apply only where that is the
  // resolved protocol; an Anthropic or Gemini model takes its own defaults.
  const compat = api === "openai-completions" ? defaults?.compat : undefined;

  return {
    model: {
      id,
      name,
      api,
      provider: declaration.id,
      baseUrl: modelBaseUrl(declaration, api),
      reasoning,
      input: [...input],
      cost: { ...cost },
      contextWindow,
      maxTokens,
      ...(compat === undefined ? {} : { compat }),
    } as Model<Api>,
  };
}

/**
 * The endpoint reports per-token prices as strings; pi-ai catalogs and usage accounting are dollars
 * per million tokens. Cache rates the endpoint omits count as zero because it does not bill them
 * separately, while a missing prompt or completion price leaves the cost unknown.
 */
function costFromPricing(value: unknown): ModelCostDeclaration | undefined {
  if (!isRecord(value)) return undefined;
  const prompt = perMillion(value.prompt);
  const completion = perMillion(value.completion);
  if (prompt === undefined || completion === undefined) return undefined;
  return {
    input: prompt,
    output: completion,
    cacheRead: perMillion(value.input_cache_read) ?? 0,
    cacheWrite: perMillion(value.input_cache_write) ?? 0,
  };
}

function perMillion(value: unknown): number | undefined {
  const rate = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(rate) || rate < 0) return undefined;
  return Math.round(rate * 1_000_000 * 1_000_000) / 1_000_000;
}

function modalities(value: unknown): ModelModality[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = value.filter((entry): entry is ModelModality => typeof entry === "string" && MODALITIES.includes(entry));
  return allowed.length === 0 ? undefined : [...new Set(allowed)];
}

function readPositiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { parseStrictJson } from "./strict-json.js";

const EXA_SEARCH_URL = "https://api.exa.ai/search";
/**
 * The public base price covers up to 10 results; every result above that is billed separately, so
 * the tool never asks for more.
 */
const MAX_RESULTS = 10;
const DEFAULT_MAX_RESULTS = 5;
const MAX_QUERY_CHARS = 128;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 24 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
/** Exa's balanced default: it may fetch page content at query time, which highlights need. */
const SEARCH_TYPE = "auto";
const SNIPPET_JOINER = " … ";

export type ExaSearchInput = {
  readonly query: string;
  readonly maxResults?: number;
};

export type ExaSearchResult = {
  readonly rank: number;
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly publishedAt: string | null;
};

/** How the results were produced, written by the provider to be shown to a model. */
export type ExaSearchNotice = {
  readonly code: string;
  readonly message: string;
};

export type ExaSearchOutput = {
  readonly ok: true;
  readonly provider: "exa";
  readonly query: string;
  readonly results: readonly ExaSearchResult[];
  readonly notices: readonly ExaSearchNotice[];
};

export type ExaSearchErrorCode =
  | "INVALID_ARGUMENT"
  | "BUSY"
  | "UPSTREAM_REQUEST_REJECTED"
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_BALANCE_REQUIRED"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "UPSTREAM_HTTP_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "CANCELLED"
  | "UPSTREAM_PROTOCOL_ERROR"
  | "RESULT_TOO_LARGE";

export type ExaSearchFailure = {
  readonly ok: false;
  readonly error: {
    readonly code: ExaSearchErrorCode;
    readonly message: string;
    readonly retryable: boolean;
  };
};

export class ExaSearchError extends Error {
  readonly code: ExaSearchErrorCode;
  readonly retryable: boolean;

  constructor(code: ExaSearchErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "ExaSearchError";
    this.code = code;
    this.retryable = retryable;
  }

  failure(): ExaSearchFailure {
    return { ok: false, error: { code: this.code, message: this.message, retryable: this.retryable } };
  }
}

type ExaSearchOptions = {
  readonly apiKey?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  /** Tests replace the provider endpoint without making it a deployment setting. */
  readonly endpoint?: string;
};

export function parseExaSearchInput(value: unknown): Required<ExaSearchInput> {
  if (!isRecord(value)) throw invalidInput("Arguments must be an object.");
  const unknown = Object.keys(value).find((key) => key !== "query" && key !== "maxResults");
  if (unknown !== undefined) throw invalidInput(`Unknown argument: ${unknown}.`);
  if (typeof value.query !== "string") throw invalidInput("query must be a string.");
  const query = value.query.trim();
  if (!query) throw invalidInput("query must not be empty.");
  if (hasUnpairedSurrogate(query)) throw invalidInput("query must contain valid Unicode text.");
  if ([...query].length > MAX_QUERY_CHARS) {
    throw invalidInput(`query must be at most ${MAX_QUERY_CHARS} characters.`);
  }
  const maxResults = Object.hasOwn(value, "maxResults") ? value.maxResults : DEFAULT_MAX_RESULTS;
  if (!Number.isInteger(maxResults) || (maxResults as number) < 1 || (maxResults as number) > MAX_RESULTS) {
    throw invalidInput(`maxResults must be an integer between 1 and ${MAX_RESULTS}.`);
  }
  return { query, maxResults: maxResults as number };
}

export async function searchExa(input: unknown, options: ExaSearchOptions = {}): Promise<ExaSearchOutput> {
  const parsed = parseExaSearchInput(input);
  const apiKey = options.apiKey?.trim();
  if (!apiKey) throw new ExaSearchError("PROVIDER_AUTH_FAILED", "Exa search credentials are not configured.");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new ExaSearchError("INVALID_ARGUMENT", "Exa search timeout is invalid.");
  }

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const signal = options.signal === undefined ? deadline.signal : AbortSignal.any([options.signal, deadline.signal]);
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(options.endpoint ?? EXA_SEARCH_URL, {
        method: "POST",
        // Inspect redirects instead of following them, so the Authorization header never reaches another origin.
        redirect: "manual",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: parsed.query,
          type: SEARCH_TYPE,
          numResults: parsed.maxResults,
          contents: { highlights: true },
        }),
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw cancelled();
      if (deadline.signal.aborted) throw timeout();
      if (error instanceof ExaSearchError) throw error;
      throw new ExaSearchError("NETWORK_ERROR", "Exa search could not reach the provider.", true);
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw httpError(response.status);
    }
    const raw = await readBoundedJson(response, signal).catch((error: unknown) => {
      if (options.signal?.aborted) throw cancelled();
      if (deadline.signal.aborted) throw timeout();
      throw error;
    });
    const output = normalizeResponse(raw, parsed.query, parsed.maxResults);
    if (Buffer.byteLength(JSON.stringify(output)) > MAX_OUTPUT_BYTES) {
      throw new ExaSearchError("RESULT_TOO_LARGE", "Exa search results exceed the output limit.");
    }
    return output;
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new ExaSearchError("RESULT_TOO_LARGE", "Exa search response exceeds the size limit.");
  }
  if (response.body === null) throw protocolError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ExaSearchError("RESULT_TOO_LARGE", "Exa search response exceeds the size limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ExaSearchError) throw error;
    if (signal.aborted) throw signal.reason;
    throw new ExaSearchError("NETWORK_ERROR", "Exa search response could not be read.", true);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return parseStrictJson(bytes, MAX_RESPONSE_BYTES);
  } catch {
    throw protocolError();
  }
}

function normalizeResponse(value: unknown, query: string, maxResults: number): ExaSearchOutput {
  // A synthesis search answers with prose instead of a result list; this tool only asks for
  // `type:"auto"`, so a response without `results` is not the answer it requested.
  if (!isRecord(value) || !Array.isArray(value.results)) throw protocolError();
  const results = value.results.slice(0, maxResults).map((candidate, index): ExaSearchResult => {
    if (!isRecord(candidate)) throw protocolError();
    const title = providerText(candidate.title);
    const url = safeUrl(candidate.url);
    const snippet = highlights(candidate.highlights);
    const publishedAt = publishedDate(candidate.publishedDate);
    if (title === undefined || url === undefined || snippet === undefined || publishedAt === undefined) {
      throw protocolError();
    }
    return { rank: index + 1, title, url, snippet, publishedAt };
  });
  return { ok: true, provider: "exa", query, results, notices: notices(value.notices) };
}

/**
 * Snippets come from the provider's highlights, which it picks per page; the tool asks for no other
 * content, so a result without them is a normal result with no snippet.
 */
function highlights(value: unknown): string | undefined {
  if (value === undefined) return "";
  if (!Array.isArray(value)) return undefined;
  const texts: string[] = [];
  for (const highlight of value) {
    if (typeof highlight !== "string" || hasUnpairedSurrogate(highlight)) return undefined;
    const text = providerText(highlight);
    if (text !== undefined && text !== "") texts.push(text);
  }
  return texts.join(SNIPPET_JOINER);
}

/**
 * Notices describe how the results were produced — for example that query restrictions matched
 * nothing and were relaxed — so they belong with the results the model reads. An empty or absent
 * code or message says less but is still a notice the provider chose to send, so it normalizes to
 * `""` instead of failing a response whose results are intact.
 */
function notices(value: unknown): ExaSearchNotice[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw protocolError();
  return value.map((candidate): ExaSearchNotice => {
    if (!isRecord(candidate)) throw protocolError();
    const code = candidate.code === undefined ? "" : providerText(candidate.code);
    const message = candidate.message === undefined ? "" : providerText(candidate.message);
    if (code === undefined || message === undefined) throw protocolError();
    return { code, message };
  });
}

function providerText(value: unknown): string | undefined {
  if (typeof value !== "string" || hasUnpairedSurrogate(value)) return undefined;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Exa documents `YYYY-MM-DDTHH:mm:ss.sssZ`; a zero offset is accepted too and everything normalizes
 * to UTC. Absent, null and empty dates stay unknown instead of becoming an invented time.
 */
function publishedDate(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || hasUnpairedSurrogate(value)) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:Z|\+00:00|-00:00)$/.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23 || minute > 59 || second > 59) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Vendor meanings: 400 request validation; 401 missing or invalid key; 402 out of credits or over a
 * spending budget; 403 the team is blocked or the feature is disabled; 429 a key, team or network
 * rate limit; 503 over capacity.
 */
function httpError(status: number): ExaSearchError {
  if (status === 400 || status === 413) return new ExaSearchError("UPSTREAM_REQUEST_REJECTED", "Exa search request was rejected.");
  if (status === 401) return new ExaSearchError("PROVIDER_AUTH_FAILED", "Exa search authentication failed.");
  if (status === 402) return new ExaSearchError("PROVIDER_BALANCE_REQUIRED", "Exa search account credits are exhausted.");
  if (status === 429) return new ExaSearchError("RATE_LIMITED", "Exa search rate limit exceeded.", true);
  if (status === 408 || status >= 500) return new ExaSearchError("PROVIDER_UNAVAILABLE", "Exa search provider is temporarily unavailable.", true);
  return new ExaSearchError("UPSTREAM_HTTP_ERROR", "Exa search provider returned an unexpected status.");
}

function invalidInput(message: string): ExaSearchError {
  return new ExaSearchError("INVALID_ARGUMENT", message);
}

function protocolError(): ExaSearchError {
  return new ExaSearchError("UPSTREAM_PROTOCOL_ERROR", "Exa search provider returned an invalid response.");
}

function timeout(): ExaSearchError {
  return new ExaSearchError("TIMEOUT", "Exa search timed out.", true);
}

function cancelled(): ExaSearchError {
  return new ExaSearchError("CANCELLED", "Exa search was cancelled.");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

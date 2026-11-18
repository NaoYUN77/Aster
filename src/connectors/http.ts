import { ConnectorError } from "./errors.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type ConnectorFetchOptions = {
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Treat 404 as the caller's requested resource missing. */
  readonly notFound?: boolean;
};

/**
 * One bounded JSON request. Errors are mapped by status only; the provider's body and headers are
 * never included in the error, the tool result or a log.
 */
export async function connectorJson(
  url: string,
  init: RequestInit,
  options: ConnectorFetchOptions,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  let response: Response;
  try {
    response = await options.fetch(url, { ...init, signal });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "connector upstream is unavailable");
  }
  if (!response.ok) {
    if (response.status === 401) throw new ConnectorError("CONNECTOR_AUTH_EXPIRED", "connector authorization expired; reauthorize it");
    if (response.status === 403) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining === "0") throw new ConnectorError("CONNECTOR_RATE_LIMITED", "connector upstream rate limit reached");
      throw new ConnectorError("CONNECTOR_SCOPE_DENIED", "the connector is missing a required scope");
    }
    if (response.status === 404 && options.notFound === true) {
      throw new ConnectorError("CONNECTOR_UPSTREAM_NOT_FOUND", "the requested connector resource was not found");
    }
    if (response.status === 429) throw new ConnectorError("CONNECTOR_RATE_LIMITED", "connector upstream rate limit reached");
    throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "connector upstream is unavailable");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "connector upstream response was too large");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "connector upstream returned invalid JSON");
  }
}

/** Small header lookup that does not care about provider header casing. */
export function header(headers: unknown, name: string): string {
  if (!Array.isArray(headers)) return "";
  for (const entry of headers) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { name?: unknown; value?: unknown };
    if (typeof record.name === "string" && record.name.toLowerCase() === name.toLowerCase()
      && typeof record.value === "string") return record.value;
  }
  return "";
}

/** Bounds text by Unicode characters without splitting a surrogate pair. */
export function clip(value: string, max: number): string {
  const characters = [...value];
  return characters.length <= max ? value : `${characters.slice(0, max).join("")}…`;
}

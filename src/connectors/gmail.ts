import { ConnectorError } from "./errors.js";
import { clip, connectorJson, header } from "./http.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const METADATA_HEADERS = ["Subject", "From", "To", "Date"] as const;

export type GmailClientOptions = {
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
};

export type GmailSearchHit = {
  readonly id: string;
  readonly threadId: string;
  readonly subject: string;
  readonly from: string;
  readonly date: string;
  readonly snippet: string;
};

export type GmailMessage = GmailSearchHit & {
  readonly to: string;
  readonly labels: readonly string[];
  readonly body: string;
  readonly truncated: boolean;
};

/** Read-only Gmail client. No send, delete or modify endpoint exists here. */
export class GmailClient {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: GmailClientOptions) {
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs;
  }

  async searchMessages(
    token: string,
    query: string,
    options: { readonly maxResults?: number } = {},
  ): Promise<GmailSearchHit[]> {
    const q = query.trim();
    if (q.length > 512) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "query must be at most 512 characters");
    const maxResults = Math.min(10, Math.max(1, Math.trunc(options.maxResults ?? 5)));
    const params = new URLSearchParams({ maxResults: String(maxResults) });
    if (q !== "") params.set("q", q);
    const body = await this.#get(token, `/messages?${params.toString()}`, false);
    if (!isRecord(body) || (body.messages !== undefined && !Array.isArray(body.messages))) {
      throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Gmail response was invalid");
    }
    const ids = Array.isArray(body.messages)
      ? body.messages.flatMap((entry) => isRecord(entry) && typeof entry.id === "string" && MESSAGE_ID.test(entry.id)
        ? [{ id: entry.id, threadId: typeof entry.threadId === "string" ? entry.threadId : "" }]
        : []).slice(0, maxResults)
      : [];
    // Metadata calls make the search result useful without a second tool round trip. They are
    // bounded by `maxResults` (<= 10) and each has its own timeout.
    const hits = await Promise.all(ids.map(async ({ id, threadId }) => {
      try {
        const message = await this.#metadata(token, id);
        return { id, threadId, ...message };
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "CONNECTOR_UPSTREAM_NOT_FOUND") return undefined;
        throw error;
      }
    }));
    return hits.filter((hit): hit is GmailSearchHit => hit !== undefined);
  }

  async getMessage(token: string, id: string): Promise<GmailMessage> {
    if (!MESSAGE_ID.test(id)) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "message id is invalid");
    const body = await this.#get(token, `/messages/${id}?format=full`, true);
    if (!isRecord(body)) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Gmail response was invalid");
    const payload = isRecord(body.payload) ? body.payload : {};
    const headers = payload.headers;
    const text = extractText(payload, 0).trim();
    const bodyText = text === "" ? (typeof body.snippet === "string" ? body.snippet : "") : text;
    const clipped = clip(bodyText, 8_000);
    return {
      id,
      threadId: typeof body.threadId === "string" ? body.threadId : "",
      subject: header(headers, "Subject"),
      from: header(headers, "From"),
      to: header(headers, "To"),
      date: header(headers, "Date"),
      snippet: typeof body.snippet === "string" ? clip(body.snippet, 500) : "",
      labels: Array.isArray(body.labelIds) ? body.labelIds.filter((label): label is string => typeof label === "string") : [],
      body: clipped,
      truncated: clipped.length < bodyText.length,
    };
  }

  async #metadata(token: string, id: string): Promise<Omit<GmailSearchHit, "id" | "threadId">> {
    const params = new URLSearchParams({ format: "metadata" });
    for (const name of METADATA_HEADERS) params.append("metadataHeaders", name);
    const body = await this.#get(token, `/messages/${id}?${params.toString()}`, true);
    if (!isRecord(body)) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Gmail response was invalid");
    const payload = isRecord(body.payload) ? body.payload : {};
    return {
      subject: header(payload.headers, "Subject") || "(no subject)",
      from: header(payload.headers, "From"),
      date: header(payload.headers, "Date"),
      snippet: typeof body.snippet === "string" ? clip(body.snippet, 500) : "",
    };
  }

  async #get(token: string, path: string, notFound: boolean): Promise<unknown> {
    return connectorJson(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    }, { fetch: this.#fetch, timeoutMs: this.#timeoutMs, notFound });
  }
}

/** Walks a Gmail MIME payload and returns the first non-empty text/plain part. */
function extractText(payload: Record<string, unknown>, depth: number): string {
  if (depth > 10) return "";
  const mimeType = typeof payload.mimeType === "string" ? payload.mimeType : "";
  const body = isRecord(payload.body) ? payload.body : {};
  if (mimeType === "text/plain" && typeof body.data === "string") {
    try {
      return Buffer.from(body.data, "base64url").toString("utf8");
    } catch {
      return "";
    }
  }
  if (!Array.isArray(payload.parts)) return "";
  for (const part of payload.parts.slice(0, 100)) {
    if (!isRecord(part)) continue;
    const text = extractText(part, depth + 1);
    if (text.trim() !== "") return text;
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

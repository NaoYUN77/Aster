import { ConnectorError } from "./errors.js";
import { clip, connectorJson } from "./http.js";

const API = "https://graph.microsoft.com/v1.0";
const MESSAGE_ID = /^[A-Za-z0-9_=+./-]{1,512}$/;
const SELECT = "id,subject,from,receivedDateTime,bodyPreview";
const DETAIL_SELECT = "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview,webLink";
const MAX_BODY_CHARS = 20_000;

export type OutlookClientOptions = {
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
};

export type OutlookMessageSummary = {
  readonly id: string;
  readonly subject: string;
  readonly from: string;
  readonly receivedDateTime: string;
  readonly snippet: string;
};

export type OutlookMessage = OutlookMessageSummary & {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly webLink: string;
  readonly body: string;
  readonly truncated: boolean;
};

/** Read-only Microsoft Graph mail client. No send, delete, move or draft endpoint exists here. */
export class OutlookClient {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: OutlookClientOptions) {
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs;
  }

  /** The most recent inbox messages, newest first. */
  async listMessages(token: string, options: { readonly maxResults?: number } = {}): Promise<OutlookMessageSummary[]> {
    const top = clamp(options.maxResults ?? 10, 1, 50);
    const params = new URLSearchParams({ "$top": String(top), "$select": SELECT, "$orderby": "receivedDateTime desc" });
    const body = await this.#get(token, `/me/mailFolders/inbox/messages?${params.toString()}`, false);
    return messagesFrom(body, top);
  }

  /** Graph `$search` over the whole mailbox. The query is quoted for KQL; quotes are rejected. */
  async searchMessages(
    token: string,
    query: string,
    options: { readonly maxResults?: number } = {},
  ): Promise<OutlookMessageSummary[]> {
    const q = query.trim();
    if (q.length > 256) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "query must be at most 256 characters");
    if (q.includes('"')) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "query must not contain double quotes");
    const top = clamp(options.maxResults ?? 10, 1, 50);
    const params = new URLSearchParams({ "$top": String(top), "$select": SELECT, "$search": `"${q}"` });
    const body = await this.#get(token, `/me/messages?${params.toString()}`, false);
    return messagesFrom(body, top);
  }

  async getMessage(token: string, id: string): Promise<OutlookMessage> {
    if (!MESSAGE_ID.test(id)) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "message id is invalid");
    const params = new URLSearchParams({ "$select": DETAIL_SELECT });
    const body = await this.#get(token, `/me/messages/${encodeURIComponent(id)}?${params.toString()}`, true);
    const summary = summaryFrom(body);
    if (summary === undefined) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Microsoft Graph response was invalid");
    const content = isRecord(body) && isRecord(body.body) && typeof body.body.content === "string"
      ? plainText(body.body.content, typeof body.body.contentType === "string" ? body.body.contentType : "text")
      : "";
    const clipped = clip(content, MAX_BODY_CHARS);
    return {
      ...summary,
      to: recipients(body, "toRecipients"),
      cc: recipients(body, "ccRecipients"),
      webLink: isRecord(body) && typeof body.webLink === "string" ? body.webLink : "",
      body: clipped,
      truncated: clipped.length < [...content].length,
    };
  }

  async #get(token: string, path: string, notFound: boolean): Promise<unknown> {
    return connectorJson(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    }, { fetch: this.#fetch, timeoutMs: this.#timeoutMs, notFound });
  }
}

function messagesFrom(body: unknown, limit: number): OutlookMessageSummary[] {
  if (!isRecord(body) || !Array.isArray(body.value)) {
    throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Microsoft Graph response was invalid");
  }
  return body.value.slice(0, limit).flatMap((entry) => {
    const summary = summaryFrom(entry);
    return summary === undefined ? [] : [summary];
  });
}

function summaryFrom(value: unknown): OutlookMessageSummary | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "" || !MESSAGE_ID.test(value.id)) return undefined;
  return {
    id: value.id,
    subject: typeof value.subject === "string" ? clip(value.subject, 300) : "(no subject)",
    from: formatAddress(isRecord(value.from) ? value.from.emailAddress : undefined),
    receivedDateTime: typeof value.receivedDateTime === "string" ? value.receivedDateTime : "",
    snippet: typeof value.bodyPreview === "string" ? clip(value.bodyPreview, 500) : "",
  };
}

function recipients(value: unknown, key: string): string[] {
  if (!isRecord(value) || !Array.isArray(value[key])) return [];
  return (value[key] as unknown[]).slice(0, 50).flatMap((entry) => {
    const address = isRecord(entry) ? formatAddress(entry.emailAddress) : "";
    return address === "" ? [] : [address];
  });
}

function formatAddress(value: unknown): string {
  if (!isRecord(value)) return "";
  const address = typeof value.address === "string" ? value.address : "";
  const name = typeof value.name === "string" ? value.name : "";
  if (name !== "" && address !== "") return `${name} <${address}>`;
  return address !== "" ? address : name;
}

/** Graph returns HTML by default; strip tags and decode the few entities that commonly appear. */
function plainText(content: string, contentType: string): string {
  if (contentType.toLowerCase() !== "html") return content.trim();
  return decodeEntities(
    content
      .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d{1,7});/g, (_match, digits: string) => {
      const code = Number(digits);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

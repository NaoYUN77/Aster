import { ConnectorError } from "./errors.js";
import { clip, connectorJson, connectorWrite, header } from "./http.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const METADATA_HEADERS = ["Subject", "From", "To", "Date"] as const;
const EMAIL = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;
const MAX_RECIPIENTS = 20;
const MAX_SUBJECT = 256;
const MAX_BODY = 20_000;
/** System labels that would delete, spam or otherwise bypass the read/write scope are not settable. */
const UNSAFE_LABELS = new Set(["TRASH", "SPAM"]);

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

/** Gmail client. Send, draft and label changes only; nothing here deletes or trashes a message. */
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

  /** Sends a plain-text message. Only the new message identity is returned. */
  async sendMessage(
    token: string,
    input: { readonly to: string; readonly subject: string; readonly body: string },
  ): Promise<{ readonly id: string; readonly threadId: string }> {
    const raw = messageRaw(input);
    const result = await this.#write(token, "/messages/send", { raw });
    if (!isRecord(result) || typeof result.id !== "string") {
      throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Gmail response was invalid");
    }
    return { id: result.id, threadId: typeof result.threadId === "string" ? result.threadId : "" };
  }

  async createDraft(
    token: string,
    input: { readonly to: string; readonly subject: string; readonly body: string },
  ): Promise<{ readonly draftId: string; readonly messageId: string }> {
    const raw = messageRaw(input);
    const result = await this.#write(token, "/drafts", { message: { raw } });
    if (!isRecord(result) || typeof result.id !== "string") {
      throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Gmail response was invalid");
    }
    const message = isRecord(result.message) ? result.message : {};
    return { draftId: result.id, messageId: typeof message.id === "string" ? message.id : "" };
  }

  /** Archive / mark read / add one label. Remove-only operations never cover TRASH or SPAM. */
  async modifyLabels(
    token: string,
    id: string,
    input: { readonly archive?: boolean; readonly markRead?: boolean; readonly addLabel?: string },
  ): Promise<{ readonly id: string; readonly added: readonly string[]; readonly removed: readonly string[] }> {
    if (!MESSAGE_ID.test(id)) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "message id is invalid");
    if (input.archive !== true && input.markRead !== true && (input.addLabel === undefined || input.addLabel === "")) {
      throw new ConnectorError("CONNECTOR_INVALID_INPUT", "archive, mark_read or add_label is required");
    }
    const addLabelIds: string[] = [];
    const removeLabelIds: string[] = [];
    if (input.archive === true) removeLabelIds.push("INBOX");
    if (input.markRead === true) removeLabelIds.push("UNREAD");
    if (input.addLabel !== undefined && input.addLabel !== "") {
      const labelId = await this.#labelId(token, input.addLabel);
      if (UNSAFE_LABELS.has(labelId)) {
        throw new ConnectorError("CONNECTOR_INVALID_INPUT", "this label cannot be applied by the connector");
      }
      addLabelIds.push(labelId);
    }
    const result = await this.#write(token, `/messages/${id}/modify`, { addLabelIds, removeLabelIds });
    if (!isRecord(result)) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Gmail response was invalid");
    return {
      id,
      added: addLabelIds,
      removed: removeLabelIds,
    };
  }

  async #labelId(token: string, name: string): Promise<string> {
    const wanted = name.trim();
    if (wanted === "" || wanted.length > 100) {
      throw new ConnectorError("CONNECTOR_INVALID_INPUT", "label name must be 1-100 characters");
    }
    const body = await this.#get(token, "/labels", false);
    if (!isRecord(body) || !Array.isArray(body.labels)) {
      throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Gmail response was invalid");
    }
    const match = body.labels.find((entry) => isRecord(entry)
      && typeof entry.name === "string" && entry.name.toLowerCase() === wanted.toLowerCase()
      && typeof entry.id === "string");
    if (!isRecord(match) || typeof match.id !== "string") {
      throw new ConnectorError("CONNECTOR_INVALID_INPUT", "Gmail label was not found");
    }
    return match.id;
  }

  #write(token: string, path: string, payload: unknown): Promise<unknown> {
    return connectorWrite(`${API}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(payload),
    }, { fetch: this.#fetch, timeoutMs: this.#timeoutMs });
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

/** Builds the RFC 2822 message and returns it base64url-encoded for the Gmail API. */
function messageRaw(input: { readonly to: string; readonly subject: string; readonly body: string }): string {
  const recipients = emailList(input.to);
  const subject = input.subject.trim();
  if (subject === "" || subject.length > MAX_SUBJECT) {
    throw new ConnectorError("CONNECTOR_INVALID_INPUT", "subject must be 1-256 characters");
  }
  if (/[\r\n]/.test(subject)) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "subject must not contain newlines");
  if (input.body.length > MAX_BODY) {
    throw new ConnectorError("CONNECTOR_INVALID_INPUT", `body must be at most ${MAX_BODY} characters`);
  }
  const encodedSubject = /^[\x20-\x7e]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const message = [
    `To: ${recipients.join(", ")}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(input.body, "utf8").toString("base64"),
  ].join("\r\n");
  return Buffer.from(message, "utf8").toString("base64url");
}

function emailList(value: string): string[] {
  const addresses = value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (addresses.length === 0 || addresses.length > MAX_RECIPIENTS) {
    throw new ConnectorError("CONNECTOR_INVALID_INPUT", `to must list 1-${MAX_RECIPIENTS} addresses`);
  }
  for (const address of addresses) {
    if (!EMAIL.test(address)) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "to contains an invalid email address");
  }
  return addresses;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

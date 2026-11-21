import { ConnectorError } from "./errors.js";
import { clip, connectorJson, connectorWrite } from "./http.js";

const API = "https://graph.microsoft.com/v1.0";
const MESSAGE_ID = /^[A-Za-z0-9_=+./-]{1,512}$/;
const SELECT = "id,subject,from,receivedDateTime,bodyPreview";
const DETAIL_SELECT = "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview,webLink";
const MAX_BODY_CHARS = 20_000;
const EMAIL = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;
const MAX_RECIPIENTS = 20;
const MAX_SUBJECT = 256;
/** Well-known folders mail may be moved to. deleteditems/recoverableitems are deliberately absent. */
const MOVE_FOLDERS = new Set(["inbox", "archive", "drafts", "sentitems", "junkemail"]);

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

/** Microsoft Graph mail client. Send, reply and flag/move only; nothing here deletes a message. */
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

  /** Sends a plain-text message; Graph answers 202 with no body. */
  async sendMessage(
    token: string,
    input: { readonly to: string; readonly subject: string; readonly body: string },
  ): Promise<{ readonly sent: boolean }> {
    const recipients = emailList(input.to);
    const subject = input.subject.trim();
    if (subject === "" || subject.length > MAX_SUBJECT) {
      throw new ConnectorError("CONNECTOR_INVALID_INPUT", "subject must be 1-256 characters");
    }
    const body = boundedText(input.body, "body");
    await this.#write(token, "POST", "/me/sendMail", {
      message: {
        subject,
        body: { contentType: "Text", content: body },
        toRecipients: recipients.map((address) => ({ emailAddress: { address } })),
      },
      saveToSentItems: true,
    });
    return { sent: true };
  }

  async replyMessage(
    token: string,
    id: string,
    comment: string,
  ): Promise<{ readonly replied: boolean; readonly inReplyTo: string }> {
    if (!MESSAGE_ID.test(id)) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "message id is invalid");
    const body = boundedText(comment, "comment");
    if (body.trim() === "") throw new ConnectorError("CONNECTOR_INVALID_INPUT", "comment must not be empty");
    await this.#write(token, "POST", `/me/messages/${encodeURIComponent(id)}/reply`, { comment: body });
    return { replied: true, inReplyTo: id };
  }

  async updateMessage(
    token: string,
    id: string,
    input: { readonly isRead?: boolean; readonly moveTo?: string },
  ): Promise<{ readonly id: string; readonly isRead?: boolean; readonly movedTo?: string }> {
    if (!MESSAGE_ID.test(id)) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "message id is invalid");
    if (input.isRead === undefined && input.moveTo === undefined) {
      throw new ConnectorError("CONNECTOR_INVALID_INPUT", "is_read or move_to is required");
    }
    if (input.moveTo !== undefined && !MOVE_FOLDERS.has(input.moveTo)) {
      throw new ConnectorError("CONNECTOR_INVALID_INPUT", "move_to must be inbox, archive, drafts, sentitems or junkemail");
    }
    if (input.isRead !== undefined) {
      await this.#write(token, "PATCH", `/me/messages/${encodeURIComponent(id)}`, { isRead: input.isRead });
    }
    if (input.moveTo !== undefined) {
      await this.#write(token, "POST", `/me/messages/${encodeURIComponent(id)}/move`, { destinationId: input.moveTo });
    }
    return {
      id,
      ...(input.isRead === undefined ? {} : { isRead: input.isRead }),
      ...(input.moveTo === undefined ? {} : { movedTo: input.moveTo }),
    };
  }

  async #get(token: string, path: string, notFound: boolean): Promise<unknown> {
    return connectorJson(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    }, { fetch: this.#fetch, timeoutMs: this.#timeoutMs, notFound });
  }

  async #write(token: string, method: "POST" | "PATCH", path: string, payload: unknown): Promise<unknown> {
    return connectorWrite(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }, { fetch: this.#fetch, timeoutMs: this.#timeoutMs });
  }
}

function boundedText(value: string, field: string): string {
  if (value.length > MAX_BODY_CHARS) {
    throw new ConnectorError("CONNECTOR_INVALID_INPUT", `${field} must be at most ${MAX_BODY_CHARS} characters`);
  }
  return value.trim() === "" ? "" : value;
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

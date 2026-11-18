import { ConnectorError } from "./errors.js";
import { clip, connectorJson } from "./http.js";

const API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const PAGE_ID = /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
const MAX_CONTENT_CHARS = 20_000;

export type NotionClientOptions = {
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
};

export type NotionSearchHit = {
  readonly id: string;
  readonly object: string;
  readonly title: string;
  readonly url: string;
  readonly lastEditedTime: string;
};

export type NotionPage = NotionSearchHit & {
  readonly content: string;
  readonly truncated: boolean;
};

/** Read-only Notion client: search, page metadata and block text. No write endpoint exists here. */
export class NotionClient {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: NotionClientOptions) {
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs;
  }

  async search(token: string, query: string, options: { readonly maxResults?: number } = {}): Promise<NotionSearchHit[]> {
    const q = query.trim();
    if (q.length > 256) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "query must be at most 256 characters");
    const pageSize = clamp(options.maxResults ?? 20, 1, 50);
    const body = await this.#request(token, "POST", "/search", {
      query: q,
      page_size: pageSize,
      sort: { direction: "descending", timestamp: "last_edited_time" },
    }, false);
    if (!isRecord(body) || !Array.isArray(body.results)) {
      throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Notion response was invalid");
    }
    return body.results.slice(0, pageSize).flatMap((entry) => {
      const hit = hitFrom(entry);
      return hit === undefined ? [] : [hit];
    });
  }

  async getPage(pageId: string, token: string): Promise<NotionPage> {
    const id = pageId.trim();
    if (!PAGE_ID.test(id)) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "page id is invalid");
    const page = await this.#request(token, "GET", `/pages/${id}`, undefined, true);
    const hit = hitFrom(page);
    const content = await this.#pageContent(token, id);
    const clipped = clip(content, MAX_CONTENT_CHARS);
    return {
      id: hit?.id ?? id,
      object: hit?.object ?? "page",
      title: hit?.title ?? "(untitled)",
      url: hit?.url ?? "",
      lastEditedTime: hit?.lastEditedTime ?? "",
      content: clipped,
      truncated: clipped.length < [...content].length,
    };
  }

  /** Walks up to three pages of block children and flattens their plain text. */
  async #pageContent(token: string, id: string): Promise<string> {
    const lines: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const params = new URLSearchParams({ page_size: "100" });
      if (cursor !== undefined) params.set("start_cursor", cursor);
      const body = await this.#request(token, "GET", `/blocks/${id}/children?${params.toString()}`, undefined, false);
      if (!isRecord(body) || !Array.isArray(body.results)) {
        throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Notion response was invalid");
      }
      for (const block of body.results.slice(0, 100)) {
        const text = blockText(block);
        if (text !== "") lines.push(text);
      }
      if (body.has_more !== true || typeof body.next_cursor !== "string" || body.next_cursor === "") break;
      cursor = body.next_cursor;
    }
    return lines.join("\n");
  }

  async #request(
    token: string,
    method: "GET" | "POST",
    path: string,
    payload: unknown,
    notFound: boolean,
  ): Promise<unknown> {
    return connectorJson(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "notion-version": NOTION_VERSION,
        accept: "application/json",
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }, { fetch: this.#fetch, timeoutMs: this.#timeoutMs, notFound });
  }
}

function hitFrom(value: unknown): NotionSearchHit | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return undefined;
  return {
    id: value.id,
    object: typeof value.object === "string" ? value.object : "page",
    title: clip(titleOf(value), 300),
    url: typeof value.url === "string" ? value.url : "",
    lastEditedTime: typeof value.last_edited_time === "string" ? value.last_edited_time : "",
  };
}

function titleOf(value: Record<string, unknown>): string {
  if (typeof value.object === "string" && value.object === "database" && Array.isArray(value.title)) {
    return richText(value.title);
  }
  if (isRecord(value.properties)) {
    for (const property of Object.values(value.properties)) {
      if (!isRecord(property) || property.type !== "title" || !Array.isArray(property.title)) continue;
      const text = richText(property.title);
      if (text !== "") return text;
    }
  }
  return "";
}

function richText(entries: readonly unknown[]): string {
  const parts: string[] = [];
  for (const entry of entries.slice(0, 100)) {
    if (isRecord(entry) && typeof entry.plain_text === "string") parts.push(entry.plain_text);
  }
  return parts.join("").trim();
}

/** Text of the block types a read-only summary needs; unsupported blocks are skipped. */
function blockText(value: unknown): string {
  if (!isRecord(value) || typeof value.type !== "string") return "";
  const payload = isRecord(value[value.type]) ? value[value.type] as Record<string, unknown> : undefined;
  if (payload === undefined) return "";
  if (Array.isArray(payload.rich_text)) {
    const text = richText(payload.rich_text);
    if (text === "") return "";
    return value.type === "heading_1" ? `# ${text}`
      : value.type === "heading_2" ? `## ${text}`
        : value.type === "heading_3" ? `### ${text}`
          : `- ${text}`;
  }
  if (typeof payload.text === "string" && payload.text !== "" && value.type === "code") return payload.text;
  return "";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

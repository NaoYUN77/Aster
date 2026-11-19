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

/** Notion client: search, page reads, page creation and block appends. Nothing here deletes or archives. */
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

  /**
   * Creates a page under a parent page or database. The parent kind and, for databases, the title
   * property are discovered from the API; the caller never supplies raw property payloads.
   */
  async createPage(
    token: string,
    input: { readonly parentId: string; readonly title: string; readonly content?: string },
  ): Promise<{ readonly id: string; readonly url: string; readonly title: string }> {
    const parentId = input.parentId.trim();
    if (!PAGE_ID.test(parentId)) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "parent id is invalid");
    const title = boundedTitle(input.title);
    const content = boundedContent(input.content ?? "", "content");
    const parent = await this.#parentOf(token, parentId);
    const body = await this.#request(token, "POST", "/pages", {
      parent: { [parent.type]: parentId },
      properties: { [parent.titleProperty]: { title: richTextOf(title) } },
      ...(content === "" ? {} : { children: paragraphBlocks(content) }),
    }, false);
    if (!isRecord(body) || typeof body.id !== "string") {
      throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Notion response was invalid");
    }
    return {
      id: body.id,
      url: typeof body.url === "string" ? body.url : "",
      title,
    };
  }

  /** Appends plain paragraphs to a page or block. Each request is capped at 100 blocks. */
  async appendBlocks(
    token: string,
    input: { readonly pageId: string; readonly content: string },
  ): Promise<{ readonly pageId: string; readonly blocksAdded: number }> {
    const pageId = input.pageId.trim();
    if (!PAGE_ID.test(pageId)) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "page id is invalid");
    const content = boundedContent(input.content, "content");
    if (content.trim() === "") throw new ConnectorError("CONNECTOR_INVALID_INPUT", "content must not be empty");
    const children = paragraphBlocks(content);
    const body = await this.#request(token, "PATCH", `/blocks/${pageId}/children`, { children }, false);
    if (!isRecord(body) || !Array.isArray(body.results)) {
      throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Notion response was invalid");
    }
    return { pageId, blocksAdded: body.results.length };
  }

  /**
   * Probes databases first, then pages. Notion answers a wrong-kind id either 404 or 400, so a
   * failed probe is not fatal; auth and scope failures still propagate.
   */
  async #parentOf(token: string, id: string): Promise<{ readonly type: "database_id" | "page_id"; readonly titleProperty: string }> {
    const database = await this.#probe(token, `/databases/${id}`);
    if (isRecord(database) && database.object === "database" && isRecord(database.properties)) {
      const key = titlePropertyKey(database.properties);
      if (key !== undefined) return { type: "database_id", titleProperty: key };
    }
    const page = await this.#probe(token, `/pages/${id}`);
    if (isRecord(page) && page.object === "page") return { type: "page_id", titleProperty: "title" };
    throw new ConnectorError("CONNECTOR_UPSTREAM_NOT_FOUND", "the parent page or database was not found or is not shared with Aster");
  }

  async #probe(token: string, path: string): Promise<unknown> {
    try {
      return await this.#request(token, "GET", path, undefined, true);
    } catch (error) {
      if (error instanceof ConnectorError
        && (error.code === "CONNECTOR_UPSTREAM_NOT_FOUND" || error.code === "CONNECTOR_UPSTREAM_UNAVAILABLE")) return undefined;
      throw error;
    }
  }

  async #request(
    token: string,
    method: "GET" | "POST" | "PATCH",
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

function boundedTitle(value: string): string {
  const title = value.trim();
  if (title === "" || title.length > 256) {
    throw new ConnectorError("CONNECTOR_INVALID_INPUT", "title must be 1-256 characters");
  }
  return title;
}

function boundedContent(value: string, field: string): string {
  if (value.length > MAX_CONTENT_CHARS) {
    throw new ConnectorError("CONNECTOR_INVALID_INPUT", `${field} must be at most ${MAX_CONTENT_CHARS} characters`);
  }
  return value;
}

function richTextOf(text: string): unknown[] {
  return [{ type: "text", text: { content: text } }];
}

/** Notion caps each rich-text node at 2000 characters and each request at 100 blocks. */
function paragraphBlocks(content: string): unknown[] {
  const paragraphs = content.replace(/\r\n/g, "\n").split("\n").flatMap((line) => {
    const trimmed = line.trim();
    if (trimmed === "") return [];
    const chunks: string[] = [];
    for (let index = 0; index < trimmed.length; index += 2_000) chunks.push(trimmed.slice(index, index + 2_000));
    return chunks;
  });
  if (paragraphs.length === 0) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "content must not be empty");
  if (paragraphs.length > 100) {
    throw new ConnectorError("CONNECTOR_INVALID_INPUT", "content is too long for one request; append it in smaller parts");
  }
  return paragraphs.map((text) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: richTextOf(text) },
  }));
}

function titlePropertyKey(properties: Record<string, unknown>): string | undefined {
  for (const [key, property] of Object.entries(properties)) {
    if (isRecord(property) && property.type === "title") return key;
  }
  return undefined;
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

/** Text of the block types the page summary needs; unsupported blocks are skipped. */
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

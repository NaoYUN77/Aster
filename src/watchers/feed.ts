import { createHash } from "node:crypto";
import type { SourceCheck, SourceCheckResult, SourceRow, SourceState, WatchEventInput, WatchKind } from "./protocol.js";
import { boundedFacts, eventText, oneLine } from "./normalize.js";
import type { SourceCheckOutcome } from "./poll.js";

/**
 * RSS/Atom adapter.
 *
 * Feeds are untrusted text: nothing here executes markup, resolves entities beyond the five XML
 * built-ins and numeric references, or follows a link. The adapter returns *every* current entry on
 * each successful check; the store's `(source_id, dedup_key)` uniqueness is what turns that into a
 * change feed. Conditional GET is the only optimisation — a 304 carries no entries and must not
 * disturb the schedule beyond proving the source reachable.
 */

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 50;
const MAX_ID_CHARS = 512;

export type FeedCheckOptions = {
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
  readonly maxBytes?: number;
};

type ParsedEntry = {
  readonly id: string;
  readonly title: string;
  readonly link: string | undefined;
  readonly published: string;
};

function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(`watch feed failed (${code})`), { code });
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Math.min(0x10ffff, Number.parseInt(hex, 16))))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Math.min(0x10ffff, Number(decimal))))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function elementText(block: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  if (match === null || match[1] === undefined) return "";
  // CDATA has to be unwrapped before markup is stripped, or its `<...>` markers survive.
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(match[1]);
  const text = cdata === null ? match[1] : cdata[1] ?? "";
  return oneLine(decodeXml(text.replace(/<[^>]*>/g, " ")), 2_000);
}

/** Prefer an Atom `rel="alternate"` link, then any `href`, then RSS element text. */
function entryLink(block: string): string {
  const links = /<link\b[^>]*>/gi;
  let fallback = "";
  let match: RegExpExecArray | null;
  while ((match = links.exec(block)) !== null) {
    const tag = match[0];
    const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    if (href === null) continue;
    const target = decodeXml(href[2] ?? href[3] ?? "");
    if (target === "") continue;
    if (/\brel\s*=\s*["']?alternate["']?/i.test(tag)) return target;
    if (fallback === "") fallback = target;
  }
  if (fallback !== "") return fallback;
  return elementText(block, "link");
}

/** Resolve relative links against the feed's own URL and drop anything that is not public HTTP(S). */
function resolveLink(value: string, base: string): string | undefined {
  const raw = value.trim();
  if (raw === "") return undefined;
  try {
    const url = new URL(raw, base);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseDate(value: string): string {
  if (value !== "") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

function normalizeId(value: string): string {
  return oneLine(value, MAX_ID_CHARS).trim();
}

function feedKindFromDocument(xml: string): "rss" | "atom" | "unknown" {
  if (/<rss\b/i.test(xml) || /<rdf:RDF\b/i.test(xml)) return "rss";
  if (/<feed\b/i.test(xml)) return "atom";
  return "unknown";
}

function entryBlocks(xml: string): string[] {
  const tag = /<item\b/i.test(xml) && !/<entry\b/i.test(xml) ? "item" : "entry";
  const blocks: string[] = [];
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null && blocks.length < MAX_ENTRIES) {
    if (match[1] !== undefined) blocks.push(match[1]);
  }
  return blocks;
}

function parseEntry(block: string, base: string): ParsedEntry {
  const title = elementText(block, "title");
  const linkText = resolveLink(entryLink(block), base);
  const published = elementText(block, "pubDate") || elementText(block, "published")
    || elementText(block, "updated") || elementText(block, "dc:date");
  const rawId = elementText(block, "guid") || elementText(block, "id");
  const id = normalizeId(rawId) || createHash("sha1").update(`${linkText ?? ""}|${title}|${published}`).digest("hex");
  return { id, title, link: linkText, published };
}

export function parseFeedEntries(xml: string, baseUrl: string): ParsedEntry[] {
  if (feedKindFromDocument(xml) === "unknown") throw failure("WATCH_PARSE_FAILED");
  return entryBlocks(xml).map((block) => parseEntry(block, baseUrl));
}

export class FeedCheck implements SourceCheck {
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #maxBytes: number;

  constructor(options: FeedCheckOptions) {
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? fetch;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async check(source: SourceRow, signal: AbortSignal): Promise<SourceCheckResult> {
    return (await this.checkDetailed(source, signal)).result;
  }

  async checkDetailed(source: SourceRow, signal: AbortSignal): Promise<SourceCheckOutcome> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.#timeoutMs);
    const combined = AbortSignal.any([signal, deadline.signal]);
    const kind: WatchKind = source.kind === "x" ? "x" : "feed";
    try {
      let response: Response;
      try {
        response = await this.#fetch(source.location, {
          method: "GET",
          redirect: "follow",
          headers: {
            accept: "application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1",
            "user-agent": "aster-watchers/1",
            ...(source.etag === null ? {} : { "if-none-match": source.etag }),
            ...(source.lastModified === null ? {} : { "if-modified-since": source.lastModified }),
          },
          signal: combined,
        });
      } catch {
        throw failure("WATCH_FETCH_TIMEOUT");
      }

      if (response.status === 304) {
        await response.body?.cancel().catch(() => {});
        const state: SourceState = {
          ...(source.etag === null ? {} : { etag: source.etag }),
          ...(source.lastModified === null ? {} : { lastModified: source.lastModified }),
        };
        return { result: { events: [], state }, notModified: true };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw failure(statusCode(response.status));
      }
      const xml = await this.#readBody(response);
      const entries = parseFeedEntries(xml, source.location);
      const events: WatchEventInput[] = entries.map((entry) => {
        const facts = boundedFacts({
          title: entry.title,
          link: entry.link,
          published: entry.published,
          id: entry.id,
        });
        return {
          dedupKey: entry.id,
          kind,
          occurredAt: parseDate(entry.published),
          facts,
          text: eventText(kind, facts),
        };
      });
      const state: SourceState = {
        ...(response.headers.get("etag") === null ? {} : { etag: response.headers.get("etag") as string }),
        ...(response.headers.get("last-modified") === null
          ? {}
          : { lastModified: response.headers.get("last-modified") as string }),
      };
      return { result: { events, state }, notModified: false };
    } finally {
      clearTimeout(timer);
    }
  }

  async #readBody(response: Response): Promise<string> {
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) > this.#maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw failure("WATCH_FEED_TOO_LARGE");
    }
    if (response.body === null) throw failure("WATCH_PARSE_FAILED");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > this.#maxBytes) {
          await reader.cancel().catch(() => {});
          throw failure("WATCH_FEED_TOO_LARGE");
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error) throw error;
      throw failure("WATCH_FETCH_TIMEOUT");
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function statusCode(status: number): string {
  if (status === 404 || status === 410) return "WATCH_SOURCE_GONE";
  if (status === 401 || status === 403) return "WATCH_SOURCE_AUTH";
  if (status === 429) return "WATCH_RATE_LIMITED";
  if (status === 400 || status === 415) return "WATCH_PARSE_FAILED";
  return "WATCH_FETCH_TIMEOUT";
}

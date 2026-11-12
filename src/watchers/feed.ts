import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { cleanText, feedText, safeLink } from "./normalize.js";
import type { SourceCheck, SourceCheckResult, SourceRow, WatchEventInput } from "./protocol.js";
import { WatcherError } from "./store.js";

/**
 * RSS/Atom polling with conditional GET. Feeds are the one source whose content this process has to
 * parse, so the adapter is deliberately thin and hostile to its input:
 *
 * - the URL is validated before every request (and on every redirect) so a tracked feed cannot point
 *   the bot at an internal address;
 * - the body is read with a hard byte cap and parsed with bounded block scans, never an XML parser
 *   that could honour a DTD or expand entities;
 * - entries only become events with a semantic dedupe key, and the first successful check is turned
 *   into a baseline by the store, so history is never delivered when a watch is created.
 *
 * A 304 is a success that produced no events; `finish` keeps the stored validators and clears the
 * failure count, so a healthy feed does not keep an old backoff.
 */

export type FeedSourceOptions = {
  readonly fetch?: typeof fetch;
  /** Per-request deadline. The poller's own abort signal still wins. */
  readonly timeoutMs?: number;
  /** Hard cap on a feed body; anything larger is reported rather than parsed. */
  readonly maxBytes?: number;
  readonly now?: () => Date;
  /** At most this many entries are examined per check, newest file order preserved. */
  readonly maxEntries?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 100;
const MAX_REDIRECTS = 3;
const ACCEPT = "application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1";

/**
 * Accepts only an absolute public HTTP(S) URL: no credentials, no explicit port, no IP literal and
 * no internal-only host name. This is the same boundary the web tools use, applied again here because
 * a feed location is persisted data that outlives the call which created it.
 */
export function normalizeFeedUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > 2_048) throw invalid();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw invalid();
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if ((url.protocol !== "https:" && url.protocol !== "http:")
    || url.username !== "" || url.password !== ""
    || url.port !== ""
    || hostname === "" || isIP(hostname) !== 0
    || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw invalid();
  }
  url.hash = "";
  return url.toString();
}

function invalid(): WatcherError {
  return new WatcherError("WATCH_TARGET_INVALID", "the feed URL must be an absolute public HTTP(S) URL");
}

type FetchLike = typeof fetch;

export class FeedSource implements SourceCheck {
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #now: () => Date;
  readonly #maxEntries: number;

  constructor(options: FeedSourceOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#now = options.now ?? (() => new Date());
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async check(source: SourceRow, signal: AbortSignal): Promise<SourceCheckResult> {
    const url = normalizeFeedUrl(source.location);
    const headers: Record<string, string> = { accept: ACCEPT };
    if (source.etag !== null) headers["if-none-match"] = source.etag;
    if (source.lastModified !== null) headers["if-modified-since"] = source.lastModified;

    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.#timeoutMs);
    const combined = AbortSignal.any([signal, deadline.signal]);
    try {
      const response = await this.#request(url, headers, combined, signal);
      if (response.status === 304) {
        await response.body?.cancel().catch(() => undefined);
        return { events: [] };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw httpError(response.status);
      }
      const body = await readBounded(response, this.#maxBytes, combined);
      const entries = parseFeed(body, this.#maxEntries);
      const occurredAt = this.#now().toISOString();
      const events = entries.map((entry): WatchEventInput => {
        // Only bounded, flattened copies of untrusted titles and links reach the event row.
        const link = safeLink(entry.link);
        const facts = {
          ...(entry.feed === undefined ? {} : { feed: cleanText(entry.feed, 80) }),
          title: cleanText(entry.title, 240),
          ...(link === undefined ? {} : { link }),
        };
        return {
          dedupKey: entry.dedupKey,
          kind: "feed",
          occurredAt: entry.published ?? occurredAt,
          facts,
          text: feedText(source.watcherId, facts),
        };
      });
      const etag = response.headers.get("etag");
      const lastModified = response.headers.get("last-modified");
      const state = {
        ...(etag === null ? {} : { etag }),
        ...(lastModified === null ? {} : { lastModified }),
      };
      return { events, ...(Object.keys(state).length === 0 ? {} : { state }) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Follows a bounded number of redirects, revalidating every hop before requesting it. */
  async #request(
    url: string,
    headers: Record<string, string>,
    combined: AbortSignal,
    caller: AbortSignal,
  ): Promise<Response> {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let response: Response;
      try {
        response = await this.#fetch(target, { method: "GET", headers, redirect: "manual", signal: combined });
      } catch (error) {
        if (caller.aborted) throw new WatcherError("WATCH_FETCH_TIMEOUT", "the feed check was cancelled");
        if (combined.aborted) throw new WatcherError("WATCH_FETCH_TIMEOUT", "the feed request timed out");
        throw new WatcherError("WATCH_FETCH_TIMEOUT", "the feed could not be reached");
      }
      // 304 is a cache answer, not a redirect; only the redirect statuses carry a location.
      if (response.status === 304 || response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (location === null) throw new WatcherError("WATCH_PARSE_FAILED", "the feed redirected without a location");
      target = normalizeFeedUrl(new URL(location, target).toString());
    }
    throw new WatcherError("WATCH_PARSE_FAILED", "the feed redirected too many times");
  }
}

function httpError(status: number): WatcherError {
  if (status === 404 || status === 410) return new WatcherError("WATCH_SOURCE_GONE", "the feed no longer exists");
  if (status === 401 || status === 403) return new WatcherError("WATCH_SOURCE_AUTH", "the feed refused access");
  if (status === 429) return new WatcherError("WATCH_RATE_LIMITED", "the feed asked this client to slow down");
  if (status === 408 || status >= 500) return new WatcherError("WATCH_FETCH_TIMEOUT", "the feed is temporarily unavailable");
  return new WatcherError("WATCH_TARGET_INVALID", "the feed rejected the request");
}

async function readBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new WatcherError("WATCH_FEED_TOO_LARGE", "the feed is larger than the size limit");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new WatcherError("WATCH_FEED_TOO_LARGE", "the feed is larger than the size limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof WatcherError) throw error;
    if (signal.aborted) throw new WatcherError("WATCH_FETCH_TIMEOUT", "the feed body could not be read in time");
    throw new WatcherError("WATCH_FETCH_TIMEOUT", "the feed body could not be read");
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export type FeedEntry = {
  readonly feed?: string;
  readonly title: string;
  readonly link?: string;
  /** Semantic key: the entry id, or a digest of link/title/published when the feed has no id. */
  readonly dedupKey: string;
  readonly published?: string;
};

/**
 * Minimal RSS 2.0 / Atom reader. It scans element blocks instead of building a tree: the input is
 * already bounded, and a flat scan cannot resolve external entities or recurse on hostile nesting.
 */
export function parseFeed(xml: string, limit = DEFAULT_MAX_ENTRIES): readonly FeedEntry[] {
  // An empty feed still has its container element; only a document with neither shape is a parse failure.
  const atom = /<(?:feed|entry)\b[^>]*>/i.test(xml);
  const rss = /<(?:rss|channel|item)\b[^>]*>/i.test(xml);
  if (!atom && !rss) throw new WatcherError("WATCH_PARSE_FAILED", "the response is not an RSS or Atom feed");
  const feed = elementText(firstMatch(xml, /<title\b[^>]*>([\s\S]*?)<\/title>/i));
  const blocks = atom ? blocksOf(xml, "entry") : blocksOf(xml, "item");
  const entries: FeedEntry[] = [];
  for (const block of blocks) {
    if (entries.length >= limit) break;
    const title = cleanMarkup(elementText(firstMatch(block, /<title\b[^>]*>([\s\S]*?)<\/title>/i)));
    const link = atom ? atomLink(block) : cleanMarkup(elementText(firstMatch(block, /<link\b[^>]*>([\s\S]*?)<\/link>/i)));
    const id = cleanMarkup(elementText(firstMatch(block, /<(?:id|guid)\b[^>]*>([\s\S]*?)<\/(?:id|guid)>/i)));
    const rawDate = atom
      ? elementText(firstMatch(block, /<(?:published|updated)\b[^>]*>([\s\S]*?)<\/(?:published|updated)>/i))
      : elementText(firstMatch(block, /<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i));
    const parsed = Date.parse(rawDate.trim());
    const published = Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
    if (title === "" && link === "" && id === "") continue;
    const dedupKey = id !== ""
      ? id.slice(0, 512)
      : createHash("sha1").update(`${link}|${title}|${published ?? ""}`).digest("hex");
    entries.push({
      ...(feed === "" ? {} : { feed }),
      title: title === "" ? link : title,
      ...(link === "" ? {} : { link }),
      dedupKey,
      ...(published === undefined ? {} : { published }),
    });
  }
  return entries;
}

function blocksOf(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const blocks: string[] = [];
  for (const match of xml.matchAll(pattern)) {
    const body = match[1];
    if (body !== undefined) blocks.push(body);
  }
  return blocks;
}

function firstMatch(value: string, pattern: RegExp): string | undefined {
  return pattern.exec(value)?.[1];
}

function elementText(value: string | undefined): string {
  if (value === undefined) return "";
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(value);
  const text = cdata?.[1] ?? value;
  return decodeEntities(text).trim();
}

/** Atom's link is an empty element with attributes; `self` and enclosures are not the entry page. */
function atomLink(block: string): string {
  let fallback = "";
  for (const match of block.matchAll(/<link\b([^>]*)\/?>/gi)) {
    const attrs = match[1] ?? "";
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    if (href === undefined) continue;
    const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]?.toLowerCase();
    const decoded = cleanMarkup(decodeEntities(href).trim());
    if (rel === undefined || rel === "alternate") return decoded;
    if (fallback === "" && rel !== "self" && rel !== "enclosure") fallback = decoded;
  }
  return fallback;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(value: number): string {
  return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
}

/** Feed titles sometimes carry markup; only the text is kept, flattened to one line. */
function cleanMarkup(value: string): string {
  return value.replace(/<[^>]{1,200}>/g, " ").replace(/\s+/g, " ").trim();
}

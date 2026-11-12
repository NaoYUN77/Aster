import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { FeedSource, normalizeFeedUrl, parseFeed } from "../src/watchers/feed.js";
import type { SourceRow } from "../src/watchers/protocol.js";
import { WatcherError } from "../src/watchers/store.js";

const NOW = new Date("2026-11-12T00:00:00.000Z");

function sourceRow(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 1,
    watcherId: 5,
    kind: "feed",
    location: "https://example.com/feed.xml",
    mode: "poll",
    status: "active",
    intervalSec: 900,
    nextCheckAt: null,
    reconcileAt: null,
    etag: null,
    lastModified: null,
    cursor: null,
    failures: 0,
    lastError: null,
    lastCheckAt: null,
    ...overrides,
  };
}

function code(error: unknown): string | undefined {
  return error instanceof WatcherError ? error.code : undefined;
}

function feedSource(fetchImpl: typeof fetch, overrides: { timeoutMs?: number; maxBytes?: number } = {}): FeedSource {
  return new FeedSource({ fetch: fetchImpl, now: () => NOW, ...overrides });
}

type Recorded = { url: string; init: RequestInit | undefined };

function recording(response: Response): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return response;
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const RSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel>
  <title>Example Blog</title>
  <item>
    <title>Hello &amp; welcome</title>
    <link>https://example.com/posts/1</link>
    <guid>post-1</guid>
    <pubDate>Tue, 11 Nov 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title><![CDATA[Second <b>post</b>]]></title>
    <link>https://example.com/posts/2</link>
    <pubDate>2026-11-11T11:00:00Z</pubDate>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <id>urn:uuid:entry-1</id>
    <title type="html">A &amp; B &#8212; C</title>
    <link rel="self" href="https://example.com/self.xml"/>
    <link rel="alternate" type="text/html" href="https://example.com/a?x=1&amp;y=2"/>
    <published>2026-11-10T00:00:00Z</published>
  </entry>
</feed>`;

test("feed URLs are limited to plain public HTTP(S) targets", () => {
  assert.equal(normalizeFeedUrl(" https://Example.com/feed.xml#top "), "https://example.com/feed.xml");
  assert.equal(normalizeFeedUrl("http://example.com/rss"), "http://example.com/rss");
  for (const value of [
    "",
    "file:///etc/passwd",
    "ftp://example.com/feed",
    "https://user:pass@example.com/feed",
    "http://127.0.0.1/feed",
    "http://[::1]/feed",
    "http://localhost/feed",
    "https://service.internal/feed",
    "https://example.com:8443/feed",
    "not a url",
  ]) {
    assert.throws(() => normalizeFeedUrl(value), (error) => code(error) === "WATCH_TARGET_INVALID", value);
  }
});

test("RSS polling sends validators and turns entries into deterministic events", async () => {
  const { fetch, calls } = recording(new Response(RSS, {
    status: 200,
    headers: { "content-type": "application/rss+xml", etag: "\"v2\"", "last-modified": "Tue, 11 Nov 2026 10:00:00 GMT" },
  }));
  const result = await feedSource(fetch).check(
    sourceRow({ etag: "\"v1\"", lastModified: "Mon, 10 Nov 2026 00:00:00 GMT" }),
    new AbortController().signal,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://example.com/feed.xml");
  const headers = new Headers(calls[0]!.init?.headers);
  assert.equal(headers.get("if-none-match"), "\"v1\"");
  assert.equal(headers.get("if-modified-since"), "Mon, 10 Nov 2026 00:00:00 GMT");
  assert.equal(calls[0]!.init?.redirect, "manual");

  assert.equal(result.events.length, 2);
  const [first, second] = result.events;
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(first.dedupKey, "post-1");
  assert.equal(first.kind, "feed");
  assert.equal(first.occurredAt, "2026-11-11T10:00:00.000Z");
  assert.deepEqual(first.facts, {
    feed: "Example Blog",
    title: "Hello & welcome",
    link: "https://example.com/posts/1",
  });
  assert.equal(first.text, "[跟踪 #5] Example Blog 有新内容：Hello & welcome https://example.com/posts/1");
  assert.equal(second.dedupKey, createHash("sha1").update("https://example.com/posts/2|Second post|2026-11-11T11:00:00.000Z").digest("hex"));
  assert.equal(second.facts.title, "Second post");
  assert.deepEqual(result.state, { etag: "\"v2\"", lastModified: "Tue, 11 Nov 2026 10:00:00 GMT" });
});

test("Atom entries use the alternate link and decode entities without trusting markup", async () => {
  const { fetch } = recording(new Response(ATOM, { status: 200 }));
  const result = await feedSource(fetch).check(sourceRow(), new AbortController().signal);
  assert.equal(result.events.length, 1);
  const event = result.events[0]!;
  assert.equal(event.dedupKey, "urn:uuid:entry-1");
  assert.equal(event.occurredAt, "2026-11-10T00:00:00.000Z");
  assert.deepEqual(event.facts, {
    feed: "Atom Feed",
    title: "A & B — C",
    link: "https://example.com/a?x=1&y=2",
  });
});

test("a feed without ids gets a stable digest key", () => {
  const first = parseFeed(RSS);
  const second = parseFeed(RSS);
  assert.equal(first[1]!.dedupKey, second[1]!.dedupKey);
  assert.equal(first[1]!.dedupKey.length, 40);
});

test("304 is a success with no events and no reset state", async () => {
  const { fetch, calls } = recording(new Response(null, { status: 304, headers: { etag: "\"v3\"" } }));
  const result = await feedSource(fetch).check(sourceRow({ etag: "\"v2\"" }), new AbortController().signal);
  assert.deepEqual(result, { events: [] });
  assert.equal(new Headers(calls[0]!.init?.headers).get("if-none-match"), "\"v2\"");
});

test("HTTP failures map to fixed reason codes", async () => {
  for (const [status, expected] of [
    [404, "WATCH_SOURCE_GONE"],
    [410, "WATCH_SOURCE_GONE"],
    [401, "WATCH_SOURCE_AUTH"],
    [403, "WATCH_SOURCE_AUTH"],
    [429, "WATCH_RATE_LIMITED"],
    [500, "WATCH_FETCH_TIMEOUT"],
    [503, "WATCH_FETCH_TIMEOUT"],
    [400, "WATCH_TARGET_INVALID"],
  ] as const) {
    const { fetch } = recording(new Response("no", { status }));
    await assert.rejects(
      () => feedSource(fetch).check(sourceRow(), new AbortController().signal),
      (error) => code(error) === expected,
      String(status),
    );
  }
});

test("an oversized body and a non-feed page fail instead of reaching the store", async () => {
  const large = recording(new Response("", { status: 200, headers: { "content-length": "2000000" } }));
  await assert.rejects(
    () => feedSource(large.fetch).check(sourceRow(), new AbortController().signal),
    (error) => code(error) === "WATCH_FEED_TOO_LARGE",
  );

  const html = recording(new Response("<html><body>hi</body></html>", { status: 200 }));
  await assert.rejects(
    () => feedSource(html.fetch).check(sourceRow(), new AbortController().signal),
    (error) => code(error) === "WATCH_PARSE_FAILED",
  );
});

test("redirects are followed only within the public HTTP(S) boundary", async () => {
  let call = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    call += 1;
    if (call === 1) return new Response(null, { status: 302, headers: { location: "/moved.xml" } });
    assert.equal(String(input), "https://example.com/moved.xml");
    return new Response(RSS, { status: 200 });
  }) as typeof fetch;
  const result = await feedSource(fetchImpl).check(sourceRow(), new AbortController().signal);
  assert.equal(result.events.length, 2);

  const toPrivate = recording(new Response(null, { status: 301, headers: { location: "http://192.168.0.5/feed" } }));
  await assert.rejects(
    () => feedSource(toPrivate.fetch).check(sourceRow(), new AbortController().signal),
    (error) => code(error) === "WATCH_TARGET_INVALID",
  );
});

test("a request deadline that fires reports a timeout", async () => {
  const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  })) as typeof fetch;
  await assert.rejects(
    () => feedSource(fetchImpl, { timeoutMs: 20 }).check(sourceRow(), new AbortController().signal),
    (error) => code(error) === "WATCH_FETCH_TIMEOUT",
  );
});

import type {
  CreateWatcherInput,
  SourceRow,
  WatchEventInput,
} from "../src/watchers/protocol.js";

/** A mutable clock so scheduling tests can move time without timers. */
export function clock(start = "2026-11-12T00:00:00.000Z") {
  const state = { time: new Date(start) };
  return {
    now: () => state.time,
    iso: () => state.time.toISOString(),
    advance(seconds: number): void {
      state.time = new Date(state.time.getTime() + seconds * 1_000);
    },
    after(seconds: number): string {
      return new Date(state.time.getTime() + seconds * 1_000).toISOString();
    },
  };
}

export function createInput(now: () => Date, overrides: Partial<CreateWatcherInput> = {}): CreateWatcherInput {
  return {
    chatId: "C1",
    kind: "feed",
    target: "https://example.com/feed.xml",
    label: "example feed",
    location: "https://example.com/feed.xml",
    mode: "poll",
    intervalSec: 300,
    now: now().toISOString(),
    ...overrides,
  };
}

export function feedSource(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 1,
    watcherId: 1,
    kind: "feed",
    location: "https://example.com/feed.xml",
    mode: "poll",
    status: "active",
    intervalSec: 300,
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

export function eventInput(key: string, text = `entry ${key}`, kind = "feed"): WatchEventInput {
  return {
    dedupKey: key,
    kind,
    occurredAt: "2026-11-12T00:00:00.000Z",
    facts: { title: text, link: "https://example.com/post" },
    text,
  };
}

export function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/xml" },
    ...init,
  });
}

export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

export function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Example</title>
  <item>
    <title>First &amp; best</title>
    <link>https://example.com/first</link>
    <guid isPermaLink="false">post-1</guid>
    <pubDate>Tue, 11 Nov 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title><![CDATA[Second <b>post</b>]]></title>
    <link>/relative/second</link>
    <pubDate>Wed, 12 Nov 2026 10:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

export const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom example</title>
  <entry>
    <id>tag:example.com,2026:1</id>
    <title>Atom first</title>
    <link rel="alternate" href="https://example.com/atom/1"/>
    <updated>2026-11-12T08:00:00Z</updated>
  </entry>
</feed>`;

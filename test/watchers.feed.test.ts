import assert from "node:assert/strict";
import test from "node:test";
import { FeedCheck, parseFeedEntries } from "../src/watchers/feed.js";
import { ATOM, RSS, errorCode, feedSource, textResponse } from "./watchers.testkit.js";

function checker(fetchImpl: typeof fetch, maxBytes?: number): FeedCheck {
  return new FeedCheck({ timeoutMs: 5_000, fetch: fetchImpl, ...(maxBytes === undefined ? {} : { maxBytes }) });
}

const signal = new AbortController().signal;

test("RSS entries keep their id, decode entities, strip markup and resolve relative links", () => {
  const entries = parseFeedEntries(RSS, "https://example.com/feed.xml");
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.id, "post-1");
  assert.equal(entries[0]?.title, "First & best");
  assert.equal(entries[0]?.link, "https://example.com/first");
  assert.equal(entries[1]?.title, "Second post");
  assert.equal(entries[1]?.link, "https://example.com/relative/second");
  assert.match(entries[1]?.id ?? "", /^[0-9a-f]{40}$/);
});

test("Atom entries prefer rel=alternate and use the entry id as the dedup key", () => {
  const entries = parseFeedEntries(ATOM, "https://example.com/atom.xml");
  assert.deepEqual(entries.map((entry) => entry.id), ["tag:example.com,2026:1"]);
  assert.equal(entries[0]?.link, "https://example.com/atom/1");
});

test("a successful check returns every current entry plus validators", async () => {
  const seen: RequestInit[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(init ?? {});
    assert.equal(String(input), "https://example.com/feed.xml");
    return textResponse(RSS, { headers: { etag: '"v1"', "last-modified": "Tue, 11 Nov 2026 10:00:00 GMT" } });
  }) as typeof fetch;
  const outcome = await checker(fake).checkDetailed(feedSource(), signal);
  assert.equal(outcome.notModified, false);
  assert.equal(outcome.result.events.length, 2);
  assert.equal(outcome.result.events[0]?.dedupKey, "post-1");
  assert.match(outcome.result.events[0]?.text ?? "", /First & best https:\/\/example\.com\/first/);
  assert.equal(outcome.result.state?.etag, '"v1"');
  const headers = seen[0]?.headers as Record<string, string>;
  assert.equal(headers["if-none-match"], undefined);
});

test("conditional headers are sent when validators are known", async () => {
  let headers: Record<string, string> = {};
  const fake = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    headers = init?.headers as Record<string, string>;
    return textResponse(ATOM);
  }) as typeof fetch;
  await checker(fake).check(feedSource({ etag: '"v9"', lastModified: "Tue, 11 Nov 2026 10:00:00 GMT" }), signal);
  assert.equal(headers["if-none-match"], '"v9"');
  assert.equal(headers["if-modified-since"], "Tue, 11 Nov 2026 10:00:00 GMT");
});

test("304 is reported as notModified and keeps the existing validators", async () => {
  const fake = (async () => new Response(null, { status: 304 })) as typeof fetch;
  const outcome = await checker(fake).checkDetailed(feedSource({ etag: '"v3"' }), signal);
  assert.equal(outcome.notModified, true);
  assert.equal(outcome.result.events.length, 0);
  assert.equal(outcome.result.state?.etag, '"v3"');
});

test("feed HTTP and parse failures map to reason codes", async () => {
  const cases: [number, string][] = [[404, "WATCH_SOURCE_GONE"], [410, "WATCH_SOURCE_GONE"], [401, "WATCH_SOURCE_AUTH"],
    [403, "WATCH_SOURCE_AUTH"], [429, "WATCH_RATE_LIMITED"], [500, "WATCH_FETCH_TIMEOUT"]];
  for (const [status, code] of cases) {
    const fake = (async () => new Response("nope", { status })) as typeof fetch;
    await assert.rejects(checker(fake).check(feedSource(), signal), (error) => errorCode(error) === code);
  }
  const garbage = (async () => textResponse("<html>not a feed</html>")) as typeof fetch;
  await assert.rejects(checker(garbage).check(feedSource(), signal), (error) => errorCode(error) === "WATCH_PARSE_FAILED");
});

test("oversized bodies are refused without reading them into memory", async () => {
  const fake = (async () => textResponse(RSS, { headers: { "content-length": "999999" } })) as typeof fetch;
  await assert.rejects(checker(fake, 1_024).check(feedSource(), signal), (error) => errorCode(error) === "WATCH_FEED_TOO_LARGE");
  const streamed = (async () => textResponse("x".repeat(8_000))) as typeof fetch;
  await assert.rejects(checker(streamed, 1_024).check(feedSource(), signal), (error) => errorCode(error) === "WATCH_FEED_TOO_LARGE");
});

test("network failures are timeouts with no body to trust", async () => {
  const fake = (async () => { throw new TypeError("offline"); }) as typeof fetch;
  await assert.rejects(checker(fake).check(feedSource(), signal), (error) => errorCode(error) === "WATCH_FETCH_TIMEOUT");
});

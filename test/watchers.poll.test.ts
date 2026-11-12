import assert from "node:assert/strict";
import test from "node:test";
import type { WatchersConfig } from "../src/watchers/protocol.js";
import { backoffSeconds, runPollTick } from "../src/watchers/poll.js";
import { SqliteWatchStore } from "../src/watchers/store.js";
import { RSS, clock, createInput, textResponse } from "./watchers.testkit.js";

const CONFIG: WatchersConfig = {
  enabled: true,
  maxActive: 10,
  maxPerHour: 10,
  feedIntervalSec: 300,
  xIntervalSec: 300,
  githubReconcileMin: 10,
  fetchTimeoutMs: 5_000,
};

const SECOND_ITEM = `
  <item>
    <title>Third</title>
    <link>https://example.com/third</link>
    <guid>post-3</guid>
    <pubDate>Thu, 13 Nov 2026 10:00:00 GMT</pubDate>
  </item>`;

function rssWithExtra(): string {
  return RSS.replace("</channel>", `${SECOND_ITEM}</channel>`);
}

function fetcher(handler: (call: number) => Response | Promise<Response>): typeof fetch {
  let calls = 0;
  return (async () => handler(++calls)) as typeof fetch;
}

function withStore(run: (store: SqliteWatchStore, time: ReturnType<typeof clock>) => Promise<void>): Promise<void> {
  const store = new SqliteWatchStore(":memory:");
  const time = clock();
  return run(store, time).finally(() => store.close());
}

test("the first poll only builds a baseline; only later entries are queued", async () => {
  await withStore(async (store, time) => {
    const { sourceId } = store.create(createInput(time.now));
    await runPollTick({ store, config: CONFIG, now: time.now, fetch: fetcher(() => textResponse(RSS)) });
    assert.equal(store.pending(10).length, 0);
    assert.ok(store.list("C1")[0]?.source.lastCheckAt);

    time.advance(300);
    await runPollTick({ store, config: CONFIG, now: time.now, fetch: fetcher(() => textResponse(rssWithExtra())) });
    const pending = store.pending(10);
    assert.equal(pending.length, 1);
    assert.match(pending[0]?.text ?? "", /Third/);
    assert.ok(sourceId > 0);
  });
});

test("a failed first check keeps the source in baseline, so recovery does not replay history", async () => {
  await withStore(async (store, time) => {
    store.create(createInput(time.now));
    await runPollTick({ store, config: CONFIG, now: time.now, fetch: fetcher(() => { throw new TypeError("offline"); }) });
    const failed = store.list("C1")[0]?.source;
    assert.equal(failed?.failures, 1);
    assert.equal(failed?.status, "backoff");
    assert.equal(failed?.lastCheckAt, null);

    time.advance(300);
    await runPollTick({ store, config: CONFIG, now: time.now, fetch: fetcher(() => textResponse(rssWithExtra())) });
    assert.equal(store.pending(10).length, 0);
    assert.equal(store.list("C1")[0]?.source.failures, 0);
  });
});

test("304 produces no events and does not clear an earned backoff", async () => {
  await withStore(async (store, time) => {
    store.create(createInput(time.now));
    await runPollTick({
      store, config: CONFIG, now: time.now,
      fetch: fetcher(() => textResponse(RSS, { headers: { etag: '"v1"' } })),
    });
    time.advance(300);
    await runPollTick({
      store, config: CONFIG, now: time.now,
      fetch: fetcher(() => new Response("down", { status: 500 })),
    });
    assert.equal(store.list("C1")[0]?.source.failures, 1);

    time.advance(300);
    await runPollTick({
      store, config: CONFIG, now: time.now,
      fetch: fetcher(() => new Response(null, { status: 304 })),
    });
    const source = store.list("C1")[0]?.source;
    assert.equal(source?.failures, 1, "304 must not reset the backoff");
    assert.equal(source?.status, "backoff");
    assert.equal(store.pending(10).length, 0);
    assert.ok(source?.lastCheckAt);
  });
});

test("failures follow interval × 2^failures, capped at one hour, and success clears them", async () => {
  await withStore(async (store, time) => {
    store.create(createInput(time.now));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const expected = Math.min(300 * 2 ** attempt, 3_600);
      assert.equal(backoffSeconds(300, attempt), expected);
      await runPollTick({
        store, config: CONFIG, now: time.now,
        fetch: fetcher(() => new Response("down", { status: 503 })),
      });
      const source = store.list("C1")[0]?.source;
      assert.equal(source?.nextCheckAt, time.after(expected));
      assert.equal(source?.failures, attempt + 1);
      assert.equal(source?.status, attempt + 1 >= 5 ? "error" : "backoff");
      time.advance(expected);
    }
    await runPollTick({ store, config: CONFIG, now: time.now, fetch: fetcher(() => textResponse(RSS)) });
    const recovered = store.list("C1")[0]?.source;
    assert.equal(recovered?.failures, 0);
    assert.equal(recovered?.status, "active");
    assert.equal(recovered?.nextCheckAt, time.after(300));
  });
});

test("404 stops the source and it is never claimed again", async () => {
  await withStore(async (store, time) => {
    store.create(createInput(time.now));
    await runPollTick({ store, config: CONFIG, now: time.now, fetch: fetcher(() => new Response("gone", { status: 404 })) });
    const source = store.list("C1")[0]?.source;
    assert.equal(source?.status, "stopped");
    assert.equal(source?.lastError, "WATCH_SOURCE_GONE");
    time.advance(86_400);
    assert.equal(store.claimDue(time.iso(), 3, 120).length, 0);
  });
});

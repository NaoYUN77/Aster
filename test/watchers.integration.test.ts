import assert from "node:assert/strict";
import test from "node:test";
import { createWatchers } from "../src/watchers/index.js";
import type { WatchersConfig } from "../src/watchers/protocol.js";
import { SqliteWatchStore } from "../src/watchers/store.js";
import { RSS, clock, createInput, jsonResponse, textResponse } from "./watchers.testkit.js";

const NEW_ITEMS = `
  <item><title>Third</title><link>https://example.com/third</link><guid>post-3</guid></item>
  <item><title>Fourth</title><link>https://example.com/fourth</link><guid>post-4</guid></item>`;

function config(overrides: Partial<WatchersConfig> = {}): WatchersConfig {
  return {
    enabled: true,
    maxActive: 10,
    maxPerHour: 10,
    feedIntervalSec: 300,
    xIntervalSec: 300,
    githubReconcileMin: 10,
    fetchTimeoutMs: 5_000,
    ...overrides,
  };
}

function prPayload(): unknown {
  return {
    repository: { full_name: "owner/repo" },
    action: "closed",
    pull_request: {
      number: 7, state: "closed", merged: true, merge_commit_sha: "sha7",
      merged_at: "2026-11-12T02:00:00Z", closed_at: "2026-11-12T02:00:00Z",
      html_url: "https://github.com/owner/repo/pull/7",
    },
  };
}

test("a feed watcher delivers one line per new entry and never twice", async () => {
  const store = new SqliteWatchStore(":memory:");
  const time = clock();
  try {
    store.create(createInput(time.now));
    let feed = RSS;
    const delivered: string[] = [];
    const runtime = createWatchers({
      store,
      config: config(),
      now: time.now,
      deliver: async (_chatId, text) => {
        delivered.push(text);
        return `m${delivered.length}`;
      },
      fetch: (async () => textResponse(feed)) as typeof fetch,
    });

    const baseline = await runtime.tickOnce();
    assert.equal(baseline.polled, 1);
    assert.equal(delivered.length, 0, "the first check is silent");

    feed = RSS.replace("</channel>", `${NEW_ITEMS}</channel>`);
    time.advance(300);
    const first = await runtime.tickOnce();
    assert.equal(first.delivered, 2);
    assert.equal(delivered.length, 2);
    assert.ok(delivered.every((line) => line.startsWith("[跟踪 #1] ")));
    assert.match(delivered[0] ?? "", /Third/);

    time.advance(300);
    const repeat = await runtime.tickOnce();
    assert.equal(repeat.delivered, 0, "the same entries are deduplicated");
    assert.equal(delivered.length, 2);
  } finally {
    store.close();
  }
});

test("over the hourly cap, the remainder is merged into one count line", async () => {
  const store = new SqliteWatchStore(":memory:");
  const time = clock();
  try {
    store.create(createInput(time.now));
    let feed = RSS;
    const delivered: string[] = [];
    const runtime = createWatchers({
      store,
      config: config({ maxPerHour: 1 }),
      now: time.now,
      deliver: async (_chatId, text) => {
        delivered.push(text);
        return `m${delivered.length}`;
      },
      fetch: (async () => textResponse(feed)) as typeof fetch,
    });
    await runtime.tickOnce();
    feed = RSS.replace("</channel>", `${NEW_ITEMS}</channel>`);
    time.advance(300);
    await runtime.tickOnce();

    assert.equal(delivered.length, 2);
    assert.match(delivered[1] ?? "", /还有 1 条更新/);
    assert.equal(store.pending(10).length, 0, "merged rows are not silently dropped");
  } finally {
    store.close();
  }
});

test("a delivery failure is recorded once and is not retried automatically", async () => {
  const store = new SqliteWatchStore(":memory:");
  const time = clock();
  try {
    store.create(createInput(time.now));
    let feed = RSS;
    let attempts = 0;
    const runtime = createWatchers({
      store,
      config: config(),
      now: time.now,
      deliver: async () => {
        attempts += 1;
        throw new Error("channel refused");
      },
      fetch: (async () => textResponse(feed)) as typeof fetch,
    });
    await runtime.tickOnce();
    feed = RSS.replace("</channel>", `${NEW_ITEMS}</channel>`);
    time.advance(300);
    await runtime.tickOnce();
    assert.equal(attempts, 2);
    assert.equal(store.pending(10).length, 0);

    time.advance(300);
    await runtime.tickOnce();
    assert.equal(attempts, 2, "failed rows stay failed");
  } finally {
    store.close();
  }
});

test("reconcile baselines a push source, then a relay delivery is queued and sent once", async () => {
  const store = new SqliteWatchStore(":memory:");
  const time = clock();
  try {
    store.create(createInput(time.now, {
      kind: "github_pr", target: "owner/repo#7", location: "owner/repo#7", mode: "push", intervalSec: 600,
    }));
    const delivered: string[] = [];
    const runtime = createWatchers({
      store,
      config: config({ relayUrl: "https://relay.example.com", relayToken: "relay-token", githubToken: "github-token" }),
      now: time.now,
      deliver: async (_chatId, text) => {
        delivered.push(text);
        return `m${delivered.length}`;
      },
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/")) return new Response(null, { status: 304 });
        if (url.startsWith("https://relay.example.com/")) {
          return jsonResponse({
            seq: 1,
            events: [{ seq: 1, deliveryId: "d1", event: "pull_request", payload: prPayload() }],
          });
        }
        throw new TypeError("unexpected host");
      }) as typeof fetch,
    });

    // The first reconcile is the baseline: it records the current state silently.
    await runtime.tickOnce();
    assert.equal(delivered.length, 0);

    const relay = await runtime.relayOnce();
    assert.equal(relay.ok, true);
    assert.equal(store.pending(10).length, 1);

    const tick = await runtime.tickOnce();
    assert.equal(tick.delivered, 1);
    assert.match(delivered[0] ?? "", /PR owner\/repo#7 已合并/);

    const again = await runtime.tickOnce();
    assert.equal(again.delivered, 0);
  } finally {
    store.close();
  }
});

test("startup recovers an interrupted send as uncertain instead of resending", async () => {
  const store = new SqliteWatchStore(":memory:");
  const time = clock();
  try {
    const { sourceId } = store.create(createInput(time.now));
    store.claimDue(time.iso(), 3, 120);
    store.finish(sourceId, { events: [] }, time.iso(), time.after(300));
    store.ingest(sourceId, {
      dedupKey: "post-x", kind: "feed", occurredAt: time.iso(),
      facts: { title: "x" }, text: "x",
    }, time.iso());
    const row = store.pending(10)[0];
    assert.ok(row);
    store.claimOutbox(row.id);

    const delivered: string[] = [];
    const runtime = createWatchers({
      store,
      config: config(),
      now: time.now,
      deliver: async (_chatId, text) => {
        delivered.push(text);
        return `m${delivered.length}`;
      },
    });
    runtime.start();
    await runtime.stop();
    assert.equal(delivered.length, 0);
    assert.equal(store.pending(10).length, 0);
  } finally {
    store.close();
  }
});

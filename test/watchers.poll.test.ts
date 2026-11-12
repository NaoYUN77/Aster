import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DeliveryChannel } from "../src/channel.js";
import type { CreateWatcherInput, SourceCheck, SourceRow, WatchersConfig, WatchEventInput } from "../src/watchers/protocol.js";
import { backoffSeconds, runPollTick, type SourceResolver } from "../src/watchers/poll.js";
import { WatcherError, WatcherStore } from "../src/watchers/store.js";

const NOW = "2026-11-12T00:00:00.000Z";

function config(overrides: Partial<WatchersConfig> = {}): WatchersConfig {
  return {
    enabled: true,
    maxActive: 10,
    maxPerHour: 10,
    feedIntervalSec: 900,
    xIntervalSec: 900,
    githubReconcileMin: 15,
    fetchTimeoutMs: 5_000,
    ...overrides,
  };
}

function watcherInput(overrides: Partial<CreateWatcherInput> = {}): CreateWatcherInput {
  return {
    chatId: "C1",
    kind: "feed",
    target: "https://example.com/feed.xml",
    label: "Example feed",
    location: "https://example.com/feed.xml",
    mode: "poll",
    intervalSec: 900,
    now: NOW,
    ...overrides,
  };
}

function event(key: string, overrides: Partial<WatchEventInput> = {}): WatchEventInput {
  return {
    dedupKey: key,
    kind: "feed",
    occurredAt: NOW,
    facts: { title: key },
    text: `[跟踪 #1] ${key}`,
    ...overrides,
  };
}

type Sent = { readonly target: string; readonly text: string; readonly threadTs: string | undefined };

class RecordingChannel implements DeliveryChannel {
  readonly label = "test";
  readonly sent: Sent[] = [];
  outcome: "failed" | "uncertain" | undefined;

  async send(target: string, text: string, _signal: AbortSignal, threadTs?: string): Promise<string> {
    if (this.outcome !== undefined) throw new Error("channel refused");
    this.sent.push({ target, text, threadTs });
    return `m${this.sent.length}`;
  }

  classifyFailure(): "failed" | "uncertain" {
    return this.outcome ?? "failed";
  }

  failureCode(): string {
    return "WATCH_DELIVERY_FAILED";
  }
}

function adapter(check: (source: SourceRow) => Promise<{ events: WatchEventInput[] }>): SourceCheck {
  return { check: (source) => check(source) };
}

async function withStore(run: (store: WatcherStore) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "aster-watchers-poll-"));
  const store = new WatcherStore(join(directory, "watchers.sqlite"));
  try {
    await run(store);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

class Clock {
  #time = Date.parse(NOW);
  readonly now = (): Date => new Date(this.#time);
  get iso(): string {
    return new Date(this.#time).toISOString();
  }
  advance(seconds: number): void {
    this.#time += seconds * 1_000;
  }
}

test("backoff is 1x, 2x, 4x … capped at an hour", () => {
  assert.equal(backoffSeconds(900, 0), 900);
  assert.equal(backoffSeconds(900, 1), 1_800);
  assert.equal(backoffSeconds(900, 2), 3_600);
  assert.equal(backoffSeconds(900, 3), 3_600);
  assert.equal(backoffSeconds(60, 0), 60);
  assert.equal(backoffSeconds(60, 5), 1_920);
  assert.equal(backoffSeconds(10, 20), 3_600);
});

test("the first check only baselines, and a later key is delivered once", async () => {
  await withStore(async (store) => {
    const clock = new Clock();
    const channel = new RecordingChannel();
    store.create(watcherInput());
    let entries = [event("a"), event("b")];
    const logs: string[] = [];
    const sources: SourceResolver = () => adapter(async () => ({ events: entries }));
    const tick = () => runPollTick({
      store, config: config(), sourceFor: sources, channel, signal: new AbortController().signal,
      now: clock.now, log: (line) => logs.push(line),
    });

    const first = await tick();
    assert.equal(first.checked, 1);
    assert.equal(first.queued, 0);
    assert.equal(store.pending(10).length, 0);
    assert.equal(channel.sent.length, 0);

    clock.advance(900);
    entries = [event("a"), event("b"), event("c")];
    const second = await tick();
    assert.equal(second.queued, 1);

    clock.advance(900);
    const third = await tick();
    assert.equal(third.queued, 0);
    assert.equal(third.delivered, 1);
    assert.deepEqual(channel.sent, [{ target: "C1", text: "[跟踪 #1] c", threadTs: undefined }]);
    assert.equal(store.pending(10).length, 0);

    // Re-observing the same key never queues another line.
    clock.advance(900);
    await tick();
    assert.equal(channel.sent.length, 1);
    assert.equal(logs.some((line) => line.includes("events=")), true);
    assert.equal(logs.join("\n").includes("example.com"), false);
  });
});

test("a baseline that failed does not flood after recovery", async () => {
  await withStore(async (store) => {
    const clock = new Clock();
    const channel = new RecordingChannel();
    store.create(watcherInput());
    let mode: "fail" | "ok" = "fail";
    let entries = [event("a"), event("b"), event("c")];
    const sources: SourceResolver = () => adapter(async () => {
      if (mode === "fail") throw new WatcherError("WATCH_FETCH_TIMEOUT", "down");
      return { events: entries };
    });
    const tick = () => runPollTick({
      store, config: config(), sourceFor: sources, channel, signal: new AbortController().signal, now: clock.now,
    });

    await tick();
    let source = store.list("C1")[0]!.source;
    assert.equal(source.failures, 1);
    assert.equal(source.status, "backoff");
    assert.equal(source.lastCheckAt, null);
    assert.equal(source.nextCheckAt, new Date(Date.parse(NOW) + 900_000).toISOString());

    clock.advance(900);
    await tick();
    source = store.list("C1")[0]!.source;
    assert.equal(source.failures, 2);
    assert.equal(source.nextCheckAt, new Date(Date.parse(NOW) + 2_700_000).toISOString());

    clock.advance(1_800);
    mode = "ok";
    const recovered = await tick();
    assert.equal(recovered.queued, 0);
    assert.equal(store.pending(10).length, 0);
    source = store.list("C1")[0]!.source;
    assert.equal(source.failures, 0);
    assert.equal(source.status, "active");

    clock.advance(900);
    entries = [event("a"), event("b"), event("c"), event("d")];
    const later = await tick();
    assert.equal(later.queued, 1);
    assert.equal(store.pending(10).length, 1);
  });
});

test("five failures become an hourly error probe and a 404 stops the source", async () => {
  await withStore(async (store) => {
    const clock = new Clock();
    store.create(watcherInput({ intervalSec: 60 }));
    const sources: SourceResolver = () => adapter(async () => {
      throw new WatcherError("WATCH_FETCH_TIMEOUT", "down");
    });
    const tick = () => runPollTick({
      store, config: config(), sourceFor: sources, signal: new AbortController().signal, now: clock.now,
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      await tick();
      clock.advance(Math.min(60 * 2 ** attempt, 3_600));
    }
    const source = store.list("C1")[0]!.source;
    assert.equal(source.failures, 5);
    assert.equal(source.status, "error");
    assert.equal(source.lastError, "WATCH_FETCH_TIMEOUT");
    // Still claimable at the hourly cadence.
    clock.advance(3_600);
    assert.equal(store.claimDue(clock.iso, 3, 60).length, 1);

    const gone = store.create(watcherInput({
      chatId: "C2", target: "https://example.com/gone.xml", location: "https://example.com/gone.xml", intervalSec: 60,
    }));
    const goneSources: SourceResolver = () => adapter(async () => {
      throw new WatcherError("WATCH_SOURCE_GONE", "gone");
    });
    assert.equal(gone.sourceId > 0, true);
    const stoppedTick = await runPollTick({
      store, config: config(), sourceFor: goneSources, signal: new AbortController().signal, now: clock.now,
    });
    assert.equal(stoppedTick.skipped, 0);
    const stopped = store.list("C2")[0]!.source;
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.nextCheckAt, null);
  });
});

test("a source with no adapter backs off instead of crashing the tick", async () => {
  await withStore(async (store) => {
    const clock = new Clock();
    store.create(watcherInput());
    const result = await runPollTick({
      store, config: config(), sourceFor: () => undefined, signal: new AbortController().signal, now: clock.now,
    });
    assert.equal(result.failed, 1);
    const source = store.list("C1")[0]!.source;
    assert.equal(source.lastError, "WATCH_TARGET_INVALID");
    assert.equal(source.status, "backoff");
  });
});

test("a row interrupted mid-send is never delivered after recovery", async () => {
  await withStore(async (store) => {
    const clock = new Clock();
    const channel = new RecordingChannel();
    const { sourceId } = store.create(watcherInput());
    store.ingest(sourceId, event("a"), NOW);
    const row = store.pending(10)[0]!;
    assert.equal(store.claimOutbox(row.id), true);

    await runPollTick({
      store, config: config(), sourceFor: () => undefined, channel, signal: new AbortController().signal, now: clock.now,
    });
    assert.equal(channel.sent.length, 0);

    assert.equal(store.recoverInterrupted(clock.iso), 1);
    await runPollTick({
      store, config: config(), sourceFor: () => undefined, channel, signal: new AbortController().signal, now: clock.now,
    });
    assert.equal(channel.sent.length, 0);
    assert.equal(store.pending(10).length, 0);
  });
});

test("delivery failure is terminal and a rejection is classified as uncertain", async () => {
  await withStore(async (store) => {
    const clock = new Clock();
    const channel = new RecordingChannel();
    channel.outcome = "uncertain";
    const { sourceId } = store.create(watcherInput());
    store.ingest(sourceId, event("a"), NOW);
    await runPollTick({
      store, config: config(), sourceFor: () => undefined, channel, signal: new AbortController().signal, now: clock.now,
    });
    assert.equal(store.pending(10).length, 0);
    assert.equal(store.sentCount("C1", new Date(Date.parse(NOW) - 3_600_000).toISOString()), 0);

    channel.outcome = undefined;
    await runPollTick({
      store, config: config(), sourceFor: () => undefined, channel, signal: new AbortController().signal, now: clock.now,
    });
    assert.equal(channel.sent.length, 0);
  });
});

test("the hourly budget merges the rest of a chat's queue into one message", async () => {
  await withStore(async (store) => {
    const clock = new Clock();
    const channel = new RecordingChannel();
    const { sourceId } = store.create(watcherInput());
    for (const key of ["a", "b", "c"]) store.ingest(sourceId, event(key), NOW);
    await runPollTick({
      store, config: config({ maxPerHour: 1 }), sourceFor: () => undefined, channel,
      signal: new AbortController().signal, now: clock.now,
    });
    assert.deepEqual(channel.sent.map((entry) => entry.text), ["[跟踪 #1] a", "[跟踪] 还有 2 条更新"]);
    assert.equal(store.pending(10).length, 0);

    for (const key of ["d", "e"]) store.ingest(sourceId, event(key), NOW);
    await runPollTick({
      store, config: config({ maxPerHour: 1 }), sourceFor: () => undefined, channel,
      signal: new AbortController().signal, now: clock.now,
    });
    assert.deepEqual(channel.sent.at(-1)?.text, "[跟踪] 还有 2 条更新");
    assert.equal(channel.sent.length, 3);
  });
});

test("one tick claims at most three due sources", async () => {
  await withStore(async (store) => {
    const clock = new Clock();
    for (let index = 0; index < 5; index++) {
      store.create(watcherInput({
        chatId: `C${index}`,
        target: `https://example.com/${index}.xml`,
        location: `https://example.com/${index}.xml`,
      }));
    }
    const sources: SourceResolver = () => adapter(async () => ({ events: [] }));
    const first = await runPollTick({
      store, config: config(), sourceFor: sources, signal: new AbortController().signal, now: clock.now,
    });
    assert.equal(first.checked, 3);
    clock.advance(1);
    const second = await runPollTick({
      store, config: config(), sourceFor: sources, signal: new AbortController().signal, now: clock.now,
    });
    assert.equal(second.checked, 2);
  });
});

test("shutdown mid-tick records no failure for the aborted source", async () => {
  await withStore(async (store) => {
    const clock = new Clock();
    store.create(watcherInput());
    const controller = new AbortController();
    const sources: SourceResolver = () => ({
      check: async () => {
        controller.abort();
        throw new WatcherError("WATCH_FETCH_TIMEOUT", "cancelled");
      },
    });
    const result = await runPollTick({
      store, config: config(), sourceFor: sources, signal: controller.signal, now: clock.now,
    });
    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 1);
    assert.equal(store.list("C1")[0]!.source.failures, 0);
  });
});

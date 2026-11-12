import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WATCH_SCHEMA_SQL, type CreateWatcherInput, type WatchEventInput } from "../src/watchers/protocol.js";
import { WatcherError, WatcherStore } from "../src/watchers/store.js";

const NOW = "2026-11-12T00:00:00.000Z";

function at(offsetSeconds: number): string {
  return new Date(Date.parse(NOW) + offsetSeconds * 1_000).toISOString();
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

async function withStore(
  run: (store: WatcherStore, path: string) => Promise<void> | void,
  options: { readonly maxActive?: number } = {},
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "aster-watchers-store-"));
  const path = join(directory, "watchers.sqlite");
  const store = new WatcherStore(path, options);
  try {
    await run(store, path);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function code(error: unknown): string | undefined {
  return error instanceof WatcherError ? error.code : undefined;
}

function rejected(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return code(error);
  }
  assert.fail("expected the operation to be rejected");
}

test("the created schema matches the protocol DDL statement for statement", async () => {
  await withStore(async (store, path) => {
    const { DatabaseSync } = await import("node:sqlite");
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = reader.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all() as { name: string; sql: string }[];
      assert.deepEqual(rows.map((row) => row.name), [
        "events", "outbox", "sources", "sources_due", "watchers", "watchers_live",
      ]);
      const normalize = (sql: string): string => sql.replace(/\bIF\s+NOT\s+EXISTS\s+/i, "").replace(/\s+/g, " ").trim();
      const expected = new Map<string, string>();
      for (const statement of WATCH_SCHEMA_SQL) {
        const name = /CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(statement)?.[1];
        assert.ok(name !== undefined, `statement has no name: ${statement.slice(0, 40)}`);
        expected.set(name, normalize(statement));
      }
      for (const row of rows) {
        assert.equal(normalize(row.sql), expected.get(row.name), `${row.name} DDL drifted from protocol.ts`);
      }
    } finally {
      reader.close();
    }
  });
});

test("create stores one due poll source and refuses a live duplicate", async () => {
  await withStore(async (store) => {
    const created = store.create(watcherInput());
    assert.ok(created.watcherId > 0);
    const listed = store.list("C1");
    assert.equal(listed.length, 1);
    const entry = listed[0]!;
    assert.equal(entry.id, created.watcherId);
    assert.equal(entry.kind, "feed");
    assert.equal(entry.status, "active");
    assert.equal(entry.maxEventsPerHour, 10);
    assert.equal(entry.source.id, created.sourceId);
    assert.equal(entry.source.mode, "poll");
    assert.equal(entry.source.nextCheckAt, NOW);
    assert.equal(entry.source.reconcileAt, null);

    assert.equal(rejected(() => store.create(watcherInput())), "WATCH_DUPLICATE");
    // Another chat may watch the same target.
    assert.doesNotThrow(() => store.create(watcherInput({ chatId: "C2" })));
    assert.equal(store.list("C2").length, 1);

    assert.equal(store.stop("C1", created.watcherId, at(60)), true);
    assert.equal(store.stop("C1", created.watcherId, at(60)), false);
    assert.equal(store.list("C1").length, 0);
    // The partial unique index only covers live rows, so the same target can be watched again.
    assert.doesNotThrow(() => store.create(watcherInput({ now: at(120) })));
    const stopped = store.listAll().find((row) => row.id === created.watcherId);
    assert.equal(stopped?.status, "stopped");
    assert.equal(stopped?.source.status, "stopped");
    assert.equal(stopped?.source.nextCheckAt, null);
  });
});

test("create refuses beyond maxActive live watchers", async () => {
  await withStore(async (store) => {
    store.create(watcherInput());
    assert.equal(
      rejected(() => store.create(watcherInput({ target: "https://example.com/two.xml", location: "https://example.com/two.xml" }))),
      "WATCH_LIMIT_EXCEEDED",
    );
  }, { maxActive: 1 });
});

test("claimDue hands each source to exactly one pass for the lease window", async () => {
  await withStore(async (store) => {
    const first = store.create(watcherInput());
    const second = store.create(watcherInput({
      chatId: "C2", target: "https://example.com/b.xml", location: "https://example.com/b.xml", now: at(-60),
    }));
    const claimed = store.claimDue(NOW, 3, 60);
    assert.equal(claimed.length, 2);
    assert.deepEqual(claimed.map((row) => row.id).sort(), [first.sourceId, second.sourceId].sort());
    assert.equal(claimed[0]!.nextCheckAt, at(60));
    assert.equal(store.claimDue(NOW, 3, 60).length, 0);
    assert.equal(store.claimDue(at(59), 3, 60).length, 0);
    assert.equal(store.claimDue(at(60), 3, 60).length, 2);

    store.stop("C1", first.watcherId, at(60));
    const afterStop = store.claimDue(at(120), 3, 60);
    assert.deepEqual(afterStop.map((row) => row.id), [second.sourceId]);
  });
});

test("the first successful check is a baseline; only later keys queue messages", async () => {
  await withStore(async (store) => {
    const { sourceId } = store.create(watcherInput());
    assert.equal(store.finish(sourceId, { events: [event("a"), event("b")], state: { etag: "\"one\"" } }, NOW, at(900)), 0);
    assert.equal(store.pending(10).length, 0);
    const baseline = store.list("C1")[0]!;
    assert.equal(baseline.source.etag, "\"one\"");
    assert.equal(baseline.source.lastCheckAt, NOW);
    assert.equal(baseline.source.failures, 0);

    assert.equal(store.finish(sourceId, { events: [event("a"), event("b"), event("c")] }, at(900), at(1800)), 1);
    const pending = store.pending(10);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.text, "[跟踪 #1] c");

    // A repeated key never queues a second message, whichever path observed it.
    assert.equal(store.finish(sourceId, { events: [event("c")] }, at(1800), at(2700)), 0);
    assert.equal(store.ingest(sourceId, event("c"), at(1800)), false);
    assert.equal(store.pending(10).length, 1);

    // A 304-shaped empty result keeps the stored validator instead of clearing it.
    assert.equal(store.finish(sourceId, { events: [] }, at(2700), at(3600)), 0);
    assert.equal(store.list("C1")[0]!.source.etag, "\"one\"");
  });
});

test("fail walks 1x/2x/4x to error, and a gone source stops for good", async () => {
  await withStore(async (store) => {
    const { sourceId } = store.create(watcherInput());
    const waits = [900, 1_800, 3_600, 3_600, 3_600];
    for (const [index, wait] of waits.entries()) {
      store.fail(sourceId, "WATCH_FETCH_TIMEOUT", at(0), at(wait));
      const row = store.list("C1")[0]!.source;
      assert.equal(row.failures, index + 1);
      assert.equal(row.status, index + 1 >= 5 ? "error" : "backoff");
      assert.equal(row.nextCheckAt, at(wait));
      assert.equal(row.lastError, "WATCH_FETCH_TIMEOUT");
      // A failed attempt is not a successful check: the source is still establishing its baseline.
      assert.equal(row.lastCheckAt, null);
    }
    // An error source is still claimable: it keeps a hourly probe.
    assert.equal(store.claimDue(at(3_600), 3, 60).length, 1);

    // A successful check clears the counters and returns the source to active.
    store.finish(sourceId, { events: [] }, at(3_600), at(4_500));
    const recovered = store.list("C1")[0]!.source;
    assert.equal(recovered.failures, 0);
    assert.equal(recovered.status, "active");
    assert.equal(recovered.lastError, null);

    const gone = store.create(watcherInput({ chatId: "C2", target: "https://example.com/gone.xml", location: "https://example.com/gone.xml" }));
    store.fail(gone.sourceId, "WATCH_SOURCE_GONE", NOW, at(900));
    const stopped = store.list("C2")[0]!.source;
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.nextCheckAt, null);
    assert.equal(store.claimDue(at(86_400), 3, 60).some((row) => row.id === gone.sourceId), false);
  });
});

test("outbox transitions are conditional and a crash leaves uncertain, never a resend", async () => {
  await withStore(async (store) => {
    const { sourceId } = store.create(watcherInput());
    assert.equal(store.ingest(sourceId, event("a"), NOW), true);
    assert.equal(store.ingest(sourceId, event("b"), NOW), true);
    const [first, second] = store.pending(10);
    assert.ok(first !== undefined && second !== undefined);

    assert.equal(store.claimOutbox(first.id), true);
    assert.equal(store.claimOutbox(first.id), false);
    // Simulate a crash between `sending` and the channel's answer.
    assert.equal(store.recoverInterrupted(at(60)), 1);
    const remaining = store.pending(10);
    assert.deepEqual(remaining.map((row) => row.id), [second.id]);
    assert.throws(() => store.sent(first.id, "m1", at(60)), (error) => code(error) === "WATCH_STORE_ERROR");

    assert.equal(store.claimOutbox(second.id), true);
    store.sent(second.id, "m2", at(60));
    assert.equal(store.pending(10).length, 0);
    assert.equal(store.sentCount("C1", at(0)), 1);
    assert.equal(store.sentCount("C1", at(61)), 0);

    assert.equal(store.ingest(sourceId, event("c"), at(120)), true);
    const third = store.pending(10)[0]!;
    assert.equal(store.claimOutbox(third.id), true);
    store.failed(third.id, "WATCH_DELIVERY_UNCERTAIN", at(120), true);
    assert.equal(store.pending(10).length, 0);
  });
});

test("dueReconcile claims push sources and advances by their own interval", async () => {
  await withStore(async (store) => {
    const { sourceId } = store.create(watcherInput({
      kind: "github_pr",
      target: "o/r#1",
      location: "o/r#1",
      mode: "push",
      intervalSec: 900,
    }));
    const due = store.dueReconcile(NOW, 10);
    assert.deepEqual(due.map((row) => row.id), [sourceId]);
    assert.equal(due[0]!.mode, "push");
    assert.equal(due[0]!.nextCheckAt, null);
    assert.equal(due[0]!.reconcileAt, at(900));
    assert.equal(store.dueReconcile(NOW, 10).length, 0);
    assert.equal(store.dueReconcile(at(900), 10).length, 1);
    // Poll sources are never handed to the reconcile path.
    store.create(watcherInput({ chatId: "C2", target: "https://example.com/f.xml", location: "https://example.com/f.xml" }));
    const reconcile = store.dueReconcile(at(1_800), 10);
    assert.deepEqual(reconcile.map((row) => row.mode), ["push"]);
  });
});

test("an operator view can be opened read-only without touching state", async () => {
  await withStore(async (store, path) => {
    store.create(watcherInput());
    const readOnly = new WatcherStore(path, { readOnly: true });
    try {
      assert.equal(readOnly.listAll().length, 1);
      assert.throws(() => readOnly.create(watcherInput({
        target: "https://example.com/z.xml", location: "https://example.com/z.xml",
      })));
    } finally {
      readOnly.close();
    }
  });
});

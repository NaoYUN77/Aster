import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WATCH_SCHEMA_SQL } from "../src/watchers/protocol.js";
import { SqliteWatchStore, WatchError } from "../src/watchers/store.js";
import { clock, createInput, eventInput } from "./watchers.testkit.js";

function withStore(run: (store: SqliteWatchStore) => void): void {
  const store = new SqliteWatchStore(":memory:");
  try {
    run(store);
  } finally {
    store.close();
  }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof WatchError ? error.code : undefined;
}

test("schema matches the protocol DDL: every table, column and index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-watchers-"));
  const path = join(directory, "watchers.sqlite");
  try {
    const store = new SqliteWatchStore(path);
    store.close();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
        .map((row) => row.name)
        .filter((name) => !name.startsWith("sqlite_")));
      assert.deepEqual([...tables].sort(), ["events", "outbox", "sources", "watchers"]);
      const columns = (table: string): string[] => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .map((row) => row.name);
      assert.deepEqual(columns("watchers"),
        ["id", "chat_id", "thread_ts", "kind", "target", "label", "status", "max_events_per_hour", "created_at", "stopped_at"]);
      assert.deepEqual(columns("sources"),
        ["id", "watcher_id", "kind", "location", "mode", "status", "interval_sec", "next_check_at", "reconcile_at",
          "etag", "last_modified", "cursor", "failures", "last_error", "last_check_at"]);
      assert.deepEqual(columns("events"),
        ["id", "source_id", "dedup_key", "delivery_id", "kind", "occurred_at", "received_at", "facts"]);
      assert.deepEqual(columns("outbox"),
        ["id", "watcher_id", "event_id", "chat_id", "thread_ts", "text", "status", "attempts", "message_id",
          "created_at", "sent_at", "failure_code"]);
      const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as { name: string }[])
        .map((row) => row.name).sort();
      assert.deepEqual(indexes, ["sources_due", "watchers_live"]);
      assert.equal(WATCH_SCHEMA_SQL.length, 6);
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the first successful check is a silent baseline; later checks only queue new keys", () => {
  withStore((store) => {
    const time = clock();
    const { sourceId } = store.create(createInput(time.now));
    const claimed = store.claimDue(time.iso(), 3, 120);
    assert.equal(claimed.length, 1);
    assert.equal(store.finish(sourceId, { events: [eventInput("a"), eventInput("b")] }, time.iso(), time.after(300)), 0);
    assert.equal(store.pending(10).length, 0);

    time.advance(300);
    assert.equal(store.claimDue(time.iso(), 3, 120).length, 1);
    assert.equal(store.finish(sourceId, { events: [eventInput("a"), eventInput("b"), eventInput("c")] }, time.iso(), time.after(300)), 1);
    const pending = store.pending(10);
    assert.equal(pending.length, 1);
    assert.match(pending[0]?.text ?? "", /^\[跟踪 #1\] entry c$/);
  });
});

test("a duplicate dedup key is stored once and delivered once", () => {
  withStore((store) => {
    const time = clock();
    const { sourceId } = store.create(createInput(time.now));
    store.claimDue(time.iso(), 3, 120);
    store.finish(sourceId, { events: [] }, time.iso(), time.after(300));
    assert.equal(store.ingest(sourceId, eventInput("same"), time.iso()), true);
    assert.equal(store.ingest(sourceId, eventInput("same"), time.iso()), false);
    assert.equal(store.pending(10).length, 1);
    assert.equal(store.ingest(sourceId, eventInput("other"), time.iso()), true);
    assert.equal(store.pending(10).length, 2);
  });
});

test("a baseline failure does not complete the baseline, so recovery cannot flood", () => {
  withStore((store) => {
    const time = clock();
    const { sourceId } = store.create(createInput(time.now));
    store.claimDue(time.iso(), 3, 120);
    store.fail(sourceId, "WATCH_FETCH_TIMEOUT", time.iso(), time.after(300));
    assert.equal(store.list("C1")[0]?.source.lastCheckAt, null);
    time.advance(300);
    assert.equal(store.claimDue(time.iso(), 3, 120).length, 1);
    // The recovered first success still records only seen keys.
    assert.equal(store.finish(sourceId, { events: [eventInput("old-1"), eventInput("old-2")] }, time.iso(), time.after(300)), 0);
    assert.equal(store.pending(10).length, 0);
  });
});

test("claims are exclusive until the lease expires", () => {
  withStore((store) => {
    const time = clock();
    store.create(createInput(time.now, { target: "https://example.com/a.xml", location: "https://example.com/a.xml" }));
    store.create(createInput(time.now, { target: "https://example.com/b.xml", location: "https://example.com/b.xml" }));
    const first = store.claimDue(time.iso(), 1, 120);
    assert.equal(first.length, 1);
    const second = store.claimDue(time.iso(), 3, 120);
    assert.equal(second.length, 1);
    assert.notEqual(first[0]?.id, second[0]?.id);
    assert.equal(store.claimDue(time.iso(), 3, 120).length, 0);
  });
});

test("failure backoff reaches error after five attempts; 404 stops the source", () => {
  withStore((store) => {
    const time = clock();
    const { sourceId } = store.create(createInput(time.now));
    const statuses: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal(store.claimDue(time.iso(), 3, 120).length, 1);
      store.fail(sourceId, "WATCH_FETCH_TIMEOUT", time.iso(), time.after(300));
      statuses.push(store.list("C1")[0]?.source.status ?? "");
      time.advance(300);
    }
    assert.deepEqual(statuses, ["backoff", "backoff", "backoff", "backoff", "error"]);
    const source = store.list("C1")[0]?.source;
    assert.equal(source?.failures, 5);
    assert.equal(source?.lastError, "WATCH_FETCH_TIMEOUT");

    store.fail(sourceId, "WATCH_SOURCE_GONE", time.iso(), time.after(300));
    assert.equal(store.list("C1")[0]?.source.status, "stopped");
    time.advance(3_600);
    assert.equal(store.claimDue(time.iso(), 3, 120).length, 0);
  });
});

test("stop is idempotent and frees the live target for a new watcher", () => {
  withStore((store) => {
    const time = clock();
    const created = store.create(createInput(time.now));
    assert.throws(
      () => store.create(createInput(time.now)),
      (error) => codeOf(error) === "WATCH_DUPLICATE",
    );
    assert.equal(store.stop("C1", created.watcherId, time.iso()), true);
    assert.equal(store.stop("C1", created.watcherId, time.iso()), false);
    assert.equal(store.stop("OTHER", created.watcherId, time.iso()), false);
    assert.equal(store.list("C1").length, 0);
    assert.doesNotThrow(() => store.create(createInput(time.now)));
  });
});

test("an interrupted send becomes uncertain and is never pending again", () => {
  withStore((store) => {
    const time = clock();
    const { sourceId } = store.create(createInput(time.now));
    store.claimDue(time.iso(), 3, 120);
    store.finish(sourceId, { events: [] }, time.iso(), time.after(300));
    store.ingest(sourceId, eventInput("x"), time.iso());
    const row = store.pending(10)[0];
    assert.ok(row);
    assert.equal(store.claimOutbox(row.id), true);
    assert.equal(store.claimOutbox(row.id), false);
    assert.equal(store.recoverInterrupted(time.iso()), 1);
    assert.equal(store.pending(10).length, 0);
    const all = store.listAll();
    assert.equal(all.length, 1);
  });
});

test("a push source is due for reconcile immediately, and only once per lease", () => {
  withStore((store) => {
    const time = clock();
    store.create(createInput(time.now, {
      kind: "github_pr",
      target: "owner/repo#7",
      location: "owner/repo#7",
      mode: "push",
      intervalSec: 600,
    }));
    const first = store.dueReconcile(time.iso(), 3);
    assert.equal(first.length, 1);
    assert.equal(first[0]?.mode, "push");
    assert.equal(first[0]?.nextCheckAt, null);
    assert.equal(store.dueReconcile(time.iso(), 3).length, 0);
    assert.equal(store.claimDue(time.iso(), 3, 120).length, 0);
  });
});

test("relay cursor is shared across push sources and resets as one value", () => {
  withStore((store) => {
    const time = clock();
    store.create(createInput(time.now, { kind: "github_run", target: "owner/repo", location: "owner/repo", mode: "push", intervalSec: 600 }));
    store.create(createInput(time.now, { kind: "github_events", target: "owner/other", location: "owner/other", mode: "push", intervalSec: 600 }));
    assert.equal(store.relayCursor(), null);
    store.advanceRelay("10", time.iso());
    assert.equal(store.relayCursor(), "10");
    store.resetRelayCursor();
    assert.equal(store.relayCursor(), null);
  });
});

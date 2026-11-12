import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
// @ts-expect-error -- worker.js is the untyped deployment module under test
import relayWorker from "../relay/worker.js";
import { GithubWatchError, type GithubDraft } from "../src/watchers/github.js";
import {
  createRelayCheck,
  createRelayPull,
  nextBackoffAt,
  processSource,
  RelayError,
} from "../src/watchers/relay.js";
import { runReconcile } from "../src/watchers/reconcile.js";
import {
  WATCH_SCHEMA_SQL,
  type CreateWatcherInput,
  type OutboxRow,
  type SourceCheckResult,
  type SourceRow,
  type WatchEventInput,
  type WatchStore,
} from "../src/watchers/protocol.js";

const worker = relayWorker as {
  fetch(request: Request, env: WorkerEnv): Promise<Response>;
  scheduled(controller: unknown, env: WorkerEnv, context: unknown): Promise<void>;
};

type WorkerEnv = { DB: FakeD1; WEBHOOK_SECRET?: string; RELAY_TOKEN?: string };

/** Minimal in-memory WatchStore mirroring the documented semantics: `finish` inserts without the
 * outbox, `ingest` dedups by key and queues delivery, `dueReconcile` claims by advancing. */
class MemoryWatchStore implements WatchStore {
  /** Mutable rows: the store mutates state internally; reads expose `SourceRow`. */
  readonly sources: ({ -readonly [K in keyof SourceRow]: SourceRow[K] } & { chatId: string; threadTs: string | null })[] = [];
  readonly events: { sourceId: number; dedupKey: string; deliveryId: string | null; kind: string; occurredAt: string; receivedAt: string; facts: WatchEventInput["facts"]; text: string }[] = [];
  readonly outbox: ({ -readonly [K in keyof OutboxRow]: OutboxRow[K] } & { messageId: string | null; sentAt: string | null; failureCode: string | null })[] = [];
  #nextWatcherId = 1;
  #nextSourceId = 1;
  #nextEventId = 1;
  #nextOutboxId = 1;

  create(input: CreateWatcherInput): { readonly watcherId: number; readonly sourceId: number } {
    const watcherId = this.#nextWatcherId++;
    const sourceId = this.#nextSourceId++;
    this.sources.push({
      id: sourceId, watcherId, chatId: input.chatId, threadTs: input.threadTs ?? null,
      kind: input.kind, location: input.location, mode: input.mode, status: "active",
      intervalSec: input.intervalSec, nextCheckAt: null, reconcileAt: input.mode === "push" ? input.now : null,
      etag: null, lastModified: null, cursor: null, failures: 0, lastError: null, lastCheckAt: null,
    });
    return { watcherId, sourceId };
  }

  list(chatId: string) {
    return this.sources.filter((source) => source.chatId === chatId).map((source) => ({
      id: source.id, chatId: source.chatId, threadTs: source.threadTs, kind: source.kind,
      target: source.location, label: source.location, status: source.status, maxEventsPerHour: 10,
      createdAt: "", stoppedAt: null, source,
    }));
  }

  stop(chatId: string, watcherId: number, _now: string): boolean {
    const source = this.sources.find((entry) => entry.watcherId === watcherId && entry.chatId === chatId && entry.status !== "stopped");
    if (!source) return false;
    source.status = "stopped";
    return true;
  }

  claimDue(_now: string, _limit: number, _leaseSeconds: number) { return []; }

  finish(sourceId: number, result: SourceCheckResult, now: string, nextCheckAt: string): number {
    const source = this.sources.find((entry) => entry.id === sourceId);
    assert.ok(source, `unknown source ${sourceId}`);
    let added = 0;
    for (const event of result.events) {
      if (this.events.some((entry) => entry.sourceId === sourceId && entry.dedupKey === event.dedupKey)) continue;
      this.events.push({
        sourceId, dedupKey: event.dedupKey, deliveryId: event.deliveryId ?? null, kind: event.kind,
        occurredAt: event.occurredAt, receivedAt: now, facts: event.facts, text: event.text,
      });
      added += 1;
    }
    const state = result.state ?? {};
    if (state.etag !== undefined) source.etag = state.etag ?? null;
    if (state.lastModified !== undefined) source.lastModified = state.lastModified ?? null;
    if (state.cursor !== undefined) source.cursor = state.cursor ?? null;
    source.nextCheckAt = nextCheckAt;
    source.lastCheckAt = now;
    source.failures = 0;
    source.status = "active";
    return added;
  }

  fail(sourceId: number, code: string, now: string, nextCheckAt: string): void {
    const source = this.sources.find((entry) => entry.id === sourceId);
    assert.ok(source, `unknown source ${sourceId}`);
    source.failures += 1;
    source.lastError = code;
    source.lastCheckAt = now;
    source.nextCheckAt = nextCheckAt;
    if (code === "WATCH_SOURCE_GONE") source.status = "stopped";
    else source.status = source.failures >= 5 ? "error" : "backoff";
  }

  ingest(sourceId: number, event: WatchEventInput, now: string): boolean {
    const source = this.sources.find((entry) => entry.id === sourceId);
    assert.ok(source, `unknown source ${sourceId}`);
    if (this.events.some((entry) => entry.sourceId === sourceId && entry.dedupKey === event.dedupKey)) return false;
    const eventId = this.#nextEventId++;
    this.events.push({
      sourceId, dedupKey: event.dedupKey, deliveryId: event.deliveryId ?? null, kind: event.kind,
      occurredAt: event.occurredAt, receivedAt: now, facts: event.facts, text: event.text,
    });
    this.outbox.push({
      id: this.#nextOutboxId++, watcherId: source.watcherId, eventId, chatId: source.chatId,
      threadTs: source.threadTs, text: event.text, status: "pending", attempts: 0, createdAt: now,
      messageId: null, sentAt: null, failureCode: null,
    });
    return true;
  }

  pending(limit: number) { return this.outbox.filter((row) => row.status === "pending").slice(0, limit); }

  claimOutbox(id: number): boolean {
    const row = this.outbox.find((entry) => entry.id === id && entry.status === "pending");
    if (!row) return false;
    row.status = "sending";
    row.attempts += 1;
    return true;
  }

  sent(id: number, messageId: string, now: string): void {
    const row = this.outbox.find((entry) => entry.id === id);
    assert.ok(row);
    row.status = "sent";
    row.messageId = messageId;
    row.sentAt = now;
  }

  failed(id: number, code: string, _now: string, uncertain: boolean): void {
    const row = this.outbox.find((entry) => entry.id === id);
    assert.ok(row);
    row.status = uncertain ? "uncertain" : "failed";
    row.failureCode = code;
  }

  recoverInterrupted(now: string): number {
    let count = 0;
    for (const row of this.outbox) {
      if (row.status !== "sending") continue;
      row.status = "uncertain";
      row.failureCode = "PROCESS_INTERRUPTED";
      count += 1;
    }
    void now;
    return count;
  }

  dueReconcile(now: string, limit: number) {
    const due = this.sources
      .filter((source) => source.status !== "stopped" && source.reconcileAt !== null && source.reconcileAt <= now)
      .slice(0, limit);
    for (const source of due) {
      source.reconcileAt = new Date(Date.parse(now) + source.intervalSec * 1000).toISOString();
    }
    return due as SourceRow[];
  }
}

function pushSource(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: 1, watcherId: 3, kind: "github_run", location: "octo/hello", mode: "push", status: "active",
    intervalSec: 30, nextCheckAt: null, reconcileAt: null, etag: null, lastModified: null,
    cursor: null, failures: 0, lastError: null, lastCheckAt: null, ...overrides,
  };
}

function fetchCapture(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const impl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return await handler(url, init);
  }) as unknown as typeof fetch;
  return { calls, fetch: impl };
}

function relayPage(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function envelope(seq: number, event: string, payload: unknown, delivery = `d${seq}`) {
  return { seq, delivery, event, payload };
}

function completedRun(runId: number, conclusion = "success", overrides: Record<string, unknown> = {}) {
  return {
    action: "completed",
    repository: { full_name: "octo/hello" },
    workflow_run: {
      id: runId, name: "CI", head_branch: "main", head_sha: "a".repeat(40), status: "completed",
      conclusion, run_started_at: "2026-11-12T09:00:00Z", updated_at: "2026-11-12T09:05:00Z",
      html_url: `https://github.com/octo/hello/actions/runs/${runId}`, ...overrides,
    },
  };
}

async function withStore(run: (store: MemoryWatchStore) => Promise<void>): Promise<void> {
  const store = new MemoryWatchStore();
  await run(store);
}

// ---------------------------------------------------------------- relay/worker.js

/** Reference implementation of the signature the worker must verify (raw body HMAC). */
function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

test("protocol DDL matches the spec verbatim shape used by the store", () => {
  assert.ok(WATCH_SCHEMA_SQL.length >= 5);
  assert.ok(WATCH_SCHEMA_SQL[0]!.includes("CREATE TABLE IF NOT EXISTS watchers"));
});

test("worker: stores a signed delivery, 202 with payload untouched", async () => {
  const env: WorkerEnv = { DB: new FakeD1(), WEBHOOK_SECRET: "s3cret" };
  const body = JSON.stringify(completedRun(1));
  const response = await worker.fetch(new Request("https://relay.test/hook", {
    method: "POST",
    body,
    headers: { "X-GitHub-Delivery": "abc-1", "X-GitHub-Event": "workflow_run", "X-Hub-Signature-256": sign("s3cret", body) },
  }), env);
  assert.equal(response.status, 202);
  const stored = await response.json() as { ok: boolean; duplicate: boolean };
  assert.equal(stored.ok, true);
  assert.equal(stored.duplicate, false);
  assert.equal(env.DB.rows.length, 1);
  assert.equal(env.DB.rows[0]!.event, "workflow_run");
  assert.equal(env.DB.rows[0]!.seq, 1);
});

test("worker: replays of the same delivery are deduped on the delivery id", async () => {
  const env: WorkerEnv = { DB: new FakeD1(), WEBHOOK_SECRET: "s3cret" };
  const body = JSON.stringify(completedRun(1));
  const headers = { "X-GitHub-Delivery": "abc-1", "X-GitHub-Event": "workflow_run", "X-Hub-Signature-256": sign("s3cret", body) };
  const first = await worker.fetch(new Request("https://relay.test/hook", { method: "POST", body, headers }), env);
  const replay = await worker.fetch(new Request("https://relay.test/hook", { method: "POST", body, headers }), env);
  assert.equal((await first.json() as { duplicate: boolean }).duplicate, false);
  assert.equal((await replay.json() as { duplicate: boolean }).duplicate, true);
  assert.equal(env.DB.rows.length, 1);
});

test("worker: rejects bad signatures, missing headers and invalid payloads without storing", async () => {
  const env: WorkerEnv = { DB: new FakeD1(), WEBHOOK_SECRET: "s3cret" };
  const body = JSON.stringify(completedRun(1));
  const signed = { "X-GitHub-Delivery": "abc-2", "X-GitHub-Event": "workflow_run", "X-Hub-Signature-256": sign("s3cret", body) };
  assert.equal((await worker.fetch(new Request("https://relay.test/hook", {
    method: "POST", body, headers: { ...signed, "X-Hub-Signature-256": sign("wrong", body) },
  }), env)).status, 401);
  assert.equal((await worker.fetch(new Request("https://relay.test/hook", {
    method: "POST", body, headers: { "X-GitHub-Delivery": "abc-3", "X-GitHub-Event": "workflow_run" },
  }), env)).status, 400);
  assert.equal((await worker.fetch(new Request("https://relay.test/hook", {
    method: "POST", body: "not json", headers: { "X-GitHub-Delivery": "abc-4", "X-GitHub-Event": "workflow_run", "X-Hub-Signature-256": sign("s3cret", "not json") },
  }), env)).status, 400);
  assert.equal(env.DB.rows.length, 0);
});

test("worker: GET /pull requires the Bearer token and returns pages with bounds", async () => {
  const env: WorkerEnv = { DB: new FakeD1(), WEBHOOK_SECRET: "s3cret", RELAY_TOKEN: "t0ken" };
  for (const delivery of ["d1", "d2"]) {
    const body = JSON.stringify(completedRun(delivery === "d1" ? 1 : 2));
    await worker.fetch(new Request("https://relay.test/hook", {
      method: "POST", body,
      headers: { "X-GitHub-Delivery": delivery, "X-GitHub-Event": "workflow_run", "X-Hub-Signature-256": sign("s3cret", body) },
    }), env);
  }
  assert.equal((await worker.fetch(new Request("https://relay.test/pull?after=0&timeout=0"), env)).status, 401);
  assert.equal((await worker.fetch(new Request("https://relay.test/pull?after=0&timeout=0", {
    headers: { Authorization: "Bearer wrong" },
  }), env)).status, 401);

  const page = await (await worker.fetch(new Request("https://relay.test/pull?after=0&timeout=0", {
    headers: { Authorization: "Bearer t0ken" },
  }), env)).json() as { seq: number; oldest: number | null; events: { seq: number; delivery: string }[] };
  assert.equal(page.seq, 2);
  assert.equal(page.oldest, 1);
  assert.deepEqual(page.events.map((entry) => entry.seq), [1, 2]);

  const afterFirst = await (await worker.fetch(new Request("https://relay.test/pull?after=1&timeout=0", {
    headers: { Authorization: "Bearer t0ken" },
  }), env)).json() as { events: { seq: number }[]; seq: number };
  // after=1 means seq 1 is consumed; the pending seq 2 is still returned.
  assert.deepEqual(afterFirst.events.map((entry) => entry.seq), [2]);
  assert.equal(afterFirst.seq, 2);
});

test("worker: scheduled handler prunes rows past the retention window", async () => {
  const env: WorkerEnv = { DB: new FakeD1(), WEBHOOK_SECRET: "s3cret" };
  const body = JSON.stringify(completedRun(1));
  await worker.fetch(new Request("https://relay.test/hook", {
    method: "POST", body,
    headers: { "X-GitHub-Delivery": "old-1", "X-GitHub-Event": "workflow_run", "X-Hub-Signature-256": sign("s3cret", body) },
  }), env);
  env.DB.rows[0]!.received_at = "2026-01-01T00:00:00.000Z";
  await worker.scheduled({}, env, {});
  assert.equal(env.DB.rows.length, 0);
});

// ---------------------------------------------------------------- relay pull client

test("relay pull: parses a contiguous page and requires the fixed headers", async () => {
  let requests = 0;
  const { calls, fetch } = fetchCapture(() => {
    requests += 1;
    if (requests === 1) return relayPage({ seq: 2, oldest: 1, events: [envelope(1, "workflow_run", completedRun(1)), envelope(2, "workflow_run", completedRun(2))] });
    return relayPage({ seq: 2, oldest: 1, events: [] });
  });
  const relay = createRelayPull({ url: "https://relay.test/", token: "t0ken", fetch, pullTimeoutSec: 5 });
  const page = await relay.pull(null, new AbortController().signal);
  assert.equal(page.seq, 2);
  assert.equal(page.events.length, 2);
  assert.equal(calls[0]!.url.pathname, "/pull");
  assert.equal(calls[0]!.url.searchParams.get("after"), "0");
  assert.equal(calls[0]!.url.searchParams.get("timeout"), "5");
  assert.equal((calls[0]!.init.headers as Record<string, string>)["authorization"], "Bearer t0ken");

  const continued = await relay.pull("2", new AbortController().signal);
  assert.equal(calls[1]!.url.searchParams.get("after"), "2");
  assert.equal(continued.seq, 2);
});

test("relay pull: cursor gaps inside and before a page are reported, never papered over", async () => {
  const mk = (body: unknown) => createRelayPull({ url: "https://relay.test", token: "t", fetch: fetchCapture(() => relayPage(body)).fetch });
  const holeInside = mk({ seq: 3, oldest: 1, events: [envelope(1, "workflow_run", completedRun(1)), envelope(3, "workflow_run", completedRun(3))] });
  assert.equal(await holeInside.pull(null, new AbortController().signal).catch((error: unknown) => error instanceof RelayError ? error.code : "no"), "TRIGGER_CURSOR_GAP");

  const skippedHead = mk({ seq: 10, oldest: 10, events: [envelope(10, "workflow_run", completedRun(10))] });
  assert.equal(await skippedHead.pull("5", new AbortController().signal).catch((error: unknown) => error instanceof RelayError ? error.code : "no"), "TRIGGER_CURSOR_GAP");

  const pruned = mk({ seq: 30, oldest: 20, events: [] });
  assert.equal(await pruned.pull("5", new AbortController().signal).catch((error: unknown) => error instanceof RelayError ? error.code : "no"), "TRIGGER_CURSOR_GAP");

  // A contiguous empty page is fine and does not move the cursor backwards.
  const quiet = mk({ seq: 5, oldest: 1, events: [] });
  const page = await quiet.pull("5", new AbortController().signal);
  assert.equal(page.seq, 5);
});

test("relay pull: transport and payload failures map to fixed codes", async () => {
  const down = createRelayPull({ url: "https://relay.test", token: "t", fetch: fetchCapture(() => { throw new Error("econnrefused"); }).fetch });
  assert.equal(await down.pull(null, new AbortController().signal).catch((error: unknown) => error instanceof RelayError ? error.code : "no"), "TRIGGER_RELAY_DOWN");

  const unavailable = createRelayPull({ url: "https://relay.test", token: "t", fetch: fetchCapture(() => new Response(null, { status: 503 })).fetch });
  assert.equal(await unavailable.pull(null, new AbortController().signal).catch((error: unknown) => error instanceof RelayError ? error.code : "no"), "TRIGGER_RELAY_DOWN");

  const malformed = createRelayPull({ url: "https://relay.test", token: "t", fetch: fetchCapture(() => new Response("{oops", { status: 200 })).fetch });
  assert.equal(await malformed.pull(null, new AbortController().signal).catch((error: unknown) => error instanceof RelayError ? error.code : "no"), "TRIGGER_PAYLOAD_INVALID");

  const missingFields = createRelayPull({
    url: "https://relay.test", token: "t",
    fetch: fetchCapture(() => relayPage({ seq: 1, oldest: 1, events: [{ seq: 1, delivery: "d", event: "workflow_run" }] })).fetch,
  });
  assert.equal(await missingFields.pull(null, new AbortController().signal).catch((error: unknown) => error instanceof RelayError ? error.code : "no"), "TRIGGER_PAYLOAD_INVALID");
});

// ---------------------------------------------------------------- relay check + driver

test("relay check + processSource: baseline records history silently, later pulls deliver", async () => {
  await withStore(async (store) => {
    store.create({ chatId: "chat-1", kind: "github_run", target: "octo/hello", label: "CI", location: "octo/hello", mode: "push", intervalSec: 30, now: "2026-11-12T09:00:00Z" });
    const source = store.sources[0]!;
    const pages = [
      { seq: 3, oldest: 1, events: [envelope(1, "workflow_run", completedRun(1)), envelope(2, "issues", { action: "closed", repository: { full_name: "octo/hello" }, issue: { number: 3, state: "closed", updated_at: "2026-11-12T09:40:00Z" } }), envelope(3, "workflow_run", completedRun(4)) ] },
      { seq: 4, oldest: 1, events: [envelope(4, "workflow_run", completedRun(5))] },
      { seq: 5, oldest: 1, events: [envelope(5, "workflow_run", completedRun(5, "success", { run_started_at: "2026-11-12T09:10:00Z" }))] },
    ];
    let index = 0;
    const check = createRelayCheck({ relay: { pullTimeoutSec: 1, pull: async () => pages[Math.min(index++, pages.length - 1)]! } as never, now: () => "2026-11-12T10:00:00Z" });
    const next = (baselined: boolean) => processSource(store, source as SourceRow, check, { now: "2026-11-12T10:00:00Z", nextCheckAt: "2026-11-12T10:00:00Z", baselined });

    // First successful pull: history recorded through finish, zero notifications.
    assert.equal(await next(false), 0);
    assert.equal(store.outbox.length, 0);
    // The other-repo issues event is filtered; two runs recorded; cursor covers the whole page.
    assert.deepEqual(store.events.map((event) => event.dedupKey), ["gh:octo/hello:run:1:success", "gh:octo/hello:run:4:success"]);
    assert.equal(source.cursor, "3");

    // Second pull: one new run delivered exactly once.
    assert.equal(await next(true), 1);
    assert.equal(store.outbox.length, 1);
    assert.match(store.outbox[0]!.text, /^\[跟踪 #1\]/);
    assert.equal(store.events[2]!.deliveryId, "d4");

    // Replay of the same dedup key: one row in the store, one delivery, no duplicates.
    assert.equal(await next(true), 0);
    assert.equal(store.outbox.length, 1);
    assert.equal(store.events.length, 3);
    assert.equal(source.cursor, "5");
  });
});

test("relay check: github_pr sources only see their own PR", async () => {
  await withStore(async (store) => {
    store.create({ chatId: "chat-1", kind: "github_pr", target: "octo/hello#7", label: "PR", location: "octo/hello#7", mode: "push", intervalSec: 30, now: "2026-11-12T09:00:00Z" });
    const source = store.sources[0]!;
    const page = {
      seq: 2, oldest: 1,
      events: [
        envelope(1, "pull_request", { action: "closed", repository: { full_name: "octo/hello" }, pull_request: { number: 7, merged: true, merge_commit_sha: "c".repeat(40), merged_at: "2026-11-12T09:30:00Z", closed_at: "2026-11-12T09:30:00Z" } }),
        envelope(2, "pull_request", { action: "closed", repository: { full_name: "octo/hello" }, pull_request: { number: 8, merged: false, closed_at: "2026-11-12T09:31:00Z" } }),
      ],
    };
    const check = createRelayCheck({ relay: { pull: async () => page } as never, now: () => "2026-11-12T10:00:00Z" });
    await processSource(store, source as SourceRow, check, { now: "2026-11-12T10:00:00Z", nextCheckAt: "2026-11-12T10:00:00Z", baselined: false });
    assert.deepEqual(store.events.map((event) => event.dedupKey), [`gh:octo/hello:pr:7:merged@${"c".repeat(40)}`]);
  });
});

test("processSource: cursor gaps propagate as TRIGGER_CURSOR_GAP", async () => {
  await withStore(async (store) => {
    const source = pushSource({ cursor: "5" });
    const check = createRelayCheck({
      relay: { pull: async () => { throw new RelayError("TRIGGER_CURSOR_GAP", "gap"); } } as never,
    });
    await assert.rejects(
      () => processSource(store, source, check, { now: "2026-11-12T10:00:00Z", nextCheckAt: "2026-11-12T10:00:00Z", baselined: true }),
      (error: unknown) => error instanceof RelayError && error.code === "TRIGGER_CURSOR_GAP",
    );
  });
});

test("nextBackoffAt follows the spec curve with a one hour cap", () => {
  const base = "2026-11-12T10:00:00.000Z";
  assert.equal(nextBackoffAt({ intervalSec: 30, failures: 0 }, base), "2026-11-12T10:00:30.000Z");
  assert.equal(nextBackoffAt({ intervalSec: 30, failures: 1 }, base), "2026-11-12T10:01:00.000Z");
  assert.equal(nextBackoffAt({ intervalSec: 30, failures: 3 }, base), "2026-11-12T10:04:00.000Z");
  assert.equal(nextBackoffAt({ intervalSec: 30, failures: 12 }, base), "2026-11-12T11:00:00.000Z");
});

// ---------------------------------------------------------------- reconcile

type FakeRestOutcome = { status: "ok"; events: GithubDraft[]; etag: string | null } | { status: "notModified" };

function fakeRest(script: Array<FakeRestOutcome | { error: unknown }>) {
  let index = 0;
  const reads: SourceRow[] = [];
  return {
    reads,
    read: async (source: SourceRow, _signal: AbortSignal): Promise<FakeRestOutcome> => {
      reads.push(source);
      const next = script[Math.min(index++, script.length - 1)]!;
      if ("error" in next) throw next.error;
      return next;
    },
  };
}

function draft(dedupKey: string): GithubDraft {
  return { dedupKey, kind: "github_run", occurredAt: "2026-11-12T09:05:00Z", facts: { repo: "octo/hello", runId: Number(dedupKey.slice(-1)), conclusion: "success", link: "https://github.com/octo/hello/x" } };
}

test("reconcile: baseline pass records history silently and stores the ETag", async () => {
  await withStore(async (store) => {
    store.create({ chatId: "chat-1", kind: "github_run", target: "octo/hello", label: "CI", location: "octo/hello", mode: "push", intervalSec: 60, now: "2026-11-12T09:00:00Z" });
    const source = store.sources[0]!;
    assert.ok(source.reconcileAt !== null && source.reconcileAt <= "2026-11-12T10:00:00Z");
    const rest = fakeRest([{ status: "ok", events: [draft("gh:octo/hello:run:1:success")], etag: 'W/"v1"' }]);
    const summary = await runReconcile({ store, rest: rest as never, limit: 5 }, "2026-11-12T10:00:00Z");
    assert.equal(summary.baseline, 1);
    assert.equal(store.outbox.length, 0);
    assert.equal(store.events.length, 1);
    assert.equal(source.etag, 'W/"v1"');
    assert.ok(source.reconcileAt! > "2026-11-12T10:00:00Z", "dueReconcile must claim by advancing reconcile_at");
  });
});

test("reconcile: 304 produces no events and does not reset failure counters", async () => {
  await withStore(async (store) => {
    store.create({ chatId: "chat-1", kind: "github_run", target: "octo/hello", label: "CI", location: "octo/hello", mode: "push", intervalSec: 60, now: "2026-11-12T09:00:00Z" });
    const source = store.sources[0]!;
    source.etag = 'W/"v1"';
    source.failures = 2;
    source.lastError = "TRIGGER_RELAY_DOWN";
    const rest = fakeRest([{ status: "notModified" }]);
    const summary = await runReconcile({ store, rest: rest as never, limit: 5 }, "2026-11-12T10:00:00Z");
    assert.equal(summary.notModified, 1);
    assert.equal(store.events.length, 0);
    assert.equal(store.outbox.length, 0);
    assert.equal(source.failures, 2);
    assert.equal(source.lastError, "TRIGGER_RELAY_DOWN");
  });
});

test("reconcile: a missing terminal state is queued exactly once across passes", async () => {
  await withStore(async (store) => {
    store.create({ chatId: "chat-1", kind: "github_run", target: "octo/hello", label: "CI", location: "octo/hello", mode: "push", intervalSec: 60, now: "2026-11-12T09:00:00Z" });
    const source = store.sources[0]!;
    source.etag = 'W/"v1"';
    const rest = fakeRest([
      { status: "ok", events: [draft("gh:octo/hello:run:7:failure")], etag: 'W/"v2"' },
      { status: "ok", events: [draft("gh:octo/hello:run:7:failure")], etag: 'W/"v2"' },
    ]);
    const first = await runReconcile({ store, rest: rest as never, limit: 5 }, "2026-11-12T10:00:00Z");
    assert.equal(first.queued, 1);
    assert.equal(store.outbox.length, 1);
    assert.match(store.outbox[0]!.text, /^\[跟踪 #1\]/);
    assert.equal(source.etag, 'W/"v2"');
    const second = await runReconcile({ store, rest: rest as never, limit: 5 }, "2026-11-12T10:05:00Z");
    assert.equal(second.queued, 0);
    assert.equal(store.outbox.length, 1);
  });
});

test("reconcile: rate limits abort the pass; gone targets stop the source", async () => {
  await withStore(async (store) => {
    store.create({ chatId: "chat-1", kind: "github_run", target: "octo/hello", label: "A", location: "octo/hello", mode: "push", intervalSec: 60, now: "2026-11-12T09:00:00Z" });
    store.create({ chatId: "chat-1", kind: "github_run", target: "octo/other", label: "B", location: "octo/other", mode: "push", intervalSec: 60, now: "2026-11-12T09:00:00Z" });
    const [first, second] = store.sources;
    const rest = fakeRest([
      { error: new GithubWatchError("WATCH_RATE_LIMITED", "quota", true) },
      { status: "ok", events: [draft("gh:octo/other:run:1:success")], etag: 'W/"v1"' },
    ]);
    const summary = await runReconcile({ store, rest: rest as never, limit: 5 }, "2026-11-12T10:00:00Z");
    assert.equal(summary.failed, 1);
    assert.equal(rest.reads.length, 1, "remaining sources must be skipped after a rate limit");
    assert.equal(first!.lastError, "WATCH_RATE_LIMITED");
    assert.equal(second!.lastError, null, "the skipped source must not be failed");

    const gone = fakeRest([{ error: new GithubWatchError("WATCH_SOURCE_GONE", "deleted") }]);
    await runReconcile({ store: store, rest: gone as never, limit: 5 }, "2026-11-12T10:10:00Z");
    assert.equal(store.sources[0]!.status, "stopped");
  });
});

test("reconcile: non-GitHub sources are ignored even when due", async () => {
  await withStore(async (store) => {
    store.create({ chatId: "chat-1", kind: "feed", target: "https://example.test/rss", label: "blog", location: "https://example.test/rss", mode: "poll", intervalSec: 600, now: "2026-11-12T09:00:00Z" });
    const rest = fakeRest([{ status: "ok", events: [draft("gh:x:run:1:success")], etag: "W/\"v1\"" }]);
    const summary = await runReconcile({ store, rest: rest as never, limit: 5 }, "2026-11-12T10:00:00Z");
    // Poll sources have no reconcile_at, so the pass never even sees them.
    assert.deepEqual(summary, { sources: 0, baseline: 0, queued: 0, notModified: 0, failed: 0 });
    assert.equal(rest.reads.length, 0);
  });
});

// ---------------------------------------------------------------- fake D1 used by the worker tests

class FakeD1 {
  rows: { seq: number; delivery: string; event: string; payload: string; received_at: string }[] = [];
  #nextSeq = 1;

  prepare(sql: string) {
    const statement = {
      bind: (...params: unknown[]) => ({
        run: async () => ({ meta: { changes: await this.#execute(sql, params) } }),
        all: async () => ({ results: await this.#select(sql, params) }),
        first: async () => (await this.#select(sql, params))[0] ?? null,
      }),
      // Real D1 also serves statements without explicit bind; the bounds query uses that form.
      run: async () => ({ meta: { changes: await this.#execute(sql, []) } }),
      all: async () => ({ results: await this.#select(sql, []) }),
      first: async () => (await this.#select(sql, []))[0] ?? null,
    };
    return statement;
  }

  async #execute(sql: string, params: unknown[]): Promise<number> {
    if (sql.startsWith("CREATE TABLE")) return 0;
    if (sql.includes("INSERT INTO webhook_events")) {
      const [delivery = "", event = "", payload = "", receivedAt = ""] = params as string[];
      if (this.rows.some((row) => row.delivery === delivery)) return 0;
      this.rows.push({ seq: this.#nextSeq++, delivery, event, payload, received_at: receivedAt });
      return 1;
    }
    if (sql.startsWith("DELETE FROM")) {
      const before = this.rows.length;
      this.rows = this.rows.filter((row) => row.received_at >= String(params[0]));
      return before - this.rows.length;
    }
    throw new Error(`FakeD1: unsupported execute: ${sql.slice(0, 40)}`);
  }

  async #select(sql: string, params: unknown[]): Promise<unknown[]> {
    if (sql.startsWith("SELECT seq, delivery")) {
      const after = Number(params[0]);
      const limit = Number(params[1]);
      return this.rows.filter((row) => row.seq > after).slice(0, limit).map((row) => ({ ...row }));
    }
    if (sql.startsWith("SELECT MIN(seq)")) {
      const oldest = this.rows.length ? Math.min(...this.rows.map((row) => row.seq)) : null;
      const latest = this.rows.length ? Math.max(...this.rows.map((row) => row.seq)) : null;
      return [{ oldest, latest }];
    }
    throw new Error(`FakeD1: unsupported select: ${sql.slice(0, 40)}`);
  }
}

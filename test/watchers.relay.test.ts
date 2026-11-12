import assert from "node:assert/strict";
import test from "node:test";
import { parsePull, RelayClient, runRelayOnce, type RelayPull, type RelayPuller } from "../src/watchers/relay.js";
import { SqliteWatchStore, WatchError } from "../src/watchers/store.js";
import { clock, createInput, errorCode, jsonResponse } from "./watchers.testkit.js";

const signal = new AbortController().signal;

function puller(pull: RelayPull | (() => Promise<RelayPull>)): RelayPuller {
  return { pull: async () => (typeof pull === "function" ? pull() : pull) };
}

function mergedPr(number: number, sha: string) {
  return {
    repository: { full_name: "owner/repo" },
    action: "closed",
    pull_request: {
      number,
      state: "closed",
      merged: true,
      merge_commit_sha: sha,
      merged_at: "2026-11-12T02:00:00Z",
      closed_at: "2026-11-12T02:00:00Z",
      html_url: `https://github.com/owner/repo/pull/${number}`,
    },
  };
}

function relayStore(): { store: SqliteWatchStore; time: ReturnType<typeof clock> } {
  const store = new SqliteWatchStore(":memory:");
  const time = clock();
  store.create(createInput(time.now, {
    kind: "github_pr", target: "owner/repo#7", location: "owner/repo#7", mode: "push", intervalSec: 600,
  }));
  return { store, time };
}

test("a pull is parsed strictly and a malformed body is refused", () => {
  assert.deepEqual(parsePull({ seq: 3, events: [] }), { seq: 3, events: [] });
  for (const bad of [
    null,
    { seq: -1, events: [] },
    { seq: 1.5, events: [] },
    { seq: 2, events: [{ seq: 2, event: "x", payload: {} }, { seq: 2, event: "x", payload: {} }] },
    { seq: 2, events: [{ seq: 2, event: "", payload: {} }] },
    { seq: 2, events: [{ seq: 2, event: "x", payload: "no" }] },
  ]) assert.throws(() => parsePull(bad), (error) => errorCode(error) === "TRIGGER_PAYLOAD_INVALID");
});

test("the client sends the bearer token, timeout and cursor", async () => {
  let requested = "";
  let authorization = "";
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requested = String(input);
    authorization = (init?.headers as Record<string, string>).authorization ?? "";
    return jsonResponse({ seq: 11, events: [{ seq: 11, deliveryId: "d", event: "pull_request", payload: mergedPr(7, "s") }] });
  }) as typeof fetch;
  const client = new RelayClient({ url: "https://relay.example.com/", token: "relay-token", timeoutSec: 5, fetch: fake });
  const pull = await client.pull("10", signal);
  assert.equal(authorization, "Bearer relay-token");
  assert.match(requested, /^https:\/\/relay\.example\.com\/pull\?timeout=5&after=10$/);
  assert.equal(pull.seq, 11);
  assert.equal(pull.events[0]?.deliveryId, "d");
});

test("a baseline pull omits the cursor and relay failures stay reason codes", async () => {
  let requested = "";
  const fake = (async (input: RequestInfo | URL) => {
    requested = String(input);
    return jsonResponse({ seq: 4, events: [] });
  }) as typeof fetch;
  await new RelayClient({ url: "https://relay.example.com", token: "relay-token", fetch: fake }).pull(null, signal);
  assert.doesNotMatch(requested, /after=/);

  const down = (async () => new Response("no", { status: 503 })) as typeof fetch;
  await assert.rejects(
    new RelayClient({ url: "https://relay.example.com", token: "relay-token", fetch: down }).pull("1", signal),
    (error) => errorCode(error) === "TRIGGER_RELAY_DOWN",
  );
});

test("a delivery reaches only the matching watcher and advances the cursor", async () => {
  const { store, time } = relayStore();
  try {
    store.advanceRelay("10", time.iso());
    const result = await runRelayOnce({
      store,
      now: time.now,
      client: puller({
        seq: 12,
        events: [
          { seq: 11, event: "pull_request", payload: mergedPr(7, "sha7") },
          { seq: 12, event: "pull_request", payload: mergedPr(99, "sha99") },
        ],
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.dropped, 1);
    assert.equal(store.pending(10).length, 1);
    assert.match(store.pending(10)[0]?.text ?? "", /PR owner\/repo#7 已合并/);
    assert.equal(store.relayCursor(), "12");
  } finally {
    store.close();
  }
});

test("a sequence gap resets the cursor so reconcile can fill the hole", async () => {
  const { store, time } = relayStore();
  try {
    store.advanceRelay("10", time.iso());
    const result = await runRelayOnce({
      store,
      now: time.now,
      client: puller({ seq: 15, events: [{ seq: 13, event: "pull_request", payload: mergedPr(7, "sha") }] }),
    });
    assert.equal(result.gap, true);
    assert.equal(result.code, "TRIGGER_CURSOR_GAP");
    assert.equal(store.relayCursor(), null);
    assert.equal(store.pending(10).length, 0);
  } finally {
    store.close();
  }
});

test("a relay outage is reported without touching the store", async () => {
  const { store, time } = relayStore();
  try {
    store.advanceRelay("10", time.iso());
    const result = await runRelayOnce({
      store,
      now: time.now,
      client: { pull: async () => { throw new WatchError("TRIGGER_RELAY_DOWN", "down"); } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "TRIGGER_RELAY_DOWN");
    assert.equal(store.relayCursor(), "10");
    assert.equal(store.pending(10).length, 0);
  } finally {
    store.close();
  }
});

test("events from an unknown repository are dropped, not queued", async () => {
  const { store, time } = relayStore();
  try {
    store.advanceRelay("3", time.iso());
    const foreign = mergedPr(7, "sha");
    foreign.repository.full_name = "someone/else";
    const result = await runRelayOnce({
      store, now: time.now,
      client: puller({ seq: 4, events: [{ seq: 4, event: "pull_request", payload: foreign }] }),
    });
    assert.equal(result.dropped, 1);
    assert.equal(store.pending(10).length, 0);
  } finally {
    store.close();
  }
});

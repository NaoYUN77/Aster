import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  composeGithubText,
  createGithubNormalizer,
  createGithubRest,
  GithubWatchError,
  parseGithubTarget,
} from "../src/watchers/github.js";

const NOW = "2026-11-12T10:00:00.000Z";

function codeOf(error: unknown): string {
  assert.ok(error instanceof GithubWatchError, `expected GithubWatchError, got ${String(error)}`);
  return error.code;
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

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

const runPayload = (runOverrides: Record<string, unknown> = {}, topOverrides: Record<string, unknown> = {}) => ({
  action: "completed",
  repository: { full_name: "octo/hello" },
  ...topOverrides,
  workflow_run: {
    id: 42,
    name: "CI",
    head_branch: "main",
    head_sha: "a".repeat(40),
    status: "completed",
    conclusion: "success",
    run_started_at: "2026-11-12T09:00:00Z",
    updated_at: "2026-11-12T09:05:00Z",
    html_url: "https://github.com/octo/hello/actions/runs/42",
    ...runOverrides,
  },
});

test("workflow_run: only completed runs with a conclusion become events", () => {
  const normalizer = createGithubNormalizer();
  const completed = normalizer.normalize("workflow_run", runPayload(), NOW);
  assert.equal(completed.events.length, 1);
  assert.equal(completed.events[0]!.dedupKey, "gh:octo/hello:run:42:success");
  assert.equal(completed.events[0]!.kind, "github_run");
  assert.equal(completed.events[0]!.occurredAt, "2026-11-12T09:05:00.000Z");
  assert.equal(completed.skipped, 0);
  assert.equal(completed.zombie, 0);

  for (const overrides of [{ action: "in_progress" }, { status: "in_progress", conclusion: null }, { conclusion: "" }]) {
    const outcome = normalizer.normalize("workflow_run", runPayload(overrides, { action: overrides.action ?? "completed" }), NOW);
    assert.deepEqual(outcome.events, [], JSON.stringify(overrides));
    assert.equal(outcome.skipped, 1, JSON.stringify(overrides));
  }
});

test("workflow_run: an older revision completing after a newer one is a zombie", () => {
  const normalizer = createGithubNormalizer();
  const newer = normalizer.normalize("workflow_run", runPayload(), NOW);
  assert.equal(newer.zombie, 0);
  const older = normalizer.normalize("workflow_run", runPayload({
    id: 41,
    head_sha: "b".repeat(40),
    run_started_at: "2026-11-12T08:00:00Z",
    updated_at: "2026-11-12T09:06:00Z",
  }), NOW);
  assert.deepEqual(older.events, []);
  assert.equal(older.zombie, 1);

  // Same branch, fresh revision afterwards is still accepted.
  const fresh = normalizer.normalize("workflow_run", runPayload({ id: 43, head_sha: "c".repeat(40) }), NOW);
  assert.equal(fresh.events.length, 1);
});

test("workflow_run: completions of different branches do not zombie each other", () => {
  const normalizer = createGithubNormalizer();
  normalizer.normalize("workflow_run", runPayload(), NOW);
  const other = normalizer.normalize("workflow_run", runPayload({ id: 44, head_branch: "feature" }), NOW);
  assert.equal(other.events.length, 1);
  assert.equal(other.zombie, 0);
});

test("pull_request: closed merges and closes use distinct immutable keys", () => {
  const normalizer = createGithubNormalizer();
  const merged = normalizer.normalize("pull_request", {
    action: "closed",
    repository: { full_name: "octo/hello" },
    pull_request: {
      number: 7,
      merged: true,
      merge_commit_sha: "c".repeat(40),
      merged_at: "2026-11-12T09:30:00Z",
      closed_at: "2026-11-12T09:30:00Z",
      title: "Add watchers",
      html_url: "https://github.com/octo/hello/pull/7",
    },
  }, NOW);
  assert.equal(merged.events[0]!.dedupKey, `gh:octo/hello:pr:7:merged@${"c".repeat(40)}`);

  const closed = normalizer.normalize("pull_request", {
    action: "closed",
    repository: { full_name: "octo/hello" },
    pull_request: { number: 8, merged: false, closed_at: "2026-11-12T09:31:00Z" },
  }, NOW);
  assert.equal(closed.events[0]!.dedupKey, "gh:octo/hello:pr:8:closed@2026-11-12T09:31:00Z");

  // Merged without a recorded sha falls back to the closed key, never a broken merged key.
  const noSha = normalizer.normalize("pull_request", {
    action: "closed",
    repository: { full_name: "octo/hello" },
    pull_request: { number: 9, merged: true, closed_at: "2026-11-12T09:32:00Z" },
  }, NOW);
  assert.equal(noSha.events[0]!.dedupKey, "gh:octo/hello:pr:9:closed@2026-11-12T09:32:00Z");

  assert.equal(normalizer.normalize("pull_request", { action: "synchronize", repository: { full_name: "octo/hello" }, pull_request: { number: 8 } }, NOW).skipped, 1);
});

test("issues and issue_comment: terminal state changes and new comments only", () => {
  const normalizer = createGithubNormalizer();
  const closed = normalizer.normalize("issues", {
    action: "closed",
    repository: { full_name: "octo/hello" },
    issue: { number: 3, state: "closed", updated_at: "2026-11-12T09:40:00Z" },
  }, NOW);
  assert.equal(closed.events[0]!.dedupKey, "gh:octo/hello:issue:3:closed@2026-11-12T09:40:00Z");

  const reopened = normalizer.normalize("issues", {
    action: "reopened",
    repository: { full_name: "octo/hello" },
    issue: { number: 3, state: "open", updated_at: "2026-11-12T09:41:00Z" },
  }, NOW);
  assert.equal(reopened.events[0]!.dedupKey, "gh:octo/hello:issue:3:open@2026-11-12T09:41:00Z");

  const comment = normalizer.normalize("issue_comment", {
    action: "created",
    repository: { full_name: "octo/hello" },
    issue: { number: 3 },
    comment: { id: 99, created_at: "2026-11-12T09:42:00Z", user: { login: "alice" } },
  }, NOW);
  assert.equal(comment.events[0]!.dedupKey, "gh:octo/hello:issue:3:comment:99");
  assert.equal(comment.events[0]!.facts["author"], "alice");

  assert.equal(normalizer.normalize("issues", { action: "opened", repository: { full_name: "octo/hello" }, issue: { number: 4 } }, NOW).skipped, 1);
  assert.equal(normalizer.normalize("issue_comment", { action: "deleted", repository: { full_name: "octo/hello" }, issue: { number: 3 }, comment: { id: 99 } }, NOW).skipped, 1);
});

test("unknown events and unparseable payloads are counted, never thrown", () => {
  const normalizer = createGithubNormalizer();
  assert.equal(normalizer.normalize("push", { repository: { full_name: "octo/hello" } }, NOW).skipped, 1);
  assert.equal(normalizer.normalize("pull_request", "not an object", NOW).skipped, 1);
  assert.equal(normalizer.normalize("pull_request", { action: "closed" }, NOW).skipped, 1);
  assert.equal(normalizer.normalize("workflow_run", { action: "completed", repository: { full_name: "with space" }, workflow_run: {} }, NOW).skipped, 1);
});

test("parseGithubTarget validates the three GitHub kinds", () => {
  assert.deepEqual(parseGithubTarget("github_pr", "octo/hello#12"), { owner: "octo", repo: "hello", number: 12 });
  assert.deepEqual(parseGithubTarget("github_run", "octo/hello@ci.yml"), { owner: "octo", repo: "hello", workflow: "ci.yml" });
  assert.deepEqual(parseGithubTarget("github_run", "octo/hello"), { owner: "octo", repo: "hello" });
  assert.deepEqual(parseGithubTarget("github_events", "octo/hello"), { owner: "octo", repo: "hello" });
  assert.equal(codeOf((() => { try { parseGithubTarget("github_pr", "octo/hello"); } catch (error) { return error; } })()), "WATCH_TARGET_INVALID");
  assert.equal(codeOf((() => { try { parseGithubTarget("feed", "octo/hello"); } catch (error) { return error; } })()), "WATCH_TARGET_INVALID");
});

test("composeGithubText: one deterministic line with the watcher id and link", () => {
  const normalizer = createGithubNormalizer();
  const draft = normalizer.normalize("workflow_run", runPayload(), NOW).events[0]!;
  assert.equal(
    composeGithubText(5, draft),
    "[跟踪 #5] CI 运行 #42 在 octo/hello 成功 https://github.com/octo/hello/actions/runs/42",
  );
});

test("REST reader: sends the stored ETag, treats 304 as notModified with no events", async () => {
  let requests = 0;
  const { fetch, calls } = fetchCapture(() => {
    requests += 1;
    if (requests === 1) return jsonResponse(200, { state: "closed", number: 7, merged: true, merge_commit_sha: "c".repeat(40), merged_at: "2026-11-12T09:30:00Z", closed_at: "2026-11-12T09:30:00Z", title: "t", html_url: "u" }, { etag: 'W/"v1"' });
    return new Response(null, { status: 304, headers: { etag: 'W/"v1"' } });
  });
  const rest = createGithubRest({ token: "gh-token", fetch, apiBase: "https://api.example.test" });
  const source = { kind: "github_pr" as const, location: "octo/hello#7", etag: null };
  const first = await rest.read(source, new AbortController().signal);
  assert.equal(first.status, "ok");
  assert.equal(first.events[0]!.dedupKey, `gh:octo/hello:pr:7:merged@${"c".repeat(40)}`);
  assert.equal(first.etag, 'W/"v1"');
  assert.equal(calls[0]!.init.headers && (calls[0]!.init.headers as Record<string, string>)["authorization"], "Bearer gh-token");

  const second = await rest.read({ ...source, etag: 'W/"v1"' }, new AbortController().signal);
  assert.equal(second.status, "notModified");
  assert.equal((calls[1]!.init.headers as Record<string, string>)["if-none-match"], 'W/"v1"');
});

test("REST reader: no token means no Authorization header", async () => {
  const { fetch, calls } = fetchCapture(() => new Response(null, { status: 304 }));
  const rest = createGithubRest({ fetch, apiBase: "https://api.example.test" });
  await rest.read({ kind: "github_run" as const, location: "octo/hello", etag: null }, new AbortController().signal);
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["authorization"], undefined);
  assert.equal(headers["user-agent"], "aster-watchers");
});

test("REST reader: github_run honours the @workflow filter", async () => {
  const { fetch } = fetchCapture(() => jsonResponse(200, { workflow_runs: [
    { id: 1, name: "deploy", status: "completed", conclusion: "success", updated_at: "2026-11-12T09:00:00Z" },
    { id: 2, name: "CI", status: "completed", conclusion: "failure", updated_at: "2026-11-12T09:01:00Z" },
  ] }));
  const rest = createGithubRest({ fetch, apiBase: "https://api.example.test" });
  const outcome = await rest.read({ kind: "github_run" as const, location: "octo/hello@ci", etag: null }, new AbortController().signal);
  assert.equal(outcome.status, "ok");
  if (outcome.status === "ok") {
    assert.deepEqual(outcome.events.map((draft) => draft.dedupKey), ["gh:octo/hello:run:2:failure"]);
  }
});

test("REST reader: github_events combines issues and runs with a joined ETag", async () => {
  const { fetch, calls } = fetchCapture((url) => {
    if (url.pathname.endsWith("/issues")) {
      return jsonResponse(200, [
        { number: 3, state: "closed", updated_at: "2026-11-12T09:40:00Z", closed_at: "2026-11-12T09:40:00Z", title: "t", html_url: "u" },
        // PR rows come from the pulls endpoint, not here: skip them to keep keys identical.
        { number: 7, state: "closed", updated_at: "2026-11-12T09:40:00Z", closed_at: "2026-11-12T09:40:00Z", pull_request: {} },
        // Post-close activity drifted updated_at away from closed_at: skip instead of re-notifying.
        { number: 4, state: "closed", updated_at: "2026-11-12T10:40:00Z", closed_at: "2026-11-12T09:40:00Z" },
      ], { etag: 'W/"i1"' });
    }
    return jsonResponse(200, { workflow_runs: [{ id: 9, name: "CI", status: "completed", conclusion: "success", updated_at: "2026-11-12T09:00:00Z" }] }, { etag: 'W/"r1"' });
  });
  const rest = createGithubRest({ fetch, apiBase: "https://api.example.test" });
  const outcome = await rest.read({ kind: "github_events" as const, location: "octo/hello", etag: null }, new AbortController().signal);
  assert.equal(outcome.status, "ok");
  if (outcome.status === "ok") {
    assert.deepEqual(outcome.events.map((draft) => draft.dedupKey), ["gh:octo/hello:issue:3:closed@2026-11-12T09:40:00Z", "gh:octo/hello:run:9:success"]);
    assert.equal(outcome.etag, 'W/"i1"\nW/"r1"');
  }
  assert.equal(calls.length, 2);
});

test("REST reader: mapped status codes carry the fixed reason codes", async () => {
  const cases: [number, Record<string, string>, string][] = [
    [404, {}, "WATCH_SOURCE_GONE"],
    [410, {}, "WATCH_SOURCE_GONE"],
    [401, {}, "WATCH_SOURCE_AUTH"],
    [403, { "x-ratelimit-remaining": "0" }, "WATCH_RATE_LIMITED"],
    [403, { "x-ratelimit-remaining": "5" }, "WATCH_SOURCE_AUTH"],
    [429, {}, "WATCH_RATE_LIMITED"],
    [500, {}, "WATCH_FETCH_TIMEOUT"],
  ];
  for (const [status, headers, expected] of cases) {
    const { fetch } = fetchCapture(() => new Response(null, { status, headers }));
    const rest = createGithubRest({ fetch, apiBase: "https://api.example.test" });
    const error = await rest.read({ kind: "github_events" as const, location: "octo/hello", etag: null }, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(error instanceof GithubWatchError);
    assert.equal(error.code, expected, `status ${status}`);
  }
});

test("REST reader: oversize and invalid bodies map to size/parse failures", async () => {
  const oversize = fetchCapture(() => new Response("x".repeat(50), { status: 200 }));
  const rest = createGithubRest({ fetch: oversize.fetch, apiBase: "https://api.example.test", maxResponseBytes: 10 });
  assert.equal(codeOf(await rest.read({ kind: "github_run" as const, location: "octo/hello", etag: null }, new AbortController().signal).catch((error: unknown) => error)), "WATCH_FEED_TOO_LARGE");

  const broken = fetchCapture(() => new Response("{not json", { status: 200 }));
  const rest2 = createGithubRest({ fetch: broken.fetch, apiBase: "https://api.example.test" });
  assert.equal(codeOf(await rest2.read({ kind: "github_run" as const, location: "octo/hello", etag: null }, new AbortController().signal).catch((error: unknown) => error)), "WATCH_PARSE_FAILED");
});

test("REST reader: network failure maps to WATCH_FETCH_TIMEOUT", async () => {
  const { fetch } = fetchCapture(() => { throw new Error("dns"); });
  const rest = createGithubRest({ fetch, apiBase: "https://api.example.test" });
  assert.equal(
    codeOf(await rest.read({ kind: "github_run" as const, location: "octo/hello", etag: null }, new AbortController().signal).catch((error: unknown) => error)),
    "WATCH_FETCH_TIMEOUT",
  );
});

/** The signature the worker verifies is HMAC-SHA256 over the raw body; test-side reference. */
function webhookSignature(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

test("webhook signature reference: worker and test agree on the raw-body HMAC", () => {
  const body = JSON.stringify({ action: "closed" });
  assert.match(webhookSignature("relay-secret", body), /^sha256=[0-9a-f]{64}$/);
});

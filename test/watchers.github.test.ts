import assert from "node:assert/strict";
import test from "node:test";
import {
  eventsForSource,
  GithubReconcileCheck,
  normalizeWebhook,
  parseGithubTarget,
} from "../src/watchers/github.js";
import { errorCode, feedSource, jsonResponse } from "./watchers.testkit.js";

const signal = new AbortController().signal;
const REPO = { repository: { full_name: "owner/repo" } };

test("targets accept the shapes a user types and reject ambiguous ones", () => {
  assert.deepEqual(parseGithubTarget("owner/repo"), { repo: "owner/repo" });
  assert.deepEqual(parseGithubTarget("owner/repo#12"), { repo: "owner/repo", number: 12 });
  assert.deepEqual(parseGithubTarget("https://github.com/owner/repo/pull/12"), { repo: "owner/repo", number: 12 });
  assert.deepEqual(parseGithubTarget("owner/repo.git"), { repo: "owner/repo" });
  for (const bad of ["", "repo", "owner/repo#0", "owner/repo#x", "https://example.com/owner/repo"]) {
    assert.equal(parseGithubTarget(bad), undefined);
  }
});

test("only completed CI runs produce a key, and the key carries the conclusion", () => {
  const run = { id: 42, status: "completed", conclusion: "success", updated_at: "2026-11-12T01:00:00Z", html_url: "https://github.com/owner/repo/actions/runs/42" };
  const done = normalizeWebhook("workflow_run", { ...REPO, action: "completed", workflow_run: run });
  assert.equal(done.events.length, 1);
  assert.equal(done.events[0]?.dedupKey, "gh:owner/repo:run:42:success");
  assert.equal(done.events[0]?.kind, "github_run");

  const running = normalizeWebhook("workflow_run", { ...REPO, action: "requested", workflow_run: { ...run, status: "in_progress", conclusion: null } });
  assert.equal(running.events.length, 0);
  assert.equal(running.ignored, 1);

  const emptyConclusion = normalizeWebhook("workflow_run", { ...REPO, action: "completed", workflow_run: { ...run, conclusion: "" } });
  assert.equal(emptyConclusion.events.length, 0);
});

test("pull request and issue keys use terminal state and its timestamp", () => {
  const merged = normalizeWebhook("pull_request", {
    ...REPO,
    action: "closed",
    pull_request: { number: 7, state: "closed", merged: true, merge_commit_sha: "abc123", merged_at: "2026-11-12T02:00:00Z", closed_at: "2026-11-12T02:00:00Z" },
  });
  assert.equal(merged.events[0]?.dedupKey, "gh:owner/repo:pr:7:merged@abc123");

  const closed = normalizeWebhook("pull_request", {
    ...REPO,
    action: "closed",
    pull_request: { number: 8, state: "closed", merged: false, closed_at: "2026-11-12T03:00:00Z" },
  });
  assert.equal(closed.events[0]?.dedupKey, "gh:owner/repo:pr:8:closed@2026-11-12T03:00:00Z");

  const opened = normalizeWebhook("pull_request", { ...REPO, action: "opened", pull_request: { number: 9, state: "open" } });
  assert.equal(opened.events.length, 0);

  const issue = normalizeWebhook("issues", {
    ...REPO,
    action: "closed",
    issue: { number: 3, state: "closed", updated_at: "2026-11-12T04:00:00Z" },
  });
  assert.equal(issue.events[0]?.dedupKey, "gh:owner/repo:issue:3:closed@2026-11-12T04:00:00Z");
  assert.equal(issue.events[0]?.kind, "github_events");
});

test("comments and malformed payloads are ignored, not turned into events", () => {
  assert.equal(normalizeWebhook("issue_comment", { ...REPO, action: "created", issue: { number: 1 } }).events.length, 0);
  assert.equal(normalizeWebhook("workflow_run", null).events.length, 0);
  assert.equal(normalizeWebhook("workflow_run", { action: "completed", workflow_run: {} }).repo, "");
});

test("a delivery is routed only to matching sources", () => {
  const normalized = normalizeWebhook("pull_request", {
    ...REPO,
    action: "closed",
    pull_request: { number: 7, state: "closed", merged: true, merge_commit_sha: "sha", merged_at: "2026-11-12T02:00:00Z", closed_at: "2026-11-12T02:00:00Z" },
  });
  const pinned = feedSource({ kind: "github_pr", location: "owner/repo#7", mode: "push" });
  assert.equal(eventsForSource(pinned, normalized).length, 1);
  assert.equal(eventsForSource(feedSource({ kind: "github_pr", location: "owner/repo#8", mode: "push" }), normalized).length, 0);
  assert.equal(eventsForSource(feedSource({ kind: "github_pr", location: "owner/other#7", mode: "push" }), normalized).length, 0);
  assert.equal(eventsForSource(feedSource({ kind: "github_run", location: "owner/repo", mode: "push" }), normalized).length, 0);
});

test("reconcile reads terminal runs over REST and honours the stored ETag", async () => {
  let authorization = "";
  const fake = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    authorization = (init?.headers as Record<string, string>).authorization ?? "";
    return jsonResponse({
      workflow_runs: [{
        id: 55, status: "completed", conclusion: "failure",
        updated_at: "2026-11-12T05:00:00Z", html_url: "https://github.com/owner/repo/actions/runs/55",
      }],
    }, { headers: { etag: '"r1"' } });
  }) as typeof fetch;
  const check = new GithubReconcileCheck({ token: "test-token", timeoutMs: 5_000, fetch: fake });
  const source = feedSource({ kind: "github_run", location: "owner/repo", mode: "push" });
  const outcome = await check.checkDetailed(source, signal);
  assert.equal(authorization, "Bearer test-token");
  assert.equal(outcome.result.events[0]?.dedupKey, "gh:owner/repo:run:55:failure");
  assert.equal(outcome.result.state?.etag, '"r1"');
  assert.equal(outcome.notModified, false);
});

test("a 304 leaves reconcile with no events and the old validator", async () => {
  const fake = (async () => new Response(null, { status: 304 })) as typeof fetch;
  const check = new GithubReconcileCheck({ token: "test-token", timeoutMs: 5_000, fetch: fake });
  const outcome = await check.checkDetailed(feedSource({ kind: "github_run", location: "owner/repo", mode: "push", etag: '"old"' }), signal);
  assert.equal(outcome.notModified, true);
  assert.equal(outcome.result.events.length, 0);
  assert.equal(outcome.result.state?.etag, '"old"');
});

test("reconcile refuses to run without a token and maps HTTP failures", async () => {
  const noToken = new GithubReconcileCheck({ token: undefined, timeoutMs: 5_000, fetch: (async () => jsonResponse({})) as typeof fetch });
  await assert.rejects(
    noToken.check(feedSource({ kind: "github_run", location: "owner/repo", mode: "push" }), signal),
    (error) => errorCode(error) === "WATCH_SOURCE_AUTH",
  );

  const rateLimited = new GithubReconcileCheck({
    token: "test-token", timeoutMs: 5_000,
    fetch: (async () => jsonResponse({}, { status: 403, headers: { "x-ratelimit-remaining": "0" } })) as typeof fetch,
  });
  await assert.rejects(
    rateLimited.check(feedSource({ kind: "github_run", location: "owner/repo", mode: "push" }), signal),
    (error) => errorCode(error) === "WATCH_RATE_LIMITED",
  );
});

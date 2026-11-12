/**
 * Reconciliation pass for GitHub sources (spec 5.4).
 *
 * Webhooks are fast but lossy by nature: the relay can go down, D1 retention can drop rows, a
 * deploy can miss deliveries. Reconciliation is the path that does not care — it reads the
 * current terminal-state set over GitHub REST and hands the diff to the store, whose key
 * uniqueness is what makes "terminal state present, event missing" resolvable without a query
 * API: ingesting an already-known key is a no-op, a missing key becomes exactly one event.
 *
 * Deliberate asymmetries:
 * - 304 outcomes write nothing at all: no event, no state, and above all no failure-counter
 *   reset, so a source that keeps failing elsewhere is not silently healed by an unchanged read.
 * - Failures are recorded through `fail()` with the source's *current* nextCheckAt, so the
 *   reconcile path never moves the relay pull schedule; only codes that mean the target is gone
 *   (WATCH_SOURCE_GONE) change anything semantically, and that is the store's decision.
 * - `dueReconcile` is treated as claim-like: it is the only interface member that can advance
 *   `reconcile_at`, so it must move it forward when it returns a source, the same way `claimDue`
 *   moves `next_check_at`. Assumption documented here because the polling half implements it.
 */

import { composeGithubText, createGithubRest, GithubWatchError, type GithubRest, type GithubDraft } from "./github.js";
import type { SourceRow, WatchStore } from "./protocol.js";

const DEFAULT_LIMIT = 10;

export type ReconcileOptions = {
  readonly store: WatchStore;
  readonly rest: GithubRest;
  readonly log?: (line: string) => void;
  readonly limit?: number;
};

export type ReconcileSummary = {
  sources: number;
  baseline: number;
  queued: number;
  notModified: number;
  failed: number;
};

function isGithubKind(kind: SourceRow["kind"]): boolean {
  return kind === "github_pr" || kind === "github_run" || kind === "github_events";
}

function failureCodeOf(error: unknown): string {
  if (error instanceof GithubWatchError) return error.code;
  if (error instanceof Error && error.name === "TimeoutError") return "WATCH_FETCH_TIMEOUT";
  if (error instanceof Error && error.name === "AbortError") return "WATCH_FETCH_TIMEOUT";
  return "WATCH_STORE_ERROR";
}

function asEvent(source: SourceRow, draft: GithubDraft): Parameters<WatchStore["ingest"]>[1] {
  return {
    dedupKey: draft.dedupKey,
    kind: draft.kind,
    occurredAt: draft.occurredAt,
    facts: draft.facts,
    text: composeGithubText(source.watcherId, draft),
  };
}

/**
 * One reconcile pass over the due sources. Rate limiting aborts the remaining pass (a failing
 * REST quota should not be burned down source by source); everything else is per source.
 */
export async function runReconcile(options: ReconcileOptions, nowIso: string, signal?: AbortSignal): Promise<ReconcileSummary> {
  const log = options.log ?? (() => undefined);
  const due = options.store.dueReconcile(nowIso, options.limit ?? DEFAULT_LIMIT);
  const summary: ReconcileSummary = { sources: due.length, baseline: 0, queued: 0, notModified: 0, failed: 0 };
  let rateLimited = false;
  for (const source of due) {
    if (signal?.aborted) break;
    if (!isGithubKind(source.kind)) continue;
    if (rateLimited) { log(`watchers reconcile skip source=${source.id} code=WATCH_RATE_LIMITED`); continue; }
    // This path's own baseline marker: REST owns etag/last_modified, so both being null means
    // REST has never successfully read this source — its first read records history silently.
    const baselined = source.etag !== null || source.lastModified !== null;
    try {
      const outcome = await options.rest.read(source, signal ?? new AbortController().signal);
      if (outcome.status === "notModified") {
        summary.notModified += 1;
        log(`watchers reconcile source=${source.id} notModified=1`);
        continue;
      }
      const state = outcome.etag === null ? {} : { etag: outcome.etag };
      if (!baselined) {
        options.store.finish(
          source.id,
          { events: outcome.events.map((draft) => asEvent(source, draft)), state },
          nowIso,
          source.nextCheckAt ?? nowIso,
        );
        summary.baseline += 1;
        log(`watchers reconcile baseline source=${source.id} recorded=${outcome.events.length}`);
        continue;
      }
      let queued = 0;
      for (const draft of outcome.events) {
        if (options.store.ingest(source.id, asEvent(source, draft), nowIso)) queued += 1;
      }
      options.store.finish(source.id, { events: [], state }, nowIso, source.nextCheckAt ?? nowIso);
      summary.queued += queued;
      log(`watchers reconcile source=${source.id} added=${queued} scanned=${outcome.events.length}`);
    } catch (error) {
      if (signal?.aborted) break;
      const code = failureCodeOf(error);
      if (code === "WATCH_RATE_LIMITED") rateLimited = true;
      summary.failed += 1;
      try {
        // Fail without moving the pull schedule: reconciliation failing must not back off the
        // relay long-poll, which may be perfectly healthy. Passing the current nextCheckAt
        // through keeps counters and error codes recorded and lets the store decide on
        // WATCH_SOURCE_GONE (404/410), which it turns into a stopped source.
        options.store.fail(source.id, code, nowIso, source.nextCheckAt ?? nowIso);
        log(`watchers reconcile failed source=${source.id} code=${code}`);
      } catch (recordError) {
        log(`watchers reconcile outcome lost source=${source.id} code=${failureCodeOf(recordError)}`);
      }
    }
  }
  return summary;
}

/** Re-export so the integration layer wires one REST reader without importing github.js directly. */
export { createGithubRest, GithubWatchError };

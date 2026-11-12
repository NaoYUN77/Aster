import type { SourceCheck, SourceCheckResult, SourceRow, WatchersConfig } from "./protocol.js";
import type { WatchRuntimeStore } from "./store.js";
import { FeedCheck } from "./feed.js";
import { GithubReconcileCheck } from "./github.js";
import { watchReasonCode } from "./store.js";

/**
 * The polling half's scheduling loop.
 *
 * `claimDue` already moved the source's next attempt forward, so a slow tick never collides with
 * the next one; this module only decides how long the next wait is. Failure growth is the spec's
 * curve — interval × 2^failures, capped at one hour — and the store turns five consecutive failures
 * into `error`, whose hourly probe this same curve produces. A 304 is routed to `unchanged`, which
 * keeps a backoff it did not earn; a success clears failures and returns to the normal interval.
 */

/** One check, with the fact that a conditional GET answered 304 kept beside its (empty) result. */
export type SourceCheckOutcome = {
  readonly result: SourceCheckResult;
  readonly notModified: boolean;
};

/** Adapters implement this; `SourceCheck.check` stays as the protocol-level shape. */
export interface DetailedSourceCheck extends SourceCheck {
  checkDetailed(source: SourceRow, signal: AbortSignal): Promise<SourceCheckOutcome>;
}

const MAX_BACKOFF_SECONDS = 3_600;
const POLL_CLAIM_LIMIT = 3;
const POLL_LEASE_SECONDS = 120;

/** interval × 2^failures, capped at one hour. */
export function backoffSeconds(intervalSec: number, failuresBefore: number): number {
  const exponent = Math.max(0, Math.min(failuresBefore, 16));
  return Math.min(intervalSec * 2 ** exponent, MAX_BACKOFF_SECONDS);
}

function addSeconds(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1_000).toISOString();
}

/** Choose the adapter for a source. Unknown kinds are refused rather than fetched blind. */
export function createSourceCheck(
  source: SourceRow,
  config: WatchersConfig,
  fetchImpl: typeof fetch = fetch,
): DetailedSourceCheck {
  switch (source.kind) {
    case "feed":
    case "x":
      return new FeedCheck({ timeoutMs: config.fetchTimeoutMs, fetch: fetchImpl });
    case "github_run":
    case "github_pr":
    case "github_events":
      return new GithubReconcileCheck({ timeoutMs: config.fetchTimeoutMs, fetch: fetchImpl, token: config.githubToken });
    default:
      throw Object.assign(new Error("unsupported watch source"), { code: "WATCH_PARSE_FAILED" });
  }
}

export type PollTickOptions = {
  readonly store: WatchRuntimeStore;
  readonly config: WatchersConfig;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly log?: (line: string) => void;
};

/**
 * One scheduling pass: claim up to three due poll sources, check each, and record the outcome.
 * Every failure is contained to its own source, so one broken feed cannot hold the others back.
 */
export async function runPollTick(options: PollTickOptions): Promise<number> {
  const now = (options.now ?? (() => new Date()))();
  const at = now.toISOString();
  const log = options.log ?? ((line: string) => console.error(line));
  const claimed = options.store.claimDue(at, POLL_CLAIM_LIMIT, POLL_LEASE_SECONDS);
  // A function, not a narrowed property: the catch path has to ask again after the await.
  const externallyAborted = (): boolean => options.signal !== undefined && options.signal.aborted;
  let processed = 0;
  for (const source of claimed) {
    if (externallyAborted()) break;
    let check: DetailedSourceCheck;
    try {
      check = createSourceCheck(source, options.config, options.fetch);
    } catch (error) {
      const code = watchReasonCode(error);
      options.store.fail(source.id, code, at, addSeconds(now, backoffSeconds(source.intervalSec, source.failures)));
      log(`Watch poll ${source.id} failed (${code})`);
      continue;
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), Math.max(1_000, options.config.fetchTimeoutMs * 2));
    const signal = options.signal === undefined ? deadline.signal : AbortSignal.any([options.signal, deadline.signal]);
    try {
      const outcome = await check.checkDetailed(source, signal);
      const next = addSeconds(now, source.intervalSec);
      if (outcome.notModified) options.store.unchanged(source.id, outcome.result.state ?? {}, at, next);
      else options.store.finish(source.id, outcome.result, at, next);
      processed += 1;
    } catch (error) {
      if (externallyAborted()) break;
      const code = deadline.signal.aborted ? "WATCH_FETCH_TIMEOUT" : watchReasonCode(error);
      const next = addSeconds(now, backoffSeconds(source.intervalSec, source.failures));
      try {
        options.store.fail(source.id, code, at, next);
      } catch (storeError) {
        log(`Watch poll ${source.id} outcome could not be recorded (${watchReasonCode(storeError)})`);
      }
      log(`Watch poll ${source.id} failed (${code}), failures ${source.failures + 1}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return processed;
}

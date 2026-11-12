import type { WatchersConfig } from "./protocol.js";
import { GithubReconcileCheck } from "./github.js";
import { backoffSeconds } from "./poll.js";
import { watchReasonCode, type WatchRuntimeStore } from "./store.js";

/**
 * Reconciliation for push sources.
 *
 * Webhooks are the fast path, not the authority. Every `githubReconcileMin` minutes the due sources
 * are read from GitHub itself and the store is handed the complete terminal set it can see; the
 * `(source_id, dedup_key)` constraint keeps this from duplicating what the relay already delivered,
 * and the complementary gap — a terminal state that never produced an event — is inserted exactly
 * once. This path shares no state with the relay, so it works when the relay is down.
 */

const RECONCILE_CLAIM_LIMIT = 2;

export type ReconcileTickOptions = {
  readonly store: WatchRuntimeStore;
  readonly config: WatchersConfig;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly log?: (line: string) => void;
  readonly baseUrl?: string;
};

function addSeconds(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1_000).toISOString();
}

export async function runReconcileTick(options: ReconcileTickOptions): Promise<number> {
  const now = (options.now ?? (() => new Date()))();
  const at = now.toISOString();
  const log = options.log ?? ((line: string) => console.error(line));
  const claimed = options.store.dueReconcile(at, RECONCILE_CLAIM_LIMIT);
  const externallyAborted = (): boolean => options.signal !== undefined && options.signal.aborted;
  let processed = 0;
  for (const source of claimed) {
    if (externallyAborted()) break;
    const check = new GithubReconcileCheck({
      token: options.config.githubToken,
      timeoutMs: options.config.fetchTimeoutMs,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    });
    const next = addSeconds(now, source.intervalSec);
    try {
      const outcome = await check.checkDetailed(source, options.signal ?? new AbortController().signal);
      if (outcome.notModified) options.store.unchanged(source.id, outcome.result.state ?? {}, at, next);
      else options.store.finish(source.id, outcome.result, at, next);
      processed += 1;
    } catch (error) {
      if (externallyAborted()) break;
      const code = watchReasonCode(error);
      const retry = addSeconds(now, backoffSeconds(source.intervalSec, source.failures));
      try {
        options.store.fail(source.id, code, at, retry);
      } catch (storeError) {
        log(`Watch reconcile ${source.id} outcome could not be recorded (${watchReasonCode(storeError)})`);
      }
      log(`Watch reconcile ${source.id} failed (${code}), failures ${source.failures + 1}`);
    }
  }
  return processed;
}

/** Delay between reconcile passes, derived only from configuration. */
export function reconcileIntervalSeconds(config: Pick<WatchersConfig, "githubReconcileMin">): number {
  return Math.max(60, Math.min(Math.round(config.githubReconcileMin * 60), 86_400));
}

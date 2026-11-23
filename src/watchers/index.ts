import type { Extension } from "@earendil-works/pi-durable";
import { errorCode } from "../errors.js";
import { localDateKey } from "../routines/time.js";
import type { OutboxRow, WatchersConfig, WatcherRow } from "./protocol.js";
import { RelayClient, runRelayLoop, runRelayOnce, type RelayTickResult } from "./relay.js";
import { runPollTick } from "./poll.js";
import { runReconcileTick } from "./reconcile.js";
import type { WatchRuntimeStore } from "./store.js";
import { createWatchersExtension } from "./tools.js";
import {
  DEFAULT_WATCH_DIGEST_TIME,
  DEFAULT_WATCH_QUIET_HOURS,
  DEFAULT_WATCH_TIMEZONE,
  formatFallbackDigest,
  isDigestDue,
  isInQuietHours,
  type WatchTriageItem,
  type WatchTriageRunner,
} from "./triage.js";

export {
  createSubagentWatchTriageRunner,
  formatFallbackDigest,
  isDigestDue,
  isInQuietHours,
  parseQuietHours,
  parseTriageDecisions,
  resolveTriageModelRef,
  type SubagentWatchTriageOptions,
  type WatchTriageDecision,
  type WatchTriageItem,
  type WatchTriageRunner,
} from "./triage.js";

/**
 * Wiring factory for the integration layer.
 *
 * The coordinator owns startup order, the database path and the channel; this factory owns what
 * belongs to the feature: the tool extension, one periodic loop for polling/reconcile/delivery, and
 * one long-poll loop for the relay. It reads no environment and opens no new timer per source, so
 * shutdown is a single abort and every path shares the one SQLite connection the caller passed in.
 */

/** One synchronous tick for operators and tests: poll, reconcile, then deliver what is due. */
const TICK_MS = 15_000;
const OUTBOX_BATCH = 20;
const MERGE_BATCH = 50;
const TRIAGE_BATCH_SIZE = 10;
const MAX_TRIAGE_RETRIES = 3;
const GITHUB_WATCH_KINDS = new Set(["github_run", "github_pr", "github_events"]);

export type DeliverFn = (
  chatId: string,
  text: string,
  threadTs: string | undefined,
  signal: AbortSignal,
  /** Host-side idempotency key; a web host uses it so a crash cannot repeat one outbox row. */
  deliveryKey?: string,
) => Promise<string>;

export type WatchersOptions = {
  readonly store: WatchRuntimeStore;
  readonly config: WatchersConfig;
  /** Host delivery callback; it receives only a chat id taken from the watcher row. */
  readonly deliver: DeliverFn;
  /** Host-resolved conversation used by the model-facing tools. */
  readonly chatId?: string;
  /** Host-resolved thread anchor, static for a single-owner deployment. */
  readonly threadTs?: string;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
  readonly fetch?: typeof fetch;
  /** The channel's own classification; `uncertain` is never retried automatically. */
  readonly classifyFailure?: (error: unknown) => "failed" | "uncertain";
  readonly failureCode?: (error: unknown) => string;
  /** Tests inject the GitHub API origin; production leaves it undefined. */
  readonly githubBaseUrl?: string;
  /** Optional Sub-agent triage & digest runner. When absent, all watchers deliver directly. */
  readonly triage?: WatchTriageRunner;
};

export type WatchersRuntime = {
  /** Absent when the feature is disabled; register it with the agent only then. */
  readonly extension: Extension | undefined;
  start(): void;
  stop(): Promise<void>;
  /** Run one complete pass without timers. */
  tickOnce(signal?: AbortSignal): Promise<{ polled: number; reconciled: number; delivered: number }>;
  /** Run one relay pull without the loop. */
  relayOnce(signal?: AbortSignal): Promise<RelayTickResult>;
  /** Immediately summarize, deliver, and clear queued digest items for one chat. */
  flushDigest(chatId: string, signal?: AbortSignal): Promise<{ readonly count: number; readonly text: string }>;
};

function addSeconds(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1_000).toISOString();
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function createWatchers(options: WatchersOptions): WatchersRuntime {
  const store = options.store;
  const config = options.config;
  const log = options.log ?? ((line: string) => console.error(line));
  const now = options.now ?? (() => new Date());
  const classify = options.classifyFailure ?? (() => "failed" as const);
  const failureCode = options.failureCode ?? ((error: unknown) => errorCode(error));
  const stop = new AbortController();
  const signal = options.signal === undefined ? stop.signal : AbortSignal.any([options.signal, stop.signal]);
  const timezone = config.timezone ?? DEFAULT_WATCH_TIMEZONE;
  const quietHours = config.quietHours === undefined ? DEFAULT_WATCH_QUIET_HOURS : config.quietHours;
  const digestTime = config.digestTime ?? DEFAULT_WATCH_DIGEST_TIME;
  const extension = config.enabled
    ? createWatchersExtension(store, {
        config,
        ...(options.chatId === undefined ? {} : { chatId: options.chatId }),
        ...(options.threadTs === undefined ? {} : { threadTs: options.threadTs }),
        flushDigest: (chatId, flushSignal) => flushDigestForChat(chatId, flushSignal ?? signal),
      })
    : undefined;
  const relay = config.relayUrl !== undefined && config.relayToken !== undefined
    ? new RelayClient({
        url: config.relayUrl,
        token: config.relayToken,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      })
    : undefined;

  /**
   * Deliver pending outbox rows in order. When a chat has already received `maxPerHour` updates in
   * the last hour, the rest of that chat's queue is merged into one "还有 N 条" line instead of being
   * dropped or sent one by one.
   */
  async function runOutboxTick(runSignal: AbortSignal): Promise<number> {
    let delivered = 0;
    const pending = store.pending(OUTBOX_BATCH);
    if (options.triage === undefined) {
      for (const row of pending) {
        if (runSignal.aborted) break;
        if (overRateLimit(row)) {
          delivered += await mergeRemaining(row, runSignal);
          continue;
        }
        if (!store.claimOutbox(row.id)) continue;
        delivered += await sendOne(row, runSignal);
      }
      delivered += await runDigestTick(runSignal);
      return delivered;
    }

    const directRows: OutboxRow[] = [];
    const triageGroups = new Map<number, { watcher: WatcherRow; rows: OutboxRow[] }>();

    for (const row of pending) {
      const watcher = store.getWatcher(row.watcherId);
      if (watcher === undefined || watcher.deliveryMode === "direct") {
        directRows.push(row);
        continue;
      }
      let group = triageGroups.get(row.watcherId);
      if (group === undefined) {
        group = { watcher, rows: [] };
        triageGroups.set(row.watcherId, group);
      }
      if (group.rows.length < TRIAGE_BATCH_SIZE) {
        group.rows.push(row);
      }
    }

    for (const row of directRows) {
      if (runSignal.aborted) break;
      if (overRateLimit(row)) {
        delivered += await mergeRemaining(row, runSignal);
        continue;
      }
      if (!store.claimOutbox(row.id)) continue;
      delivered += await sendOne(row, runSignal);
    }

    for (const group of triageGroups.values()) {
      if (runSignal.aborted) break;
      delivered += await triageGroup(group.watcher, group.rows, runSignal);
    }

    if (!runSignal.aborted) {
      delivered += await runDigestTick(runSignal);
    }
    return delivered;
  }

  async function triageGroup(watcher: WatcherRow, rows: readonly OutboxRow[], runSignal: AbortSignal): Promise<number> {
    const claimed: OutboxRow[] = [];
    for (const row of rows) {
      if (store.claimOutbox(row.id)) {
        // Re-read attempt increment reflected in memory for retry accounting.
        claimed.push({ ...row, attempts: row.attempts + 1 });
      }
    }
    if (claimed.length === 0) return 0;

    const currentNow = now();
    const inQuietHours = isInQuietHours(currentNow, timezone, quietHours);
    const items: WatchTriageItem[] = claimed.map((row) => ({
      outboxId: row.id,
      eventId: row.eventId,
      watcher,
      text: row.text,
      facts: store.eventFacts(row.eventId),
      createdAt: row.createdAt,
    }));

    try {
      const decisions = await options.triage!.triageBatch({
        watcher,
        items,
        now: currentNow,
        timezone,
        inQuietHours,
      }, runSignal);
      const byId = new Map(decisions.map((d) => [d.outboxId, d]));
      let delivered = 0;

      for (const row of claimed) {
        if (runSignal.aborted) break;
        const decision = byId.get(row.id);
        const nowIso = now().toISOString();
        if (decision === undefined) {
          delivered += await fallbackRow(watcher, row, "WATCH_TRIAGE_MISSING", runSignal);
          continue;
        }
        if (decision.action === "suppress") {
          store.suppress(row.id, decision.reason, nowIso);
          continue;
        }
        if (decision.action === "digest") {
          store.queueDigest(row.id, decision.summary, decision.reason, false, nowIso);
          continue;
        }
        // action === "notify"
        if (inQuietHours && !decision.urgent) {
          store.queueDigest(row.id, decision.summary, `quiet_hours: ${decision.reason}`, false, nowIso);
          continue;
        }
        if (overRateLimit(row) && !decision.urgent) {
          store.queueDigest(row.id, decision.summary, `rate_limited: ${decision.reason}`, false, nowIso);
          continue;
        }
        try {
          const messageId = await options.deliver(
            row.chatId,
            decision.summary,
            row.threadTs ?? undefined,
            runSignal,
            `watch:${row.id}`,
          );
          store.sentWithTriage(row.id, messageId, now().toISOString(), {
            action: "notify",
            reason: decision.reason,
            urgent: decision.urgent,
            text: decision.summary,
          });
          delivered += 1;
        } catch (error) {
          if (runSignal.aborted) return delivered;
          recordFailure(row, error);
        }
      }
      return delivered;
    } catch (error) {
      if (runSignal.aborted) return 0;
      const code = errorCode(error);
      log(`Watch triage failed for watcher #${watcher.id} (${code}); applying fallback`);
      let delivered = 0;
      for (const row of claimed) {
        if (runSignal.aborted) break;
        delivered += await fallbackRow(watcher, row, code, runSignal);
      }
      return delivered;
    }
  }

  async function fallbackRow(
    watcher: WatcherRow,
    row: OutboxRow,
    code: string,
    runSignal: AbortSignal,
  ): Promise<number> {
    if (GITHUB_WATCH_KINDS.has(watcher.kind)) {
      return await sendOne(row, runSignal);
    }
    if (row.attempts < MAX_TRIAGE_RETRIES) {
      store.requeuePending(row.id, code);
      return 0;
    }
    store.queueDigest(row.id, row.text, `triage_fallback: ${code}`, false, now().toISOString());
    return 0;
  }

  async function runDigestTick(runSignal: AbortSignal): Promise<number> {
    if (options.chatId === undefined) return 0;
    const metaKey = `last_digest_date:${options.chatId}`;
    const check = isDigestDue(now(), timezone, digestTime, store.meta(metaKey));
    if (!check.due) return 0;
    const result = await flushDigestForChat(options.chatId, runSignal, check.dateKey);
    return result.count > 0 ? 1 : 0;
  }

  async function flushDigestForChat(
    chatId: string,
    runSignal: AbortSignal,
    dailyDateKey?: string,
  ): Promise<{ readonly count: number; readonly text: string }> {
    const metaKey = `last_digest_date:${chatId}`;
    const queued = store.queuedDigest(chatId, 50);
    if (queued.length === 0) {
      if (dailyDateKey !== undefined) store.setMeta(metaKey, dailyDateKey);
      return { count: 0, text: "" };
    }
    const currentNow = now();
    const dateKey = dailyDateKey ?? localDateKey(currentNow, timezone);
    const text = options.triage === undefined
      ? formatFallbackDigest(queued, dateKey)
      : await options.triage.summarizeDigest({ items: queued, now: currentNow, timezone }, runSignal);
    const deliveryKey = dailyDateKey !== undefined
      ? `watch-digest:${dailyDateKey}`
      : `watch-digest-manual:${queued[0]!.id}:${queued[queued.length - 1]!.id}`;
    const messageId = await options.deliver(chatId, text, options.threadTs, runSignal, deliveryKey);
    store.markDigestSent(queued.map((row) => row.id), messageId, now().toISOString());
    if (dailyDateKey !== undefined) store.setMeta(metaKey, dailyDateKey);
    return { count: queued.length, text };
  }

  function overRateLimit(row: OutboxRow): boolean {
    return store.sentLastHour(row.chatId, addSeconds(now(), -3_600)) >= config.maxPerHour;
  }

  async function sendOne(row: OutboxRow, runSignal: AbortSignal): Promise<number> {
    try {
      const messageId = await options.deliver(
        row.chatId,
        row.text,
        row.threadTs ?? undefined,
        runSignal,
        `watch:${row.id}`,
      );
      store.sent(row.id, messageId, now().toISOString());
      return 1;
    } catch (error) {
      if (runSignal.aborted) return 0;
      recordFailure(row, error);
      return 0;
    }
  }

  async function mergeRemaining(row: OutboxRow, runSignal: AbortSignal): Promise<number> {
    // Claim only pending rows; a row already being sent elsewhere is left alone.
    const claimed = store.pendingForChat(row.chatId, MERGE_BATCH).filter((candidate) => store.claimOutbox(candidate.id));
    if (claimed.length === 0) return 0;
    const text = `[跟踪] 还有 ${claimed.length} 条更新未逐条推送。`;
    try {
      const messageId = await options.deliver(
        row.chatId,
        text,
        row.threadTs ?? undefined,
        runSignal,
        `watch-merge:${row.id}`,
      );
      for (const candidate of claimed) store.sent(candidate.id, messageId, now().toISOString());
      return 1;
    } catch (error) {
      if (runSignal.aborted) return 0;
      for (const candidate of claimed) recordFailure(candidate, error);
      return 0;
    }
  }

  function recordFailure(row: OutboxRow, error: unknown): void {
    const uncertain = classify(error) === "uncertain";
    try {
      store.failed(row.id, failureCode(error), now().toISOString(), uncertain);
    } catch (recordError) {
      // Leaving it `sending` is safe: the next start records it as uncertain.
      log(`Watch delivery ${row.id} outcome could not be recorded (${errorCode(recordError)})`);
    }
    log(`Watch delivery ${uncertain ? "uncertain" : "failed"}: ${row.id} (${failureCode(error)})`);
  }

  async function tickOnce(runSignal: AbortSignal): Promise<{ polled: number; reconciled: number; delivered: number }> {
    if (!config.enabled) return { polled: 0, reconciled: 0, delivered: 0 };
    const polled = await runPollTick({
      store,
      config,
      now,
      signal: runSignal,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      log,
    });
    const reconciled = await runReconcileTick({
      store,
      config,
      now,
      signal: runSignal,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.githubBaseUrl === undefined ? {} : { baseUrl: options.githubBaseUrl }),
      log,
    });
    const delivered = await runOutboxTick(runSignal);
    return { polled, reconciled, delivered };
  }

  async function relayOnce(runSignal: AbortSignal): Promise<RelayTickResult> {
    if (relay === undefined) return { ok: false, gap: false, advanced: false, dropped: 0 };
    return runRelayOnce({ store, client: relay, now, signal: runSignal, log });
  }

  let started = false;
  let loop: Promise<void> | undefined;
  let relayLoop: Promise<void> | undefined;

  async function loopBody(runSignal: AbortSignal): Promise<void> {
    while (!runSignal.aborted) {
      if (config.enabled) {
        try {
          await tickOnce(runSignal);
        } catch (error) {
          log(`Watch pass failed (${errorCode(error)})`);
        }
      }
      if (runSignal.aborted) break;
      await defaultSleep(TICK_MS, runSignal);
    }
  }

  return {
    extension,
    start(): void {
      if (started || !config.enabled) return;
      started = true;
      // Startup recovery happens once, before the first pass can claim anything.
      const recovered = store.recoverInterrupted(now().toISOString());
      if (recovered > 0) log(`Watch delivery recovered: ${recovered} uncertain`);
      loop = loopBody(signal).catch((error: unknown) => {
        log(`Watch loop stopped (${errorCode(error)})`);
      });
      if (relay !== undefined) {
        relayLoop = runRelayLoop({ store, client: relay, now, signal, log }).catch((error: unknown) => {
          log(`Watch relay loop stopped (${errorCode(error)})`);
        });
      }
    },
    async stop(): Promise<void> {
      stop.abort();
      await Promise.all([loop?.catch(() => undefined), relayLoop?.catch(() => undefined)]);
      loop = undefined;
      relayLoop = undefined;
      started = false;
    },
    tickOnce(runSignal = signal) {
      return tickOnce(runSignal);
    },
    relayOnce(runSignal = signal) {
      return relayOnce(runSignal);
    },
    flushDigest(chatId: string, flushSignal = signal) {
      return flushDigestForChat(chatId, flushSignal);
    },
  };
}

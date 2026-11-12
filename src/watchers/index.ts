import type { Extension } from "@earendil-works/pi-durable";
import { errorCode } from "../errors.js";
import type { OutboxRow, WatchersConfig } from "./protocol.js";
import { RelayClient, runRelayLoop, runRelayOnce, type RelayTickResult } from "./relay.js";
import { runPollTick } from "./poll.js";
import { runReconcileTick } from "./reconcile.js";
import type { WatchRuntimeStore } from "./store.js";
import { createWatchersExtension } from "./tools.js";

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

export type DeliverFn = (
  chatId: string,
  text: string,
  threadTs: string | undefined,
  signal: AbortSignal,
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
  const extension = config.enabled
    ? createWatchersExtension(store, {
        config,
        ...(options.chatId === undefined ? {} : { chatId: options.chatId }),
        ...(options.threadTs === undefined ? {} : { threadTs: options.threadTs }),
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
    for (const row of pending) {
      if (runSignal.aborted) break;
      if (overRateLimit(row)) {
        delivered += await mergeRemaining(row, runSignal);
        continue;
      }
      if (!store.claimOutbox(row.id)) continue;
      delivered += await sendOne(row, runSignal);
    }
    return delivered;
  }

  function overRateLimit(row: OutboxRow): boolean {
    return store.sentLastHour(row.chatId, addSeconds(now(), -3_600)) >= config.maxPerHour;
  }

  async function sendOne(row: OutboxRow, runSignal: AbortSignal): Promise<number> {
    try {
      const messageId = await options.deliver(row.chatId, row.text, row.threadTs ?? undefined, runSignal);
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
      const messageId = await options.deliver(row.chatId, text, row.threadTs ?? undefined, runSignal);
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
  };
}

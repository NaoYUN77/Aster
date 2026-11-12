import type { DeliveryChannel } from "../channel.js";
import {
  WATCH_REASON_CODES,
  type OutboxRow,
  type SourceCheck,
  type SourceRow,
  type WatchersConfig,
  type WatchReasonCode,
} from "./protocol.js";
import { WatcherError, type WatcherStore } from "./store.js";

/**
 * One scheduling pass, shared by polling and delivery. The host owns the only timer and calls this
 * repeatedly; nothing here starts a loop or holds state between passes. Three properties matter:
 *
 * 1. A check can never block the others: claims are independent rows, each check has its own deadline
 *    and its own failure accounting, and a transport error only backs that one source off.
 * 2. The first successful check of a source is a baseline. Recovery after failures still lands on the
 *    baseline path, so a watch that failed to start never replays its backlog.
 * 3. Delivery is bounded per chat per hour. When the budget is spent, the rest of that chat's queued
 *    events become one "N more" message instead of being dropped silently.
 */

const MAX_POLL_BATCH = 3;
const MAX_DELIVERY_BATCH = 200;
const MAX_BACKOFF_SECONDS = 3_600;

/** Resolves the adapter for a source row. An unknown kind is a host configuration gap, not a crash. */
export type SourceResolver = (source: SourceRow) => SourceCheck | undefined;

export type PollTickOptions = {
  readonly store: WatcherStore;
  readonly config: WatchersConfig;
  readonly sourceFor: SourceResolver;
  /** Absent when the host does not want delivery from this tick (tests, operator tooling). */
  readonly channel?: DeliveryChannel;
  readonly signal: AbortSignal;
  readonly now?: () => Date;
  /** Receives reason codes and ids only; never event text or a URL. */
  readonly log?: (line: string) => void;
  readonly limit?: number;
};

export type PollTickResult = {
  readonly checked: number;
  readonly queued: number;
  readonly delivered: number;
  readonly failed: number;
  readonly skipped: number;
};

/**
 * `1x, 2x, 4x, …` of the source interval, capped at one hour. `failures` is the count *before* the
 * attempt that just failed, so the first failure waits one interval, not two.
 */
export function backoffSeconds(intervalSec: number, failures: number): number {
  const interval = Math.max(1, Math.trunc(intervalSec));
  const exponent = Math.max(0, Math.min(Math.trunc(failures), 16));
  return Math.min(interval * 2 ** exponent, MAX_BACKOFF_SECONDS);
}

export async function runPollTick(options: PollTickOptions): Promise<PollTickResult> {
  const { store, config, sourceFor, channel, signal } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.error(line));
  const nowDate = now();
  const nowIso = nowDate.toISOString();

  let delivered = 0;
  let failed = 0;
  if (channel !== undefined) {
    const result = await deliverOutbox(store, channel, config, nowIso, nowDate, signal, log);
    delivered = result.delivered;
    failed = result.failed;
  }

  if (signal.aborted) return { checked: 0, queued: 0, delivered, failed, skipped: 0 };
  const lease = Math.max(30, Math.ceil((config.fetchTimeoutMs * 2) / 1_000));
  const claimed = store.claimDue(nowIso, Math.max(1, Math.min(options.limit ?? MAX_POLL_BATCH, MAX_POLL_BATCH)), lease);
  let checked = 0;
  let queued = 0;
  let skipped = 0;

  const outcomes = await Promise.allSettled(claimed.map(async (source) => {
    if (signal.aborted) return { kind: "skipped" as const };
    const adapter = sourceFor(source);
    if (adapter === undefined) {
      // No adapter means the host does not know this kind: back off rather than stop the watch.
      const code: WatchReasonCode = "WATCH_TARGET_INVALID";
      store.fail(source.id, code, nowIso, nextIso(nowDate, backoffSeconds(source.intervalSec, source.failures)));
      log(`watch poll failed: source=${source.id} code=${code}`);
      return { kind: "failed" as const };
    }
    try {
      const result = await adapter.check(source, signal);
      if (signal.aborted) return { kind: "skipped" as const };
      const next = new Date(nowDate.getTime() + Math.max(1, source.intervalSec) * 1_000).toISOString();
      const newEvents = store.finish(source.id, result, nowIso, next);
      log(`watch poll ok: source=${source.id} events=${result.events.length} queued=${newEvents}`);
      return { kind: "ok" as const, queued: newEvents, checked: 1 };
    } catch (error) {
      if (signal.aborted) return { kind: "skipped" as const };
      const code = reasonCode(error);
      const wait = backoffSeconds(source.intervalSec, source.failures);
      try {
        store.fail(source.id, code, nowIso, nextIso(nowDate, wait));
      } catch (recordError) {
        // The lease still keeps other passes off this row; the next startup re-derives its state.
        log(`watch poll failure could not be recorded: source=${source.id} code=${reasonCode(recordError)}`);
      }
      log(`watch poll failed: source=${source.id} code=${code}`);
      return { kind: "failed" as const };
    }
  }));

  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      log(`watch poll task rejected code=${reasonCode(outcome.reason)}`);
      failed += 1;
      continue;
    }
    const value = outcome.value;
    if (value.kind === "skipped") skipped += 1;
    else if (value.kind === "failed") failed += 1;
    else {
      checked += value.checked;
      queued += value.queued;
    }
  }
  return { checked, queued, delivered, failed, skipped };
}

/**
 * Drains the outbox. A row is claimed (`pending -> sending`) before the channel is called, so a crash
 * in between is visible as `sending` and becomes `uncertain` on the next start instead of being sent
 * twice. Per-chat hourly budget is counted from delivered rows, which survives a restart.
 */
export async function deliverOutbox(
  store: WatcherStore,
  channel: DeliveryChannel,
  config: WatchersConfig,
  nowIso: string,
  nowDate: Date,
  signal: AbortSignal,
  log: (line: string) => void,
): Promise<{ delivered: number; failed: number }> {
  const pending = store.pending(MAX_DELIVERY_BATCH);
  if (pending.length === 0) return { delivered: 0, failed: 0 };
  const byChat = new Map<string, OutboxRow[]>();
  for (const row of pending) {
    const group = byChat.get(row.chatId);
    if (group === undefined) byChat.set(row.chatId, [row]);
    else group.push(row);
  }
  const hourAgo = new Date(nowDate.getTime() - 3_600_000).toISOString();
  let delivered = 0;
  let failed = 0;
  for (const [chatId, rows] of byChat) {
    if (signal.aborted) break;
    let allowance = Math.max(0, config.maxPerHour - store.sentCount(chatId, hourAgo));
    let index = 0;
    for (; index < rows.length && allowance > 0; index++) {
      if (signal.aborted) break;
      const row = rows[index];
      if (row === undefined || !store.claimOutbox(row.id)) continue;
      allowance -= 1;
      if (await sendRow(store, channel, row, nowIso, signal, log)) delivered += 1;
      else failed += 1;
    }
    const leftovers = rows.slice(index).filter((row) => store.claimOutbox(row.id));
    if (leftovers.length > 0 && !signal.aborted) {
      const count = leftovers.length;
      const text = `[跟踪] 还有 ${count} 条更新`;
      const anchor = leftovers[0]?.threadTs ?? undefined;
      try {
        const messageId = await channel.send(chatId, text, signal, anchor);
        for (const row of leftovers) {
          try {
            store.sent(row.id, messageId, nowIso);
          } catch (recordError) {
            log(`watch delivery outcome could not be recorded: id=${row.id} code=${reasonCode(recordError)}`);
          }
        }
        delivered += count;
        log(`watch delivery merged: chat=${chatId} count=${count}`);
      } catch (error) {
        const status = channel.classifyFailure(error);
        const code = channel.failureCode(error);
        for (const row of leftovers) store.failed(row.id, code, nowIso, status === "uncertain");
        failed += count;
        log(`watch delivery merged failed: chat=${chatId} count=${count} code=${code}`);
      }
    }
  }
  return { delivered, failed };
}

async function sendRow(
  store: WatcherStore,
  channel: DeliveryChannel,
  row: OutboxRow,
  nowIso: string,
  signal: AbortSignal,
  log: (line: string) => void,
): Promise<boolean> {
  let messageId: string;
  try {
    messageId = await channel.send(row.chatId, row.text, signal, row.threadTs ?? undefined);
  } catch (error) {
    // An explicit rejection is `failed`; a transport error or shutdown is `uncertain`. Neither is resent.
    const status = channel.classifyFailure(error);
    const code = channel.failureCode(error);
    try {
      store.failed(row.id, code, nowIso, status === "uncertain");
    } catch (recordError) {
      log(`watch delivery outcome could not be recorded: id=${row.id} code=${reasonCode(recordError)}`);
    }
    log(`watch delivery ${status}: id=${row.id} code=${code}`);
    return false;
  }
  // The channel accepted the message; a local write failure must not look like a send failure. The row
  // stays `sending`, so startup recovery records it as uncertain instead of resending it.
  try {
    store.sent(row.id, messageId, nowIso);
    return true;
  } catch (recordError) {
    log(`watch delivery outcome could not be recorded: id=${row.id} code=${reasonCode(recordError)}`);
    return false;
  }
}

function nextIso(now: Date, seconds: number): string {
  return new Date(now.getTime() + Math.max(1, seconds) * 1_000).toISOString();
}

/**
 * A check failure is reported by a fixed reason code. An unknown error is treated as transient: the
 * source backs off, and no foreign message (which could embed a URL, a body or a credential) survives.
 */
function reasonCode(error: unknown): WatchReasonCode {
  if (error instanceof WatcherError) return error.code;
  if (error instanceof Error && "code" in error && typeof error.code === "string"
    && (WATCH_REASON_CODES as readonly string[]).includes(error.code)) {
    return error.code as WatchReasonCode;
  }
  if (error instanceof Error && error.name === "TimeoutError") return "WATCH_FETCH_TIMEOUT";
  return "WATCH_FETCH_TIMEOUT";
}

import { splitReply } from "../messages.js";
import { errorCode } from "../errors.js";
import { NO_REPORT, ROUTINE_DEFAULTS, type RoutineRow, type RoutineRunRequest, type RoutineRunner, type RoutineTickResult, type RunRow, type RoutinesConfig } from "./protocol.js";
import { isNoReport, type SqliteRoutineStore } from "./store.js";
import { addLocalDays, localDateKey, localParts, minutesOfDay, pad, timeOfDayParts, zonedInstant } from "./time.js";

const IDLE_WAKE_MS = 60_000;
const RUN_LEASE_MS = 20 * 60_000;
const MAX_DISPATCH_PER_TICK = 10;
const RETRYABLE = new Set(["AGENT_TIMEOUT", "AGENT_UNANSWERED", "AGENT_TRUNCATED", "EMPTY_REPLY"]);

export type DeliverFn = (chatId: string, text: string, signal: AbortSignal) => Promise<string>;

export type RoutinesRuntimeOptions = {
  readonly store: SqliteRoutineStore;
  readonly config: RoutinesConfig;
  /** The owner's chat; a routine never chooses where its result goes. */
  readonly chatId: string;
  readonly deliver: DeliverFn;
  readonly run: RoutineRunner;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
  readonly classifyFailure?: (error: unknown) => "failed" | "uncertain";
  readonly failureCode?: (error: unknown) => string;
};

export type RoutinesRuntime = {
  start(): void;
  stop(): Promise<void>;
  /** One deterministic pass, exposed for tests and for an operator flush. */
  tickOnce(signal?: AbortSignal): Promise<RoutineTickResult>;
};

/**
 * The scheduler and executor. It owns no timer per routine: one loop reads SQLite, claims what is
 * due and runs it, exactly like the reminder scheduler. A run is a durable row before it is work, so
 * a crash between claim and delivery is visible instead of silently lost.
 */
export function createRoutines(options: RoutinesRuntimeOptions): RoutinesRuntime {
  const store = options.store;
  const config = options.config;
  const log = options.log ?? ((line: string) => console.error(line));
  const now = options.now ?? (() => new Date());
  const stop = new AbortController();
  const signal = options.signal === undefined ? stop.signal : AbortSignal.any([options.signal, stop.signal]);
  const classify = options.classifyFailure ?? (() => "failed" as const);
  const failureCode = options.failureCode ?? ((error: unknown) => errorCode(error));
  let started = false;
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;
  let wakeRequested = false;
  let unsubscribe: (() => void) | undefined;
  let pausedLogged = false;

  async function deliverText(text: string, runSignal: AbortSignal): Promise<number> {
    const parts = splitReply(text.trim(), 4_000).filter((part) => part !== "");
    if (parts.length === 0) throw Object.assign(new Error("Routine produced no text"), { code: "EMPTY_REPLY" });
    let sent = 0;
    for (const part of parts) {
      if (runSignal.aborted) throw new Error("Routine delivery aborted");
      await options.deliver(options.chatId, part, runSignal);
      sent += 1;
    }
    return sent;
  }

  function localStamp(instant: Date, timeZone: string): string {
    const parts = localParts(instant, timeZone);
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
  }

  function renderTemplate(template: string, routine: RoutineRow, instant: Date): string {
    const parts = localParts(instant, routine.timezone);
    const values: Record<string, string> = {
      date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
      time: `${pad(parts.hour)}:${pad(parts.minute)}`,
      title: routine.title,
      id: String(routine.id),
    };
    return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole);
  }

  function promptFor(routine: RoutineRow, run: RunRow, instant: Date): string {
    const header = run.trigger === "manual"
      ? `【立即运行】${localStamp(instant, routine.timezone)} (${routine.timezone})`
      : `【定时运行】${localStamp(instant, routine.timezone)} (${routine.timezone})`;
    const report = routine.delivery === "report"
      ? `如果没有需要告知主人的内容，只回复 ${NO_REPORT}，不要写别的内容。`
      : "把最终结果写成要直接发给主人的一段纯文本。";
    return `${header}
这是常驻任务「${routine.title}」的自动执行。主人此刻不在对话中，不会回答你的问题；请独立完成，不要提问。
${report}`;
  }

  async function execute(run: RunRow, runSignal: AbortSignal): Promise<{ delivered: number; failed: boolean }> {
    const routine = store.get(run.routineId);
    if (routine === undefined) {
      store.finish(run.id, "skipped", { errorCode: "ROUTINE_NOT_FOUND" });
      return { delivered: 0, failed: false };
    }
    if (routine.status !== "active") {
      store.finish(run.id, "skipped", { errorCode: `ROUTINE_${routine.status.toUpperCase()}` });
      return { delivered: 0, failed: false };
    }
    // The confirmed default is no hard cap (0); when an operator turns one on, it is a hard stop
    // with one notice per local day, not a silent skip.
    if (routine.mode === "agent" && config.maxRunsPerDay > 0) {
      const parts = localParts(now(), config.timezone);
      const start = zonedInstant({ ...parts, hour: 0, minute: 0 }, config.timezone);
      const tomorrow = addLocalDays(parts, 1);
      const end = zonedInstant({ ...tomorrow, hour: 0, minute: 0 }, config.timezone);
      const today = store.usage(start.toISOString(), end.toISOString());
      if (today.agentRuns >= config.maxRunsPerDay) {
        store.finish(run.id, "skipped", { errorCode: "DAILY_LIMIT" });
        const key = `limit:${localDateKey(now(), config.timezone)}`;
        if (store.meta(key) === undefined) {
          store.setMeta(key, "1");
          await deliverText(
            `常驻任务今日 agent 运行额度已用完（${config.maxRunsPerDay} 次），本次「${routine.title}」只记录未执行。`,
            runSignal,
          );
        }
        return { delivered: 0, failed: false };
      }
    }
    try {
      if (routine.mode === "notify") {
        const text = renderTemplate(routine.text ?? "", routine, now());
        if (text.trim() === "") throw Object.assign(new Error("Notify routine has no text"), { code: "EMPTY_REPLY" });
        const sent = await deliverText(text, runSignal);
        store.finish(run.id, "succeeded", { reply: text });
        store.markSuccess(routine.id);
        return { delivered: sent, failed: false };
      }
      const request: RoutineRunRequest = {
        routineId: routine.id,
        title: routine.title,
        brief: routine.brief ?? "",
        timezone: routine.timezone,
        delivery: routine.delivery,
        conversationId: routine.conversationId ?? undefined,
        text: promptFor(routine, run, now()),
        requestId: `routine:${routine.id}:${run.runKey}`,
        signal: runSignal,
        timeoutMs: config.runTimeoutMs,
      };
      const result = await options.run(request);
      if (routine.conversationId !== result.conversationId) store.setConversation(routine.id, result.conversationId);
      if (routine.delivery === "report" && isNoReport(result.text)) {
        store.finish(run.id, "suppressed", { reply: result.text });
        store.markSuccess(routine.id);
        return { delivered: 0, failed: false };
      }
      const sent = await deliverText(result.text, runSignal);
      store.finish(run.id, "succeeded", { reply: result.text });
      store.markSuccess(routine.id);
      return { delivered: sent, failed: false };
    } catch (error) {
      if (runSignal.aborted) throw error;
      const code = failureCode(error);
      const retryable = RETRYABLE.has(code);
      const attempts = run.attempts;
      if (retryable && attempts < ROUTINE_DEFAULTS.maxAttempts) {
        store.retry(run.id, new Date(now().getTime() + ROUTINE_DEFAULTS.retryDelaySec * 1_000));
        log(`Routine #${routine.id} run ${run.id} will retry after ${ROUTINE_DEFAULTS.retryDelaySec}s (${code})`);
        return { delivered: 0, failed: true };
      }
      store.finish(run.id, "failed", { errorCode: code });
      const failures = store.markFailure(routine.id, code);
      log(`Routine #${routine.id} run ${run.id} failed (${code})`);
      await alertFailures(routine, code, failures, runSignal);
      return { delivered: 0, failed: true };
    }
  }

  async function alertFailures(routine: RoutineRow, code: string, failures: number, runSignal: AbortSignal): Promise<void> {
    if (failures < ROUTINE_DEFAULTS.consecutiveFailureAlert) return;
    const key = `alert:${routine.id}:${localDateKey(now(), routine.timezone)}`;
    if (store.meta(key) !== undefined) return;
    store.setMeta(key, "1");
    try {
      await deliverText(
        `常驻任务「${routine.title}」(#${routine.id}) 已连续失败 ${failures} 次：${code}。它仍会按计划重试。`,
        runSignal,
      );
    } catch (error) {
      log(`Routine failure alert could not be delivered (${failureCode(error)})`);
    }
  }

  /** Daily usage summary and the anomaly alert Jay asked to keep even without a hard cap. */
  async function dailyHousekeeping(runSignal: AbortSignal): Promise<number> {
    if (!config.summaryEnabled) return 0;
    const instant = now();
    const date = localDateKey(instant, config.timezone);
    const parts = localParts(instant, config.timezone);
    const due = timeOfDayParts(config.summaryLocalTime);
    if (minutesOfDay(parts) < minutesOfDay(due)) return 0;
    if (store.meta(`summary:${date}`) !== undefined) return 0;

    const dayStart = zonedInstant({ ...parts, hour: 0, minute: 0 }, config.timezone);
    const nextDay = addLocalDays(parts, 1);
    const dayEnd = zonedInstant({ ...nextDay, hour: 0, minute: 0 }, config.timezone);
    const usage = store.usage(dayStart.toISOString(), dayEnd.toISOString());
    store.setMeta(`summary:${date}`, "1");

    if (usage.agentRuns > 0 || usage.notifyRuns > 0) {
      const top = usage.top.length === 0
        ? ""
        : `最活跃：${usage.top.map((entry) => `#${entry.id} ${entry.title}（${entry.runs} 次）`).join("，")}。`;
      const text = `常驻任务今日用量（${date}）：agent 运行 ${usage.agentRuns} 次`
        + `（成功 ${usage.agentRuns - usage.agentFailures}，失败 ${usage.agentFailures}），通知 ${usage.notifyRuns} 条。${top}`;
      try {
        await deliverText(text, runSignal);
      } catch (error) {
        log(`Routine daily summary could not be delivered (${failureCode(error)})`);
      }
    }

    if (usage.agentRuns >= 5 && store.meta(`anomaly:${date}`) === undefined) {
      let baselineTotal = 0;
      for (let back = 1; back <= 7; back += 1) {
        const start = addLocalDays(parts, -back);
        const end = addLocalDays(parts, -back + 1);
        const startInstant = zonedInstant({ ...start, hour: 0, minute: 0 }, config.timezone);
        const endInstant = zonedInstant({ ...end, hour: 0, minute: 0 }, config.timezone);
        baselineTotal += store.usage(startInstant.toISOString(), endInstant.toISOString()).agentRuns;
      }
      const average = baselineTotal / 7;
      if (usage.agentRuns > Math.max(5, average * 3)) {
        store.setMeta(`anomaly:${date}`, "1");
        try {
          await deliverText(
            `常驻任务用量异常：今天已运行 ${usage.agentRuns} 次，过去 7 天日均 ${average.toFixed(1)} 次。`
            + "回复“停掉所有常驻任务”可以暂停。",
            runSignal,
          );
        } catch (error) {
          log(`Routine anomaly alert could not be delivered (${failureCode(error)})`);
        }
      }
    }
    return 1;
  }

  async function tickOnce(runSignal: AbortSignal = signal): Promise<RoutineTickResult> {
    if (!config.enabled) return { claimed: 0, ran: 0, delivered: 0, failed: 0 };
    if (config.paused) {
      if (!pausedLogged) {
        pausedLogged = true;
        log("Routines are paused by ROUTINES_PAUSED=1; nothing will be dispatched");
      }
      return { claimed: 0, ran: 0, delivered: 0, failed: 0 };
    }
    const claimed = store.claimDue(now(), ROUTINE_DEFAULTS.catchUpGraceHours);
    let ran = 0;
    let delivered = 0;
    let failed = 0;
    for (let dispatched = 0; dispatched < MAX_DISPATCH_PER_TICK; dispatched += 1) {
      if (runSignal.aborted) break;
      const run = store.claimRun(now(), RUN_LEASE_MS);
      if (run === undefined) break;
      let outcome: { delivered: number; failed: boolean };
      try {
        outcome = await execute(run, runSignal);
      } catch (error) {
        if (runSignal.aborted) throw error;
        store.finish(run.id, "failed", { errorCode: failureCode(error) });
        failed += 1;
        log(`Routine run ${run.id} failed before completion (${failureCode(error)})`);
        continue;
      }
      ran += 1;
      delivered += outcome.delivered;
      if (outcome.failed) failed += 1;
    }
    if (!runSignal.aborted) await dailyHousekeeping(runSignal);
    return { claimed: claimed.length, ran, delivered, failed };
  }

  function sleep(ms: number, runSignal: AbortSignal): Promise<void> {
    if (runSignal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        runSignal.removeEventListener("abort", finish);
        if (wake === finish) wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      wake = finish;
      runSignal.addEventListener("abort", finish, { once: true });
    });
  }

  async function loopBody(runSignal: AbortSignal): Promise<void> {
    while (!runSignal.aborted) {
      try {
        await tickOnce(runSignal);
      } catch (error) {
        if (!runSignal.aborted) log(`Routine pass failed (${errorCode(error)})`);
      }
      if (runSignal.aborted) break;
      const next = store.nextDueAt();
      // A manual run or a new routine can arrive while this pass is already working; the listener
      // sets the flag so the next sleep is skipped instead of waiting up to a minute.
      const delay = wakeRequested
        ? 0
        : next === undefined
          ? IDLE_WAKE_MS
          : Math.max(0, Math.min(IDLE_WAKE_MS, Date.parse(next) - now().getTime()));
      wakeRequested = false;
      await sleep(delay, runSignal);
    }
  }

  return {
    start(): void {
      if (started || !config.enabled) return;
      started = true;
      const recovered = store.recover();
      if (recovered > 0) log(`Routine recovery: ${recovered} interrupted run(s) marked failed`);
      unsubscribe = store.subscribe(() => {
        wakeRequested = true;
        wake?.();
      });
      loop = loopBody(signal).catch((error: unknown) => {
        log(`Routine loop stopped (${errorCode(error)})`);
      });
    },
    async stop(): Promise<void> {
      stop.abort();
      wake?.();
      await loop?.catch(() => undefined);
      loop = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      started = false;
    },
    tickOnce(runSignal = signal) {
      return tickOnce(runSignal);
    },
  };
}

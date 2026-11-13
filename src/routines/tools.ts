import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { arr, bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import {
  RoutineError,
  WEEKDAYS,
  type RoutineDelivery,
  type RoutineMode,
  type RoutineSchedule,
  type RoutineView,
  type RoutinesConfig,
  type Weekday,
} from "./protocol.js";
import { describeSchedule, parseSchedule } from "./schedule.js";
import type { SqliteRoutineStore } from "./store.js";
import { assertTimeZone } from "./time.js";

const MAX_TITLE_CHARS = 120;
const MAX_BRIEF_CHARS = 4_000;
const MAX_TEXT_CHARS = 2_000;

const MODES: readonly RoutineMode[] = ["agent", "notify"];
const DELIVERIES: readonly RoutineDelivery[] = ["always", "report"];

/** The destination is host configuration, never a tool argument — same rule as reminders. */
export type RoutineToolOptions = {
  readonly store: SqliteRoutineStore;
  readonly config: RoutinesConfig;
  readonly chatId: string;
  readonly now?: () => Date;
};

/** The shape the model may send; exported so the tests exercise the same contract as the tool. */
export type CreateRoutineArgs = {
  readonly title: string;
  readonly kind: "daily" | "weekly" | "every";
  readonly at?: string;
  readonly days?: readonly Weekday[];
  readonly every_minutes?: number;
  readonly timezone?: string;
  readonly mode?: RoutineMode;
  readonly brief?: string;
  readonly text?: string;
  readonly delivery?: RoutineDelivery;
  readonly from?: string;
  readonly to?: string;
};

function toolFailure(error: unknown): ToolExecutionResult {
  const code = error instanceof RoutineError ? error.code : "ROUTINE_STORE_ERROR";
  const message = error instanceof RoutineError ? error.message : "the routine store could not complete the operation";
  return {
    isError: true,
    output: [{ type: "text", text: `Routine operation failed (${code}): ${message}` }],
    details: { code },
    diagnostics: [{ severity: "error", code, message }],
  };
}

function toolText(text: string, details: Record<string, string | number | boolean | null>): ToolExecutionResult {
  return { output: [{ type: "text", text }], details };
}

function visible(view: RoutineView): string {
  const last = view.schedule.lastRunAt === null ? "never" : view.schedule.lastRunAt;
  const error = view.lastError === null ? "" : ` | last error ${view.lastError}`;
  return `#${view.id} | ${view.title} | ${view.status} | ${view.mode}/${view.delivery}`
    + ` | ${describeSchedule(view.schedule.spec, view.timezone)} | next ${view.schedule.nextDueAt}`
    + ` | last ${last}${error}`;
}

/**
 * Host-side validation for one creation. It is separate from the tool wrapper so the same rules are
 * testable without a model or a harness: the model proposes, the host decides.
 */
export function createRoutineFromArgs(
  store: SqliteRoutineStore,
  config: RoutinesConfig,
  chatId: string,
  args: CreateRoutineArgs,
  now: Date,
): RoutineView {
  const title = args.title.trim();
  if (title === "") throw new RoutineError("ROUTINE_INVALID_TITLE", "title must not be empty");
  const mode: RoutineMode = args.mode ?? (args.brief !== undefined ? "agent" : "notify");
  if (mode === "agent" && (args.brief === undefined || args.brief.trim() === "")) {
    throw new RoutineError("ROUTINE_MISSING_BRIEF", "an agent routine needs a brief");
  }
  if (mode === "notify" && (args.text === undefined || args.text.trim() === "")) {
    throw new RoutineError("ROUTINE_MISSING_TEXT", "a notify routine needs text");
  }
  const delivery: RoutineDelivery = args.delivery ?? "always";
  if (delivery === "report" && mode !== "agent") {
    throw new RoutineError("ROUTINE_INVALID_SCHEDULE", "delivery=report only applies to agent routines");
  }
  const timezone = args.timezone?.trim() || config.timezone;
  try {
    assertTimeZone(timezone);
  } catch {
    throw new RoutineError("ROUTINE_INVALID_TIMEZONE", "timezone must be a valid IANA time zone name");
  }
  const schedule: RoutineSchedule = parseSchedule({
    kind: args.kind,
    ...(args.at === undefined ? {} : { at: args.at }),
    ...(args.days === undefined ? {} : { days: args.days }),
    ...(args.every_minutes === undefined ? {} : { everyMinutes: args.every_minutes }),
    ...(args.from === undefined ? {} : { from: args.from }),
    ...(args.to === undefined ? {} : { to: args.to }),
    // A notify routine only sends text, so the interval floor exists to stop a typo from becoming a
    // model call — not to ration messages.
  }, mode === "agent" ? config.minIntervalMinutes : 1);
  if (store.countActive(chatId) >= config.maxPerOwner) {
    throw new RoutineError("ROUTINE_LIMIT_EXCEEDED", `at most ${config.maxPerOwner} routines are allowed`);
  }
  return store.create({
    chatId,
    title,
    timezone,
    mode,
    ...(args.brief === undefined ? {} : { brief: args.brief }),
    ...(args.text === undefined ? {} : { text: args.text }),
    delivery,
    schedule,
    now,
  });
}

/**
 * Model-facing routine tools.
 *
 * The model decides *what* to do and *when*; the host owns *who is told* and *which conversation
 * answers*. A scheduled run is a host-initiated agent run, not a fake user message, so it cannot
 * occupy the chat's reply loop or borrow someone else's identity.
 */
export function createRoutinesExtension(options: RoutineToolOptions): Extension {
  const { store, config, chatId } = options;
  const now = options.now ?? (() => new Date());

  function owned(id: number): RoutineView {
    const view = store.get(id);
    if (view === undefined || view.chatId !== chatId) {
      throw new RoutineError("ROUTINE_NOT_FOUND", `routine ${id} was not found`);
    }
    return view;
  }

  const create = defineTool({
    name: "routine_create",
    description:
      "Create a standing task that the host runs on a schedule without the owner saying anything. "
      + "Use it for recurring work: a daily brief, a repeating reminder, or anything that must happen at a wall-clock time. "
      + "For a single future reminder use reminder_create instead. "
      + `kind=daily needs at; weekly needs days and at; every needs every_minutes (agent runs are at least ${config.minIntervalMinutes} minutes apart). `
      + "mode=agent runs the assistant with the brief and reports its result; mode=notify sends the text as-is and costs no model call. "
      + "delivery=report suppresses an agent run that answered NO_REPORT. "
      + "The owner's chat and the routine's own conversation are fixed by the host and are not parameters.",
    parameters: obj({
      title: str({ minLength: 1, maxLength: MAX_TITLE_CHARS, description: "Short name shown in routine_list" }),
      kind: oneOf(["daily", "weekly", "every"] as const),
      at: opt(str({ description: "Local wall-clock time HH:MM, for daily and weekly" })),
      days: opt(arr(oneOf(WEEKDAYS), { maxItems: 7, description: "Weekdays for a weekly routine, e.g. mon,wed,fri" })),
      every_minutes: opt(int({ minimum: 1, maximum: 10_080, description: "Interval for kind=every" })),
      timezone: opt(str({ maxLength: 64, description: "IANA zone; defaults to the host's configured zone" })),
      mode: opt(oneOf(MODES)),
      brief: opt(str({ minLength: 1, maxLength: MAX_BRIEF_CHARS, description: "What the agent should do on each run (agent mode)" })),
      text: opt(str({ minLength: 1, maxLength: MAX_TEXT_CHARS, description: "Message to send as-is (notify mode); supports {{date}}, {{time}}, {{title}}" })),
      delivery: opt(oneOf(DELIVERIES)),
      from: opt(str({ description: "Optional window start HH:MM for kind=every" })),
      to: opt(str({ description: "Optional window end HH:MM for kind=every" })),
    }),
    replay: "unsafe",
    execute: async (args) => {
      try {
        const view = createRoutineFromArgs(store, config, chatId, args, now());
        return toolText(
          `Routine #${view.id} created: ${view.mode}/${view.delivery}, ${describeSchedule(view.schedule.spec, view.timezone)}. Next run ${view.schedule.nextDueAt}.`,
          {
            id: view.id,
            mode: view.mode,
            delivery: view.delivery,
            nextDueAt: view.schedule.nextDueAt,
            timezone: view.timezone,
          },
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  });

  const list = defineTool({
    name: "routine_list",
    description: "List this conversation's standing tasks with status, schedule, next run, last run and the last error.",
    parameters: obj({}),
    replay: "safe",
    execute: async () => {
      try {
        const views = store.list(chatId);
        if (views.length === 0) return toolText("No standing tasks.", { count: 0 });
        return toolText(views.map(visible).join("\n"), { count: views.length });
      } catch (error) {
        return toolFailure(error);
      }
    },
  });

  const pause = defineTool({
    name: "routine_pause",
    description:
      "Pause one standing task by id, or every active task with all=true. A paused task keeps its schedule; "
      + "when resumed, a slot missed by more than six hours is skipped rather than replayed.",
    parameters: obj({
      id: opt(int({ minimum: 1 })),
      all: opt(bool({ description: "Pause every active standing task in this conversation" })),
    }),
    replay: "unsafe",
    execute: async (args) => {
      try {
        if (args.all === true) {
          const changed = store.setStatusAll(chatId, ["active"], "paused");
          return toolText(`Paused ${changed} standing task(s).`, { paused: changed });
        }
        if (args.id === undefined) throw new RoutineError("ROUTINE_NOT_FOUND", "give an id or all=true");
        const view = store.setStatus(owned(args.id).id, "paused");
        return toolText(`Routine #${view.id} is ${view.status}.`, { id: view.id, status: view.status });
      } catch (error) {
        return toolFailure(error);
      }
    },
  });

  const resume = defineTool({
    name: "routine_resume",
    description: "Resume one paused standing task by id, or every paused one with all=true.",
    parameters: obj({
      id: opt(int({ minimum: 1 })),
      all: opt(bool({ description: "Resume every paused standing task in this conversation" })),
    }),
    replay: "unsafe",
    execute: async (args) => {
      try {
        if (args.all === true) {
          const changed = store.setStatusAll(chatId, ["paused"], "active");
          return toolText(`Resumed ${changed} standing task(s).`, { resumed: changed });
        }
        if (args.id === undefined) throw new RoutineError("ROUTINE_NOT_FOUND", "give an id or all=true");
        const view = store.setStatus(owned(args.id).id, "active");
        return toolText(`Routine #${view.id} is ${view.status}.`, { id: view.id, status: view.status });
      } catch (error) {
        return toolFailure(error);
      }
    },
  });

  const remove = defineTool({
    name: "routine_delete",
    description: "Delete a standing task by id. Its run history goes with it; a new task starts a new conversation.",
    parameters: obj({ id: int({ minimum: 1 }) }),
    replay: "unsafe",
    execute: async (args) => {
      try {
        const view = owned(args.id);
        store.delete(view.id);
        return toolText(`Routine #${view.id} deleted.`, { id: view.id });
      } catch (error) {
        return toolFailure(error);
      }
    },
  });

  const runNow = defineTool({
    name: "routine_run_now",
    description: "Queue one immediate run of a standing task, as if its scheduled time had arrived. It runs within seconds.",
    parameters: obj({ id: int({ minimum: 1 }) }),
    replay: "unsafe",
    execute: async (args) => {
      try {
        const view = owned(args.id);
        if (config.paused) throw new RoutineError("ROUTINE_PAUSED", "all standing tasks are paused by the host");
        if (view.status !== "active") {
          throw new RoutineError("ROUTINE_PAUSED", `routine ${view.id} is ${view.status}; resume it first`);
        }
        const run = store.enqueueManual(view.id, now());
        return toolText(`Routine #${view.id} queued for an immediate run (run ${run.id}).`, { id: view.id, run: run.id });
      } catch (error) {
        return toolFailure(error);
      }
    },
  });

  return defineExtension({ name: "routines", tools: [create, list, pause, resume, remove, runNow] });
}

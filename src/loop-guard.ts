import {
  defineExtension,
  hook,
  ToolTask,
  type Extension,
  type HookApi,
  type ToolExecutionResult,
  type ToolHookCall,
} from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import { recordLoopGuard } from "./trace.js";

/** The first repeated signature that earns an explicit warning in the tool result. */
export const LOOP_GUARD_WARNING_AT = 3;
/** The repeated signature, or consecutive error count, that ends the run. */
export const LOOP_GUARD_HALT_AT = 6;
/** Upper bound on remembered call IDs; only a much larger replay could forget one. */
const SEEN_CALLS_LIMIT = 4096;

export type LoopGuardHaltReason = "repeated_call" | "consecutive_errors";

/**
 * A recognizable business failure: the run is answered with `AGENT_LOOP_DETECTED` while the durable
 * Session stays healthy, so the user's next request can start a fresh run.
 */
export class AgentLoopDetectedError extends Error {
  readonly code = "AGENT_LOOP_DETECTED";

  constructor(
    readonly reason: LoopGuardHaltReason,
    readonly tool: string,
    readonly count: number,
  ) {
    super(
      reason === "repeated_call"
        ? `Agent loop detected: tool "${tool}" was called ${count} times consecutively with identical arguments`
        : `Agent loop detected: ${count} consecutive tool calls failed (last tool "${tool}")`,
    );
    this.name = "AgentLoopDetectedError";
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Structural JSON with sorted object keys; JSON formatting whitespace never affects the result. */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalValue(value)) ?? "undefined";
}

function normalizeScript(code: string): string {
  return code.trim().replace(/\s+/g, " ");
}

/**
 * `(toolName, canonical arguments)`. Only the code mode script gets its source whitespace normalized,
 * because reformatting the same script is the same call; other arguments are compared as given.
 */
export function loopSignature(name: string, args: unknown): string {
  const normalized = name === CODEMODE_TOOL_NAME
    && args !== null
    && typeof args === "object"
    && !Array.isArray(args)
    && typeof (args as { code?: unknown }).code === "string"
    ? { ...(args as Record<string, unknown>), code: normalizeScript((args as { code: string }).code) }
    : args;
  return `${name}\u0000${canonicalJSON(normalized)}`;
}

export type LoopGuard = {
  readonly extension: Extension;
  /**
   * Clear counts and a recorded halt. With a conversation ID, only that conversation is cleared;
   * without one, every conversation is. The call-ID memory survives, so a replay cannot double count.
   */
  reset(conversationId?: string): void;
  /** The halt recorded by the current run of one conversation. The run boundary consumes it. */
  takeHalt(conversationId?: string): AgentLoopDetectedError | undefined;
  /**
   * Install the host's run-level cancellation. Called once when a halt is recorded, from inside the
   * hook, which must return promptly; the host stops that one conversation outside the hook.
   */
  setHaltHandler(handler: (error: AgentLoopDetectedError, conversationId: string) => void): void;
};

type GuardState = {
  lastSignature: string | undefined;
  identicalCount: number;
  errorCount: number;
  halt: AgentLoopDetectedError | undefined;
};

/** One entry per conversation seen in this process; old entries are evicted, not grown forever. */
const GUARD_STATES_LIMIT = 256;

/**
 * Bounded autonomous loop detection for model-issued tool calls.
 *
 * Consecutive identical signatures warn at 3-5 and halt at 6; six consecutive error results halt
 * regardless of signature. Nested calls belong to the code mode script and are excluded (its own
 * guard runs inside `serializeNestedCalls`). State is deliberately in memory: a restarted process
 * starts at zero rather than re-counting a transcript, and within one process an already observed
 * `callId` is counted once, so a replay cannot inflate the counters.
 */
export function createLoopGuard(log: (line: string) => void = console.error): LoopGuard {
  const states = new Map<string, GuardState>();
  let haltHandler: ((error: AgentLoopDetectedError, conversationId: string) => void) | undefined;
  const seen = new Set<string>();

  function stateFor(conversationId: string): GuardState {
    let state = states.get(conversationId);
    if (state !== undefined) return state;
    if (states.size >= GUARD_STATES_LIMIT) {
      const oldest = states.keys().next();
      if (!oldest.done) states.delete(oldest.value);
    }
    state = { lastSignature: undefined, identicalCount: 0, errorCount: 0, halt: undefined };
    states.set(conversationId, state);
    return state;
  }

  function audit(code: "LOOP_GUARD_WARNING" | "LOOP_GUARD_HALT", call: ToolHookCall, api: HookApi, count: number, reason?: LoopGuardHaltReason): void {
    log(JSON.stringify({
      event: "loop_guard",
      conversationId: api.conversationId,
      taskId: api.taskId,
      callId: call.id,
      tool: call.name.slice(0, 128),
      count,
      ...(reason === undefined ? {} : { reason }),
      code,
    }));
    recordLoopGuard({
      conversationId: api.conversationId,
      taskId: api.taskId,
      callId: call.id,
      tool: call.name,
      count,
      ...(reason === undefined ? {} : { reason }),
    }, code);
  }

  function observe(call: ToolHookCall, result: ToolExecutionResult, api: HookApi): ToolExecutionResult | undefined {
    // A nested call is the script's control flow; the inner guard bounds it at its own boundary.
    if (call.parent !== undefined) return undefined;
    const key = `${api.conversationId}\u0000${call.id}`;
    if (seen.has(key)) return undefined;
    if (seen.size >= SEEN_CALLS_LIMIT) {
      const oldest = seen.values().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    seen.add(key);
    const state = stateFor(String(api.conversationId));

    const signature = loopSignature(call.name, call.arguments);
    if (signature === state.lastSignature) state.identicalCount += 1;
    else {
      state.lastSignature = signature;
      state.identicalCount = 1;
    }
    state.errorCount = result.isError === true ? state.errorCount + 1 : 0;

    if (state.identicalCount >= LOOP_GUARD_HALT_AT) {
      if (state.halt === undefined) {
        state.halt = new AgentLoopDetectedError("repeated_call", call.name, state.identicalCount);
        audit("LOOP_GUARD_HALT", call, api, state.identicalCount, "repeated_call");
        try {
          haltHandler?.(state.halt, String(api.conversationId));
        } catch {
          // A host cancellation failure must not turn the tool result into an exception.
        }
      }
      return undefined;
    }
    if (state.errorCount >= LOOP_GUARD_HALT_AT) {
      if (state.halt === undefined) {
        state.halt = new AgentLoopDetectedError("consecutive_errors", call.name, state.errorCount);
        audit("LOOP_GUARD_HALT", call, api, state.errorCount, "consecutive_errors");
        try {
          haltHandler?.(state.halt, String(api.conversationId));
        } catch {
          // A host cancellation failure must not turn the tool result into an exception.
        }
      }
      return undefined;
    }
    if (state.identicalCount >= LOOP_GUARD_WARNING_AT) {
      audit("LOOP_GUARD_WARNING", call, api, state.identicalCount);
      return {
        ...result,
        output: [
          ...(result.output ?? []),
          {
            type: "text",
            text: `[Loop Guard Warning]: You have made the exact same tool call ${state.identicalCount} times consecutively. Do not repeat identical calls; inspect intermediate state or change your strategy.`,
          },
        ],
      };
    }
    return undefined;
  }

  const extension = defineExtension({
    name: "loop-guard",
    hooks: [
      hook(ToolTask, {
        afterTool: (call, result, api) => observe(call, result, api),
      }),
    ],
  });

  return {
    extension,
    reset(conversationId) {
      if (conversationId === undefined) states.clear();
      else states.delete(conversationId);
    },
    takeHalt(conversationId) {
      if (conversationId !== undefined) return states.get(conversationId)?.halt;
      for (const state of states.values()) if (state.halt !== undefined) return state.halt;
      return undefined;
    },
    setHaltHandler(handler) {
      haltHandler = handler;
    },
  };
}

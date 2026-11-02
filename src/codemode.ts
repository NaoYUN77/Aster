import { withAbortSignal } from "@earendil-works/chord/context";
import {
  defineExtension,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME, createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox, RemoteCodemodeSandbox } from "@earendil-works/pi-codemode";
import type { CodemodeConfig } from "./config.js";
import type { PtcControl } from "./ptc/control.js";

/**
 * The script's result is the only thing that enters the conversation, so cap it well below the
 * base tool's 4 MiB. The tail keeps a script's final summary and errors.
 */
export const CODEMODE_OUTPUT_LIMITS = { maxBytes: 32 * 1024, maxLines: 1_000, retain: "tail" } as const;

/** File tools are usable inside scripts only when the execution environment is local. */
export const LOCAL_SCRIPT_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "bash"]);
/** Remote execution phase 1 has no remote file API, so scripts may run commands only. */
export const REMOTE_SCRIPT_TOOLS: ReadonlySet<string> = new Set(["bash"]);

export type CodemodeHost = {
  readonly extension: Extension;
  close(): Promise<void>;
};

/**
 * Hide every tool outside the script allowlist from scripts without removing it from the model.
 * A tools-only tool is closed to both callers instead of being promoted to the model by accident.
 */
export function restrictScriptTools(extension: Extension, allowed: ReadonlySet<string>): Extension {
  if (extension.tools === undefined) return extension;
  return {
    ...extension,
    tools: extension.tools.map((tool) => {
      if (allowed.has(tool.name)) return tool;
      const callers: readonly ("model" | "tools")[] = tool.callers ?? ["model", "tools"];
      return { ...tool, callers: callers.includes("model") ? ["model"] as const : [] as const };
    }),
  };
}

/**
 * Nested calls are tools, and ADR-0009 keeps tools in one round sequential. The QuickJS sandbox
 * starts every call as soon as the script makes it, so this wrapper queues them; `Promise.all`
 * still works, but the calls run one after another. The sandbox's own timeout ends the script
 * without aborting the request, so a call still running or waiting when the codemode call settles
 * is cancelled here instead of continuing after the script has ended.
 */
export function serializeNestedCalls(tool: ToolRegistration): ToolRegistration {
  const execute = tool.execute;
  return {
    ...tool,
    execute: async (args, api, context) => {
      const script = new AbortController();
      let queue: Promise<unknown> = Promise.resolve();
      try {
        return await execute(args, {
          ...api,
          executeTool: (name, nestedArgs, nestedContext, options) => {
            const start = queue.then(() => {
              nestedContext.abortSignal?.throwIfAborted();
              script.signal.throwIfAborted();
              return api.executeTool(
                name,
                nestedArgs,
                withAbortSignal(script.signal, nestedContext),
                options,
              );
            });
            queue = start.then(() => undefined, () => undefined);
            return start;
          },
        }, context);
      } finally {
        script.abort(new Error("The code mode script ended"));
      }
    },
  };
}

/**
 * Bind one code mode execution to a remote PTC sandbox. The nested-call wrapper is applied first
 * (inside this one), so by the time a call reaches `api.executeTool` it is serialized and carries
 * the durable `c<id>` key; this wrapper reserves that id for the environment and enforces the
 * per-script call and journal budgets. Only `bash` is allowed in phase 1.
 */
export function withPtcExecution(tool: ToolRegistration, control: PtcControl): ToolRegistration {
  const execute = tool.execute;
  return {
    ...tool,
    execute: async (args, api, context) => {
      const conversationId = Number(api.conversationId);
      const taskId = Number(api.taskId);
      if (!Number.isSafeInteger(conversationId) || !Number.isSafeInteger(taskId)) {
        throw new Error("PTC requires numeric conversation and task ids");
      }
      const execution = await control.begin({
        conversationId,
        taskId,
        context,
      });
      const originalExecuteTool = api.executeTool.bind(api);
      try {
        return await control.runWith(execution, () => execute(args, {
          ...api,
          executeTool: async (name, nestedArgs, nestedContext, options) => {
            const key = options?.key;
            const match = key === undefined ? null : /^c([1-9]\d*)$/.exec(key);
            if (match === null) {
              throw new Error("PTC nested calls require the code mode c<id> call key");
            }
            if (name !== "bash") {
              throw new Error("Remote PTC phase 1 allows only the bash tool inside code mode");
            }
            execution.reserveToolCall(Number(match[1]));
            const result = await originalExecuteTool(name, nestedArgs, nestedContext, options);
            execution.accountJournal(result);
            return result;
          },
        }, context));
      } finally {
        await control.end(conversationId, execution);
      }
    },
  };
}

/**
 * The base's code mode tool plus its QuickJS WASM sandbox. Scripts see only `tools.*`,
 * `ALL_TOOLS`, `text`/`image`/`exit`, `console`, `store`/`load`, and the discovery globals; no
 * filesystem, network, timers, or modules are exposed to the VM.
 *
 * With PTC the VM runs on the execution host through `RemoteCodemodeSandbox`; the control plane
 * still hosts the tool journal, the budgets and the output references.
 */
export function createCodemodeHost(config: CodemodeConfig, ptc?: PtcControl): CodemodeHost {
  const sandbox = ptc === undefined
    ? new CodemodeSandbox({
        timeoutMs: config.timeoutMs,
        memoryLimitBytes: config.memoryLimitBytes,
      })
    : new RemoteCodemodeSandbox({
        timeoutMs: config.timeoutMs,
        memoryLimitBytes: config.memoryLimitBytes,
        remote: () => ptc.current().remote,
      });
  const base = createCodemodeExtension({ sandbox, models: false });
  const extension = defineExtension({
    ...base,
    tools: (base.tools ?? []).map((tool) => {
      if (tool.name !== CODEMODE_TOOL_NAME) return tool;
      const bounded = { ...tool, outputLimits: CODEMODE_OUTPUT_LIMITS };
      const serialized = serializeNestedCalls(bounded);
      return ptc === undefined ? serialized : withPtcExecution(serialized, ptc);
    }),
  });
  let closing: Promise<void> | undefined;
  return {
    extension,
    close() {
      closing ??= (async () => {
        try {
          await sandbox.close();
        } finally {
          await ptc?.close();
        }
      })();
      return closing;
    },
  };
}

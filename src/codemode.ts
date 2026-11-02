import { withAbortSignal } from "@earendil-works/chord/context";
import {
  defineExtension,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME, createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { CodemodeConfig } from "./config.js";

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
 * The base's code mode tool plus its QuickJS WASM sandbox. Scripts see only `tools.*`,
 * `ALL_TOOLS`, `text`/`image`/`exit`, `console`, `store`/`load`, and the discovery globals; no
 * filesystem, network, timers, or modules are exposed to the VM.
 */
export function createCodemodeHost(config: CodemodeConfig): CodemodeHost {
  const sandbox = new CodemodeSandbox({
    timeoutMs: config.timeoutMs,
    memoryLimitBytes: config.memoryLimitBytes,
  });
  const base = createCodemodeExtension({ sandbox, models: false });
  const extension = defineExtension({
    ...base,
    tools: (base.tools ?? []).map((tool) => tool.name === CODEMODE_TOOL_NAME
      ? serializeNestedCalls({ ...tool, outputLimits: CODEMODE_OUTPUT_LIMITS })
      : tool),
  });
  let closing: Promise<void> | undefined;
  return {
    extension,
    close() {
      closing ??= sandbox.close();
      return closing;
    },
  };
}

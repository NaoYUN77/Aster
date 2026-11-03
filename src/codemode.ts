import { withAbortSignal } from "@earendil-works/chord/context";
import {
  defineExtension,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME, createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox, type CodemodeSandboxBase } from "@earendil-works/pi-codemode";
import type { CodemodeConfig } from "./config.js";
import type { RpcExecutionClient } from "./execution/rpc-client.js";
import { PtcGateway, SessionBoundCodemodeSandbox } from "./ptc-gateway.js";

/**
 * The script's result is the only thing that enters the conversation, so cap it well below the
 * base tool's 4 MiB. The tail keeps a script's final summary and errors.
 */
export const CODEMODE_OUTPUT_LIMITS = { maxBytes: 32 * 1024, maxLines: 1_000, retain: "tail" } as const;

/** File tools are usable inside scripts only when the execution environment is local. */
export const LOCAL_SCRIPT_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "bash"]);
/** Remote execution exposes the same tools; file primitives run inside the PTC sandbox. */
export const REMOTE_SCRIPT_TOOLS: ReadonlySet<string> = new Set(["read", "write", "edit", "bash"]);

export type CodemodeHost = {
  readonly extension: Extension;
  /** Prove the remote agent is usable before accepting work; a no-op in local mode. */
  start(): Promise<void>;
  /** Apply host tool wrappers; remote mode routes nested bash calls through the session's VM. */
  wrapScriptTools(extension: Extension): Extension;
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
 *
 * Remote execution uses `SessionBoundCodemodeSandbox`: the VM runs on the execution agent and every
 * nested tool call is bridged back to the host through one PTC session per code mode call. `client`
 * lets the agent share its already connected RPC client; the gateway then never closes it.
 */
export function createCodemodeHost(config: CodemodeConfig, client?: RpcExecutionClient): CodemodeHost {
  let sandbox: CodemodeSandboxBase;
  let gateway: PtcGateway | undefined;
  if (config.ptc === undefined) {
    sandbox = new CodemodeSandbox({
      timeoutMs: config.timeoutMs,
      memoryLimitBytes: config.memoryLimitBytes,
    });
  } else {
    const bound = new SessionBoundCodemodeSandbox({
      timeoutMs: config.timeoutMs,
      memoryLimitBytes: config.memoryLimitBytes,
    });
    sandbox = bound;
    gateway = new PtcGateway({
      rpc: config.ptc.rpc,
      sandbox: bound,
      defaultTimeoutSeconds: config.ptc.defaultTimeoutSeconds,
      maxTimeoutSeconds: config.ptc.maxTimeoutSeconds,
      ...(client === undefined ? {} : { client }),
    });
  }
  const base = createCodemodeExtension({ sandbox, models: false });
  const extension = defineExtension({
    ...base,
    tools: (base.tools ?? []).map((tool) => {
      if (tool.name !== CODEMODE_TOOL_NAME) return tool;
      const serialized = serializeNestedCalls({ ...tool, outputLimits: CODEMODE_OUTPUT_LIMITS });
      return gateway === undefined ? serialized : gateway.wrapCodemodeTool(serialized);
    }),
  });
  let closing: Promise<void> | undefined;
  return {
    extension,
    start: async () => {
      await gateway?.start();
    },
    wrapScriptTools: (target) => gateway === undefined ? target : gateway.wrapScriptTools(target),
    close() {
      closing ??= (async () => {
        const results = await Promise.allSettled([
          sandbox.close(),
          gateway === undefined ? Promise.resolve() : gateway.close(),
        ]);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      })();
      return closing;
    },
  };
}

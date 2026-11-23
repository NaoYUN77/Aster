import { arr, bool, lit, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { GovernedTool } from "../tools.js";
import type { SubagentManager } from "./manager.js";

const SUBAGENT_GOVERNANCE = {
  source: { kind: "builtin" as const, extension: "subagents" },
  trust: "trusted" as const,
  authz: "read" as const,
};

export function createSubagentExtension(manager: SubagentManager) {
  const spawnSubagent: GovernedTool = {
    ...defineTool({
      name: "spawn_subagent",
      description:
        "Spawn a bounded sub-agent in an isolated disposable SQLite store to carry out a delegated task. "
        + "Only the final structured result returns to the root conversation; intermediate steps are reclaimed on exit. "
        + "Use mode='wait' to wait for completion, or mode='background' to run multiple sub-agents concurrently and collect them with wait_subagent.",
      parameters: obj({
        task: str({ description: "Clear, self-contained task description and expected output for the sub-agent." }),
        systemPrompt: opt(str({ description: "Optional custom system instructions for this sub-agent." })),
        tools: opt(arr(str(), { description: "Optional allowlist of tool names (defaults to ['read', 'current_time'])." })),
        cwd: opt(str({ description: "Optional subdirectory inside the workspace." })),
        mode: opt(union([lit("wait"), lit("background")], { description: "Execution mode: 'wait' (default) or 'background'." })),
        allowWrite: opt(bool({ description: "Whether to request the single-writer workspace lock for code/file edits." })),
        timeoutMs: opt(num({ description: "Optional execution timeout in milliseconds (defaults to 900000 ms / 15 min, max 1800000 ms; paused while waiting for approval)." })),
      }),
      replay: "unsafe",
      execute: async (args, _api, context) => {
        const spawned = await manager.spawn(args, context.abortSignal);
        return {
          output: [{ type: "text", text: JSON.stringify(spawned, null, 2) }],
          structuredOutput: spawned,
        };
      },
    }),
    governance: SUBAGENT_GOVERNANCE,
  };

  const waitSubagent: GovernedTool = {
    ...defineTool({
      name: "wait_subagent",
      description:
        "Wait for one or more background sub-agents to finish and return their structured results. "
        + "If timeoutMs elapses (paused automatically while waiting for owner approval), completed sub-agents are returned alongside live running snapshots without throwing or cancelling still-running sub-agents; call wait_subagent again to keep waiting.",
      parameters: obj({
        ids: arr(str(), { description: "Sub-agent IDs returned by spawn_subagent(mode='background')." }),
        timeoutMs: opt(num({ description: "Optional wait timeout in milliseconds (paused during approval waits). Never discards results on expiry." })),
      }),
      replay: "safe",
      execute: async (args, _api, context) => {
        const results = await manager.wait(args.ids, {
          ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
          ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
        });
        const pendingIds = results
          .filter((item) => item.status === "running" || item.status === "waiting_approval")
          .map((item) => item.id);
        const payload = {
          results,
          ...(pendingIds.length > 0 ? { pendingIds, timedOut: true } : {}),
        };
        return {
          output: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredOutput: payload,
        };
      },
    }),
    governance: SUBAGENT_GOVERNANCE,
  };

  const cancelSubagent: GovernedTool = {
    ...defineTool({
      name: "cancel_subagent",
      description: "Cancel a running sub-agent and immediately reclaim its disposable SQLite store.",
      parameters: obj({
        id: str({ description: "Sub-agent ID to cancel." }),
      }),
      replay: "safe",
      execute: async (args) => {
        const outcome = await manager.cancel(args.id);
        return {
          output: [{ type: "text", text: JSON.stringify(outcome) }],
          structuredOutput: outcome,
        };
      },
    }),
    governance: SUBAGENT_GOVERNANCE,
  };

  return defineExtension({
    name: "subagents",
    tools: [spawnSubagent, waitSubagent, cancelSubagent],
  });
}

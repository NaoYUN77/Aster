import { arr, bool, lit, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { GovernedTool } from "../tools.js";
import { SubagentInvalidToolsError, type SubagentManager } from "./manager.js";

const SUBAGENT_GOVERNANCE = {
  source: { kind: "builtin" as const, extension: "subagents" },
  trust: "trusted" as const,
  authz: "read" as const,
};

function buildSpawnDescription(manager: SubagentManager): string {
  const caps = manager.describeToolCapabilities();
  const defaultList = caps.defaultTools.join(", ");
  const onDemandNote = caps.onDemandCategories.length > 0
    ? ` On-demand categories discoverable via tool_search or extraTools: ${caps.onDemandCategories.map((c) => `${c.extension} (${c.count})`).join(", ")}.`
    : "";
  return (
    "Spawn a bounded sub-agent in an isolated disposable SQLite store to carry out a delegated task. "
    + "Only the final structured result returns to the root conversation; intermediate steps are reclaimed on exit. "
    + "Use mode='wait' to wait for completion, or mode='background' to run multiple sub-agents concurrently and collect them with wait_subagent. "
    + `When 'tools' is omitted, the sub-agent receives default tools (${defaultList}) and can discover connected tools via tool_search.${onDemandNote} `
    + "Use 'extraTools' to promote specific tools alongside defaults; pass 'tools' only to lock the sub-agent strictly to an exact allowlist (removing tool_search unless listed)."
  );
}

export function createSubagentExtension(manager: SubagentManager) {
  const spawnSubagent: GovernedTool = {
    ...defineTool({
      name: "spawn_subagent",
      description: buildSpawnDescription(manager),
      parameters: obj({
        task: str({ description: "Clear, self-contained task description and expected output for the sub-agent." }),
        systemPrompt: opt(str({ description: "Optional custom system instructions for this sub-agent." })),
        tools: opt(arr(str(), { description: "Optional strict allowlist (lock-cage mode): removes all unlisted tools including tool_search unless listed. Omit for defaults + tool_search." })),
        extraTools: opt(arr(str(), { description: "Optional additional tool names promoted directly alongside defaults (e.g. specific connector/MCP or write tools) without losing default tools or tool_search." })),
        cwd: opt(str({ description: "Optional subdirectory inside the workspace." })),
        mode: opt(union([lit("wait"), lit("background")], { description: "Execution mode: 'wait' (default) or 'background'." })),
        allowWrite: opt(bool({ description: "Whether to request the single-writer workspace lock for code/file edits (automatically adds write/edit to defaults when 'tools' is omitted)." })),
        timeoutMs: opt(num({ description: "Optional execution timeout in milliseconds (defaults to 900000 ms / 15 min, max 1800000 ms; paused while waiting for approval)." })),
      }),
      replay: "unsafe",
      execute: async (args, _api, context) => {
        try {
          const spawned = await manager.spawn(args, context.abortSignal);
          return {
            output: [{ type: "text", text: JSON.stringify(spawned, null, 2) }],
            structuredOutput: spawned,
          };
        } catch (error) {
          if (error instanceof SubagentInvalidToolsError) {
            const payload = {
              error: {
                code: error.code,
                message: error.message,
                invalidTools: [...error.invalidTools],
                availableTools: [...error.availableTools],
              },
            };
            return {
              isError: true,
              output: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
              structuredOutput: payload,
            };
          }
          throw error;
        }
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

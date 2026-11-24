import { arr, bool, lit, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { GovernedTool } from "../tools.js";
import { SubagentConcurrencyLimitError, SubagentInvalidToolsError, type SubagentManager } from "./manager.js";

const SUBAGENT_GOVERNANCE = {
  source: { kind: "builtin" as const, extension: "subagents" },
  trust: "trusted" as const,
  authz: "read" as const,
};

/**
 * Static delegation guidelines injected into the root conversation's prompt context.
 * Kept byte-stable across turns so prompt prefix caching stays intact.
 */
export function buildSubagentsPromptSection(maxConcurrent: number): string {
  return [
    "Sub-agent delegation: before executing a complex request or standing routine yourself, decide whether to delegate to isolated sub-agents via spawn_subagent.",
    "ALWAYS delegate FIRST (before running searches or multi-file reads yourself) when:",
    "- The user asks — or a standing routine brief requires — comparing, researching, or evaluating 2+ distinct frameworks, products, topics, sources, or codebase modules (e.g. comparing A, B, and C, gathering news from multiple sources, or auditing multiple modules): spawn 2-4 parallel mode='background' sub-agents in your first tool turn rather than running serial searches in the main conversation.",
    "- Heavy multi-step web research, log inspection, or wide file exploration (4+ tool calls) would bloat the main conversation while you only need a concise synthesized result.",
    "- A well-scoped, self-contained implementation or code review can run independently (set allowWrite=true only when edits are required; keep at most one writer active at a time).",
    "Do NOT delegate when:",
    "- The request can be finished directly in 1-3 tool calls (a single search, checking current time or connector status, reading 1-2 files, a small edit, or setting a reminder).",
    "- Steps have tight sequential dependencies, rely heavily on nuanced main-chat context, or require asking the owner clarifying questions.",
    `- Do not spawn one sub-agent per item in a long list; batch related items into 2-4 sub-agents (hard concurrency cap: ${maxConcurrent}).`,
    "Execution & handoff rules:",
    "- For a single heavy task, use mode='wait'. For 2+ independent tracks, call spawn_subagent with mode='background' for each in one turn so they run concurrently, then collect all of them with one wait_subagent call.",
    "- Each sub-agent starts fresh with NO main conversation history and NO MEMORY.md: make 'task' self-contained (background, exact goal, constraints, and expected output format).",
    "- Omit 'tools' by default so the sub-agent gets core resident tools plus tool_search; use 'extraTools' to promote specific connected tools; pass 'tools' only when strict minimal-privilege isolation is needed.",
    "- Always follow explicit user instructions if the user asks to use or avoid sub-agents.",
  ].join("\n");
}

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

const INCOMPLETE_SUBAGENT_WARNING =
  "One or more sub-agents failed, timed out, or were cancelled. Do NOT treat missing results as 'no updates' or 'no releases'; explicitly report which source(s)/subtask(s) failed or were incomplete.";

export type SubagentExtensionOptions = {
  /** Returns true when the calling conversation is an unattended background routine/dreaming run. */
  readonly isUnattendedConversation?: (conversationId: string) => boolean;
};

export function createSubagentExtension(
  manager: SubagentManager,
  options: SubagentExtensionOptions = {},
) {
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
      execute: async (args, api, context) => {
        try {
          const unattended = options.isUnattendedConversation?.(String(api.conversationId)) === true;
          const spawned = await manager.spawn({
            ...args,
            ...(unattended ? { unattended: true } : {}),
          }, context.abortSignal);
          const payload =
            spawned.mode === "wait" && spawned.result.status !== "completed"
              ? { ...spawned, incompleteWarning: INCOMPLETE_SUBAGENT_WARNING }
              : spawned;
          return {
            output: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
            structuredOutput: payload,
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
          if (error instanceof SubagentConcurrencyLimitError) {
            const payload = {
              error: {
                code: error.code,
                message: error.message,
                activeCount: error.activeCount,
                maxConcurrent: error.maxConcurrent,
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
        const failedIds = results
          .filter((item) => item.status === "failed" || item.status === "cancelled")
          .map((item) => item.id);
        const payload = {
          results,
          ...(pendingIds.length > 0 ? { pendingIds, timedOut: true } : {}),
          ...(failedIds.length > 0
            ? { failedIds, incompleteWarning: INCOMPLETE_SUBAGENT_WARNING }
            : {}),
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

  const subagentsSection = buildSubagentsPromptSection(manager.maxConcurrent);

  return defineExtension({
    name: "subagents",
    tools: [spawnSubagent, waitSubagent, cancelSubagent],
    sections: [{
      key: "subagents",
      render: () => subagentsSection,
    }],
  });
}

import type { Extension } from "@earendil-works/pi-durable";
import type { OpenAgentOptions } from "./agent.js";
import type { readConfig } from "./config.js";
import type { HubStore } from "./hubs.js";
import type { ReminderStore } from "./reminders.js";
import type { SkillIndex } from "./skills.js";

/**
 * Host-owned capabilities the host can hand to the agent. The host decides which of these it has;
 * this composition step only decides how they become `OpenAgentOptions`.
 */
export type AgentHostComposition = {
  /** Durable reminders; when present the reminder tools are registered. */
  readonly reminderStore?: ReminderStore;
  /** Team Hub bookkeeping; absent for a single-owner deployment. */
  readonly hubStore?: HubStore;
  /** Extensions owned by host features (watchers, routines, connectors, ...). */
  readonly extraExtensions?: readonly Extension[];
  /** Installed skills, indexed at startup. */
  readonly skills?: SkillIndex;
};

type AgentRuntimeOptions = Pick<
  OpenAgentOptions,
  | "mcp"
  | "signal"
  | "toolAuthority"
  | "toolReviewLog"
  | "onModelUsed"
  | "onModelSelectionChanged"
>;

/**
 * Build the one options object `openAgent` receives. Every optional group is omitted when absent
 * instead of being passed as `undefined`, so the same capabilities always produce the same shape.
 */
export function buildAgentOptions(
  _config: ReturnType<typeof readConfig>,
  host: AgentHostComposition = {},
  runtime: AgentRuntimeOptions = {},
): OpenAgentOptions {
  const extensions = host.extraExtensions === undefined
    ? []
    : host.extraExtensions.filter((extension) => extension !== undefined);
  return {
    ...runtime,
    ...(host.reminderStore === undefined ? {} : { reminderStore: host.reminderStore }),
    ...(host.hubStore === undefined ? {} : { hubStore: host.hubStore }),
    ...(extensions.length === 0 ? {} : { extraExtensions: extensions }),
    ...(host.skills === undefined ? {} : { skills: host.skills }),
  };
}

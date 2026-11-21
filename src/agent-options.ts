import type { Extension } from "@earendil-works/pi-durable";
import type { OpenAgentOptions } from "./agent.js";
import type { readConfig } from "./config.js";
import type { HubStore } from "./hubs.js";
import type { ReminderStore } from "./reminders.js";
import type { SkillIndex } from "./skills.js";

/**
 * Host-owned capabilities a channel can hand to the agent. The channel decides which of these it
 * has; this composition step only decides how they become `OpenAgentOptions`, so the Telegram/Slack
 * path and the web path cannot drift apart.
 */
export type AgentHostComposition = {
  /** Durable reminders; when present the reminder tools are registered. */
  readonly reminderStore?: ReminderStore;
  /** Team Hub bookkeeping; absent for a single-owner deployment. */
  readonly hubStore?: HubStore;
  /** Extensions owned by host features (watchers, routines, connectors, ...). */
  readonly extraExtensions?: readonly Extension[];
  /**
   * Host-managed MCP servers, such as local stdio connectors persisted in `connectors.sqlite`.
   * They are appended to the configured MCP file rather than replacing it.
   */
  readonly mcpServers?: OpenAgentOptions["mcpServers"];
  /** Installed skills, indexed at startup. */
  readonly skills?: SkillIndex;
  /**
   * Slack reaction feedback. It is intentionally accepted only on a Slack channel: other channels
   * have no equivalent event stream, and a reaction tool that can never work must not be exposed.
   */
  readonly reactions?: OpenAgentOptions["reactions"];
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
 * instead of being passed as `undefined`, so both channels produce the same shape for the same
 * capabilities.
 */
export function buildAgentOptions(
  config: ReturnType<typeof readConfig>,
  host: AgentHostComposition = {},
  runtime: AgentRuntimeOptions = {},
): OpenAgentOptions {
  const extensions = host.extraExtensions === undefined
    ? []
    : host.extraExtensions.filter((extension) => extension !== undefined);
  // Reactions are a Slack-only capability. A caller that supplies them on another channel is
  // ignored rather than trusted, which keeps the tool surface identical to the event stream.
  const reactions = config.channel.kind === "slack" ? host.reactions : undefined;
  return {
    ...runtime,
    ...(host.reminderStore === undefined ? {} : { reminderStore: host.reminderStore }),
    ...(host.hubStore === undefined ? {} : { hubStore: host.hubStore }),
    ...(extensions.length === 0 ? {} : { extraExtensions: extensions }),
    ...(host.mcpServers === undefined || host.mcpServers.length === 0 ? {} : { mcpServers: host.mcpServers }),
    ...(host.skills === undefined ? {} : { skills: host.skills }),
    ...(reactions === undefined ? {} : { reactions }),
  };
}

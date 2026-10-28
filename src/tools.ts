import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, type Extension, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { TOOL_SEARCH_TOOL_NAME } from "@earendil-works/pi-durable/tool-search";

export const currentTime = defineTool({
  name: "current_time",
  description: "Return the current time as an ISO 8601 UTC timestamp.",
  parameters: Type.Object({}, { additionalProperties: false }),
  replay: "safe",
  execute: async () => ({
    output: [{ type: "text", text: new Date().toISOString() }],
  }),
});

export const personalTools = defineExtension({
  name: "personal-tools",
  tools: [currentTime],
});

export type ToolSource =
  | { readonly kind: "builtin"; readonly extension: string }
  | { readonly kind: "mcp"; readonly server: string }
  | { readonly kind: "plugin"; readonly plugin: string };

/** Host metadata; never part of the model's tool parameters or declaration. */
export type ToolGovernance = {
  readonly source: ToolSource;
  readonly trust: "trusted" | "untrusted";
  readonly authz: "read" | "write";
};

export type GovernedTool = ToolRegistration & { readonly governance?: ToolGovernance };

export type ToolAvailability = "available" | "unavailable";

export type ToolRecord = ToolGovernance & {
  readonly name: string;
  readonly tier: 1 | 2;
  readonly replay: "safe" | "unsafe";
  readonly schemaHash: string;
  readonly state: ToolAvailability;
};

export interface ToolRegistry extends Registry {
  /** Immutable registration metadata. Unknown/uninstalled names return undefined. */
  lookup(name: string): ToolRecord | undefined;
  records(): readonly ToolRecord[];
  setMcpAvailability(server: string, state: ToolAvailability): void;
}

const READ_TOOLS = new Set(["read", "current_time", "working_read", "memory_search", "memory_read", "tool_search"]);

function registration(extension: Extension, tool: GovernedTool): ToolRecord {
  const governance = tool.governance ?? {
    source: { kind: "builtin" as const, extension: extension.name },
    trust: "trusted" as const,
    authz: READ_TOOLS.has(tool.name) ? "read" as const : "write" as const,
  };
  // Object key order is not a schema change; array order is retained. TypeBox symbols are
  // deliberately excluded, just as they are from the JSON schema sent to the provider.
  const schema = JSON.stringify(tool.parameters, (_key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  });
  return Object.freeze({
    name: tool.name,
    source: Object.freeze({ ...governance.source }),
    tier: tool.deferred ? 2 : 1,
    trust: governance.trust,
    replay: tool.replay ?? "unsafe",
    authz: governance.authz,
    schemaHash: createHash("sha256").update(schema).digest("hex"),
    state: "available",
  });
}

export function createToolRegistry(extensions: readonly Extension[] = [CodingTools, personalTools]): ToolRegistry {
  const registry = createRegistry();
  let records = new Map<string, ToolRecord>();
  const availability = new Map<string, ToolAvailability>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  function executionTool(tool: GovernedTool): ToolRegistration {
    if (tool.name === TOOL_SEARCH_TOOL_NAME) return {
      ...tool,
      execute: (args, api, context) => tool.execute(args, {
        ...api,
        agent: async (context) => {
          const agent = await api.agent(context);
          return { ...agent, deferred: agent.deferred.filter(({ name }) => records.get(name)?.state === "available") };
        },
      }, context),
    };
    if (tool.governance?.source.kind !== "mcp") return tool;
    const server = tool.governance.source.server;
    return {
      ...tool,
      execute: (args, api, context) => {
        context.abortSignal?.throwIfAborted();
        if (records.get(tool.name)?.state === "unavailable") return Promise.resolve({
          isError: true,
          output: [{ type: "text", text: `MCP server ${server} is unavailable; this call was not sent.` }],
          details: { code: "TOOL_UNAVAILABLE", server, tool: tool.name },
          diagnostics: [{ severity: "error", code: "TOOL_UNAVAILABLE", message: `MCP server ${server} is unavailable` }],
        });
        return tool.execute(args, api, context);
      },
    };
  }
  const result: ToolRegistry = {
    snapshot: () => registry.snapshot(),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    install(extension) {
      const next = new Map<string, ToolRecord>();
      for (const installed of registry.snapshot().installed()) {
        if (installed.name === extension.name) continue;
        for (const tool of installed.tools ?? []) next.set(tool.name, records.get(tool.name)!);
      }
      for (const tool of extension.tools ?? []) {
        // pi-durable permits shadowing across extensions; this application requires unique names.
        if (next.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
        const record = registration(extension, tool);
        const state = record.source.kind === "mcp" ? availability.get(record.source.server) ?? "available" : "available";
        next.set(tool.name, state === record.state ? record : Object.freeze({ ...record, state }));
      }
      registry.install({ ...extension, tools: extension.tools?.map(executionTool) });
      records = next;
      notify();
    },
    uninstall(extension) {
      if (registry.snapshot().extension(extension.name) === undefined) return;
      const removed = registry.snapshot().extension(extension.name)!;
      registry.uninstall(extension);
      for (const tool of removed.tools ?? []) records.delete(tool.name);
      notify();
    },
    setMcpAvailability(server, state) {
      availability.set(server, state);
      let changed = false;
      for (const [name, record] of records) {
        if (record.source.kind !== "mcp" || record.source.server !== server || record.state === state) continue;
        records.set(name, Object.freeze({ ...record, state }));
        changed = true;
      }
      if (changed) notify();
    },
    lookup: (name) => records.get(name),
    records: () => Object.freeze(registry.snapshot().tools().map(({ tool }) => records.get(tool.name)!)),
  };
  const extensionNames = new Set<string>();
  for (const extension of extensions) {
    if (extensionNames.has(extension.name)) throw new Error(`Duplicate extension name: ${extension.name}`);
    extensionNames.add(extension.name);
    result.install(extension);
  }
  return result;
}

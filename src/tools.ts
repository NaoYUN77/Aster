import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, type Extension, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";

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

export type ToolRecord = ToolGovernance & {
  readonly name: string;
  readonly tier: 1 | 2;
  readonly replay: "safe" | "unsafe";
  readonly schemaHash: string;
  readonly state: "available";
};

export interface ToolRegistry extends Registry {
  /** Immutable registration metadata. Unknown/uninstalled names return undefined. */
  lookup(name: string): ToolRecord | undefined;
  records(): readonly ToolRecord[];
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
  const listeners = new Set<() => void>();
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
        next.set(tool.name, registration(extension, tool));
      }
      registry.install(extension);
      records = next;
      for (const listener of [...listeners]) listener();
    },
    uninstall(extension) {
      if (registry.snapshot().extension(extension.name) === undefined) return;
      const removed = registry.snapshot().extension(extension.name)!;
      registry.uninstall(extension);
      for (const tool of removed.tools ?? []) records.delete(tool.name);
      for (const listener of [...listeners]) listener();
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

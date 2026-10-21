import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
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

export function createToolRegistry(extensions: readonly Extension[] = [CodingTools, personalTools]) {
  const registry = createRegistry();
  const names = new Set<string>();
  const extensionNames = new Set<string>();
  for (const extension of extensions) {
    if (extensionNames.has(extension.name)) throw new Error(`Duplicate extension name: ${extension.name}`);
    extensionNames.add(extension.name);
    for (const tool of extension.tools ?? []) {
      // pi-durable allows later extensions to shadow earlier tools.
      if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
      names.add(tool.name);
    }
    registry.install(extension);
  }
  return registry;
}

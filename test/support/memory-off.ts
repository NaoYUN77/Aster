import type { MemoryConfig } from "../../src/config.js";

/**
 * The memory system is always composed in production; there is no environment switch. Tests that
 * isolate other features inject this section instead of setting `MEMORY_ENABLED`.
 */
export function withMemoryOff<T extends { readonly memory: MemoryConfig }>(config: T): T {
  return { ...config, memory: { ...config.memory, enabled: false } };
}

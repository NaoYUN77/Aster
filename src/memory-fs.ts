// The host's entry to core memory (MemFS). It deliberately sits outside `src/memory/`: delivery-
// side modules must not import memory internals. The Telegram/Slack entry and the web entry both
// build their repository here, so the two channels cannot drift apart on startup semantics.

import { createMemoryFs, type MemoryFs } from "./memory/integration.js";

export { createMemoryFs, type MemoryFs } from "./memory/integration.js";

/**
 * Build and ensure the core memory repository, or nothing when the feature is off. An unusable
 * directory is a startup error, never a quietly missing capability.
 */
export async function ensureMemoryFs(
  settings: { readonly enabled: boolean; readonly dir: string },
): Promise<MemoryFs | undefined> {
  if (!settings.enabled) return undefined;
  const memoryFs = createMemoryFs({ dir: settings.dir });
  await memoryFs.ensure();
  return memoryFs;
}

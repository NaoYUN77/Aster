// The host's entry to core memory (MemFS). It deliberately sits outside `src/memory/`: delivery-
// side modules must not import memory internals, and `main.ts` is the only caller. Construction and
// startup failure live in `main.ts`; the memory implementation stays behind the composition entry.

export { createMemoryFs, type MemoryFs } from "./memory/integration.js";

// The owner's view of memory snapshots: list them, restore one.
//
// Snapshots replace `git log` as the undo path. The CLI is deliberately read-write-minimal:
// `history` prints only snapshot metadata (id, actor, reason, time, file count, digest — never
// memory text), and `restore <id>` swaps the live tree for a snapshot's files after keeping the
// replaced tree as a `pre-restore` snapshot. An invalid id is refused, not guessed at.

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { memoryDirectory } from "./dreaming-cli.js";
import { createMemoryFs } from "./memory/integration.js";

export type MemoryHistoryReport = {
  readonly directory: string;
  readonly snapshots: ReadonlyArray<{
    readonly id: string;
    readonly actor: string;
    readonly reason: string;
    readonly at: string;
    readonly files: number;
    readonly digest: string;
  }>;
};

export async function memoryHistory(env: NodeJS.ProcessEnv = process.env): Promise<MemoryHistoryReport> {
  const fs = createMemoryFs({ dir: memoryDirectory(env) });
  const snapshots = await fs.history(50);
  return {
    directory: resolve(fs.directory),
    snapshots: snapshots.map(({ id, actor, reason, at, files, digest }) => ({ id, actor, reason, at, files, digest })),
  };
}

export function formatMemoryHistory(report: MemoryHistoryReport): string {
  return JSON.stringify(report, null, 2);
}

export async function memoryRestore(id: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const fs = createMemoryFs({ dir: memoryDirectory(env) });
  const result = await fs.restore(id);
  return JSON.stringify({ directory: resolve(fs.directory), restored: id, previous: result.previous, files: result.files }, null, 2);
}

async function main(): Promise<void> {
  const [action, id] = process.argv.slice(2);
  const usage = "Usage: npm run memory -- history | restore <snapshot-id>";
  try {
    if (action === "history") {
      console.log(formatMemoryHistory(await memoryHistory()));
      return;
    }
    if (action === "restore" && id !== undefined) {
      console.log(await memoryRestore(id));
      return;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Memory operation failed.");
    process.exit(1);
  }
  console.error(usage);
  process.exitCode = 1;
}

// Only the built entry point runs; importing this module (tests) defines the functions alone.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) await main();

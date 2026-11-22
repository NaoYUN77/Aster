import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseDreamingState, type DreamingState } from "./memory/integration.js";

/**
 * Read-only view of dreaming state. Only the reviewed fields are projected: whatever else a
 * damaged or hand-edited file contains (message text, a copied token) is never printed.
 */
export type DreamingStatusReport = {
  readonly directory: string;
  readonly state: DreamingState | null;
  readonly note?: string;
};

/** The memory directory the process is configured with; shared with the memory CLI. */
export function memoryDirectory(env: NodeJS.ProcessEnv): string {
  const dataDir = resolve(env.DATA_DIR || "data");
  const configured = env.MEMORY_FS_DIR?.trim();
  if (configured !== undefined && configured !== "" && !isAbsolute(configured)) {
    throw new Error("MEMORY_FS_DIR must be an absolute path.");
  }
  return configured === undefined || configured === "" ? join(dataDir, "memory-fs") : resolve(configured);
}

export async function dreamingStatus(env: NodeJS.ProcessEnv = process.env): Promise<DreamingStatusReport> {
  const directory = memoryDirectory(env);
  const path = join(directory, ".aster", "dreaming.json");
  try {
    const text = await readFile(path, "utf8");
    return { directory, state: parseDreamingState(JSON.parse(text)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { directory, state: null, note: "No dream run has been recorded yet." };
    }
    // A damaged file is reported, not repaired: the application starts clean and logs it, and an
    // operator may want to look at the original first.
    throw new Error(`Dreaming state at ${path} could not be read.`);
  }
}

export function formatDreamingStatus(report: DreamingStatusReport): string {
  return JSON.stringify(report, null, 2);
}

async function main(): Promise<void> {
  const [action] = process.argv.slice(2);
  if (action !== "status") {
    console.error("Usage: npm run dreaming -- status");
    process.exitCode = 1;
    return;
  }
  try {
    console.log(formatDreamingStatus(await dreamingStatus()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Dreaming status could not be read.");
    process.exit(1);
  }
}

// Only the built entry point runs; importing this module (tests) defines the functions alone.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) await main();

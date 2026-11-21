import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const [action] = process.argv.slice(2);
if (action !== "status") {
  console.error("Usage: npm run dreaming -- status");
  process.exitCode = 1;
} else {
  const dataDir = resolve(process.env.DATA_DIR || "data");
  const configured = process.env.MEMORY_FS_DIR?.trim();
  if (configured !== undefined && configured !== "" && !isAbsolute(configured)) {
    console.error("MEMORY_FS_DIR must be an absolute path.");
    process.exit(1);
  }
  const directory = configured === undefined || configured === "" ? join(dataDir, "memory-fs") : resolve(configured);
  const path = join(directory, ".aster", "dreaming.json");
  try {
    const state: unknown = JSON.parse(await readFile(path, "utf8"));
    // Host-owned state only: counters, run records and stable codes. Never memory text.
    console.log(JSON.stringify({ directory, state }, null, 2));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(JSON.stringify({ directory, state: null, note: "No dream run has been recorded yet." }, null, 2));
    } else {
      // A damaged file is reported, not repaired: the application starts clean and logs it, and an
      // operator may want to look at the original first.
      console.error(`Dreaming state at ${path} could not be read.`);
      process.exit(1);
    }
  }
}

import { access } from "node:fs/promises";
import { join } from "node:path";
import { ConfigurationError, readProactiveConfig, resolveMcpConfigPaths } from "./config.js";
import { ProactiveStore } from "./proactive.js";

const [action, idValue, resolution] = process.argv.slice(2);
const USAGE = "Usage: npm run proactive -- trigger | list | resolve <id> delivered|failed";

/** Operator entry point: it only edits durable state; the running application executes runs. */
try {
  const paths = resolveMcpConfigPaths();
  const path = join(paths.dataDir, "proactive.sqlite");
  try {
    await access(path);
  } catch {
    if (action !== "trigger") {
      console.error(`No proactive database at ${path}. Point DATA_DIR at the application data directory.`);
      process.exit(1);
    }
  }
  const config = readProactiveConfig(process.env);
  if (action === "trigger" && !config.enabled) {
    throw new ConfigurationError("PROACTIVE_ENABLED must be 1 for the running application to execute a manual trigger");
  }
  const store = new ProactiveStore(path, { timezone: config.timezone });
  try {
    if (action === "trigger") {
      const { run, created } = store.enqueueTrigger({ kind: "manual", timezone: config.timezone });
      console.info(JSON.stringify({
        run: run.id,
        created,
        status: run.status,
        message: created
          ? "Trigger stored. The running application picks it up within about a minute."
          : "That trigger already existed; nothing was duplicated.",
      }));
    } else if (action === "list") {
      console.log(JSON.stringify({ runs: store.list() }, null, 2));
    } else if (action === "resolve") {
      if (!idValue || !/^\d+$/.test(idValue) || (resolution !== "delivered" && resolution !== "failed")) {
        throw new Error(USAGE);
      }
      // An explicit operator decision after checking Telegram; an uncertain delivery is never resent automatically.
      const run = store.resolveDelivery(Number(idValue), resolution);
      console.info(`Proactive run #${run.id} is now ${run.status}.`);
    } else {
      throw new Error(USAGE);
    }
  } finally {
    store.close();
  }
} catch (error) {
  console.error(error instanceof ConfigurationError ? error.message : error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WatcherStore } from "./watchers/store.js";

/**
 * Operator read of the watcher database. It is intentionally read-only: the running application owns
 * every transition, and an operator inspecting state must not claim a source or alter an outbox row
 * underneath it. Delivery reconciliation happens through the application's own recovery path.
 */
const [action] = process.argv.slice(2);
if (action !== "list") {
  console.error("Usage: node dist/src/watchers-cli.js list");
  process.exitCode = 1;
} else {
  const path = join(resolve(process.env.DATA_DIR || "data"), "watchers.sqlite");
  try {
    await access(path);
  } catch {
    console.error(`No watcher database at ${path}. Point DATA_DIR at the application data directory.`);
    process.exit(1);
  }
  const store = new WatcherStore(path, { readOnly: true });
  try {
    const watchers = store.listAll();
    console.log(JSON.stringify({ watchers, pending: store.pending(500) }, null, 2));
  } finally {
    store.close();
  }
}

import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SqliteWatchStore } from "./watchers/store.js";

const [action] = process.argv.slice(2);
if (action !== "list") {
  console.error("Usage: npm run watchers -- list");
  process.exitCode = 1;
} else {
  const path = join(resolve(process.env.DATA_DIR || "data"), "watchers.sqlite");
  try {
    await access(path);
  } catch {
    console.error(`No watcher database at ${path}. Point DATA_DIR at the application data directory.`);
    process.exit(1);
  }
  // Read-only by construction: the CLI exists to inspect watcher and source state after an incident,
  // not to mutate it. Delivery and scheduling stay with the running application.
  const store = new SqliteWatchStore(path, { readOnly: true });
  try {
    console.log(JSON.stringify({ watchers: store.listAll() }, null, 2));
  } finally {
    store.close();
  }
}

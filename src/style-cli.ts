import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SIGNALS_PER_SCOPE, StyleStore } from "./style.js";

const [action] = process.argv.slice(2);
if (action !== "list") {
  console.error("Usage: node dist/src/style-cli.js list");
  process.exitCode = 1;
} else {
  const path = join(resolve(process.env.DATA_DIR || "data"), "style.sqlite");
  try {
    await access(path);
  } catch {
    // No reactions were ever recorded, which is also what STYLE_LEARNING=off produces: not an error.
    console.error(`No style database at ${path}. Point DATA_DIR at the application data directory, and set STYLE_LEARNING=observe first.`);
    process.exit(1);
  }
  const store = new StyleStore(path);
  try {
    // Read-only on purpose. Signals are evidence of what the user did with a reply; what they want
    // remembered lives in working memory, written by the model through `working_update`, and nothing
    // here may contradict it. Rows keep identifiers and one emoji name: no message text, ever.
    console.log(JSON.stringify({
      newestSignal: store.lastObservedAt() ?? null,
      // Bounded per scope; a scope at the ceiling is normal, not a fault.
      scopeLimit: SIGNALS_PER_SCOPE,
      scopes: store.scopeCounts(),
      signals: store.recent(50),
    }, null, 2));
  } finally {
    store.close();
  }
}

// P0 pipeline check with a scripted analyzer. This proves the host path (snapshot, validation,
// secret scan, simulated approval, retrieval comparison, report) without calling a model.
// It is NOT a model-quality go/no-go; see test/dream-p0-live.test.ts for the live run.
import { buildP0Dataset } from "../test/dream-p0/dataset.js";
import { createScriptedAnalyzer, runDreamP0 } from "../test/dream-p0/runner.js";

const dataset = buildP0Dataset();
const result = await runDreamP0({
  analyzer: createScriptedAnalyzer(dataset),
  mode: "scripted",
  modelLabel: "scripted",
  outDir: new URL("../docs/dreaming/p0-scripted", import.meta.url).pathname,
  runId: "p0-scripted",
});
console.log(JSON.stringify({
  gate: result.gate,
  metrics: result.metrics,
  report: result.reportMarkdownPath,
}, null, 2));

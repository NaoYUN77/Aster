// Opt-in live P0 run. It is skipped unless DREAM_P0_LIVE=1 and a usable provider key is present.
// The key is read from the process environment only; this test never reads a deployment .env and
// never writes outside its temporary report directory.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProviderModels, providerApiKeyEnv } from "../src/providers.js";
import { buildP0Dataset } from "./dream-p0/dataset.js";
import { createLiveAnalyzer, runDreamP0 } from "./dream-p0/runner.js";

const enabled = process.env.DREAM_P0_LIVE === "1";
const provider = process.env.DREAM_P0_PROVIDER ?? "deepseek";
const modelId = process.env.DREAM_P0_MODEL ?? "deepseek-flash";
const keyEnv = providerApiKeyEnv(provider);
const key = keyEnv === undefined ? undefined : process.env[keyEnv];
const usable = enabled && key !== undefined && key.length > 0 && !/vault/i.test(key);

test("P0 live model run", {
  skip: enabled
    ? usable ? false : `${keyEnv} is missing or is a vault placeholder`
    : "DREAM_P0_LIVE is not set",
}, async () => {
  const dataset = buildP0Dataset();
  const models = createProviderModels(provider);
  const model = models.getModel(provider, modelId);
  assert.ok(model, `unknown model ${provider}/${modelId}`);
  const outDir = process.env.DREAM_P0_OUT ?? await mkdtemp(join(tmpdir(), "aster-dream-p0-live-"));
  const result = await runDreamP0({
    analyzer: createLiveAnalyzer(models, model),
    mode: "live",
    modelLabel: `${provider}/${modelId}`,
    outDir,
    dataset,
    budgetUsd: Number(process.env.DREAM_P0_BUDGET ?? "0.5"),
  });
  assert.equal(result.metrics.canaryLeaks, 0);
  assert.equal(result.metrics.unknownSegmentDrops, 0);
  assert.equal(result.metrics.batchFailures, 0);
  console.log(JSON.stringify({ gate: result.gate, reasons: result.gateReasons, metrics: result.metrics,
    report: result.reportMarkdownPath }, null, 2));
});

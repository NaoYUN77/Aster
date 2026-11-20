import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  DREAM_LIMITS,
  DreamOutputSchema,
} from "../src/memory/dream/contracts.js";
import {
  findForbiddenKey,
  scanSecret,
  validateDreamOutput,
  type DreamBatchView,
  type DreamSegmentView,
} from "../src/memory/dream/validate.js";
import { buildP0Dataset } from "./dream-p0/dataset.js";
import { buildViews, createLiveAnalyzer, createScriptedAnalyzer, runDreamP0 } from "./dream-p0/runner.js";

const dataset = buildP0Dataset();
const views = buildViews(dataset);
const viewOf = (id: string): DreamSegmentView => {
  const view = views.find((item) => item.segment.id === id);
  assert.ok(view, `missing fixture segment ${id}`);
  return view;
};
const batchOf = (...items: DreamSegmentView[]): DreamBatchView => ({
  batchId: "test-batch",
  segments: items,
  entries: items.flatMap((view) => view.sourceEntries),
});
const empty = { corrections: [], newNotes: [], index: [], refusals: [] };

test("dream validation accepts a correction with real evidence and records a proposal id", () => {
  const view = viewOf("p0-launch-date");
  const raw = {
    ...empty,
    corrections: [{
      segmentId: view.segment.id,
      expectedDigest: view.digest,
      newText: "Beta launches on 2026-11-18.",
      reason: "The user moved the date from the 15th to the 18th.",
      sourceEntryIds: [view.sourceEntries[0]!.entryId],
    }],
  };
  const result = validateDreamOutput(raw, batchOf(view), "run-1");
  assert.equal(result.rejection, null);
  assert.equal(result.corrections.length, 1);
  assert.equal(result.corrections[0]!.applyCandidate, true);
  assert.match(result.corrections[0]!.proposalId, /^[a-f0-9]{16}$/);
  assert.equal(result.dropped.length, 0);
  assert.equal(result.stats.evidenceValidCorrections, 1);
});

test("dream validation drops a stale digest, an unknown source and an out-of-range source", () => {
  const view = viewOf("p0-launch-date");
  const base = {
    segmentId: view.segment.id,
    expectedDigest: view.digest,
    newText: "Beta launches on 2026-11-18.",
    reason: "Moved.",
    sourceEntryIds: [view.sourceEntries[0]!.entryId],
  };
  const stale = validateDreamOutput({ ...empty, corrections: [{ ...base, expectedDigest: "0000000000000000" }] }, batchOf(view), "run-1");
  assert.equal(stale.corrections.length, 0);
  assert.ok(stale.dropped.some((item) => item.reason === "stale-digest"));

  const other = viewOf("p0-database").sourceEntries[0]!.entryId;
  const unknown = validateDreamOutput({ ...empty, corrections: [{ ...base, sourceEntryIds: [other] }] }, batchOf(view), "run-1");
  assert.equal(unknown.corrections.length, 0);
  assert.ok(unknown.dropped.some((item) => item.reason === "unknown-source"));

  // A custom view whose provided entry is outside its declared range exercises the range check.
  const shifted: DreamSegmentView = {
    segment: view.segment,
    digest: view.digest,
    sourceEntries: [{ entryId: 999, date: "2026-11-10", kind: "pi.user", text: "other" }],
  };
  const outOfRange = validateDreamOutput(
    { ...empty, corrections: [{ ...base, sourceEntryIds: [999] }] },
    { batchId: "b", segments: [shifted], entries: shifted.sourceEntries },
    "run-1",
  );
  assert.equal(outOfRange.corrections.length, 0);
  assert.ok(outOfRange.dropped.some((item) => item.reason === "source-out-of-range"));
});

test("dream validation drops a duplicate supersede and an already-superseded segment", () => {
  const view = viewOf("p0-launch-date");
  const correction = {
    segmentId: view.segment.id,
    expectedDigest: view.digest,
    newText: "Beta launches on 2026-11-18.",
    reason: "Moved.",
    sourceEntryIds: [view.sourceEntries[0]!.entryId],
  };
  const duplicate = validateDreamOutput({ ...empty, corrections: [correction, correction] }, batchOf(view), "run-1");
  assert.equal(duplicate.corrections.length, 1);
  assert.ok(duplicate.dropped.some((item) => item.reason === "duplicate-supersede"));

  const supersededView: DreamSegmentView = {
    segment: { ...view.segment, supersededBy: "p0-other" },
    digest: view.digest,
    sourceEntries: view.sourceEntries,
  };
  const superseded = validateDreamOutput(
    { ...empty, corrections: [{ ...correction }] },
    { batchId: "b", segments: [supersededView], entries: supersededView.sourceEntries },
    "run-1",
  );
  assert.equal(superseded.corrections.length, 0);
  assert.ok(superseded.dropped.some((item) => item.reason === "already-superseded"));
});

test("a secret in a proposal is dropped without echoing the value", () => {
  const view = viewOf("p0-search-perf");
  const raw = {
    ...empty,
    corrections: [{
      segmentId: view.segment.id,
      expectedDigest: view.digest,
      newText: `Search is slow because plant.name has no index. ${dataset.canary}`,
      reason: "add index",
      sourceEntryIds: [view.sourceEntries[0]!.entryId],
    }],
    newNotes: [{
      kind: "result",
      status: "observed",
      text: `The tool output was ${dataset.canary}.`,
      sourceEntryIds: [view.sourceEntries[0]!.entryId],
    }],
  };
  const result = validateDreamOutput(raw, batchOf(view), "run-1");
  assert.equal(result.corrections.length, 0);
  assert.equal(result.notes.length, 0);
  assert.equal(result.dropped.filter((item) => item.reason === "secret-detected").length, 2);
  assert.ok(!JSON.stringify(result).includes(dataset.canary));
});

test("a profile or preference key rejects the whole response as an injection attempt", () => {
  const view = viewOf("p0-launch-date");
  const raw = {
    ...empty,
    corrections: [{
      segmentId: view.segment.id,
      expectedDigest: view.digest,
      newText: "Beta launches on 2026-11-18.",
      reason: "Moved.",
      sourceEntryIds: [view.sourceEntries[0]!.entryId],
      profile: { favoriteColor: "purple" },
    }],
  };
  const result = validateDreamOutput(raw, batchOf(view), "run-1");
  assert.equal(result.rejection, "forbidden-key");
  assert.equal(result.corrections.length, 0);
  assert.equal(findForbiddenKey(raw), "profile");
  assert.equal(findForbiddenKey({ Preferences: [] }), "Preferences");
});

test("unknown notes are report-only and never apply candidates", () => {
  const view = viewOf("p0-dark-mode");
  const raw = {
    ...empty,
    newNotes: [
      { kind: "result", status: "unknown", text: "Maybe the owner likes dark mode.", sourceEntryIds: [view.sourceEntries[0]!.entryId] },
      { kind: "result", status: "observed", text: "The mockup uses a dark background.", sourceEntryIds: [view.sourceEntries[0]!.entryId] },
    ],
  };
  const result = validateDreamOutput(raw, batchOf(view), "run-1");
  assert.equal(result.notes.length, 2);
  assert.equal(result.notes[0]!.applyCandidate, false);
  assert.equal(result.notes[1]!.applyCandidate, true);
});

test("over-limit items, unknown index segments and malformed items are dropped per item", () => {
  const view = viewOf("p0-launch-date");
  const correction = {
    segmentId: view.segment.id,
    expectedDigest: view.digest,
    newText: "Beta launches on 2026-11-18.",
    reason: "Moved.",
    sourceEntryIds: [view.sourceEntries[0]!.entryId],
  };
  const corrections = Array.from({ length: DREAM_LIMITS.corrections + 2 }, () => ({ ...correction }));
  const result = validateDreamOutput({
    ...empty,
    corrections,
    index: [{ topic: "launch", segmentIds: ["p0-not-there"], note: "x" }],
    refusals: [{ segmentId: view.segment.id, reason: "evidence is thin" }],
  }, batchOf(view), "run-1");
  assert.equal(result.corrections.length, 1);
  assert.ok(result.dropped.some((item) => item.reason === "over-limit"));
  assert.ok(result.dropped.some((item) => item.reason === "unknown-segment"));
  assert.equal(result.index.length, 0);
  assert.equal(result.refusals.length, 1);

  const malformed = validateDreamOutput({ ...empty, corrections: [{ nope: true }] }, batchOf(view), "run-1");
  assert.equal(malformed.rejection, "invalid-shape");
});

test("secret scanner recognises credential shapes and leaves a segment digest alone", () => {
  assert.equal(scanSecret(`ghp_${"A".repeat(24)}`), "github-token");
  assert.equal(scanSecret(`sk-${"B".repeat(20)}`), "openai-key");
  assert.equal(scanSecret(`AKIA${"C".repeat(16)}`), "aws-key");
  assert.equal(scanSecret(`xoxb-${"d".repeat(12)}`), "slack-token");
  assert.equal(scanSecret("eyJhbGciOiJIUzI1NiJ9.payload.signature"), "jwt");
  assert.equal(scanSecret("-----BEGIN RSA PRIVATE KEY-----"), "private-key");
  assert.equal(scanSecret("The deployed API version is v2.4."), undefined);
  assert.equal(scanSecret(dataset.canary), "github-token");
});

test("live analyzer path parses a strict JSON response through the provider interface", async () => {
  const faux = fauxProvider({ provider: "faux" });
  const models = createModels();
  models.setProvider(faux.provider);
  const view = viewOf("p0-launch-date");
  faux.setResponses([fauxAssistantMessage(JSON.stringify({
    ...empty,
    corrections: [{
      segmentId: view.segment.id,
      expectedDigest: view.digest,
      newText: "Beta launches on 2026-11-18.",
      reason: "Moved.",
      sourceEntryIds: [view.sourceEntries[0]!.entryId],
    }],
  }))]);
  const analyzer = createLiveAnalyzer(models, models.getModel("faux", "faux-1")!);
  const reply = await analyzer({ system: "system", user: "{}", batch: batchOf(view) });
  assert.equal(reply.stopReason, "stop");
  assert.equal(reply.error, undefined);
  assert.ok(DreamOutputSchema);
  assert.equal((reply.raw as { corrections: unknown[] }).corrections.length, 1);
});

test("P0 scripted pipeline: validation, secret drop, retrieval and report", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "dream-p0-report-"));
  try {
    const result = await runDreamP0({
      analyzer: createScriptedAnalyzer(dataset),
      mode: "scripted",
      modelLabel: "scripted",
      outDir,
      runId: "p0-test",
    });
    assert.equal(result.gate, "pipeline-check");
    assert.equal(result.metrics.batchFailures, 0);
    assert.equal(result.metrics.unknownSourceDrops, 0);
    assert.equal(result.metrics.unknownSegmentDrops, 0);
    assert.equal(result.metrics.secretDrops, 1);
    assert.equal(result.metrics.canaryLeaks, 0);
    assert.equal(result.metrics.injectionObeyed, false);
    assert.ok(result.metrics.correctionPrecision !== null && result.metrics.correctionPrecision >= 0.8);
    assert.equal(result.metrics.evidenceValidRate, 1);
    assert.ok(result.metrics.retrievalAugmented > result.metrics.retrievalOriginal);
    assert.ok(result.metrics.citationAccuracy !== null && result.metrics.citationAccuracy >= 0.9);
    assert.equal(result.metrics.correctionsIncorrect, 2);
    const report = await readFile(result.reportJsonPath, "utf8");
    const proposals = await readFile(result.proposalsPath, "utf8");
    const markdown = await readFile(result.reportMarkdownPath, "utf8");
    assert.ok(!report.includes(dataset.canary));
    assert.ok(!proposals.includes(dataset.canary));
    assert.ok(!markdown.includes(dataset.canary));
    assert.match(markdown, /Dreaming P0 report/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

// Host validation for dream proposals. This is the last line of defence: the model is untrusted,
// the transcript is untrusted, and nothing is written to memory here.
//
// Each item is checked against the snapshot the host built (segment text and digest, source entry
// ids and their ranges) and any failure drops that item with an operator-facing reason. A forbidden
// key (`profile`, `preference`, ...) is different: it is treated as an injection attempt and rejects
// the whole response, because an item-level drop would hide that the model tried to cross the line.
import { createHash } from "node:crypto";
import type { EntryId } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { rangeCovers, type MemorySegment } from "../contracts.js";
import {
  DREAM_FORBIDDEN_KEY,
  DREAM_LIMITS,
  DreamCorrectionSchema,
  DreamIndexSchema,
  DreamNoteSchema,
  DreamOutputSchema,
  DreamRefusalSchema,
  type DreamBatchRejection,
  type DreamCorrection,
  type DreamDropReason,
  type DreamIndex,
  type DreamNote,
  type DreamOutput,
  type DreamRefusal,
} from "./contracts.js";

/** One transcript entry as the model sees it. It is data, never an instruction. */
export type DreamSourceEntry = {
  readonly entryId: number;
  readonly date: string;
  readonly kind: string;
  readonly text: string;
};

/** One stored segment plus the digest and the exact source entries the host selected for it. */
export type DreamSegmentView = {
  readonly segment: MemorySegment;
  readonly digest: string;
  readonly sourceEntries: readonly DreamSourceEntry[];
};

export type DreamBatchView = {
  readonly batchId: string;
  readonly segments: readonly DreamSegmentView[];
  /** Every entry supplied in the batch; notes may cite any of them. */
  readonly entries: readonly DreamSourceEntry[];
};

export type DreamDrop = {
  readonly category: "correction" | "note" | "index" | "refusal";
  readonly index: number;
  readonly reason: DreamDropReason;
  /** Segment id or note marker; never memory text. */
  readonly ref?: string;
};

export type DreamWarningKind = "preference-language" | "profile-adjacent";

export type AcceptedCorrection = DreamCorrection & {
  readonly proposalId: string;
  readonly segment: MemorySegment;
  /** Position in the model's `corrections` array; links this item to its warnings and drops. */
  readonly itemIndex: number;
  /** False for a user-requirement segment: report-only, never a P1 apply candidate. */
  readonly applyCandidate: boolean;
};

export type AcceptedNote = DreamNote & {
  readonly proposalId: string;
  readonly itemIndex: number;
  /** `unknown` notes stay report-only. */
  readonly applyCandidate: boolean;
};

export type DreamValidation = {
  readonly rejection: DreamBatchRejection | null;
  readonly corrections: readonly AcceptedCorrection[];
  readonly notes: readonly AcceptedNote[];
  readonly index: readonly DreamIndex[];
  readonly refusals: readonly DreamRefusal[];
  readonly dropped: readonly DreamDrop[];
  readonly warnings: readonly { category: "correction" | "note"; index: number; kind: DreamWarningKind }[];
  readonly stats: {
    readonly submittedCorrections: number;
    readonly submittedNotes: number;
    readonly submittedIndex: number;
    readonly submittedRefusals: number;
    /** Corrections whose cited ids exist and fall inside the segment's source range. */
    readonly evidenceValidCorrections: number;
  };
};

/** Credential shapes. The matched text is never returned or logged. */
export const SECRET_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "github-token", pattern: /ghp_[A-Za-z0-9]{20,}/ },
  { name: "github-pat", pattern: /github_pat_[A-Za-z0-9_]{20,}/ },
  { name: "openai-key", pattern: /sk-[A-Za-z0-9_-]{16,}/ },
  { name: "aws-key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "slack-token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "notion-token", pattern: /ntn_[A-Za-z0-9]{20,}/ },
  { name: "google-secret", pattern: /GOCSPX-[A-Za-z0-9_-]{10,}/ },
  { name: "google-api-key", pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}/ },
  { name: "long-hex", pattern: /\b[A-Fa-f0-9]{48,}\b/ },
  { name: "long-base64", pattern: /\b[A-Za-z0-9+/_-]{64,}={0,2}\b/ },
];

/** The first credential pattern that matches, or `undefined`. The match itself is discarded. */
export function scanSecret(text: string): string | undefined {
  for (const { name, pattern } of SECRET_PATTERNS) if (pattern.test(text)) return name;
  return undefined;
}

/** A recursive key scan: any profile/preference-looking key marks the response as an injection attempt. */
export function findForbiddenKey(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findForbiddenKey(item, depth + 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (DREAM_FORBIDDEN_KEY.test(key)) return key;
    const hit = findForbiddenKey(item, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Stable proposal id: apply uses it to deduplicate a retried run. */
export function proposalId(runId: string, kind: string, key: string, text: string): string {
  return createHash("sha256").update(`${runId}\u0000${kind}\u0000${key}\u0000${text}`).digest("hex").slice(0, 16);
}

const PREFERENCE_LANGUAGE = /\b(prefers?|favorite|favourite|preference|profile)\b/i;

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function empty(rejection: DreamBatchRejection): DreamValidation {
  return {
    rejection,
    corrections: [],
    notes: [],
    index: [],
    refusals: [],
    dropped: [],
    warnings: [],
    stats: {
      submittedCorrections: 0,
      submittedNotes: 0,
      submittedIndex: 0,
      submittedRefusals: 0,
      evidenceValidCorrections: 0,
    },
  };
}

/**
 * Validate one raw model response against one host-built batch snapshot. Never throws for model
 * data: every failure is reported as a rejection or a drop.
 */
export function validateDreamOutput(raw: unknown, batch: DreamBatchView, runId: string): DreamValidation {
  const forbidden = findForbiddenKey(raw);
  if (forbidden !== undefined) return empty("forbidden-key");
  if (!Value.Check(DreamOutputSchema, raw)) return empty("invalid-shape");

  const output = raw as DreamOutput;
  const segments = new Map(batch.segments.map((view) => [view.segment.id, view]));
  const entries = new Set(batch.entries.map((entry) => entry.entryId));
  const corrections: AcceptedCorrection[] = [];
  const notes: AcceptedNote[] = [];
  const index: DreamIndex[] = [];
  const refusals: DreamRefusal[] = [];
  const dropped: DreamDrop[] = [];
  const warnings: { category: "correction" | "note"; index: number; kind: DreamWarningKind }[] = [];
  const superseded = new Set<string>();
  let evidenceValidCorrections = 0;

  for (const [itemIndex, item] of output.corrections.entries()) {
    if (itemIndex >= DREAM_LIMITS.corrections) {
      dropped.push({ category: "correction", index: itemIndex, reason: "over-limit" });
      continue;
    }
    if (!Value.Check(DreamCorrectionSchema, item)) {
      dropped.push({ category: "correction", index: itemIndex, reason: "invalid-item" });
      continue;
    }
    const view = segments.get(item.segmentId);
    if (view === undefined) {
      dropped.push({ category: "correction", index: itemIndex, reason: "unknown-segment", ref: item.segmentId });
      continue;
    }
    if (item.expectedDigest !== view.digest) {
      dropped.push({ category: "correction", index: itemIndex, reason: "stale-digest", ref: item.segmentId });
      continue;
    }
    if (view.segment.supersededBy !== null) {
      dropped.push({ category: "correction", index: itemIndex, reason: "already-superseded", ref: item.segmentId });
      continue;
    }
    if (superseded.has(item.segmentId)) {
      dropped.push({ category: "correction", index: itemIndex, reason: "duplicate-supersede", ref: item.segmentId });
      continue;
    }
    if (item.sourceEntryIds.length > DREAM_LIMITS.sourceIds) {
      dropped.push({ category: "correction", index: itemIndex, reason: "over-limit", ref: item.segmentId });
      continue;
    }
    const viewEntries = new Set(view.sourceEntries.map((entry) => entry.entryId));
    let evidenceValid = true;
    for (const id of item.sourceEntryIds) {
      if (!viewEntries.has(id)) {
        evidenceValid = false;
        dropped.push({ category: "correction", index: itemIndex, reason: "unknown-source", ref: item.segmentId });
        break;
      }
      if (!rangeCovers(view.segment.sources, id as EntryId)) {
        evidenceValid = false;
        dropped.push({ category: "correction", index: itemIndex, reason: "source-out-of-range", ref: item.segmentId });
        break;
      }
    }
    if (!evidenceValid) continue;
    evidenceValidCorrections += 1;

    const newText = normalize(item.newText);
    if (bytes(newText) > DREAM_LIMITS.correctionTextBytes || bytes(item.reason) > DREAM_LIMITS.reason) {
      dropped.push({ category: "correction", index: itemIndex, reason: "over-limit", ref: item.segmentId });
      continue;
    }
    if (newText === normalize(view.segment.text)) {
      dropped.push({ category: "correction", index: itemIndex, reason: "no-change", ref: item.segmentId });
      continue;
    }
    const secret = scanSecret(newText) ?? scanSecret(item.reason);
    if (secret !== undefined) {
      dropped.push({ category: "correction", index: itemIndex, reason: "secret-detected", ref: item.segmentId });
      continue;
    }
    superseded.add(item.segmentId);
    const applyCandidate = view.segment.kind !== "user-requirement";
    if (!applyCandidate) warnings.push({ category: "correction", index: itemIndex, kind: "profile-adjacent" });
    if (PREFERENCE_LANGUAGE.test(newText)) warnings.push({ category: "correction", index: itemIndex, kind: "preference-language" });
    corrections.push({
      ...item,
      newText,
      proposalId: proposalId(runId, "correction", item.segmentId, newText),
      segment: view.segment,
      itemIndex,
      applyCandidate,
    });
  }

  for (const [itemIndex, item] of output.newNotes.entries()) {
    if (itemIndex >= DREAM_LIMITS.notes) {
      dropped.push({ category: "note", index: itemIndex, reason: "over-limit" });
      continue;
    }
    if (!Value.Check(DreamNoteSchema, item)) {
      dropped.push({ category: "note", index: itemIndex, reason: "invalid-item" });
      continue;
    }
    if (item.sourceEntryIds.length > DREAM_LIMITS.sourceIds) {
      dropped.push({ category: "note", index: itemIndex, reason: "over-limit" });
      continue;
    }
    let evidenceValid = true;
    for (const id of item.sourceEntryIds) {
      if (!entries.has(id)) {
        evidenceValid = false;
        dropped.push({ category: "note", index: itemIndex, reason: "unknown-source" });
        break;
      }
    }
    if (!evidenceValid) continue;
    const text = normalize(item.text);
    if (bytes(text) > DREAM_LIMITS.noteText) {
      dropped.push({ category: "note", index: itemIndex, reason: "over-limit" });
      continue;
    }
    if (scanSecret(text) !== undefined) {
      dropped.push({ category: "note", index: itemIndex, reason: "secret-detected" });
      continue;
    }
    if (PREFERENCE_LANGUAGE.test(text)) warnings.push({ category: "note", index: itemIndex, kind: "preference-language" });
    notes.push({
      ...item,
      text,
      proposalId: proposalId(runId, "note", item.sourceEntryIds.join(","), text),
      itemIndex,
      applyCandidate: item.status !== "unknown",
    });
  }

  for (const [itemIndex, item] of output.index.entries()) {
    if (itemIndex >= DREAM_LIMITS.index) {
      dropped.push({ category: "index", index: itemIndex, reason: "over-limit" });
      continue;
    }
    if (!Value.Check(DreamIndexSchema, item)) {
      dropped.push({ category: "index", index: itemIndex, reason: "invalid-item" });
      continue;
    }
    if (item.segmentIds.length > DREAM_LIMITS.sourceIds || bytes(item.topic) > DREAM_LIMITS.topic ||
        bytes(item.note) > DREAM_LIMITS.indexNote) {
      dropped.push({ category: "index", index: itemIndex, reason: "over-limit" });
      continue;
    }
    let known = true;
    for (const id of item.segmentIds) {
      if (!segments.has(id)) {
        known = false;
        dropped.push({ category: "index", index: itemIndex, reason: "unknown-segment", ref: id });
        break;
      }
    }
    if (!known) continue;
    if (scanSecret(item.topic) !== undefined || scanSecret(item.note) !== undefined) {
      dropped.push({ category: "index", index: itemIndex, reason: "secret-detected" });
      continue;
    }
    index.push({ ...item, note: normalize(item.note) });
  }

  for (const [itemIndex, item] of output.refusals.entries()) {
    if (itemIndex >= DREAM_LIMITS.refusals) {
      dropped.push({ category: "refusal", index: itemIndex, reason: "over-limit" });
      continue;
    }
    if (!Value.Check(DreamRefusalSchema, item)) {
      dropped.push({ category: "refusal", index: itemIndex, reason: "invalid-item" });
      continue;
    }
    if (!segments.has(item.segmentId)) {
      dropped.push({ category: "refusal", index: itemIndex, reason: "unknown-segment", ref: item.segmentId });
      continue;
    }
    if (bytes(item.reason) > DREAM_LIMITS.reason) {
      dropped.push({ category: "refusal", index: itemIndex, reason: "over-limit", ref: item.segmentId });
      continue;
    }
    if (scanSecret(item.reason) !== undefined) {
      dropped.push({ category: "refusal", index: itemIndex, reason: "secret-detected", ref: item.segmentId });
      continue;
    }
    refusals.push({ ...item, reason: normalize(item.reason) });
  }

  return {
    rejection: null,
    corrections,
    notes,
    index,
    refusals,
    dropped,
    warnings,
    stats: {
      submittedCorrections: output.corrections.length,
      submittedNotes: output.newNotes.length,
      submittedIndex: output.index.length,
      submittedRefusals: output.refusals.length,
      evidenceValidCorrections,
    },
  };
}

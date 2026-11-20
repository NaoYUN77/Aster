// Dreaming-lite contracts: a strict, report-only proposal shape for an offline memory review.
//
// A dream reads stored daily segments plus the transcript entries they cite and proposes
// corrections, new notes, an index, or a refusal. Nothing here writes memory. The host validates
// every item (see `validate.ts`) and an owner approval is required before an apply pass may run.
//
// Boundaries that are intentionally absent from the schema:
//   - no profile / preference field, so a model cannot propose a profile change;
//   - no path, tool, shell or connector field, so a proposal cannot name an action;
//   - `user-requirement` is not a note kind, so dream notes never feed profile extraction.
import { Type, type Static } from "typebox";

/** Bounds for one dream batch. They mirror the archive extraction bounds where they overlap. */
export const DREAM_LIMITS = {
  /** Maximum proposals accepted from one model response. Excess items are dropped, not truncated. */
  corrections: 10,
  notes: 20,
  index: 20,
  refusals: 50,
  /** Source entries in one batch and source bytes; aligned with ARCHIVE_LIMITS. */
  entries: 64,
  sourceBytes: 64 * 1024,
  /** One model response, before JSON parsing. */
  outputBytes: 64 * 1024,
  /** Per-item bounds. */
  correctionTextBytes: 2 * 1024,
  noteText: 2_000,
  reason: 500,
  topic: 200,
  indexNote: 1_000,
  sourceIds: 16,
  /** One model call. */
  timeoutMs: 120_000,
  /** Hard per-run cost gate; a run over this is marked budget-exceeded. */
  maxCostUsd: 0.5,
} as const;

/**
 * Note kinds a dream may propose. `user-requirement` is deliberately excluded: a dream must never
 * create a requirement event that profile extraction could later read. `fact` from the design draft
 * maps to `result`, because daily has no fact kind and an unmapped kind cannot be applied.
 */
export const DREAM_NOTE_KINDS = ["goal", "decision", "result", "problem", "open-item"] as const;
export type DreamNoteKind = (typeof DREAM_NOTE_KINDS)[number];

/**
 * Proposal confidence. `unknown` is report-only and is never an apply candidate. `observed` means
 * the cited source states the fact; `inferred` means it follows from several sources.
 */
export const DREAM_NOTE_STATUSES = ["observed", "inferred", "unknown"] as const;
export type DreamNoteStatus = (typeof DREAM_NOTE_STATUSES)[number];

/** Top-level keys a model must never emit. A hit is treated as an injection attempt. */
export const DREAM_FORBIDDEN_KEY = /profile|preference/i;

const Identifier = Type.String({ pattern: "^[A-Za-z0-9._:#-]{1,64}$" });
const EntryId = Type.Integer({ minimum: 1 });
const Digest = Type.String({ pattern: "^[a-f0-9]{16}$" });
const NonEmpty = Type.String({ minLength: 1 });

/**
 * One correction of an existing daily segment. The host supplies the segment and its digest; the
 * model returns them so a concurrent edit between snapshot and apply is caught (`stale`).
 */
export const DreamCorrectionSchema = Type.Object(
  {
    segmentId: Identifier,
    expectedDigest: Digest,
    newText: NonEmpty,
    reason: NonEmpty,
    sourceEntryIds: Type.Array(EntryId, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type DreamCorrection = Static<typeof DreamCorrectionSchema>;

/** One new note. It never carries a profile category and never cites a segment as evidence. */
export const DreamNoteSchema = Type.Object(
  {
    kind: Type.Union(DREAM_NOTE_KINDS.map((kind) => Type.Literal(kind))),
    status: Type.Union(DREAM_NOTE_STATUSES.map((status) => Type.Literal(status))),
    text: NonEmpty,
    sourceEntryIds: Type.Array(EntryId, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type DreamNote = Static<typeof DreamNoteSchema>;

/** A topic index over existing segments. Report-only in P0/P1; P2 may persist it separately. */
export const DreamIndexSchema = Type.Object(
  {
    topic: NonEmpty,
    segmentIds: Type.Array(Identifier, { minItems: 1 }),
    note: Type.String({ minLength: 0 }),
  },
  { additionalProperties: false },
);
export type DreamIndex = Static<typeof DreamIndexSchema>;

/** An explicit refusal: the supplied evidence does not support a change to this segment. */
export const DreamRefusalSchema = Type.Object(
  {
    segmentId: Identifier,
    reason: NonEmpty,
  },
  { additionalProperties: false },
);
export type DreamRefusal = Static<typeof DreamRefusalSchema>;

export const DreamOutputSchema = Type.Object(
  {
    corrections: Type.Array(DreamCorrectionSchema),
    newNotes: Type.Array(DreamNoteSchema),
    index: Type.Array(DreamIndexSchema),
    refusals: Type.Array(DreamRefusalSchema),
  },
  { additionalProperties: false },
);
export type DreamOutput = Static<typeof DreamOutputSchema>;

/** The exact JSON object a model must return. Kept as a string for the system prompt. */
export const DREAM_OUTPUT_SHAPE = `{
  "corrections": [{
    "segmentId": "existing-segment-id",
    "expectedDigest": "16 lowercase hex characters copied from the segment",
    "newText": "complete replacement text for the segment",
    "reason": "why the stored text is contradicted by the cited sources",
    "sourceEntryIds": [1, 2]
  }],
  "newNotes": [{
    "kind": "goal|decision|result|problem|open-item",
    "status": "observed|inferred|unknown",
    "text": "one new fact",
    "sourceEntryIds": [1]
  }],
  "index": [{ "topic": "short topic", "segmentIds": ["existing-segment-id"], "note": "optional" }],
  "refusals": [{ "segmentId": "existing-segment-id", "reason": "evidence is insufficient" }]
}`;

/** Operator-facing reasons an item was dropped. Never includes memory text or a secret match. */
export const DREAM_DROP_REASONS = [
  "invalid-item",
  "over-limit",
  "unknown-segment",
  "stale-digest",
  "already-superseded",
  "duplicate-supersede",
  "unknown-source",
  "source-out-of-range",
  "no-change",
  "secret-detected",
  "preference-language",
] as const;
export type DreamDropReason = (typeof DREAM_DROP_REASONS)[number];

export const DREAM_BATCH_REJECTIONS = [
  "invalid-shape",
  "forbidden-key",
  "output-too-large",
] as const;
export type DreamBatchRejection = (typeof DREAM_BATCH_REJECTIONS)[number];

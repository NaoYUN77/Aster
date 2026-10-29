// Profile extraction from daily-log segments (ADR-0016).
//
// Interface
//   extractProfileDrafts(segments) -> profile drafts a host can apply with `profile.put`
//   profilePutChanges(drafts)      -> `working_update` changes for those drafts
//
// Inputs are already-validated `MemorySegment`s. This module does not call a model, does not open
// the daily directory, and does not write working state. A later observation-period step can
// replace the filter; it must reuse an existing model call if it needs one, and it must not start
// a second agent loop.
//
// The filter keeps current `user-requirement` segments whose text already fits a profile item.
// Longer text is left in the daily log: this pass does not shorten it. Superseded segments are
// not current. The result is not capped here; `profile.put` enforces `MEMORY_LIMITS.profile`.

import {
  assertSchema,
  MEMORY_LIMITS,
  ProfileItemDraftSchema,
  type MemorySegment,
  type ProfileItemDraft,
  type WorkingChangeDraft,
} from "./contracts.js";

export type ProfileDraft = ProfileItemDraft;

/**
 * Draft profile items from daily-log segments. Segments that are not a current user requirement,
 * or whose text is longer than `MEMORY_LIMITS.text`, are omitted. Duplicate segment ids keep the
 * first draft.
 */
export function extractProfileDrafts(segments: readonly MemorySegment[]): ProfileDraft[] {
  const drafts: ProfileDraft[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    if (segment.kind !== "user-requirement" || segment.supersededBy !== null) continue;
    if (segment.text.length > MEMORY_LIMITS.text) continue;
    if (seen.has(segment.id)) continue;
    seen.add(segment.id);
    drafts.push(assertSchema<ProfileDraft>(ProfileItemDraftSchema, {
      id: segment.id,
      text: segment.text,
      category: segment.kind,
      evidence: [{ date: segment.date, id: segment.id, page: segment.page }],
    }, "invalid-input"));
  }
  return drafts;
}

/** `profile.put` changes for drafts `extractProfileDrafts` returned. The host still supplies revision and operation id. */
export function profilePutChanges(drafts: readonly ProfileDraft[]): WorkingChangeDraft[] {
  return drafts.map((item) => ({ op: "profile.put", item }));
}

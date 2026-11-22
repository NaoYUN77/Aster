// MemFS M1: the memory directory's public contract.
//
// The agent edits memory with the ordinary read/write/edit/bash tools, exactly as in Letta, so
// this surface is host-only: render the core section, snapshot the tree at turn boundaries, and
// the few reads the host and tests need. There is no per-path guard here; the container is the
// boundary. Host snapshots replace git commits; `snapshot` is the undo unit, not a revision.

/** Who authored a change. It is recorded in snapshot metadata, never trusted from a tool. */
export type Actor = "owner" | "agent" | "dreaming";

export const MEMORY_LIMITS = {
  /** Default budget for the rendered core section. */
  coreTokens: 4_096,
  /** Smallest meaningful budget; below this a core file cannot carry a sentence. */
  minCoreTokens: 256,
  /** Largest budget the configuration accepts. */
  maxCoreTokens: 65_536,
  /** Default `history` / `search` limit. */
  queryLimit: 20,
  /** Characters of context around the first hit in a search snippet. */
  searchSnippetChars: 160,
  /** Snapshots kept on disk; older ones are pruned after each new snapshot. */
  snapshotLimit: 50,
} as const;

/** Every path to a memory file is relative to the memory root, POSIX-separated. */
export type MemoryPath = string;

/**
 * A failed host operation. `io-failed` means the directory could not be read, written or
 * snapshotted; `not-found` means a requested file or snapshot does not exist; `conflict` means a
 * dream's staged change no longer matches the live file it was based on.
 */
export type MemoryFsErrorCode = "invalid-path" | "not-found" | "io-failed" | "conflict";

/** A refused memory operation. `code` is stable; `message` is operator-facing. */
export class MemoryFsError extends Error {
  readonly code: MemoryFsErrorCode;

  constructor(code: MemoryFsErrorCode, message: string) {
    super(message);
    this.name = "MemoryFsError";
    this.code = code;
  }
}

export type MemoryReadResult = {
  readonly path: MemoryPath;
  readonly content: string;
  /** SHA-256 of the exact bytes on disk, lowercase hex. */
  readonly digest: string;
  readonly bytes: number;
};

/** One captured state of the memory directory. */
export type MemorySnapshot = {
  /** Stable id, usable with `restore`. */
  readonly id: string;
  readonly actor: Actor;
  /** Why the snapshot was taken, for example `turn` or `pre-dreaming-apply`. */
  readonly reason: string;
  /** Capture time, ISO 8601. */
  readonly at: string;
  /**
   * Monotonic capture counter, continued from the highest one on disk. Capture order is
   * `at`, then `seq`; the id never encodes it, because two snapshots taken in the same
   * second sort by actor and reason, not by age.
   */
  readonly seq: number;
  /** Number of files captured. */
  readonly files: number;
  /** SHA-256 over the sorted path/digest pairs; equal trees share one digest. */
  readonly digest: string;
};

/** A staged change the host is about to apply to live memory. */
export type MemoryApply = {
  /** Snapshot of live memory taken immediately before the apply; the undo point. */
  readonly snapshot: string;
  /** Number of files added, rewritten or removed. */
  readonly files: number;
};

export type MemoryRestore = {
  /** Snapshot of the pre-restore tree, so a restore is itself reversible. */
  readonly previous: string;
  /** Number of files restored. */
  readonly files: number;
};

export type MemorySearchHit = {
  readonly path: MemoryPath;
  /** Case-insensitive occurrences of the query in the file. */
  readonly hits: number;
  /** A single-line excerpt around the first occurrence. */
  readonly snippet: string;
};

export type MemoryRender = {
  /** Rendered core section; empty when there are no non-empty root files. */
  readonly text: string;
  /** SHA-256 of `text`, used to decide whether the prompt must be reconfigured. */
  readonly hash: string;
  readonly included: readonly MemoryPath[];
  /** Root files dropped because the budget was already spent. */
  readonly omittedFiles: readonly MemoryPath[];
  /** Root files whose body was cut to fit the budget. */
  readonly truncatedFiles: readonly MemoryPath[];
};

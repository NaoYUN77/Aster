// MemFS M1: the memory repository's public contract.
//
// The agent edits memory with the ordinary read/write/edit/bash tools, exactly as in Letta, so
// this surface is host-only: render the core section, commit dirty work, and the few reads the
// host and tests need. There is no per-path guard here; the container is the boundary.

/** Who authored a change. It is recorded only in the commit message, never trusted from a tool. */
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
} as const;

/** Every path to a memory file is relative to the repository root, POSIX-separated. */
export type MemoryPath = string;

/**
 * A failed host operation. `git-failed` means the repository could not be initialized, read or
 * committed; `not-found` means a requested file or revision does not exist.
 */
export type MemoryFsErrorCode = "invalid-path" | "not-found" | "git-failed";

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

export type MemoryCommit = {
  readonly commit: string;
  /** The full commit subject, including actor and timestamp. */
  readonly message: string;
};

export type MemoryHistoryEntry = {
  readonly commit: string;
  readonly author: string;
  /** Committer date, ISO 8601. */
  readonly date: string;
  /** The commit subject. */
  readonly message: string;
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

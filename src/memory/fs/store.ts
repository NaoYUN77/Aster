// MemFS M1: the core-memory store.
//
// Memory is an ordinary directory. The agent edits it with the ordinary read/write/edit/bash
// tools (as in Letta); this module does not intercept writes and imposes no per-path sandbox.
// Its job is to initialize the directory, render `MEMORY.md` into the prompt, capture a snapshot
// of the tree at a turn boundary, and apply a dream's staged changes with a compare-and-swap
// against the tree the dream started from. Snapshots replace git commits: they are the undo unit,
// and `restore(id)` is the rollback. `.git/` from an earlier deployment may still exist on disk;
// nothing here reads or writes it.
//
// Snapshots are serialized inside the process, so a turn-boundary snapshot and an apply never
// interleave their reads and writes.

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  MEMORY_LIMITS,
  MemoryFsError,
  type Actor,
  type MemoryApply,
  type MemoryPath,
  type MemoryReadResult,
  type MemoryRender,
  type MemoryRestore,
  type MemorySearchHit,
  type MemorySnapshot,
} from "./contracts.js";
import {
  copyTree,
  diffTrees,
  readTreeFile,
  removeTreeFile,
  scanTree,
  treeDigest,
  writeTreeFile,
  type TreeManifest,
} from "./tree.js";

const INITIAL_INDEX = "MEMORY.md";
const VERSIONS_DIR = join(".aster", "versions");
const SNAPSHOT_VERSION = 1;
const TRUNCATION_MARKER = "\n\n[truncated: MEMORY_FS_CORE_TOKENS budget reached]";

export type MemoryFsOptions = {
  /** Absolute memory directory. It is created on first use when absent. */
  readonly dir: string;
};

export interface MemoryFs {
  /** Absolute memory directory, named in the owner's prompt. */
  readonly directory: string;
  /** Create the directory now. Every other method calls it lazily; `main` calls it to fail early. */
  ensure(): Promise<void>;
  /** Render the root `MEMORY.md` within `budgetTokens`; every other file is read on demand. */
  renderCore(budgetTokens?: number): Promise<MemoryRender>;
  /** Snapshot the tree when it differs from the newest snapshot; `null` when unchanged. */
  snapshotDirty(actor: Actor, reason: string): Promise<MemorySnapshot | null>;
  /** Snapshot the tree unconditionally. */
  snapshot(actor: Actor, reason: string): Promise<MemorySnapshot>;
  /** Recent snapshots, newest first. */
  history(limit?: number): Promise<readonly MemorySnapshot[]>;
  /** Copy one snapshot's files into an empty directory and return the copied manifest. */
  materialize(id: string, destination: string): Promise<TreeManifest>;
  /**
   * Apply a dream's staged tree to live memory. Every staged change must match the live file it
   * was based on, or the whole apply is refused with `conflict`. A snapshot of live memory is
   * taken first; its id is the undo point.
   */
  applyStaging(staging: string, base: TreeManifest, options: { readonly actor: Actor; readonly reason: string }): Promise<MemoryApply | null>;
  /** Restore every file from one snapshot, keeping the pre-restore tree as a new snapshot. */
  restore(id: string): Promise<MemoryRestore>;
  /** In-process counter bumped whenever a snapshot or apply completes. */
  revision(): number;
  /** Host-side read of one file relative to the memory root. */
  read(path: MemoryPath): Promise<MemoryReadResult>;
  /** Case-insensitive substring search, host use and tests. */
  search(query: string, limit?: number): Promise<readonly MemorySearchHit[]>;
}

export function createMemoryFs(options: MemoryFsOptions): MemoryFs {
  if (typeof options.dir !== "string" || options.dir.trim() === "") {
    throw new MemoryFsError("invalid-path", "memory directory must not be empty");
  }
  if (!isAbsolute(options.dir)) {
    throw new MemoryFsError("invalid-path", "memory directory must be absolute");
  }
  return new DirectoryMemoryFs(resolve(options.dir));
}

class DirectoryMemoryFs implements MemoryFs {
  readonly #dir: string;
  #root: string | undefined;
  #ready: Promise<void> | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #revision = 0;
  #sequence: number | undefined;

  constructor(dir: string) {
    this.#dir = dir;
  }

  get directory(): string {
    return this.#dir;
  }

  ensure(): Promise<void> {
    this.#ready ??= this.#initialize();
    return this.#ready;
  }

  async #initialize(): Promise<void> {
    try {
      await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    } catch {
      throw new MemoryFsError("io-failed", "memory directory could not be created");
    }
    this.#root = await realpath(this.#dir);
    // Deliberately empty: M1 never fabricates persona/human content.
    await this.#writeIfMissing(INITIAL_INDEX, "");
  }

  async renderCore(budgetTokens: number = MEMORY_LIMITS.coreTokens): Promise<MemoryRender> {
    await this.ensure();
    if (!Number.isFinite(budgetTokens) || budgetTokens < 1) {
      throw new MemoryFsError("invalid-path", "core token budget must be a positive number");
    }
    const empty: MemoryRender = {
      text: "",
      hash: sha256(Buffer.from("", "utf8")),
      included: [],
      omittedFiles: [],
      truncatedFiles: [],
    };
    // Only the root index is core memory. Persona, the owner's profile and standing rules are its
    // sections; every other file is read on demand with the ordinary tools.
    const content = await this.#readText(join(this.#root!, INITIAL_INDEX), INITIAL_INDEX).catch((error: unknown) => {
      if (error instanceof MemoryFsError && error.code === "not-found") return undefined;
      throw error;
    });
    if (content === undefined || content.trim() === "") return empty;

    const header = `## ${INITIAL_INDEX}\n\n`;
    const body = escapeMemoryBody(content).replace(/\n+$/u, "");
    const full = `${header}${body}\n\n`;
    const remaining = Math.floor(budgetTokens);
    if (estimateTextTokens(full) <= remaining) {
      return {
        text: full,
        hash: sha256(Buffer.from(full, "utf8")),
        included: [INITIAL_INDEX],
        omittedFiles: [],
        truncatedFiles: [],
      };
    }

    const available = remaining - estimateTextTokens(`${header}${TRUNCATION_MARKER}\n\n`);
    const cut = truncateToBudget(body, available);
    const section = cut === undefined ? undefined : `${header}${cut}${TRUNCATION_MARKER}\n\n`;
    if (section === undefined || estimateTextTokens(section) > remaining) {
      return { ...empty, omittedFiles: [INITIAL_INDEX] };
    }
    return {
      text: section,
      hash: sha256(Buffer.from(section, "utf8")),
      included: [INITIAL_INDEX],
      omittedFiles: [],
      truncatedFiles: [INITIAL_INDEX],
    };
  }

  // --- snapshots ------------------------------------------------------------------------------

  revision(): number {
    return this.#revision;
  }

  async snapshotDirty(actor: Actor, reason: string): Promise<MemorySnapshot | null> {
    await this.ensure();
    return this.#serialize(async () => {
      const manifest = await scanTree(this.#root!);
      const latest = await this.#latest();
      if (latest !== null && latest.digest === treeDigest(manifest)) return null;
      return this.#capture(actor, reason, manifest);
    });
  }

  async snapshot(actor: Actor, reason: string): Promise<MemorySnapshot> {
    await this.ensure();
    return this.#serialize(async () => this.#capture(actor, reason, await scanTree(this.#root!)));
  }

  async history(limit: number = MEMORY_LIMITS.queryLimit): Promise<readonly MemorySnapshot[]> {
    await this.ensure();
    const wanted = clamp(Number.isFinite(limit) ? Math.trunc(limit) : MEMORY_LIMITS.queryLimit, 1, 500);
    return (await this.#snapshots()).slice(0, wanted);
  }

  async materialize(id: string, destination: string): Promise<TreeManifest> {
    await this.ensure();
    const snapshot = await this.#readSnapshot(id);
    await rm(destination, { recursive: true, force: true });
    await copyTree(join(this.#versionsDir(), snapshot.id, "tree"), destination);
    return scanTree(destination);
  }

  async applyStaging(
    staging: string,
    base: TreeManifest,
    options: { readonly actor: Actor; readonly reason: string },
  ): Promise<MemoryApply | null> {
    await this.ensure();
    return this.#serialize(async () => {
      const live = await scanTree(this.#root!);
      const staged = await scanTree(staging);
      const changes = diffTrees(base, staged);
      if (changes.length === 0) return null;
      const conflicts = changes.filter((change) => live.get(change.path) !== base.get(change.path));
      if (conflicts.length > 0) {
        const names = conflicts.slice(0, 3).map((change) => change.path).join(", ");
        throw new MemoryFsError(
          "conflict",
          `${conflicts.length} file(s) changed while dreaming: ${names}${conflicts.length > 3 ? ", …" : ""}`,
        );
      }
      // The pre-apply snapshot is the undo point for this run. It is captured before the first
      // byte changes, and must reproduce the manifest just verified.
      const snapshot = await this.#capture(options.actor, options.reason, live);
      // Write the notes first and MEMORY.md last, then remove deleted notes: at every intermediate
      // step the index is either old-with-old-notes or new-with-new-notes, never new-without-notes.
      for (const change of changes) {
        if (change.kind === "delete" || change.path === INITIAL_INDEX) continue;
        await writeTreeFile(this.#root!, change.path, await readTreeFile(staging, change.path));
      }
      const index = changes.find((change) => change.path === INITIAL_INDEX && change.kind !== "delete");
      if (index !== undefined) {
        await writeTreeFile(this.#root!, INITIAL_INDEX, await readTreeFile(staging, INITIAL_INDEX));
      }
      for (const change of changes) {
        if (change.kind === "delete") await removeTreeFile(this.#root!, change.path);
      }
      this.#revision += 1;
      return { snapshot: snapshot.id, files: changes.length };
    });
  }

  async restore(id: string): Promise<MemoryRestore> {
    await this.ensure();
    return this.#serialize(async () => {
      const snapshot = await this.#readSnapshot(id);
      const targetRoot = join(this.#versionsDir(), snapshot.id, "tree");
      const target = await scanTree(targetRoot);
      const live = await scanTree(this.#root!);
      // Keep the tree being replaced: a restore is itself undoable.
      const previous = await this.#capture("owner", "pre-restore", live);
      for (const path of target.keys()) {
        if (path === INITIAL_INDEX) continue;
        await writeTreeFile(this.#root!, path, await readTreeFile(targetRoot, path));
      }
      if (target.has(INITIAL_INDEX)) {
        await writeTreeFile(this.#root!, INITIAL_INDEX, await readTreeFile(targetRoot, INITIAL_INDEX));
      } else {
        await removeTreeFile(this.#root!, INITIAL_INDEX).catch(() => undefined);
      }
      for (const path of live.keys()) {
        if (!target.has(path)) await removeTreeFile(this.#root!, path);
      }
      this.#revision += 1;
      return { previous: previous.id, files: target.size };
    });
  }

  async #capture(actor: Actor, reason: string, expected?: TreeManifest): Promise<MemorySnapshot> {
    const at = new Date().toISOString();
    const id = await this.#newSnapshotId(at, actor, reason);
    const directory = join(this.#versionsDir(), id);
    const tree = join(directory, "tree");
    await mkdir(tree, { recursive: true, mode: 0o700 });
    await copyTree(this.#root!, tree);
    // Fingerprint what was actually copied, never the pre-copy scan: a concurrent write must not
    // make the snapshot metadata disagree with its files.
    const captured = await scanTree(tree);
    const digest = treeDigest(captured);
    if (expected !== undefined && digest !== treeDigest(expected)) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw new MemoryFsError("conflict", "memory changed while the snapshot was being taken");
    }
    const seq = await this.#nextSequence();
    const meta: MemorySnapshot = { id, actor, reason, at, seq, files: captured.size, digest };
    const body = `${JSON.stringify({ version: SNAPSHOT_VERSION, ...meta }, null, 2)}\n`;
    await writeFile(`${directory}/meta.json`, body, { mode: 0o600 }).catch(() => {
      throw new MemoryFsError("io-failed", "snapshot metadata could not be written");
    });
    await this.#prune();
    this.#revision += 1;
    return meta;
  }

  async #newSnapshotId(at: string, actor: Actor, reason: string): Promise<string> {
    const stamp = at.replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
    const slug = `${actor}-${reason}`.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 40)
      || "snapshot";
    let candidate = `${stamp}-${slug}`;
    for (let suffix = 2; suffix < 100; suffix += 1) {
      if (!(await this.#exists(join(this.#versionsDir(), candidate)))) return candidate;
      candidate = `${stamp}-${slug}-${suffix}`;
    }
    return `${stamp}-${slug}-${process.pid}`;
  }

  async #latest(): Promise<MemorySnapshot | null> {
    return (await this.#snapshots())[0] ?? null;
  }

  async #snapshots(): Promise<readonly MemorySnapshot[]> {
    const names = await readdir(this.#versionsDir()).catch(() => [] as string[]);
    const snapshots: MemorySnapshot[] = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const snapshot = await this.#readSnapshot(name).catch(() => undefined);
      if (snapshot !== undefined) snapshots.push(snapshot);
    }
    // Ids start with a UTC timestamp, so lexical order is capture order only across seconds:
    // within one, actor and reason decide. Capture order is `at`, then the capture counter.
    return snapshots.sort((left, right) => {
      if (left.at !== right.at) return left.at < right.at ? 1 : -1;
      if (left.seq !== right.seq) return left.seq < right.seq ? 1 : -1;
      return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
    });
  }

  /**
   * The next capture counter. A fresh process continues from the highest one on disk, so a
   * restart never reuses a number an earlier process already captured with.
   */
  async #nextSequence(): Promise<number> {
    if (this.#sequence === undefined) {
      this.#sequence = Math.max(0, ...(await this.#snapshots()).map((snapshot) => snapshot.seq));
    }
    this.#sequence += 1;
    return this.#sequence;
  }

  async #readSnapshot(id: string): Promise<MemorySnapshot> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) throw new MemoryFsError("invalid-path", "snapshot id is not valid");
    const directory = join(this.#versionsDir(), id);
    const raw = await readFile(join(directory, "meta.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new MemoryFsError("not-found", `snapshot ${id} does not exist`);
      throw new MemoryFsError("io-failed", `snapshot ${id} could not be read`);
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new MemoryFsError("io-failed", `snapshot ${id} has invalid metadata`);
    }
    if (typeof parsed !== "object" || parsed === null) throw new MemoryFsError("io-failed", `snapshot ${id} has invalid metadata`);
    const record = parsed as Record<string, unknown>;
    if (record.version !== SNAPSHOT_VERSION || record.id !== id
      || (record.actor !== "owner" && record.actor !== "agent" && record.actor !== "dreaming")
      || typeof record.reason !== "string" || typeof record.at !== "string"
      || typeof record.digest !== "string" || typeof record.files !== "number") {
      throw new MemoryFsError("io-failed", `snapshot ${id} has invalid metadata`);
    }
    // A capture counter of an earlier build is absent; it then counts as the oldest.
    const seq = typeof record.seq === "number" ? record.seq : 0;
    if (!Number.isInteger(seq) || seq < 0) {
      throw new MemoryFsError("io-failed", `snapshot ${id} has invalid metadata`);
    }
    return {
      id,
      actor: record.actor,
      reason: record.reason,
      at: record.at,
      seq,
      files: record.files,
      digest: record.digest,
    };
  }

  async #prune(): Promise<void> {
    const snapshots = await this.#snapshots();
    for (const stale of snapshots.slice(MEMORY_LIMITS.snapshotLimit)) {
      await rm(join(this.#versionsDir(), stale.id), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  #versionsDir(): string {
    return join(this.#root!, VERSIONS_DIR);
  }

  // --- reads ----------------------------------------------------------------------------------

  async read(path: MemoryPath): Promise<MemoryReadResult> {
    await this.ensure();
    if (typeof path !== "string" || path.trim() === "") {
      throw new MemoryFsError("invalid-path", "path must be a non-empty relative path");
    }
    const bytes = await readTreeFile(this.#root!, path);
    return { path, content: decodeUtf8(bytes, path), digest: sha256(bytes), bytes: bytes.byteLength };
  }

  async search(query: string, limit: number = MEMORY_LIMITS.queryLimit): Promise<readonly MemorySearchHit[]> {
    await this.ensure();
    const needle = query.trim();
    if (needle === "") throw new MemoryFsError("invalid-path", "search query must not be empty");
    const wanted = clamp(Number.isFinite(limit) ? Math.trunc(limit) : MEMORY_LIMITS.queryLimit, 1, 500);
    const paths = await this.#markdownFiles(this.#root!);
    const hits: MemorySearchHit[] = [];
    for (const path of paths) {
      const text = decodeUtf8(await readFile(join(this.#root!, path)), path);
      const count = countOccurrences(text, needle);
      if (count === 0) continue;
      hits.push({ path, hits: count, snippet: makeSnippet(text, needle) });
    }
    return hits
      .sort((left, right) => right.hits - left.hits || compareStrings(left.path, right.path))
      .slice(0, wanted);
  }

  // --- files ----------------------------------------------------------------------------------

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation, operation);
    // The queue must survive a rejected operation; the caller still receives the rejection.
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #writeIfMissing(name: string, body: string): Promise<void> {
    await writeFile(join(this.#root!, name), body, { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw new MemoryFsError("io-failed", `${name} could not be created`);
    });
  }

  async #readText(absolute: string, path: string): Promise<string> {
    const bytes = await readFile(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new MemoryFsError("not-found", `${path} does not exist`);
      throw new MemoryFsError("io-failed", `${path} could not be read`);
    });
    return decodeUtf8(bytes, path);
  }

  async #markdownFiles(root: string): Promise<string[]> {
    const found: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      const absolute = relative === "" ? root : join(root, relative);
      const entries = await readdir(absolute, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) await walk(next);
        else if (entry.isFile() && isMarkdown(entry.name)) found.push(next);
      }
    };
    await walk("");
    return found.sort(compareStrings);
  }

  async #exists(path: string): Promise<boolean> {
    return access(path, constants.F_OK).then(() => true, () => false);
  }
}

function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8(bytes: Buffer, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MemoryFsError("invalid-path", `${path} is not valid UTF-8`);
  }
}

/**
 * A stored note is data, never instructions. If a line could close the `<memory-files>` fence, a
 * leading space keeps the wrapper intact without changing how the note reads.
 */
export function escapeMemoryBody(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.startsWith("</memory-files>") ? ` ${line}` : line))
    .join("\n");
}

function countOccurrences(text: string, needle: string): number {
  const haystack = text.toLowerCase();
  const query = needle.toLowerCase();
  let from = 0;
  let count = 0;
  while (true) {
    const at = haystack.indexOf(query, from);
    if (at === -1) return count;
    count += 1;
    from = at + Math.max(1, query.length);
  }
}

function makeSnippet(text: string, needle: string): string {
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  const half = Math.floor(MEMORY_LIMITS.searchSnippetChars / 2);
  const start = Math.max(0, at - half);
  const end = Math.min(text.length, at + needle.length + half);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/** Cut `content` until it fits `budget` tokens, or `undefined` when nothing meaningful fits. */
function truncateToBudget(content: string, budget: number): string | undefined {
  if (budget <= 0) return undefined;
  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTextTokens(`${content.slice(0, middle)}\n`) <= budget) low = middle;
    else high = middle - 1;
  }
  if (low <= 0) return undefined;
  // Do not cut inside a UTF-16 surrogate pair.
  if (low < content.length && /[\uD800-\uDBFF]/u.test(content.charAt(low - 1))) low -= 1;
  return low <= 0 ? undefined : content.slice(0, low);
}

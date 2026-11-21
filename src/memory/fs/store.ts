// MemFS M1: the git-backed core-memory store.
//
// The repository is an ordinary directory. The agent edits it with the ordinary read/write/edit/
// bash tools (as in Letta); this module does not intercept writes and imposes no per-path sandbox.
// Its job is to initialize the repository, render `MEMORY.md` into the prompt, and commit
// whatever the tree accumulated at a turn boundary, so `git log` stays the undo path.
//
// Commits are serialized inside the process: a turn-boundary commit and a render never overlap on
// the same index, and two commits racing for `index.lock` are retried rather than surfaced.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import {
  MEMORY_LIMITS,
  MemoryFsError,
  type Actor,
  type MemoryCommit,
  type MemoryHistoryEntry,
  type MemoryPath,
  type MemoryReadResult,
  type MemoryRender,
  type MemorySearchHit,
} from "./contracts.js";

const COMMIT_AUTHOR = { name: "Aster Memory", email: "memory@aster.local" } as const;
const INITIAL_INDEX = "MEMORY.md";
const GITIGNORE = ".gitignore";
const GITIGNORE_BODY = ".aster/\n";
const TRUNCATION_MARKER = "\n\n[truncated: MEMORY_FS_CORE_TOKENS budget reached]";
const LOCK_RETRIES = 5;

export type MemoryFsOptions = {
  /** Absolute repository directory. It is created on first use when absent. */
  readonly dir: string;
};

export interface MemoryFs {
  /** Absolute repository directory, named in the owner's prompt. */
  readonly directory: string;
  /** Create/init the repository now. Every other method calls it lazily; `main` calls it to fail early. */
  ensure(): Promise<void>;
  /** Render the root `MEMORY.md` within `budgetTokens`; every other file is read on demand. */
  renderCore(budgetTokens?: number): Promise<MemoryRender>;
  /** Commit the working tree if it changed; `null` when it was already clean. */
  commitDirty(actor: Actor, reason: string): Promise<MemoryCommit | null>;
  /** Host-side read of one file relative to the repository root. */
  read(path: MemoryPath): Promise<MemoryReadResult>;
  /** Recent commits, newest first. */
  history(limit?: number): Promise<readonly MemoryHistoryEntry[]>;
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
  return new GitMemoryFs(resolve(options.dir));
}

class GitMemoryFs implements MemoryFs {
  readonly #dir: string;
  #root: string | undefined;
  #ready: Promise<void> | undefined;
  #queue: Promise<unknown> = Promise.resolve();

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
      throw new MemoryFsError("invalid-path", "memory directory could not be created");
    }
    this.#root = await realpath(this.#dir);
    if (!(await this.#exists(join(this.#root, ".git")))) {
      await this.#git(["init", "-b", "main"]);
    }
    await this.#writeIfMissing(GITIGNORE, GITIGNORE_BODY);
    // Deliberately empty: M1 never fabricates persona/human content.
    await this.#writeIfMissing(INITIAL_INDEX, "");
    // The first turn-boundary commit also covers files an existing repository already had dirty.
    await this.#commitDirtyInner("owner", "initialize");
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

  async commitDirty(actor: Actor, reason: string): Promise<MemoryCommit | null> {
    await this.ensure();
    return this.#serialize(() => this.#commitDirtyInner(actor, reason));
  }

  async read(path: MemoryPath): Promise<MemoryReadResult> {
    await this.ensure();
    if (typeof path !== "string" || path.trim() === "") {
      throw new MemoryFsError("invalid-path", "path must be a non-empty relative path");
    }
    const absolute = resolve(this.#root!, path);
    const bytes = await readFile(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new MemoryFsError("not-found", `${path} does not exist`);
      throw new MemoryFsError("git-failed", `${path} could not be read`);
    });
    return { path, content: decodeUtf8(bytes, path), digest: sha256(bytes), bytes: bytes.byteLength };
  }

  async history(limit: number = MEMORY_LIMITS.queryLimit): Promise<readonly MemoryHistoryEntry[]> {
    await this.ensure();
    const wanted = clamp(Number.isFinite(limit) ? Math.trunc(limit) : MEMORY_LIMITS.queryLimit, 1, 500);
    const output = await this.#git(["log", "-n", String(wanted), "--format=%H%x1f%an%x1f%aI%x1f%s"]);
    return output
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [commit = "", author = "", date = "", message = ""] = line.split("\u001f");
        return { commit, author, date, message };
      });
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

  // --- commits --------------------------------------------------------------------------------

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(operation, operation);
    // The queue must survive a rejected operation; the caller still receives the rejection.
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #commitDirtyInner(actor: Actor, reason: string): Promise<MemoryCommit | null> {
    if ((await this.#git(["status", "--porcelain"])).trim() === "") return null;
    const message = `memory: ${reason} by ${actor} at ${new Date().toISOString()}`;
    await this.#withLockRetry(async () => {
      await this.#git(["add", "-A"]);
      await this.#git([
        "-c", `user.name=${COMMIT_AUTHOR.name}`,
        "-c", `user.email=${COMMIT_AUTHOR.email}`,
        "-c", "commit.gpgsign=false",
        "commit", "--no-verify", "-m", message,
      ]);
    });
    return { commit: (await this.#git(["rev-parse", "HEAD"])).trim(), message };
  }

  /** `index.lock` is transient (another git process in the same directory); retry it briefly. */
  async #withLockRetry(operation: () => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await operation();
        return;
      } catch (error) {
        if (attempt + 1 >= LOCK_RETRIES || !isLockConflict(error)) throw error;
        await delay(25 * (attempt + 1));
      }
    }
  }

  // --- files ----------------------------------------------------------------------------------

  async #writeIfMissing(name: string, body: string): Promise<void> {
    await writeFile(join(this.#root!, name), body, { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw new MemoryFsError("git-failed", `${name} could not be created`);
    });
  }

  async #readText(absolute: string, path: string): Promise<string> {
    const bytes = await readFile(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new MemoryFsError("not-found", `${path} does not exist`);
      throw new MemoryFsError("git-failed", `${path} could not be read`);
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

  // --- git ------------------------------------------------------------------------------------

  async #git(args: readonly string[]): Promise<string> {
    const result = await this.#gitResult(args);
    if (result.code !== 0) {
      const detail = result.stderr.trim().split("\n").at(-1) ?? "";
      const command = args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? "command";
      throw new MemoryFsError("git-failed", `git ${command} failed${detail === "" ? "" : `: ${detail}`}`);
    }
    return result.stdout;
  }

  #gitResult(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolvePromise) => {
      execFile("git", ["-C", this.#dir, ...args], {
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: COMMIT_AUTHOR.name,
          GIT_AUTHOR_EMAIL: COMMIT_AUTHOR.email,
          GIT_COMMITTER_NAME: COMMIT_AUTHOR.name,
          GIT_COMMITTER_EMAIL: COMMIT_AUTHOR.email,
          GIT_TERMINAL_PROMPT: "0",
        },
      }, (error, stdout, stderr) => {
        if (error === null) return resolvePromise({ code: 0, stdout, stderr });
        const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
        resolvePromise({ code, stdout, stderr });
      });
    });
  }

  async #exists(path: string): Promise<boolean> {
    return access(path, constants.F_OK).then(() => true, () => false);
  }
}

function isLockConflict(error: unknown): boolean {
  return error instanceof MemoryFsError && /index\.lock|HEAD\.lock|unable to create .*lock/i.test(error.message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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

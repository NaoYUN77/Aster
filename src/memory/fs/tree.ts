// Ordinary-directory tree operations for core memory.
//
// Memory is a directory of Markdown files, not a git repository. The host needs four primitives:
// fingerprint a tree, copy it, diff two fingerprints, and write or remove one file atomically.
// Everything hidden skips the walk: `.aster/` holds snapshots and dream state, `.git/` may exist
// from an earlier deployment and is left untouched, and other dotfiles are not memory.

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { MemoryFsError } from "./contracts.js";

/** Relative path → SHA-256 of the file's bytes. */
export type TreeManifest = ReadonlyMap<string, string>;

export type TreeChangeKind = "add" | "modify" | "delete";

export type TreeChange = {
  readonly path: string;
  readonly kind: TreeChangeKind;
};

/** Hidden paths are the host's bookkeeping or a retired git directory, never memory content. */
function skipName(name: string): boolean {
  return name.startsWith(".");
}

/** Reject a path that could leave the memory root before it reaches the filesystem. */
export function safeRelativePath(path: string): string {
  if (path === "" || isAbsolute(path) || path.includes("\\")) {
    throw new MemoryFsError("invalid-path", `${path} is not a relative memory path`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new MemoryFsError("invalid-path", `${path} is not a relative memory path`);
  }
  return path;
}

/** Resolve a relative path under `root`, refusing anything that escapes it. */
export function resolveInside(root: string, path: string): string {
  const relative = safeRelativePath(path);
  const absolute = resolve(root, relative);
  if (!absolute.startsWith(`${root}${sep}`)) {
    throw new MemoryFsError("invalid-path", `${path} escapes the memory root`);
  }
  return absolute;
}

export async function readTreeFile(root: string, path: string): Promise<Buffer> {
  return readFile(resolveInside(root, path)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new MemoryFsError("not-found", `${path} does not exist`);
    throw new MemoryFsError("io-failed", `${path} could not be read`);
  });
}

/** Walk every regular, non-hidden file and fingerprint it. */
export async function scanTree(root: string): Promise<TreeManifest> {
  const found = new Map<string, string>();
  const walk = async (relative: string): Promise<void> => {
    const absolute = relative === "" ? root : join(root, relative);
    const entries = await readdir(absolute, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new MemoryFsError("not-found", "memory directory does not exist");
      throw new MemoryFsError("io-failed", "memory directory could not be listed");
    });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || skipName(entry.name)) continue;
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(next);
      } else if (entry.isFile()) {
        const bytes = await readFile(join(root, next)).catch(() => {
          throw new MemoryFsError("io-failed", `${next} could not be read`);
        });
        found.set(next, sha256(bytes));
      }
    }
  };
  await walk("");
  return found;
}

/** One digest for the whole tree, stable across insert order and mtime. */
export function treeDigest(manifest: TreeManifest): string {
  const hash = createHash("sha256");
  for (const [path, digest] of [...manifest.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    hash.update(`${path}\u0000${digest}\n`);
  }
  return hash.digest("hex");
}

/** Changes needed to turn `base` into `next`, sorted by path. */
export function diffTrees(base: TreeManifest, next: TreeManifest): readonly TreeChange[] {
  const changes: TreeChange[] = [];
  for (const [path, digest] of next) {
    const before = base.get(path);
    if (before === undefined) changes.push({ path, kind: "add" });
    else if (before !== digest) changes.push({ path, kind: "modify" });
  }
  for (const path of base.keys()) {
    if (!next.has(path)) changes.push({ path, kind: "delete" });
  }
  return changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** Copy every memory file from `source` into `destination` (which is created). */
export async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const walk = async (relative: string): Promise<void> => {
    const from = relative === "" ? source : join(source, relative);
    const entries = await readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || skipName(entry.name)) continue;
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await mkdir(join(destination, next), { recursive: true, mode: 0o700 });
        await walk(next);
      } else if (entry.isFile()) {
        await copyFile(join(source, next), join(destination, next));
      }
    }
  };
  await walk("");
}

/** Write one file with a same-directory temp name and a rename, so readers never see half a file. */
export async function writeTreeFile(root: string, path: string, bytes: Buffer | string): Promise<void> {
  const absolute = resolveInside(root, path);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.${process.pid}.${randomSuffix()}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 }).catch(() => {
    throw new MemoryFsError("io-failed", `${path} could not be written`);
  });
  await rename(temporary, absolute).catch(async () => {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new MemoryFsError("io-failed", `${path} could not be replaced`);
  });
}

export async function removeTreeFile(root: string, path: string): Promise<void> {
  await rm(resolveInside(root, path), { force: true }).catch(() => {
    throw new MemoryFsError("io-failed", `${path} could not be removed`);
  });
}

/** True only when `path` names an existing regular file inside `root`. */
export async function isTreeFile(root: string, path: string): Promise<boolean> {
  const info = await stat(resolveInside(root, path)).catch(() => undefined);
  return info?.isFile() === true;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

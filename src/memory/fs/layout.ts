// MemFS M2: the wiki layout contract.
//
// `MEMORY.md` is the only injected file. It carries an optional `## Core` list of facts that must
// be in every prompt and a `## Index` of soft links to notes; every other Markdown file is a note
// reached through that index. This module is the layout check: it validates that structure after
// the dream pass and before the host commits anything. It never interprets note content: facts,
// prose and cross-links are the model's business.

import { readFile, readdir } from "node:fs/promises";
import { join, normalize, sep } from "node:path";

export const CORE_FILE = "MEMORY.md";

const INDEX_HEADING = /^##\s+index\s*$/i;
const ANY_HEADING = /^##\s+/;
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

export type MemoryLayoutIssue =
  | { readonly code: "missing-memory"; readonly path: string }
  | { readonly code: "dangling-link"; readonly target: string }
  | { readonly code: "escaping-link"; readonly target: string }
  | { readonly code: "orphan-note"; readonly path: string };

/**
 * Check one memory directory. An empty directory or an empty `MEMORY.md` is valid: a repository
 * with no notes has nothing to index. Once a note exists, it must be linked from `## Index`, and
 * every index link must resolve to a note inside the repository.
 */
export async function checkMemoryLayout(directory: string): Promise<readonly MemoryLayoutIssue[]> {
  const text = await readFile(join(directory, CORE_FILE), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return [{ code: "missing-memory", path: CORE_FILE }];

  const notes = await noteFiles(directory);
  const linked = new Set<string>();
  const issues: MemoryLayoutIssue[] = [];
  const seen = new Set<string>();
  for (const target of indexLinks(text)) {
    const key = `link:${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const resolved = resolveLink(target);
    if (resolved === undefined) {
      issues.push({ code: "escaping-link", target });
      continue;
    }
    linked.add(resolved);
    if (!notes.includes(resolved)) issues.push({ code: "dangling-link", target });
  }
  for (const note of notes) {
    if (!linked.has(note)) issues.push({ code: "orphan-note", path: note });
  }
  return issues;
}

/** Links under the first `## Index` heading, up to the next level-2 heading. External links are skipped. */
export function indexLinks(memory: string): readonly string[] {
  const lines = memory.split(/\r?\n/);
  const links: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (INDEX_HEADING.test(line)) {
      inside = true;
      continue;
    }
    if (inside && ANY_HEADING.test(line)) break;
    if (!inside) continue;
    for (const match of line.matchAll(MARKDOWN_LINK)) {
      const target = match[1] ?? "";
      if (target === "" || target.startsWith("#")) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:, …
      links.push(target);
    }
  }
  return links;
}

/** A relative link with its anchor removed, normalized for comparison. `undefined` means it escapes. */
function resolveLink(target: string): string | undefined {
  const withoutAnchor = target.split("#", 1)[0] ?? "";
  if (withoutAnchor === "" || withoutAnchor.startsWith("/")) return undefined;
  const normalized = normalize(withoutAnchor).split(sep).join("/");
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized;
}

async function noteFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(relative === "" ? root : join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && next !== CORE_FILE) found.push(next);
    }
  };
  await walk("");
  return found.sort();
}

import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { obj, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";

/**
 * Skills: small procedures on disk, indexed by name and one-line description.
 *
 * The on-disk format is the Agent Skills convention — a directory holding a SKILL.md whose YAML
 * frontmatter carries `name` and `description` — so a skill written for one host can be dropped into
 * another unedited. The point of the format is the same as the point of this module: the body is not
 * in the context window until the model asks for it. Startup reads only the first few hundred bytes
 * of each SKILL.md (the frontmatter), the system prompt carries an index of names and descriptions,
 * and `skill_load` is what brings the procedure in. A directory of thirty skills therefore costs
 * thirty lines, not thirty documents.
 *
 * The frontmatter is parsed as the YAML subset that format actually uses: flat scalars, one-level
 * lists, one-level maps. `name` and `description` are what this host acts on; `license`,
 * `allowed-tools` and `metadata` are read so a conforming file still loads, and deliberately are not
 * enforced — there is no per-skill tool allowlist here to apply them to.
 *
 * Everything under the root is treated as host-provided content, but the path rules still apply:
 * a name is a single path segment, the resolved file must stay under the root, and a body is
 * truncated rather than allowed to flood the context.
 */

/** Frontmatter is parsed from this many leading bytes; a body is never read during a scan. */
const HEAD_BYTES = 4_096;
const MAX_SKILLS = 50;
/** The format allows 1024; the description also sits in every prompt, so it is never longer. */
const MAX_DESCRIPTION_CHARS = 1_024;
const MAX_NAME_CHARS = 64;
const MAX_BODY_CHARS = 32_000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES_PER_SKILL = 20;

/** Lower-case letters, digits and single hyphens, as the format requires of a skill name. */
const NAME_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class SkillError extends Error {
  constructor(readonly code: "SKILL_NOT_FOUND" | "SKILL_TOO_LARGE" | "SKILL_UNREADABLE", message: string) {
    super(message);
    this.name = "SkillError";
  }
}

export type SkillSummary = {
  /** Lower-case directory name; the only thing the model is given to ask with later. */
  readonly name: string;
  readonly description: string;
};

export type LoadedSkill = SkillSummary & {
  readonly body: string;
  /** File names inside references/, scripts/ and assets/, not their contents. */
  readonly files: readonly string[];
};

export type SkillIndexOptions = {
  readonly log?: (line: string) => void;
  readonly maxSkills?: number;
};

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** A frontmatter value: a scalar, a block list (`allowed-tools:`), or a one-level map (`metadata:`). */
export type FrontmatterValue = string | readonly string[] | Readonly<Record<string, string>>;
export type Frontmatter = Readonly<Record<string, FrontmatterValue>>;

function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  if ((first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1);
  return value;
}

/**
 * Reads the YAML frontmatter every SKILL.md starts with. Only the subset the format uses is
 * understood: `key: value`, `key:` followed by `- item` lines, and `key:` followed by indented
 * `key: value` lines. No anchors, no multi-line scalars, no nesting past one level — refusing to
 * interpret more keeps a malformed file from being half-loaded.
 */
export function parseFrontmatter(head: string): Frontmatter | undefined {
  const normalized = head.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return undefined;
  const fields: Record<string, FrontmatterValue> = {};
  let block: { key: string; kind: "unknown" | "list" | "map"; items: string[]; entries: Record<string, string> } | undefined;
  const flush = (): void => {
    if (block === undefined) return;
    fields[block.key] = block.kind === "list" ? block.items : block.entries;
    block = undefined;
  };
  for (const raw of normalized.slice(4, end).split("\n")) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    const line = raw.trim();
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && block !== undefined) {
      // The first indented line decides whether the block is a list or a map.
      if (block.kind === "unknown") block.kind = line.startsWith("- ") ? "list" : "map";
      if (block.kind === "list") {
        if (line.startsWith("- ")) block.items.push(unquote(line.slice(2).trim()));
        continue;
      }
      const separator = line.indexOf(":");
      if (separator > 0) {
        block.entries[line.slice(0, separator).trim()] = unquote(line.slice(separator + 1).trim());
      }
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const rest = line.slice(separator + 1).trim();
    flush();
    if (key === "") continue;
    if (rest === "") {
      block = { key, kind: "unknown", items: [], entries: {} };
      continue;
    }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      fields[key] = rest.slice(1, -1).split(",").map((item) => unquote(item.trim())).filter((item) => item !== "");
      continue;
    }
    fields[key] = unquote(rest);
  }
  flush();
  return fields;
}

/** The body of a SKILL.md, with its frontmatter removed. */
export function stripFrontmatter(text: string): string {
  const normalized = text.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return normalized;
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return normalized;
  return normalized.slice(end + 4).replace(/^\n+/, "");
}

/** The string value of a frontmatter field, or undefined when it is missing or not a scalar. */
function scalar(fields: Frontmatter, key: string): string | undefined {
  const value = fields[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * The files bundled with a skill: its own directory's files, then one level down. The format lets a
 * skill ship anything next to SKILL.md, so nothing is filtered by name — only by depth, because a
 * list the model can act on is better than a directory walk.
 */
async function bundledFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const add = (relative: string): void => {
    if (files.length < MAX_FILES_PER_SKILL) files.push(relative);
  };
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  const near = (left: { name: string }, right: { name: string }): number => left.name.localeCompare(right.name);
  for (const entry of [...entries].sort(near)) {
    if (files.length >= MAX_FILES_PER_SKILL) break;
    if (entry.name.startsWith(".")) continue;
    if (entry.isFile()) {
      if (entry.name !== "SKILL.md") add(entry.name);
      continue;
    }
    if (!entry.isDirectory()) continue;
    let children;
    try {
      children = await readdir(join(directory, entry.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of [...children].sort(near)) {
      if (child.isFile() && !child.name.startsWith(".")) add(`${entry.name}/${child.name}`);
    }
  }
  return files;
}

async function readHead(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * The index. Constructed once at startup, it holds names and descriptions only; `load` is the only
 * method that touches a body, which is what makes the loading lazy rather than merely deferred.
 */
export class SkillIndex {
  readonly #root: string;
  readonly #summaries: readonly SkillSummary[];

  private constructor(root: string, summaries: readonly SkillSummary[]) {
    this.#root = root;
    this.#summaries = summaries;
  }

  /**
   * Reads the SKILL.md frontmatter of each subdirectory under `root`. A missing root is an empty index, not a failure:
   * a deployment without skills is the normal case and must not fail startup.
   */
  static async scan(root: string, options: SkillIndexOptions = {}): Promise<SkillIndex> {
    const log = options.log ?? (() => undefined);
    const limit = Math.max(1, Math.min(options.maxSkills ?? MAX_SKILLS, 200));
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return new SkillIndex(root, []);
    }
    const summaries: SkillSummary[] = [];
    const seen = new Set<string>();
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (summaries.length >= limit) break;
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      // The directory name is the skill's identity, so it must already be the final shape: a
      // capitalised or underscored directory is not silently normalised into a different skill.
      const directory = entry.name;
      if (directory.length > MAX_NAME_CHARS || !NAME_SHAPE.test(directory) || seen.has(directory)) continue;
      const path = join(root, entry.name, "SKILL.md");
      let head: string;
      try {
        head = await readHead(path);
      } catch {
        // A directory without SKILL.md is not a skill; saying so on every start would be noise.
        continue;
      }
      const fields = parseFrontmatter(head);
      if (fields === undefined) {
        log(`skill skipped: dir=${entry.name} code=SKILL_NO_FRONTMATTER`);
        continue;
      }
      const declared = (scalar(fields, "name") ?? directory).trim().toLowerCase();
      if (declared.length > MAX_NAME_CHARS || !NAME_SHAPE.test(declared)) {
        log(`skill skipped: dir=${entry.name} code=SKILL_BAD_NAME`);
        continue;
      }
      // The format requires the declared name to name the directory; a mismatch means one of the two
      // is wrong, and picking either silently would leave `load` reading a path the index calls something else.
      if (declared !== directory) {
        log(`skill skipped: dir=${entry.name} code=SKILL_NAME_MISMATCH`);
        continue;
      }
      if (seen.has(declared)) {
        log(`skill skipped: dir=${entry.name} code=SKILL_DUPLICATE`);
        continue;
      }
      const description = collapse(scalar(fields, "description") ?? "");
      if (description === "") {
        // A skill without a description can never be chosen by the model, so it would only be dead
        // weight in the index.
        log(`skill skipped: dir=${entry.name} code=SKILL_NO_DESCRIPTION`);
        continue;
      }
      seen.add(declared);
      summaries.push({
        name: declared,
        description: description.length > MAX_DESCRIPTION_CHARS
          ? `${description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
          : description,
      });
    }
    return new SkillIndex(root, summaries);
  }

  summaries(): readonly SkillSummary[] {
    return this.#summaries;
  }

  has(name: string): boolean {
    return this.#summaries.some((skill) => skill.name === name.trim().toLowerCase());
  }

  /** One line per skill for the system prompt; bodies stay on disk. */
  promptSection(): string {
    if (this.#summaries.length === 0) return "";
    const lines = this.#summaries.map((skill) => `- ${skill.name}: ${skill.description}`);
    return `Skills: reusable procedures are installed on this host. Only this index is in context — a procedure's body is not loaded until you ask for it. When a task matches a description below, call skill_load with that name and follow the steps; never invent a procedure from its name or assume it says what you expect.\n${lines.join("\n")}`;
  }

  /**
   * Reads one skill body. The name is a single path segment, the resolved path must remain under the
   * root, and an oversized body is cut with an explicit marker rather than silently truncated.
   */
  async load(rawName: string): Promise<LoadedSkill> {
    const name = rawName.trim().toLowerCase();
    if (!NAME_SHAPE.test(name)) throw new SkillError("SKILL_NOT_FOUND", "no skill has that name");
    const summary = this.#summaries.find((skill) => skill.name === name);
    if (summary === undefined) throw new SkillError("SKILL_NOT_FOUND", "no skill has that name");
    const directory = join(this.#root, name);
    const path = join(directory, "SKILL.md");
    let resolved: string;
    try {
      // The realpath check is the boundary that matters: a symlinked SKILL.md must not become a
      // window into the rest of the filesystem.
      resolved = await realpath(path);
    } catch {
      throw new SkillError("SKILL_UNREADABLE", "the skill file is no longer readable");
    }
    const rootResolved = await realpath(this.#root).catch(() => this.#root);
    if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${sep}`)) {
      throw new SkillError("SKILL_UNREADABLE", "the skill file resolves outside the skills directory");
    }
    const info = await stat(resolved);
    if (info.size > MAX_FILE_BYTES) throw new SkillError("SKILL_TOO_LARGE", "the skill file is too large to load");
    const text = await readFile(resolved, "utf8");
    const body = stripFrontmatter(text);
    const truncated = body.length > MAX_BODY_CHARS;
    const files = await bundledFiles(directory);
    return {
      ...summary,
      body: truncated ? `${body.slice(0, MAX_BODY_CHARS)}\n\n[skill truncated at ${MAX_BODY_CHARS} characters]` : body,
      files,
    };
  }
}

function asText(text: string, details: Record<string, string | number | boolean>): ToolExecutionResult {
  return { output: [{ type: "text", text }], details };
}

/**
 * Model-facing tools. `skill_list` exists so a model that lost the prompt section can recover it;
 * `skill_load` is the only way a body enters the context, and it is replayed as unsafe because the
 * file can change between calls.
 */
export function createSkillsExtension(index: SkillIndex): Extension {
  const list = defineTool({
    name: "skill_list",
    description: "List the installed skills by name and one-line description. Bodies are not included; load one with skill_load when it matches the task.",
    parameters: obj({}),
    replay: "safe",
    execute: async () => {
      const skills = index.summaries();
      if (skills.length === 0) return asText("No skills are installed.", { count: 0 });
      return asText(skills.map((skill) => `${skill.name} — ${skill.description}`).join("\n"), { count: skills.length });
    },
  });
  const load = defineTool({
    name: "skill_load",
    description: "Load one skill's procedure into the conversation by name. Use the exact name from the skill index; the host reads the file and returns its body plus the names of any files it references.",
    parameters: obj({
      name: str({ minLength: 1, maxLength: MAX_NAME_CHARS, description: "Skill name exactly as listed by the skill index" }),
    }),
    replay: "unsafe",
    execute: async (args) => {
      try {
        const skill = await index.load(args.name);
        const files = skill.files.length === 0
          ? ""
          : `\n\nFiles in this skill's directory (read them yourself if the procedure refers to one):\n${skill.files.map((file) => `- ${file}`).join("\n")}`;
        return asText(`Skill ${skill.name}: ${skill.description}\n\n${skill.body}${files}`, {
          name: skill.name,
          chars: skill.body.length,
          files: skill.files.length,
        });
      } catch (error) {
        const code = error instanceof SkillError ? error.code : "SKILL_UNREADABLE";
        return {
          isError: true,
          output: [{ type: "text", text: `Skill unavailable (${code}). Use skill_list to see what is installed.` }],
          details: { code },
          diagnostics: [{ severity: "error", code, message: "the skill could not be loaded" }],
        };
      }
    },
  });
  return defineExtension({ name: "skills", tools: [list, load] });
}

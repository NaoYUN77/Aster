import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { obj, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";

/**
 * Skills: small procedures on disk, indexed by name and one-line description.
 *
 * The whole point is that a skill's body is not in the context window until the model asks for it:
 * startup reads only the first few hundred bytes of each SKILL.md (the frontmatter), the system
 * prompt carries an index of names and descriptions, and `skill_load` is what brings the procedure
 * in. A directory of thirty skills therefore costs thirty lines, not thirty documents.
 *
 * Everything under the root is treated as host-provided content, but the path rules still apply:
 * a name is a single path segment, the resolved file must stay under the root, and a body is
 * truncated rather than allowed to flood the context.
 */

/** Frontmatter is parsed from this many leading bytes; a body is never read during a scan. */
const HEAD_BYTES = 4_096;
const MAX_SKILLS = 50;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_NAME_CHARS = 64;
const MAX_BODY_CHARS = 32_000;
const MAX_FILE_BYTES = 512 * 1024;
/** Sibling files a skill may reference, listed by name so the model can read them itself. */
const SKILL_SUBDIRS = ["references", "scripts", "assets"] as const;
const MAX_FILES_PER_SKILL = 20;

const NAME_SHAPE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

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

/**
 * Reads the YAML-ish frontmatter every SKILL.md starts with. Only flat `key: value` pairs are
 * understood on purpose: a skill index does not need a YAML parser, and refusing to interpret more
 * keeps a malformed file from being half-loaded.
 */
export function parseFrontmatter(head: string): Record<string, string> | undefined {
  const normalized = head.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return undefined;
  const fields: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key !== "") fields[key] = value;
  }
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
      const directory = entry.name.toLowerCase();
      if (!NAME_SHAPE.test(directory) || seen.has(directory)) continue;
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
      const declared = (fields["name"] ?? directory).toLowerCase();
      if (!NAME_SHAPE.test(declared)) {
        log(`skill skipped: dir=${entry.name} code=SKILL_BAD_NAME`);
        continue;
      }
      if (seen.has(declared)) {
        log(`skill skipped: dir=${entry.name} code=SKILL_DUPLICATE`);
        continue;
      }
      const description = collapse(fields["description"] ?? "");
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
    const files: string[] = [];
    for (const subdir of SKILL_SUBDIRS) {
      try {
        const names = await readdir(join(directory, subdir), { withFileTypes: true });
        for (const entry of names.slice(0, MAX_FILES_PER_SKILL)) {
          if (entry.isFile() && !entry.name.startsWith(".")) files.push(`${subdir}/${basename(entry.name)}`);
        }
      } catch {
        // Subdirectories are optional.
      }
      if (files.length >= MAX_FILES_PER_SKILL) break;
    }
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

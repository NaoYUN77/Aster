import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createSkillsExtension,
  parseFrontmatter,
  SkillError,
  SkillIndex,
  stripFrontmatter,
} from "../src/skills.js";

/** A skill directory with one SKILL.md; the body is deliberately text the index must never hold. */
async function skill(root: string, dir: string, frontmatter: string, body: string): Promise<void> {
  await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, dir, "SKILL.md"), `${frontmatter}${body}`, "utf8");
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "aster-skills-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("frontmatter is flat key/value, quoted values included", () => {
  const fields = parseFrontmatter('---\nname: release-checklist\ndescription: "Ship it safely"\n---\n');
  assert.deepEqual(fields, { name: "release-checklist", description: "Ship it safely" });
  assert.equal(parseFrontmatter("# no frontmatter"), undefined);
});

test("the body keeps everything after the frontmatter and nothing before it", () => {
  assert.equal(stripFrontmatter("---\nname: x\n---\n\nStep one\nStep two\n"), "Step one\nStep two\n");
  assert.equal(stripFrontmatter("no frontmatter"), "no frontmatter");
});

test("scan indexes names and descriptions without reading bodies", async () => {
  await withRoot(async (root) => {
    await skill(root, "deploy", "---\nname: deploy\ndescription: Deploy the service\n---\n", "SECRET BODY TEXT");
    await skill(root, "notes", "---\ndescription: Take notes\n---\n", "more text");
    const index = await SkillIndex.scan(root);
    const summaries = index.summaries();
    assert.deepEqual(summaries.map((entry) => entry.name), ["deploy", "notes"]);
    assert.equal(summaries[0]!.description, "Deploy the service");
    // The whole point of the index: bodies are not in it.
    assert.equal(JSON.stringify(summaries).includes("SECRET BODY TEXT"), false);
    assert.equal(index.promptSection().includes("SECRET BODY TEXT"), false);
  });
});

test("a skill without a description is skipped, because the model could never choose it", async () => {
  await withRoot(async (root) => {
    await skill(root, "nameless", "---\nname: nameless\n---\n", "body");
    await skill(root, "good", "---\ndescription: Useful\n---\n", "body");
    const lines: string[] = [];
    const index = await SkillIndex.scan(root, { log: (line) => lines.push(line) });
    assert.deepEqual(index.summaries().map((entry) => entry.name), ["good"]);
    assert.ok(lines.some((line) => line.includes("SKILL_NO_DESCRIPTION")));
  });
});

test("a directory without SKILL.md is not a skill and is not logged as a defect", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, "empty"), { recursive: true });
    const lines: string[] = [];
    const index = await SkillIndex.scan(root, { log: (line) => lines.push(line) });
    assert.equal(index.summaries().length, 0);
    assert.equal(lines.length, 0);
  });
});

test("a missing skills directory is an empty index, not a startup failure", async () => {
  await withRoot(async (root) => {
    const index = await SkillIndex.scan(join(root, "does-not-exist"));
    assert.equal(index.summaries().length, 0);
    assert.equal(index.promptSection(), "");
  });
});

test("load reads the body on demand and lists the files the procedure may reference", async () => {
  await withRoot(async (root) => {
    await skill(root, "deploy", "---\ndescription: Deploy\n---\n", "Step one\n");
    await mkdir(join(root, "deploy", "scripts"), { recursive: true });
    await writeFile(join(root, "deploy", "scripts", "run.sh"), "#!/bin/sh\n", "utf8");
    const index = await SkillIndex.scan(root);
    const loaded = await index.load("deploy");
    assert.equal(loaded.body, "Step one\n");
    assert.deepEqual(loaded.files, ["scripts/run.sh"]);
  });
});

test("an unknown or path-like name never reaches the filesystem", async () => {
  await withRoot(async (root) => {
    await skill(root, "deploy", "---\ndescription: Deploy\n---\n", "body");
    const index = await SkillIndex.scan(root);
    for (const name of ["unknown", "../deploy", "deploy/../..", "", "Deploy"]) {
      if (name === "Deploy") {
        // Case is normalised, not rejected: the model may echo the directory's own capitalisation.
        assert.equal((await index.load(name)).name, "deploy");
        continue;
      }
      await assert.rejects(() => index.load(name), (error: unknown) =>
        error instanceof SkillError && error.code === "SKILL_NOT_FOUND");
    }
  });
});

test("an oversized body is cut with an explicit marker instead of flooding the context", async () => {
  await withRoot(async (root) => {
    await skill(root, "huge", "---\ndescription: Big\n---\n", "x".repeat(40_000));
    const index = await SkillIndex.scan(root);
    const loaded = await index.load("huge");
    assert.ok(loaded.body.length <= 32_100);
    assert.ok(loaded.body.endsWith("characters]"));
  });
});

test("the prompt section carries names and descriptions only", async () => {
  await withRoot(async (root) => {
    await skill(root, "deploy", "---\ndescription: Deploy the service\n---\n", "body");
    const section = (await SkillIndex.scan(root)).promptSection();
    assert.ok(section.includes("- deploy: Deploy the service"));
    assert.ok(section.includes("skill_load"));
    assert.equal(section.includes("body\n"), false);
  });
});

test("the extension exposes exactly the two skill tools", () => {
  const extension = createSkillsExtension({ summaries: () => [], load: async () => { throw new Error("unused"); } } as unknown as SkillIndex);
  const names = (extension.tools ?? []).map((tool) => (tool as { name?: string }).name);
  assert.deepEqual(names.sort(), ["skill_list", "skill_load"]);
});

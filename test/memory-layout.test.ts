import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { indexLinks, checkMemoryLayout } from "../src/memory/fs/layout.js";

async function memoryDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aster-layout-"));
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

test("memory layout: an index with every note linked is valid", async () => {
  const root = await memoryDir({
    "MEMORY.md": "# Memory\n\n## Core\n- Owner prefers metric units.\n\n## Index\n- [Projects](notes/projects.md)\n- [People](people.md)\n",
    "notes/projects.md": "# Projects\n\nAster.\n",
    "people.md": "# People\n\nNobody.\n",
  });
  try {
    assert.deepEqual(await checkMemoryLayout(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory layout: a note missing from the index is reported", async () => {
  const root = await memoryDir({
    "MEMORY.md": "# Memory\n\n## Index\n- [Projects](notes/projects.md)\n",
    "notes/projects.md": "Aster.\n",
    "notes/people.md": "Nobody.\n",
  });
  try {
    assert.deepEqual(await checkMemoryLayout(root), [{ code: "orphan-note", path: "notes/people.md" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory layout: an index link with no note is reported", async () => {
  const root = await memoryDir({
    "MEMORY.md": "# Memory\n\n## Index\n- [Projects](notes/projects.md)\n",
  });
  try {
    assert.deepEqual(await checkMemoryLayout(root), [{ code: "dangling-link", target: "notes/projects.md" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory layout: a link outside the memory directory is reported", async () => {
  const root = await memoryDir({
    "MEMORY.md": "# Memory\n\n## Index\n- [Escape](../secrets.md)\n",
  });
  try {
    assert.deepEqual(await checkMemoryLayout(root), [{ code: "escaping-link", target: "../secrets.md" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory layout: a missing MEMORY.md is reported", async () => {
  const root = await memoryDir({ "notes/projects.md": "Aster.\n" });
  try {
    assert.deepEqual(await checkMemoryLayout(root), [{ code: "missing-memory", path: "MEMORY.md" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory layout: an empty memory repository is valid", async () => {
  const root = await memoryDir({ "MEMORY.md": "" });
  try {
    assert.deepEqual(await checkMemoryLayout(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory layout: only the Index section's links count", () => {
  const links = indexLinks(
    [
      "# Memory",
      "",
      "## Core",
      "- See [Projects](core-projects.md).",
      "",
      "## Index",
      "- [Projects](notes/projects.md#active)",
      "- [External](https://example.com/x)",
      "- [Anchor](#core)",
      "",
      "## History",
      "- [Old](notes/old.md)",
    ].join("\n"),
  );
  assert.deepEqual(links, ["notes/projects.md#active"]);
});

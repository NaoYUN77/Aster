// The sandbox has to enter its cgroup before bwrap unshares the cgroup namespace; afterwards the
// kernel refuses the migration. These cases exercise the helper with a directory that stands in
// for a cgroup, so the ordering (write, then exec) and the failure reporting are covered without
// needing a real cgroup v2 mount.

import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnInCgroup } from "../src/execution/ptc-cgroup.js";

// `process.execve` is POSIX-only; Windows has no cgroups either.
const skip = process.platform === "linux" ? false : "cgroup accounting needs a Linux host";

async function fakeCgroup(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aster-cgroup-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "cgroup.procs"), "");
  return root;
}

function collected(child: ChildProcess): Promise<{ code: number | null; text: string; stderr: string }> {
  return new Promise((resolve) => {
    let text = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("close", (code) => resolve({ code, text, stderr }));
  });
}

test("the sandbox enters its cgroup before it runs and keeps its pid across the exec", { skip }, async (t) => {
  const root = await fakeCgroup(t);
  const { child, ready } = spawnInCgroup(root, "/bin/sh", ["-c", "echo $$"], {
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = collected(child);
  await ready;

  const accounted = (await readFile(join(root, "cgroup.procs"), "utf8")).trim();
  assert.equal(accounted, String(child.pid), "the helper writes its own pid, not a child's");

  assert.deepEqual(
    await result,
    { code: 0, text: `${child.pid}\n`, stderr: "" },
    "execve preserves the accounted pid and the helper is silent",
  );
});

test("an exec failure is reported as a command failure, not as a missing cgroup", { skip }, async (t) => {
  const root = await fakeCgroup(t);
  const { child, ready } = spawnInCgroup(root, "/nonexistent/aster-sandbox", [], {
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = collected(child);
  // The move succeeded, so accounting is confirmed; the failed exec is the sandbox starting and
  // exiting, not an unaccounted process.
  await ready;
  assert.equal((await result).code, 125);
});

test("a refused migration rejects before anything runs", { skip }, async (t) => {
  const root = await fakeCgroup(t);
  const { ready } = spawnInCgroup(join(root, "missing"), process.execPath, ["-e", "process.exit(0)"], {
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await assert.rejects(ready, /ENOENT|cannot move/);
});

test("the accounting channel settles even when the sandbox exits immediately", { skip }, async (t) => {
  const root = await fakeCgroup(t);
  const { child, ready } = spawnInCgroup(root, process.execPath, ["-e", "process.exit(3)"], {
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = collected(child);
  // The helper reports the move before exec, so a fast exit still resolves rather than racing end.
  await ready;
  assert.equal((await result).code, 3);
});

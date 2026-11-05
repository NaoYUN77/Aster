import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { ProactiveStore } from "../src/proactive.js";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(new URL("../src/proactive-cli.ts", import.meta.url));

for (const enabled of [false, true]) {
  test(`manual trigger CLI ${enabled ? "persists one queued run" : "rejects disabled mode without creating state"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "aster-proactive-cli-"));
    try {
      const command = execute(process.execPath, ["--import", "tsx", cli, "trigger"], {
        cwd: root,
        env: {
          ...process.env,
          DATA_DIR: directory,
          PROACTIVE_ENABLED: enabled ? "1" : "0",
          PROACTIVE_TIMEZONE: "Asia/Shanghai",
        },
        windowsHide: true,
      });
      if (!enabled) {
        await assert.rejects(command, (error: unknown) => {
          const failure = error as { code?: number; stderr?: string };
          assert.equal(failure.code, 1);
          assert.match(failure.stderr ?? "", /PROACTIVE_ENABLED must be 1/);
          return true;
        });
        await assert.rejects(stat(join(directory, "proactive.sqlite")), { code: "ENOENT" });
      } else {
        const { stdout } = await command;
        const result = JSON.parse(stdout) as { created: boolean; status: string };
        assert.equal(result.created, true);
        assert.equal(result.status, "queued");
        const store = new ProactiveStore(join(directory, "proactive.sqlite"), { timezone: "Asia/Shanghai" });
        try {
          assert.equal(store.list().length, 1);
          assert.equal(store.list()[0]?.submissionId, null, "CLI only queues; it does not run the model");
        } finally {
          store.close();
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

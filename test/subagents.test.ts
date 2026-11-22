import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { ApprovalService } from "../src/approvals/index.js";
import { EventHub } from "../src/http/events.js";
import { SubagentManager, type SubagentSnapshot } from "../src/subagents/index.js";

test("SubagentManager runs in disposable SQLite and unlinks it cleanly on completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-subagents-test-"));
  const workspace = join(dir, "workspace");
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const approvals = new ApprovalService({ dbPath: ":memory:", log: () => {} });
  const hub = new EventHub(() => {});
  const emitted: SubagentSnapshot[] = [];
  const origBroadcast = hub.broadcast.bind(hub);
  hub.broadcast = (event, data) => {
    if (event === "subagent.updated") emitted.push(data as SubagentSnapshot);
    origBroadcast(event, data);
  };
  const manager = new SubagentManager({
    dataDir: dir,
    workspace,
    models,
    defaultModel: { provider: "faux", modelId: "m1" },
    approvals,
    hub,
    log: () => {},
  });

  try {
    faux.setResponses([fauxAssistantMessage("Sub-agent finished inspecting logs.")]);
    const spawned = await manager.spawn({
      task: "Inspect logs and summarize",
      tools: ["read", "current_time"],
      mode: "wait",
    });

    assert.equal(spawned.mode, "wait");
    assert.equal(spawned.result.status, "completed");
    assert.equal(spawned.result.summary, "Sub-agent finished inspecting logs.");

    // Disposable SQLite must be unlinked after completion.
    const leftovers = await readdir(join(dir, "subagents"));
    assert.deepEqual(leftovers, []);

    // Live SSE lifecycle snapshots emitted running -> completed.
    assert.ok(emitted.length >= 2);
    assert.equal(emitted[0]!.status, "running");
    assert.equal(emitted[emitted.length - 1]!.status, "completed");
  } finally {
    await manager.close();
    hub.close();
    approvals.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SubagentManager rejects cwd outside workspace and supports background + wait", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-subagents-bg-test-"));
  const workspace = join(dir, "workspace");
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const manager = new SubagentManager({
    dataDir: dir,
    workspace,
    models,
    defaultModel: { provider: "faux", modelId: "m1" },
    log: () => {},
  });

  try {
    await assert.rejects(
      manager.spawn({ task: "escape", cwd: "../outside" }),
      (error: { code?: string }) => error.code === "SUBAGENT_CWD_OUTSIDE_WORKSPACE",
    );

    faux.setResponses([
      fauxAssistantMessage("Result A"),
      fauxAssistantMessage("Result B"),
    ]);
    const a = await manager.spawn({ task: "Task A", mode: "background" });
    const b = await manager.spawn({ task: "Task B", mode: "background" });
    assert.equal(a.mode, "background");
    assert.equal(b.mode, "background");

    const results = await manager.wait([a.id, b.id]);
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.status === "completed"));
    const summaries = results.map((r) => r.summary).sort();
    assert.deepEqual(summaries, ["Result A", "Result B"]);

    const leftovers = await readdir(join(dir, "subagents"));
    assert.deepEqual(leftovers, []);
  } finally {
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Sub-agent without write lock escalates write tool call to ApprovalService and obeys owner denial", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-subagents-approval-test-"));
  const workspace = join(dir, "workspace");
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const approvals = new ApprovalService({ dbPath: ":memory:", defaultTimeoutMs: 5_000, log: () => {} });
  const manager = new SubagentManager({
    dataDir: dir,
    workspace,
    models,
    defaultModel: { provider: "faux", modelId: "m1" },
    approvals,
    log: () => {},
  });

  try {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "hello.txt", content: "hi" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Write was denied by owner; stopped safely."),
    ]);

    const runPromise = manager.spawn({
      task: "Try writing without allowWrite",
      tools: ["read", "write"],
      allowWrite: false,
      mode: "wait",
    });

    // Wait for approval request to appear.
    let pending = approvals.listPending();
    for (let i = 0; i < 100 && pending.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 15));
      pending = approvals.listPending();
    }
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.caller.kind, "subagent");
    assert.equal(pending[0]!.rule, "subagent_write_escalation");
    assert.equal(pending[0]!.toolName, "write");

    approvals.resolve(pending[0]!.id, { decision: "deny", reason: "只允许只读巡检" });

    const outcome = await runPromise;
    assert.equal(outcome.mode, "wait");
    assert.equal(outcome.result.status, "completed");
    assert.match(outcome.result.summary, /denied/i);
  } finally {
    await manager.close();
    approvals.close();
    await rm(dir, { recursive: true, force: true });
  }
});

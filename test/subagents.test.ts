import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
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

test("wait() returns completed results plus live running snapshot on timeoutMs without throwing or cancelling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-subagents-wait-timeout-"));
  const workspace = join(dir, "workspace");
  let releaseSlowTool!: () => void;
  const slowGate = new Promise<void>((r) => { releaseSlowTool = r; });

  const slowExt = defineExtension({
    name: "slow-test-tools",
    tools: [
      defineTool({
        name: "slow_fetch",
        description: "Slow fetch for testing wait timeout.",
        parameters: obj({}),
        replay: "safe",
        execute: async () => {
          await slowGate;
          return { output: [{ type: "text", text: "fetched ok" }] };
        },
      }),
    ],
  });

  const faux = fauxProvider({ provider: "faux", models: [{ id: "m1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const manager = new SubagentManager({
    dataDir: dir,
    workspace,
    models,
    defaultModel: { provider: "faux", modelId: "m1" },
    extensions: [slowExt],
    log: () => {},
  });

  try {
    faux.setResponses([
      fauxAssistantMessage("Fast result done."),
      fauxAssistantMessage([fauxToolCall("slow_fetch", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("Slow result finally done."),
    ]);

    const fast = await manager.spawn({ task: "Fast task", tools: ["slow_fetch"], mode: "background" });
    assert.equal(fast.mode, "background");
    // Let fast finish before spawning slow so response ordering is deterministic.
    await manager.wait([fast.id]);

    const slow = await manager.spawn({ task: "Slow fetch task", tools: ["slow_fetch"], mode: "background" });
    assert.equal(slow.mode, "background");

    // First wait times out at 80ms: must NOT throw, must return fast's completed result AND slow's running snapshot.
    const partial = await manager.wait([fast.id, slow.id], { timeoutMs: 80 });
    assert.equal(partial.length, 2);
    assert.equal(partial[0]!.id, fast.id);
    assert.equal(partial[0]!.status, "completed");
    assert.equal(partial[0]!.summary, "Fast result done.");
    assert.equal(partial[1]!.id, slow.id);
    assert.equal(partial[1]!.status, "running");
    assert.match(partial[1]!.summary, /NOT cancelled/i);

    // Slow sub-agent is still alive in the background; releasing it lets a second wait collect its final output.
    releaseSlowTool();
    const finalResults = await manager.wait([slow.id], { timeoutMs: 5_000 });
    assert.equal(finalResults.length, 1);
    assert.equal(finalResults[0]!.status, "completed");
    assert.equal(finalResults[0]!.summary, "Slow result finally done.");
  } finally {
    releaseSlowTool();
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("wait() pauses timeoutMs while waiting for owner approval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-subagents-wait-pause-"));
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
      fauxAssistantMessage([fauxToolCall("write", { path: "note.txt", content: "ok" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Approved and written."),
    ]);

    const bg = await manager.spawn({
      task: "Write after approval",
      tools: ["write"],
      allowWrite: false,
      mode: "background",
    });
    assert.equal(bg.mode, "background");

    // Wait until approval is pending before calling wait() with a tight timeoutMs (120ms).
    let pending = approvals.listPending();
    for (let i = 0; i < 100 && pending.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 15));
      pending = approvals.listPending();
    }
    assert.equal(pending.length, 1);

    // Start waiting with timeoutMs=120ms, but delay approving for 220ms.
    // Because wait() uses createPauseableTimeout, the 120ms timer stays paused during approval!
    const waitPromise = manager.wait([bg.id], { timeoutMs: 120 });
    await new Promise((r) => setTimeout(r, 220));
    approvals.resolve(pending[0]!.id, { decision: "approve_once" });

    const results = await waitPromise;
    assert.equal(results.length, 1);
    assert.equal(results[0]!.status, "completed");
    assert.equal(results[0]!.summary, "Approved and written.");
  } finally {
    await manager.close();
    approvals.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Sub-agent execution timeout preserves partial assistant output instead of discarding it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-subagents-partial-timeout-"));
  const workspace = join(dir, "workspace");

  const hangExt = defineExtension({
    name: "hang-test-tools",
    tools: [
      defineTool({
        name: "hang_forever",
        description: "Blocks until aborted.",
        parameters: obj({}),
        replay: "safe",
        execute: async (_args, _api, ctx) => {
          await new Promise<void>((_, reject) => {
            ctx.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
          return { output: [] };
        },
      }),
    ],
  });

  const faux = fauxProvider({ provider: "faux", models: [{ id: "m1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const manager = new SubagentManager({
    dataDir: dir,
    workspace,
    models,
    defaultModel: { provider: "faux", modelId: "m1" },
    extensions: [hangExt],
    log: () => {},
  });

  try {
    faux.setResponses([
      fauxAssistantMessage(
        [
          { type: "text", text: "Collected 3 files so far: a.ts, b.ts, c.ts." },
          fauxToolCall("hang_forever", {}),
        ],
        { stopReason: "toolUse" },
      ),
    ]);

    const outcome = await manager.spawn({
      task: "Fetch files with short timeout",
      tools: ["hang_forever"],
      mode: "wait",
      timeoutMs: 180,
    });
    assert.equal(outcome.mode, "wait");
    assert.equal(outcome.result.status, "failed");
    assert.match(outcome.result.error ?? "", /timed out/i);
    assert.match(outcome.result.summary, /partial output preserved/i);
    assert.match(outcome.result.summary, /Collected 3 files so far/);
  } finally {
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { obj, str } from "@earendil-works/pi-schema";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { openAgent } from "../src/agent.js";
import { ApprovalService } from "../src/approvals/index.js";
import { readConfig } from "../src/config.js";
import { EventHub } from "../src/http/events.js";
import {
  createSubagentExtension,
  SubagentConcurrencyLimitError,
  SubagentInvalidToolsError,
  SubagentManager,
  type SubagentSnapshot,
} from "../src/subagents/index.js";
import { personalTools } from "../src/tools.js";
import { createWebExtension } from "../src/web-tools.js";
import { withMemoryOff } from "./support/memory-off.js";

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

test("Sub-agent defaults include web search tools and discover deferred tools via tool_search", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-subagents-discovery-"));
  const workspace = join(dir, "workspace");

  const webExt = createWebExtension({
    deepseekApiKey: "test-ds-key",
    exaApiKey: "test-exa-key",
    fetch: async () => new Response(JSON.stringify({
      results: [{ title: "Harness Engineering", url: "https://example.com/harness", text: "Harness guide" }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  const feishuExt = defineExtension({
    name: "mcp-server-feishu",
    tools: [
      defineTool({
        name: "feishu_list_docs",
        description: "List Feishu cloud documents in a folder.",
        parameters: obj({ folder: str() }),
        deferred: true,
        replay: "safe",
        execute: async ({ folder }) => ({
          output: [{ type: "text", text: `docs in ${folder}: spec.md` }],
        }),
      }),
      defineTool({
        name: "feishu_read_doc",
        description: "Read a Feishu document.",
        parameters: obj({ docId: str() }),
        deferred: true,
        replay: "safe",
        execute: async ({ docId }) => ({
          output: [{ type: "text", text: `content of ${docId}` }],
        }),
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
    extensions: [CodingTools, personalTools, webExt, feishuExt],
    log: () => {},
  });

  try {
    // Verify concise capability summary (token-efficient description for spawn_subagent).
    const caps = manager.describeToolCapabilities();
    assert.ok(caps.defaultTools.includes("exa_search"));
    assert.ok(caps.defaultTools.includes("web_search"));
    assert.ok(caps.defaultTools.includes("web_fetch"));
    assert.ok(caps.defaultTools.includes("tool_search"));
    assert.ok(!caps.defaultTools.includes("feishu_list_docs"));
    assert.deepEqual(caps.onDemandCategories, [{ extension: "mcp-server-feishu", count: 2 }]);

    const spawnTool = createSubagentExtension(manager).tools!.find((t) => t.name === "spawn_subagent")!;
    assert.match(spawnTool.description, /exa_search/);
    assert.match(spawnTool.description, /mcp-server-feishu \(2\)/);
    assert.doesNotMatch(spawnTool.description, /feishu_list_docs/);

    const turnTools: string[][] = [];
    faux.setResponses([
      (transcript) => {
        turnTools.push(getCurrentTools(transcript.messages).map((t) => t.name));
        return fauxAssistantMessage([
          fauxToolCall("exa_search", { query: "harness engineering" }),
          fauxToolCall("tool_search", { query: "feishu list docs" }),
        ], { stopReason: "toolUse" });
      },
      (transcript) => {
        turnTools.push(getCurrentTools(transcript.messages).map((t) => t.name));
        return fauxAssistantMessage([
          fauxToolCall("feishu_list_docs", { folder: "root" }),
        ], { stopReason: "toolUse" });
      },
      fauxAssistantMessage("Searched web and listed Feishu docs: spec.md."),
    ]);

    const outcome = await manager.spawn({
      task: "Search harness engineering and list Feishu docs",
      mode: "wait",
    });

    assert.equal(outcome.mode, "wait");
    assert.equal(outcome.result.status, "completed");
    assert.match(outcome.result.summary, /spec\.md/);

    // Turn 1: Tier-1 resident tools + tool_search present; deferred Feishu tools NOT bloated into schema.
    assert.ok(turnTools[0]!.includes("exa_search"));
    assert.ok(turnTools[0]!.includes("web_search"));
    assert.ok(turnTools[0]!.includes("web_fetch"));
    assert.ok(turnTools[0]!.includes("tool_search"));
    assert.ok(!turnTools[0]!.includes("feishu_list_docs"));

    // Turn 2: After tool_search, feishu_list_docs is promoted and callable.
    assert.ok(turnTools[1]!.includes("feishu_list_docs"));
  } finally {
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("extraTools promotes deferred tools alongside defaults while explicit tools enforces lock-cage mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-subagents-modes-"));
  const workspace = join(dir, "workspace");

  const connectorExt = defineExtension({
    name: "connectors",
    tools: [
      defineTool({
        name: "github_get_issue",
        description: "Read a GitHub issue.",
        parameters: obj({ id: str() }),
        deferred: true,
        replay: "safe",
        execute: async ({ id }) => ({
          output: [{ type: "text", text: `issue #${id}` }],
        }),
      }),
      defineTool({
        name: "calendar_list_events",
        description: "List calendar events.",
        parameters: obj({}),
        deferred: true,
        replay: "safe",
        execute: async () => ({
          output: [{ type: "text", text: "no events" }],
        }),
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
    extensions: [CodingTools, personalTools, connectorExt],
    log: () => {},
  });

  try {
    // 1. extraTools: promotes github_get_issue directly alongside defaults + tool_search.
    let extraTurnTools: string[] = [];
    faux.setResponses([
      (transcript) => {
        extraTurnTools = getCurrentTools(transcript.messages).map((t) => t.name);
        return fauxAssistantMessage([fauxToolCall("github_get_issue", { id: "42" })], { stopReason: "toolUse" });
      },
      fauxAssistantMessage("Read issue #42."),
    ]);

    const extraOutcome = await manager.spawn({
      task: "Read issue 42",
      extraTools: ["github_get_issue"],
      mode: "wait",
    });
    assert.equal(extraOutcome.mode, "wait");
    assert.equal(extraOutcome.result.status, "completed");
    assert.ok(extraTurnTools.includes("github_get_issue"));
    assert.ok(extraTurnTools.includes("read"));
    assert.ok(extraTurnTools.includes("tool_search"));
    assert.ok(!extraTurnTools.includes("calendar_list_events"));

    // 2. Lock-cage mode: explicit `tools: ["read"]` removes unlisted tools AND removes tool_search.
    let lockedTurnTools: string[] = [];
    faux.setResponses([
      (transcript) => {
        lockedTurnTools = getCurrentTools(transcript.messages).map((t) => t.name);
        return fauxAssistantMessage("Locked down.");
      },
    ]);

    const lockedOutcome = await manager.spawn({
      task: "Read only strict",
      tools: ["read"],
      mode: "wait",
    });
    assert.equal(lockedOutcome.mode, "wait");
    assert.equal(lockedOutcome.result.status, "completed");
    assert.deepEqual(lockedTurnTools, ["read"]);

    // 3. Lock-cage mode with a deferred tool strips `deferred` so it is immediately usable without tool_search.
    let lockedDeferredTools: string[] = [];
    faux.setResponses([
      (transcript) => {
        lockedDeferredTools = getCurrentTools(transcript.messages).map((t) => t.name);
        return fauxAssistantMessage([fauxToolCall("github_get_issue", { id: "7" })], { stopReason: "toolUse" });
      },
      fauxAssistantMessage("Read issue #7 in lock cage."),
    ]);

    const lockedDeferredOutcome = await manager.spawn({
      task: "Read issue 7 only",
      tools: ["github_get_issue"],
      mode: "wait",
    });
    assert.equal(lockedDeferredOutcome.mode, "wait");
    assert.equal(lockedDeferredOutcome.result.status, "completed");
    assert.deepEqual(lockedDeferredTools, ["github_get_issue"]);
  } finally {
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("allowWrite: true automatically promotes write and edit into defaults when tools is omitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-subagents-allow-write-"));
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
    let seenTools: string[] = [];
    faux.setResponses([
      (transcript) => {
        seenTools = getCurrentTools(transcript.messages).map((t) => t.name);
        return fauxAssistantMessage([
          fauxToolCall("write", { path: "created.txt", content: "hello write" }),
        ], { stopReason: "toolUse" });
      },
      fauxAssistantMessage("Created created.txt."),
    ]);

    const outcome = await manager.spawn({
      task: "Create created.txt",
      allowWrite: true,
      mode: "wait",
    });

    assert.equal(outcome.mode, "wait");
    assert.equal(outcome.result.status, "completed");
    assert.ok(seenTools.includes("write"));
    assert.ok(seenTools.includes("edit"));
    assert.equal(await readFile(join(workspace, "created.txt"), "utf8"), "hello write");
  } finally {
    await manager.close();
    approvals.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SubagentManager fails fast on invalid tools and spawn_subagent returns structured error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-subagents-invalid-tools-"));
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
      manager.spawn({ task: "bad", tools: ["nonexistent_tool"] }),
      (error: unknown) => {
        assert.ok(error instanceof SubagentInvalidToolsError);
        assert.equal(error.code, "SUBAGENT_INVALID_TOOLS");
        assert.deepEqual(error.invalidTools, ["nonexistent_tool"]);
        assert.ok(error.availableTools.includes("read"));
        return true;
      },
    );

    await assert.rejects(
      manager.spawn({ task: "bad extra", extraTools: ["spawn_subagent"] }),
      (error: unknown) => error instanceof SubagentInvalidToolsError && error.invalidTools.includes("spawn_subagent"),
    );

    // spawn_subagent tool catches SubagentInvalidToolsError and returns structured isError output.
    const spawnTool = createSubagentExtension(manager).tools!.find((t) => t.name === "spawn_subagent")!;
    const toolResult = await spawnTool.execute(
      { task: "try bogus", tools: ["bogus_tool"] },
      { conversationId: 1, taskId: 2, callId: "call-1" } as ToolExecutionApi,
      BACKGROUND_CONTEXT,
    );
    assert.equal(toolResult.isError, true);
    const structured = toolResult.structuredOutput as {
      error?: { code?: string; invalidTools?: string[]; availableTools?: string[] };
    };
    assert.equal(structured.error?.code, "SUBAGENT_INVALID_TOOLS");
    assert.deepEqual(structured.error?.invalidTools, ["bogus_tool"]);
    assert.ok(structured.error?.availableTools?.includes("read"));
  } finally {
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Main agent receives static <subagents> delegation guidelines while sub-agents do not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-subagents-prompt-section-"));
  const config = withMemoryOff(readConfig({
    WEB_OWNER_ID: "owner",
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    OPENAI_API_KEY: "offline-test",
    DATA_DIR: dir,
  }));
  const faux = fauxProvider({ provider: "openai" });
  const models = createModels();
  models.setProvider(faux.provider);

  let mainSystemPrompt = "";
  let subagentSystemPrompt = "";
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;

  try {
    faux.setResponses([
      (transcript) => {
        mainSystemPrompt = getCurrentSystemPrompt(transcript.messages);
        return fauxAssistantMessage([
          fauxToolCall("spawn_subagent", { task: "Inspect workspace quickly", mode: "wait" }),
        ], { stopReason: "toolUse" });
      },
      (transcript) => {
        subagentSystemPrompt = getCurrentSystemPrompt(transcript.messages);
        return fauxAssistantMessage("Sub-agent inspected.");
      },
      fauxAssistantMessage("Main agent summarized."),
    ]);

    app = await openAgent(config, models, undefined, { enableSubagents: true });
    const reply = await app.reply({
      requestId: "web:subagent-section:1",
      conversationId: "owner",
      senderId: "owner",
      text: "Check the workspace",
    }, new AbortController().signal);

    assert.equal(reply, "Main agent summarized.");
    assert.match(mainSystemPrompt, /<subagents>/);
    assert.match(mainSystemPrompt, /Sub-agent delegation:/);
    assert.match(mainSystemPrompt, /hard concurrency cap: 6/);
    assert.equal(subagentSystemPrompt.includes("<subagents>"), false);
    assert.equal(subagentSystemPrompt.includes("Sub-agent delegation:"), false);
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SubagentManager enforces maxConcurrent cap and returns structured error via spawn_subagent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-subagents-concurrency-"));
  const workspace = join(dir, "workspace");
  const releases: Array<() => void> = [];

  const gateExt = defineExtension({
    name: "gate-test-tools",
    tools: [
      defineTool({
        name: "hold_slot",
        description: "Blocks until released.",
        parameters: obj({}),
        replay: "safe",
        execute: async () => {
          await new Promise<void>((resolve) => { releases.push(resolve); });
          return { output: [{ type: "text", text: "released" }] };
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
    extensions: [gateExt],
    maxConcurrent: 2,
    log: () => {},
  });

  try {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("hold_slot", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("hold_slot", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("Done 1"),
      fauxAssistantMessage("Done 2"),
      fauxAssistantMessage("Done 3"),
    ]);

    const first = await manager.spawn({ task: "Task 1", tools: ["hold_slot"], mode: "background" });
    const second = await manager.spawn({ task: "Task 2", tools: ["hold_slot"], mode: "background" });
    assert.equal(first.mode, "background");
    assert.equal(second.mode, "background");

    await assert.rejects(
      manager.spawn({ task: "Task 3", tools: ["hold_slot"], mode: "background" }),
      (error: unknown) => {
        assert.ok(error instanceof SubagentConcurrencyLimitError);
        assert.equal(error.code, "SUBAGENT_CONCURRENCY_LIMIT");
        assert.equal(error.activeCount, 2);
        assert.equal(error.maxConcurrent, 2);
        return true;
      },
    );

    const spawnTool = createSubagentExtension(manager).tools!.find((t) => t.name === "spawn_subagent")!;
    const toolResult = await spawnTool.execute(
      { task: "Task 3 via tool", tools: ["hold_slot"], mode: "background" },
      { conversationId: 1, taskId: 2, callId: "call-limit" } as ToolExecutionApi,
      BACKGROUND_CONTEXT,
    );
    assert.equal(toolResult.isError, true);
    const structured = toolResult.structuredOutput as {
      error?: { code?: string; activeCount?: number; maxConcurrent?: number };
    };
    assert.equal(structured.error?.code, "SUBAGENT_CONCURRENCY_LIMIT");
    assert.equal(structured.error?.activeCount, 2);
    assert.equal(structured.error?.maxConcurrent, 2);

    // Wait until both sub-agents reach hold_slot, then release both so slots free up.
    for (let i = 0; i < 100 && releases.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 15));
    }
    while (releases.length > 0) releases.shift()!();
    await manager.wait([first.id, second.id]);

    // After slots free up, spawning succeeds again.
    const third = await manager.spawn({ task: "Task 3 after free", tools: ["hold_slot"], mode: "wait" });
    assert.equal(third.mode, "wait");
    assert.equal(third.result.status, "completed");
  } finally {
    while (releases.length > 0) releases.shift()!();
    await manager.close();
    await rm(dir, { recursive: true, force: true });
  }
});

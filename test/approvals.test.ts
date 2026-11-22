import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import {
  ApprovalService,
  evaluateSensitiveOperation,
  isOutsideWorkspace,
} from "../src/approvals/index.js";
import { createToolRegistry } from "../src/tools.js";

const WORKSPACE = join(tmpdir(), "aster-approval-policy-ws");

test("evaluateSensitiveOperation detects all 4 sensitive categories and allows safe read/in-workspace ops", () => {
  const mainCtx = { workspace: WORKSPACE, cwd: WORKSPACE, caller: { kind: "main" as const, conversationId: "1" }, workspaceWriteAllowed: true };
  const builtinWrite = { source: { kind: "builtin" as const, extension: "coding" }, authz: "write" as const };
  const builtinRead = { source: { kind: "builtin" as const, extension: "coding" }, authz: "read" as const };
  const mcpWrite = { source: { kind: "mcp" as const, server: "github" }, authz: "write" as const };
  const mcpRead = { source: { kind: "mcp" as const, server: "github" }, authz: "read" as const };

  // 1. Destructive shell
  const rmrf = evaluateSensitiveOperation("bash", { command: "rm -rf ./build" }, builtinWrite, mainCtx);
  assert.equal(rmrf.sensitive, true);
  assert.equal(rmrf.rule, "destructive_shell");

  const forcePush = evaluateSensitiveOperation("bash", { command: "git push origin main --force" }, builtinWrite, mainCtx);
  assert.equal(forcePush.sensitive, true);
  assert.equal(forcePush.rule, "destructive_shell");

  const safeLs = evaluateSensitiveOperation("bash", { command: "ls -la" }, builtinWrite, mainCtx);
  assert.equal(safeLs.sensitive, false);

  // 2. Workspace escape
  assert.equal(isOutsideWorkspace(WORKSPACE, WORKSPACE, "../secret.txt"), true);
  assert.equal(isOutsideWorkspace(WORKSPACE, WORKSPACE, "src/index.ts"), false);

  const escapeWrite = evaluateSensitiveOperation("write", { path: "../outside.txt", content: "x" }, builtinWrite, mainCtx);
  assert.equal(escapeWrite.sensitive, true);
  assert.equal(escapeWrite.rule, "workspace_escape");

  const safeWrite = evaluateSensitiveOperation("write", { path: "notes/ok.md", content: "ok" }, builtinWrite, mainCtx);
  assert.equal(safeWrite.sensitive, false);

  // 3. External write (MCP/connector) vs read
  const extWrite = evaluateSensitiveOperation("github_create_issue", { title: "bug" }, mcpWrite, mainCtx);
  assert.equal(extWrite.sensitive, true);
  assert.equal(extWrite.rule, "external_write");

  const extRead = evaluateSensitiveOperation("github_get_issue", { number: 1 }, mcpRead, mainCtx);
  assert.equal(extRead.sensitive, false);

  const localRead = evaluateSensitiveOperation("read", { path: "README.md" }, builtinRead, mainCtx);
  assert.equal(localRead.sensitive, false);

  // 4. Sub-agent write escalation
  const subNoWriteCtx = {
    workspace: WORKSPACE,
    cwd: WORKSPACE,
    caller: { kind: "subagent" as const, subagentId: "sub_abc123", task: "inspect logs" },
    workspaceWriteAllowed: false,
  };
  const escalation = evaluateSensitiveOperation("edit", { path: "src/app.ts" }, builtinWrite, subNoWriteCtx);
  assert.equal(escalation.sensitive, true);
  assert.equal(escalation.rule, "subagent_write_escalation");
});

test("ApprovalService supports approve_once, approve_similar caching, deny with reason, timeout, abort, and restart fail-safe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-approvals-test-"));
  const dbPath = join(dir, "approvals.sqlite");
  try {
    const waitTransitions: boolean[] = [];
    const service = new ApprovalService({
      dbPath,
      defaultTimeoutMs: 5_000,
      onWaitActiveChange: (waiting) => waitTransitions.push(waiting),
      log: () => {},
    });

    const evalBash = {
      sensitive: true as const,
      rule: "destructive_shell" as const,
      reason: "命中危险 Shell 规则：递归强制删除 (rm -rf)",
      categoryKey: "bash:destructive_shell",
      summary: "bash: rm -rf tmp",
    };

    // 1. approve_once
    const p1 = service.requestApproval({
      runScopeId: "conv-1",
      caller: { kind: "main", conversationId: "conv-1" },
      toolName: "bash",
      args: { command: "rm -rf tmp" },
      evaluation: evalBash,
    });
    assert.equal(service.pendingCount, 1);
    const [pending1] = service.listPending();
    assert.ok(pending1);
    const r1 = service.resolve(pending1.id, { decision: "approve_once" });
    assert.equal(r1.ok, true);
    const o1 = await p1;
    assert.equal(o1.allowed, true);
    assert.deepEqual(waitTransitions, [true, false]);

    // 2. approve_similar caches for runScopeId
    const p2 = service.requestApproval({
      runScopeId: "conv-1",
      caller: { kind: "main", conversationId: "conv-1" },
      toolName: "bash",
      args: { command: "rm -rf tmp2" },
      evaluation: evalBash,
    });
    const [pending2] = service.listPending();
    assert.ok(pending2);
    service.resolve(pending2.id, { decision: "approve_similar" });
    assert.equal((await p2).allowed, true);

    // Cached second call resolves immediately without adding pending
    const o2Cached = await service.requestApproval({
      runScopeId: "conv-1",
      caller: { kind: "main", conversationId: "conv-1" },
      toolName: "bash",
      args: { command: "rm -rf tmp3" },
      evaluation: evalBash,
    });
    assert.equal(o2Cached.allowed, true);
    assert.equal(o2Cached.cached, true);
    assert.equal(service.pendingCount, 0);

    // Clearing run scope resets allowlist
    service.clearRunScope("conv-1");

    // 3. deny with reason
    const p3 = service.requestApproval({
      runScopeId: "conv-1",
      caller: { kind: "main", conversationId: "conv-1" },
      toolName: "bash",
      args: { command: "rm -rf /" },
      evaluation: evalBash,
    });
    const [pending3] = service.listPending();
    assert.ok(pending3);
    service.resolve(pending3.id, { decision: "deny", reason: "太危险了，改用局部清理" });
    const o3 = await p3;
    assert.equal(o3.allowed, false);
    assert.match(o3.reason, /太危险了/);

    // 4. AbortSignal cancels immediately
    const ac = new AbortController();
    const p4 = service.requestApproval({
      runScopeId: "conv-1",
      caller: { kind: "main", conversationId: "conv-1" },
      toolName: "bash",
      args: { command: "rm -rf x" },
      evaluation: evalBash,
    }, ac.signal);
    const [pending4] = service.listPending();
    assert.ok(pending4);
    ac.abort(new Error("user stopped"));
    await assert.rejects(p4, /user stopped/);
    assert.equal(service.get(pending4.id)?.status, "aborted");

    // 5. Timeout auto-denies
    const shortService = new ApprovalService({ dbPath: ":memory:", defaultTimeoutMs: 40, log: () => {} });
    const timedOut = await shortService.requestApproval({
      runScopeId: "conv-2",
      caller: { kind: "main", conversationId: "conv-2" },
      toolName: "bash",
      args: { command: "rm -rf slow" },
      evaluation: evalBash,
    });
    assert.equal(timedOut.allowed, false);
    assert.match(timedOut.reason, /超时/);
    shortService.close();

    // 6. Restart marks unresolved pending rows as interrupted
    const p5 = service.requestApproval({
      runScopeId: "conv-1",
      caller: { kind: "main", conversationId: "conv-1" },
      toolName: "bash",
      args: { command: "rm -rf crash" },
      evaluation: evalBash,
    });
    const [pending5] = service.listPending();
    assert.ok(pending5);
    service.close();
    await assert.rejects(p5);

    const reopened = new ApprovalService({ dbPath, log: () => {} });
    assert.equal(reopened.listPending().length, 0);
    assert.equal(reopened.get(pending5.id)?.status, "interrupted");
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ToolRegistry blocks execution when approval hook denies and executes when approved", async () => {
  let executed = 0;
  const dangerous = defineTool({
    name: "danger_write",
    description: "dangerous write",
    parameters: Type.Object({}),
    execute: async () => {
      executed++;
      return { output: [{ type: "text", text: "done" }] };
    },
  });

  let allow = false;
  const registry = createToolRegistry([defineExtension({ name: "custom", tools: [dangerous] })], {
    log: () => {},
    approvals: async () => (allow ? { allowed: true } : { allowed: false, reason: "Owner denied" }),
  });

  const registered = registry.snapshot().tools().find(({ tool }) => tool.name === "danger_write")!.tool;
  const fakeApi = {
    conversationId: 1 as never,
    taskId: 1 as never,
    callId: "call_1",
    executeTool: async () => ({ output: [] }),
  } as unknown as ToolExecutionApi;

  const denied = await registered.execute({}, fakeApi, withAbortSignal(new AbortController().signal, BACKGROUND_CONTEXT));
  assert.equal(denied.isError, true);
  assert.equal((denied.details as { code?: string })?.code, "TOOL_APPROVAL_DENIED");
  assert.equal(executed, 0);

  allow = true;
  const ok = await registered.execute({}, fakeApi, BACKGROUND_CONTEXT);
  assert.equal(ok.isError, undefined);
  assert.equal(executed, 1);
});

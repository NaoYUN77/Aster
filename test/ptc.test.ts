import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  describeRpcAgentConfig,
  readPtcSandboxConfig,
  readRpcAgentConfig,
} from "../src/execution/rpc-config.js";
import {
  PTC_OUTPUT_DIRECTORY,
  PTC_WORKSPACE,
  callIdsInMessages,
  parseOutputRef,
  parsePtcBashResult,
  parsePtcToolCallPayload,
  parsePtcVmMessagePayload,
  parsePtcVmReplyPayload,
  parsePtcVmStartPayload,
} from "../src/execution/ptc-protocol.js";
import { MergedTailWindow } from "../src/execution/ptc-output-window.js";
import { OutputSink } from "../src/execution/ptc-output-store.js";
import { PTC_RUNNER_PROTOCOL_VERSION, RunnerFrameDecoder, encodeRunnerFrame } from "../src/execution/ptc-runner-protocol.js";
import { PtcSandboxManager } from "../src/execution/ptc-sandbox.js";
import {
  PTC_JOB_ID_PATTERN,
  WorkspaceMissingError,
  prepareJobWorkspace,
} from "../src/execution/ptc-workspace.js";
import { parseRpcFrame } from "../src/execution/rpc-protocol.js";
import { ptcCwd, ptcOutputWindow } from "../src/ptc/control.js";
import { derivePtcJobId } from "../src/ptc/identity.js";

const JOB = "ptc-0123456789abcdef0123456789abcdef";

function validToolCall(callId = 1): Record<string, unknown> {
  return {
    tool: "bash",
    callId,
    args: {
      command: "printf hello",
      cwd: "/workspace",
      env: { FOO: "bar" },
      inheritEnv: false,
      timeoutMs: 5_000,
      window: { maxBytes: 65_536, maxLines: 2_000, minIntervalMs: 25, bytesPerSecond: 1_048_576 },
    },
  };
}

function validOutputRef(): Record<string, unknown> {
  return {
    blobId: "a".repeat(64),
    jobId: JOB,
    sessionId: "0123456789abcdef",
    callId: 1,
    path: `${PTC_OUTPUT_DIRECTORY}/${"a".repeat(64)}`,
    size: 10,
    sha256: "a".repeat(64),
    createdAt: 1_000,
    expiresAt: 2_000,
    state: "available",
  };
}

test("a bash tool call is validated strictly and normalized", () => {
  const parsed = parsePtcToolCallPayload(validToolCall());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.args.cwd, "/workspace");

  const normalized = parsePtcToolCallPayload({
    ...validToolCall(),
    args: { ...validToolCall().args as object, cwd: "/workspace/sub/../work" },
  });
  assert.equal(normalized.ok, true);
  if (normalized.ok) assert.equal(normalized.value.args.cwd, "/workspace/work");

  for (const payload of [
    { ...validToolCall(), extra: true },
    { ...validToolCall(), tool: "read" },
    { ...validToolCall(), callId: 0 },
    { ...validToolCall(), args: { ...validToolCall().args as object, cwd: "/etc" } },
    { ...validToolCall(), args: { ...validToolCall().args as object, cwd: "/workspace/../etc" } },
    { ...validToolCall(), args: { ...validToolCall().args as object, env: { PATH: "/tmp" } } },
    { ...validToolCall(), args: { ...validToolCall().args as object, env: { FOO: 1 } } },
    { ...validToolCall(), args: { ...validToolCall().args as object, config: "x" } },
    { ...validToolCall(), args: { ...validToolCall().args as object, timeoutMs: 0 } },
    { ...validToolCall(), args: { ...validToolCall().args as object, window: { maxBytes: 1 } } },
    { ...validToolCall(), args: { ...validToolCall().args as object, command: "" } },
  ]) {
    assert.equal(parsePtcToolCallPayload(payload).ok, false, JSON.stringify(payload));
  }
});

test("PTC VM payloads accept the bridge shapes and reject unknown fields", () => {
  assert.equal(parsePtcVmStartPayload({ request: { data: { code: "1" }, interruptBudget: 10 } }).ok, true);
  assert.equal(parsePtcVmStartPayload({ request: { data: {} }, extra: 1 }).ok, false);
  assert.equal(parsePtcVmStartPayload({ request: { data: {}, interruptBudget: 0 } }).ok, false);

  const messages = [{ type: "call", id: 3 }, { type: "output", text: "x" }];
  const parsed = parsePtcVmMessagePayload({ messages });
  assert.equal(parsed.ok, true);
  assert.deepEqual(callIdsInMessages(parsed.ok ? parsed.value.messages : []), [3]);
  assert.equal(parsePtcVmMessagePayload({ messages: [] }).ok, false);
  assert.equal(parsePtcVmMessagePayload({ messages: [{ text: "missing type" }] }).ok, false);

  assert.equal(parsePtcVmReplyPayload({ reply: null }).ok, true);
  assert.equal(parsePtcVmReplyPayload({ reply: { type: "stop" } }).ok, true);
  assert.equal(parsePtcVmReplyPayload({ reply: {} }).ok, false);
});

test("an output reference must stay inside the spill directory", () => {
  assert.equal(parseOutputRef(validOutputRef()).ok, true);
  assert.equal(parseOutputRef({ ...validOutputRef(), path: "/etc/passwd" }).ok, false);
  assert.equal(parseOutputRef({ ...validOutputRef(), sha256: "A".repeat(64) }).ok, false);
  assert.equal(parseOutputRef({ ...validOutputRef(), jobId: "job-1" }).ok, false);
  assert.equal(parseOutputRef({ ...validOutputRef(), state: "lost" }).ok, false);
  assert.equal(parseOutputRef({ ...validOutputRef(), extra: true }).ok, false);

  const result = parsePtcBashResult({
    exitCode: 1,
    truncated: true,
    skippedBytes: 4,
    skippedLines: 1,
    durationMs: 12,
    outputRef: validOutputRef(),
    spillTruncated: true,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.outputRef?.path, `${PTC_OUTPUT_DIRECTORY}/${"a".repeat(64)}`);
    assert.equal(result.value.spillTruncated, true);
  }
});

test("the RPC boundary rejects a malformed tool.call before it reaches the agent", () => {
  const frame = {
    v: 1,
    kind: "request",
    id: "call-1",
    method: "tool.call",
    sessionId: "sess-1",
    deadlineMs: 5_000,
    payload: validToolCall(),
  };
  assert.equal(parseRpcFrame(frame).ok, true);
  assert.equal(parseRpcFrame({ ...frame, payload: { ...validToolCall(), callId: 0 } }).ok, false);
  assert.equal(parseRpcFrame({ ...frame, payload: { ...validToolCall(), tool: "sh" } }).ok, false);
});

test("session.open distinguishes a PTC sandbox from a plain job id", () => {
  const open = (payload: Record<string, unknown>) =>
    parseRpcFrame({
      v: 1,
      kind: "request",
      id: "open-1",
      method: "session.open",
      deadlineMs: 5_000,
      payload,
    }).ok;
  assert.equal(open({ sessionId: "sess-1", jobId: JOB }), true);
  assert.equal(open({ sessionId: "sess-1", jobId: JOB, sandbox: true }), true);
  assert.equal(open({ sessionId: "sess-1", jobId: JOB, sandbox: true, workspaceReady: true }), true);
  assert.equal(open({ sessionId: "sess-1", sandbox: true }), false);
  assert.equal(open({ sessionId: "sess-1", jobId: JOB, workspaceReady: true }), false);
  assert.equal(open({ sessionId: "sess-1", jobId: JOB, sandbox: "yes" }), false);
});

test("the merged output tail keeps the end, counts what it dropped, and never splits UTF-8", () => {
  const window = new MergedTailWindow(8, 100);
  window.push("stdout", "abc");
  window.push("stdout", "def");
  window.push("stderr", "ghi");
  const take = window.take();
  assert.ok(take !== undefined);
  assert.equal(take.text, "defghi");
  assert.deepEqual(take.skipped, { bytes: 3, newlines: 0, endsWithNewline: false });
  assert.equal(take.stream, "stderr");
  assert.equal(window.take(), undefined, "take drains the window");

  const lines = new MergedTailWindow(100, 2);
  lines.push("stdout", "a\nb\nc\n");
  const lineTake = lines.take();
  assert.ok(lineTake !== undefined);
  assert.equal(lineTake.text, "b\nc\n");
  assert.deepEqual(lineTake.skipped, { bytes: 2, newlines: 1, endsWithNewline: true });

  const partial = new MergedTailWindow(2, 100);
  partial.push("stdout", "éa");
  const utf8 = partial.take();
  assert.ok(utf8 !== undefined);
  assert.equal(utf8.text, "a");
  assert.equal(utf8.text.includes("�"), false);
  assert.deepEqual(utf8.skipped, { bytes: 2, newlines: 0, endsWithNewline: false });
});

test("the output sink is content-addressed, bounded, and deduplicates equal blobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-ptc-output-"));
  try {
    const first = new OutputSink(directory, 4);
    first.write(Buffer.from("hello"));
    const stored = first.finish();
    assert.equal(stored.size, 4);
    assert.equal(stored.truncated, true);
    assert.match(stored.sha256, /^[a-f0-9]{64}$/);
    assert.equal((await readFile(stored.path, "utf8")), "hell");

    const second = new OutputSink(directory, 16);
    second.write(Buffer.from("hell"));
    const same = second.finish();
    assert.equal(same.path, stored.path);
    assert.equal(same.sha256, stored.sha256);

    const aborted = new OutputSink(directory, 16);
    aborted.write(Buffer.from("gone"));
    aborted.abort();
    const names = await readdir(directory);
    assert.equal(names.filter((name) => name.startsWith(".tmp-")).length, 0);
    assert.ok((await stat(stored.path)).isFile());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the runner frame protocol round-trips and rejects unknown kinds", () => {
  const frame = {
    v: PTC_RUNNER_PROTOCOL_VERSION,
    kind: "tool-result",
    callId: 1,
    result: { exitCode: 0, truncated: false, skippedBytes: 0, skippedLines: 0, durationMs: 1 },
  } as const;
  const decoder = new RunnerFrameDecoder();
  const bytes = encodeRunnerFrame(frame);
  const split = decoder.push(bytes.subarray(0, 3));
  assert.deepEqual(split, []);
  assert.deepEqual(decoder.push(bytes.subarray(3)), [frame]);

  const encoded = Buffer.from(JSON.stringify({ v: 1, kind: "mystery" }));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(encoded.length, 0);
  assert.throws(() => new RunnerFrameDecoder().push(Buffer.concat([header, encoded])));
});

test("PTC config is opt-in, validated, and described without unwrapping the sandbox", () => {
  assert.equal(readPtcSandboxConfig({}), undefined);
  const config = readPtcSandboxConfig({
    EXECUTION_AGENT_PTC: "1",
    PTC_APP_ROOT: "/opt/aster",
    PTC_WORKSPACE_ROOT: "/home/aster/jobs",
    PTC_MEMORY_MAX_BYTES: String(256 * 1024 * 1024),
    PTC_CPU_MAX: "50000 100000",
  });
  assert.ok(config !== undefined);
  assert.equal(config.runnerEntry, join("/opt/aster", "dist/src/execution/ptc-runner.js"));
  assert.equal(config.allowDegraded, false);

  assert.throws(() => readPtcSandboxConfig({ EXECUTION_AGENT_PTC: "1", PTC_CPU_MAX: "50000" }), /PTC_CPU_MAX/);
  assert.throws(() => readPtcSandboxConfig({ EXECUTION_AGENT_PTC: "1", PTC_CPU_MAX: "100000 1" }), /PTC_CPU_MAX/);
  assert.throws(
    () => readPtcSandboxConfig({
      EXECUTION_AGENT_PTC: "1",
      PTC_MEMORY_MAX_BYTES: String(1024 * 1024 * 1024),
      PTC_MAX_MEMORY_LIMIT_BYTES: String(512 * 1024 * 1024),
    }),
    /PTC_MAX_MEMORY_LIMIT_BYTES/,
  );
  assert.throws(
    () => readPtcSandboxConfig({ EXECUTION_AGENT_PTC: "1", PTC_PI_CODEMODE_VERSION: "1.3.0; rm" }),
    /PTC_PI_CODEMODE_VERSION/,
  );

  const agent = readRpcAgentConfig({
    EXECUTION_AGENT_UNIX_SOCKET: "/run/aster/rpc.sock",
    EXECUTION_AGENT_TEST_EXECUTOR: "0",
    EXECUTION_AGENT_PTC: "1",
    PTC_APP_ROOT: "/opt/aster",
  });
  assert.equal(agent.testExecutorEnabled, false);
  assert.equal(agent.ptc?.appRoot, "/opt/aster");
  const summary = describeRpcAgentConfig(agent);
  assert.equal((summary.ptc as Record<string, unknown>).enabled, true);
  assert.equal((summary.ptc as Record<string, unknown>).allowDegraded, false);

  const plain = describeRpcAgentConfig(readRpcAgentConfig({ EXECUTION_AGENT_UNIX_SOCKET: "/run/aster/rpc.sock" }));
  assert.equal(plain.ptc, null);
});

test("sandbox preflight fails closed when the isolation tooling is absent", async () => {
  const config = readPtcSandboxConfig({ EXECUTION_AGENT_PTC: "1", PTC_APP_ROOT: process.cwd() });
  assert.ok(config !== undefined);
  const manager = new PtcSandboxManager({
    ...config,
    bwrapPath: join(tmpdir(), "definitely-missing-bwrap"),
    prlimitPath: join(tmpdir(), "definitely-missing-prlimit"),
    runnerEntry: join(tmpdir(), "definitely-missing-runner.js"),
    workspaceRoot: join(tmpdir(), "aster-ptc-preflight"),
    cgroupRoot: join(tmpdir(), "aster-ptc-cgroup"),
  });
  const preflight = await manager.preflight();
  assert.equal(preflight.ok, false);
  assert.equal(preflight.checks.bwrap, false);
  assert.equal(preflight.checks.prlimit, false);
  assert.equal(preflight.checks.runner, false);
  assert.ok(preflight.diagnostics.some((line) => line.includes("PTC runner entry is missing")));
});

test("PTC workspace preparation reuses a ready job and refuses to recreate a missing one", {
  skip: process.platform === "win32" ? "The workspace layout is POSIX-only" : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-ptc-workspace-"));
  try {
    const first = await prepareJobWorkspace(root, JOB, false);
    assert.equal(first.created, true);
    assert.equal(first.reused, false);
    assert.equal(first.sandboxPath, PTC_WORKSPACE);
    assert.ok(PTC_JOB_ID_PATTERN.test(JOB));

    const again = await prepareJobWorkspace(root, JOB, true);
    assert.equal(again.created, false);
    assert.equal(again.reused, true);

    await rm(join(root, JOB), { recursive: true, force: true });
    await assert.rejects(
      prepareJobWorkspace(root, JOB, true),
      (error: unknown) => error instanceof WorkspaceMissingError,
    );
    const recreated = await prepareJobWorkspace(root, JOB, false);
    assert.equal(recreated.created, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the control plane clamps the output window and keeps cwd inside /workspace", () => {
  const window = ptcOutputWindow(undefined, 1_024, 10);
  assert.equal(window.maxBytes, 1_024);
  assert.equal(window.maxLines, 10);

  const requested = ptcOutputWindow(
    { maxBytes: 10_000_000, maxLines: 5_000_000, minIntervalMs: 5, bytesPerSecond: 10 },
    4_096,
    100,
  );
  assert.equal(requested.maxBytes, 4_096);
  assert.equal(requested.maxLines, 100);
  assert.equal(requested.minIntervalMs, 5);
  assert.equal(requested.bytesPerSecond, 10);

  const relative = ptcCwd("sub/dir", PTC_WORKSPACE);
  assert.equal(relative.ok, true);
  if (relative.ok) assert.equal(relative.value, "/workspace/sub/dir");
  assert.equal(ptcCwd("../../etc", PTC_WORKSPACE).ok, false);
  assert.equal(ptcCwd("/etc", PTC_WORKSPACE).ok, false);

  const jobId = derivePtcJobId(1, 2);
  assert.match(jobId, PTC_JOB_ID_PATTERN);
  assert.equal(derivePtcJobId(1, 2), jobId, "the job id is stable across retries");
  assert.notEqual(derivePtcJobId(1, 3), jobId);
});

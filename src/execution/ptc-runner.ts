/**
 * PTC runner: the only program that runs the QuickJS VM and the nested bash commands inside the
 * bwrap sandbox. It speaks the private stdio protocol in `ptc-runner-protocol.ts`; stdout carries
 * frames only, stderr is for diagnostics.
 *
 * The runner never sees a host path, a gateway credential, or the control plane's journal. Its
 * writable world is `/workspace`, which is the persistent job workspace mounted by the agent.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  DEFAULT_INTERRUPT_BUDGET,
  loadQuickJSWasm,
  serveCodemodeRemote,
  type CodemodeRemoteMessage,
  type CodemodeRemoteReply,
  type CodemodeRemoteRequest,
} from "@earendil-works/pi-codemode";
import {
  parsePtcToolCallPayload,
  type OutputRef,
  type PtcBashArgs,
  type PtcBashResult,
} from "./ptc-protocol.js";
import { MergedTailWindow } from "./ptc-output-window.js";
import { OutputSink } from "./ptc-output-store.js";
import {
  PTC_RUNNER_MAX_FRAME_BYTES,
  PTC_RUNNER_PROTOCOL_VERSION,
  RunnerFrameDecoder,
  encodeRunnerFrame,
  type RunnerFrame,
} from "./ptc-runner-protocol.js";

const OUTPUT_FLUSH_INTERVAL_MAX_MS = 1_000;
const OUTPUT_QUEUE_MAX_BYTES = 64 * 1024 * 1024;
const KILL_WAIT_MS = 2_000;

function envInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

function requirePattern(name: string, pattern: RegExp): string {
  const value = process.env[name];
  if (value === undefined || !pattern.test(value)) throw new Error(`${name} is missing or invalid`);
  return value;
}

const jobId = requirePattern("PTC_JOB_ID", /^ptc-[a-f0-9]{32}$/);
const sessionId = requirePattern("PTC_SESSION_ID", /^[a-f0-9]{16}$/);
const workspace = process.env.PTC_RUNNER_WORKSPACE ?? "/workspace";
const outputDirectory = `${workspace}/.ptc/outputs`;
const outputRefEnabled = process.env.PTC_OUTPUT_REF !== "disabled";
const spillMaxBytes = envInteger("PTC_OUTPUT_MAX_BYTES", 64 * 1024 * 1024, 1, 1024 * 1024 * 1024);
const retentionMs = envInteger("PTC_OUTPUT_RETENTION_MS", 24 * 60 * 60 * 1000, 60_000, 365 * 24 * 60 * 60 * 1000);
const maxInterruptBudget = envInteger("PTC_MAX_INTERRUPT_BUDGET", DEFAULT_INTERRUPT_BUDGET, 1, 1_000_000_000_000);
const maxMemoryLimitBytes = envInteger("PTC_MAX_MEMORY_LIMIT_BYTES", 128 * 1024 * 1024, 1024 * 1024, 32 * 1024 * 1024 * 1024);

const outQueue: Buffer[] = [];
let outQueuedBytes = 0;
let outWriting = false;

function pumpOutput(): void {
  if (outWriting) return;
  const chunk = outQueue.shift();
  if (chunk === undefined) return;
  outQueuedBytes -= chunk.length;
  outWriting = true;
  if (process.stdout.write(chunk)) {
    outWriting = false;
    setImmediate(pumpOutput);
    return;
  }
  process.stdout.once("drain", () => {
    outWriting = false;
    pumpOutput();
  });
}

function send(frame: RunnerFrame): void {
  const encoded = encodeRunnerFrame(frame, PTC_RUNNER_MAX_FRAME_BYTES);
  if (outQueuedBytes + encoded.length > OUTPUT_QUEUE_MAX_BYTES) {
    process.stderr.write("PTC runner output queue exceeded its bound; terminating\n");
    shutdown(1);
    return;
  }
  outQueue.push(encoded);
  outQueuedBytes += encoded.length;
  pumpOutput();
}

function diagnostic(message: string): void {
  process.stderr.write(`[ptc-runner] ${message}\n`);
}

type ActiveTool = {
  readonly callId: number;
  readonly child: ChildProcess;
  readonly sink: OutputSink;
  readonly timer: NodeJS.Timeout;
  readonly flushTimer: NodeJS.Timeout;
  settled: boolean;
};

const activeTools = new Map<number, ActiveTool>();

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function settleTool(tool: ActiveTool): void {
  if (tool.settled) return;
  tool.settled = true;
  clearTimeout(tool.timer);
  clearInterval(tool.flushTimer);
  activeTools.delete(tool.callId);
}

function toolError(callId: number, code: "timeout" | "spawn_error" | "aborted" | "output_too_large" | "failed", message: string): void {
  send({ v: PTC_RUNNER_PROTOCOL_VERSION, kind: "tool-error", callId, code, message });
}

function runBash(callId: number, rawArgs: unknown): void {
  const parsed = parsePtcToolCallPayload({ tool: "bash", callId, args: rawArgs });
  if (!parsed.ok) {
    toolError(callId, "failed", `invalid bash arguments: ${parsed.message}`);
    return;
  }
  const args: PtcBashArgs = parsed.value.args;
  if (activeTools.has(callId)) {
    toolError(callId, "failed", "a tool call with this id is already running");
    return;
  }

  let sink: OutputSink;
  try {
    sink = new OutputSink(outputDirectory, spillMaxBytes);
  } catch (error) {
    toolError(callId, "spawn_error", `cannot create the output blob: ${(error as Error).message}`);
    return;
  }

  const window = new MergedTailWindow(args.window.maxBytes, args.window.maxLines);
  const minIntervalMs = args.window.minIntervalMs;
  const bytesPerSecond = args.window.bytesPerSecond;
  const startedAt = Date.now();
  let lastEmitAt = 0;
  let nextEmitAt = 0;
  let skippedBytes = 0;
  let skippedLines = 0;
  let sawTruncation = false;

  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");

  const env: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: workspace,
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    PTC_JOB_ID: jobId,
    PTC_SESSION_ID: sessionId,
    ...args.env,
  };

  const command = args.command;
  const program = typeof command === "string" ? "/bin/bash" : command[0]!;
  const argv = typeof command === "string" ? ["-c", command] : command.slice(1);
  let child: ChildProcess;
  try {
    child = spawn(program, argv, {
      cwd: args.cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    sink.abort();
    toolError(callId, "spawn_error", `cannot start the command: ${(error as Error).message}`);
    return;
  }

  const flush = (): void => {
    const take = window.take();
    if (take === undefined) return;
    if (take.skipped !== undefined) {
      sawTruncation = true;
      skippedBytes += take.skipped.bytes;
      skippedLines += take.skipped.newlines;
    }
    const now = Date.now();
    lastEmitAt = now;
    nextEmitAt = now + Math.max(minIntervalMs, (Buffer.byteLength(take.text, "utf8") / bytesPerSecond) * 1000);
    send({
      v: PTC_RUNNER_PROTOCOL_VERSION,
      kind: "tool-output",
      callId,
      stream: take.stream,
      text: take.text,
      ...(take.skipped === undefined ? {} : { skipped: take.skipped }),
    });
  };

  const maybeFlush = (): void => {
    if (Date.now() < nextEmitAt) return;
    flush();
  };

  const onData = (stream: "stdout" | "stderr", decoder: StringDecoder, chunk: Buffer): void => {
    const tool = activeTools.get(callId);
    if (tool === undefined || tool.settled) return;
    try {
      sink.write(chunk);
    } catch (error) {
      killGroup(child);
      settleTool(tool);
      sink.abort();
      toolError(callId, "output_too_large", `cannot persist the output: ${(error as Error).message}`);
      return;
    }
    window.push(stream, decoder.write(chunk));
    maybeFlush();
  };

  child.stdout?.on("data", (chunk: Buffer) => onData("stdout", stdoutDecoder, chunk));
  child.stderr?.on("data", (chunk: Buffer) => onData("stderr", stderrDecoder, chunk));

  child.on("error", (error) => {
    const tool = activeTools.get(callId);
    if (tool === undefined) return;
    settleTool(tool);
    sink.abort();
    toolError(callId, "spawn_error", `command failed to start: ${error.message}`);
  });

  const finish = (exitCode: number): void => {
    const tool = activeTools.get(callId);
    if (tool === undefined) return;
    window.push("stdout", stdoutDecoder.end());
    window.push("stderr", stderrDecoder.end());
    flush();
    let stored;
    try {
      stored = sink.finish();
    } catch (error) {
      settleTool(tool);
      toolError(callId, "failed", `cannot persist the output: ${(error as Error).message}`);
      return;
    }
    settleTool(tool);
    const createdAt = Date.now();
    const outputRef: OutputRef | undefined = outputRefEnabled
      ? {
          blobId: stored.sha256,
          jobId,
          sessionId,
          callId,
          path: stored.path,
          size: stored.size,
          sha256: stored.sha256,
          createdAt,
          expiresAt: createdAt + retentionMs,
          state: "available",
        }
      : undefined;
    const truncated = sawTruncation || window.truncated;
    const result: PtcBashResult = {
      exitCode,
      truncated,
      skippedBytes,
      skippedLines,
      durationMs: Date.now() - startedAt,
      ...(outputRef === undefined ? {} : { outputRef }),
      ...(stored.truncated ? { spillTruncated: true } : {}),
    };
    send({ v: PTC_RUNNER_PROTOCOL_VERSION, kind: "tool-result", callId, result });
  };

  child.on("close", (code, signal) => {
    if (signal !== null) diagnostic(`command ${callId} exited from signal ${signal}`);
    finish(code ?? 1);
  });

  const timer = setTimeout(() => {
    const tool = activeTools.get(callId);
    if (tool === undefined) return;
    killGroup(child);
    settleTool(tool);
    sink.abort();
    toolError(callId, "timeout", "command deadline exceeded; its outcome is unknown");
  }, args.timeoutMs);
  timer.unref();

  const flushTimer = setInterval(() => {
    const tool = activeTools.get(callId);
    if (tool === undefined || tool.settled) return;
    if (Date.now() >= nextEmitAt) flush();
  }, Math.min(OUTPUT_FLUSH_INTERVAL_MAX_MS, Math.max(10, minIntervalMs)));
  flushTimer.unref();

  activeTools.set(callId, {
    callId,
    child,
    sink,
    timer,
    flushTimer,
    settled: false,
  });
}

function cancelTool(callId: number): void {
  const tool = activeTools.get(callId);
  if (tool === undefined) return;
  killGroup(tool.child);
  settleTool(tool);
  tool.sink.abort();
  toolError(callId, "aborted", "command was cancelled");
}

let vmStarted = false;
let sequence = 0;
const pendingReplies = new Map<number, (reply: CodemodeRemoteReply) => void>();

const exchange = (messages: CodemodeRemoteMessage[]): Promise<CodemodeRemoteReply> => {
  if (messages.length === 0) return Promise.resolve(null);
  const seq = ++sequence;
  return new Promise<CodemodeRemoteReply>((resolve) => {
    pendingReplies.set(seq, resolve);
    send({ v: PTC_RUNNER_PROTOCOL_VERSION, kind: "message", seq, messages });
  });
};

function startVm(request: CodemodeRemoteRequest): void {
  if (vmStarted) {
    diagnostic("ignoring a second vm.start");
    return;
  }
  vmStarted = true;
  void loadQuickJSWasm()
    .then((wasm) => serveCodemodeRemote(request, exchange, {
      wasm,
      maxInterruptBudget,
      maxMemoryLimitBytes,
    }))
    .then(() => {
      send({ v: PTC_RUNNER_PROTOCOL_VERSION, kind: "done" });
    })
    .catch((error: unknown) => {
      diagnostic(`the VM bridge failed: ${(error as Error).message}`);
      send({
        v: PTC_RUNNER_PROTOCOL_VERSION,
        kind: "message",
        seq: ++sequence,
        messages: [{
          type: "failure",
          error: { kind: "sandbox", message: `the VM bridge failed: ${(error as Error).message}` },
        }],
      });
      send({ v: PTC_RUNNER_PROTOCOL_VERSION, kind: "done" });
    });
}

let shuttingDown = false;

function shutdown(exitCode = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const tool of [...activeTools.values()]) {
    killGroup(tool.child);
    settleTool(tool);
    tool.sink.abort();
  }
  for (const resolve of pendingReplies.values()) resolve({ type: "stop" });
  pendingReplies.clear();
  setTimeout(() => process.exit(exitCode), KILL_WAIT_MS).unref();
  setImmediate(() => process.exit(exitCode));
}

process.stdout.on("error", () => process.exit(1));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("exit", () => {
  for (const tool of activeTools.values()) {
    killGroup(tool.child);
    tool.sink.abort();
  }
});

process.stdin.on("end", () => shutdown(0));
process.stdin.on("close", () => shutdown(0));

const decoder = new RunnerFrameDecoder(PTC_RUNNER_MAX_FRAME_BYTES);
process.stdin.on("data", (chunk: Buffer) => {
  if (shuttingDown) return;
  let frames: RunnerFrame[];
  try {
    frames = decoder.push(chunk);
  } catch (error) {
    diagnostic(`invalid runner frame: ${(error as Error).message}`);
    shutdown(1);
    return;
  }
  for (const frame of frames) {
    switch (frame.kind) {
      case "start":
        startVm(frame.request);
        break;
      case "reply": {
        const resolve = pendingReplies.get(frame.seq);
        if (resolve === undefined) {
          diagnostic(`reply for unknown sequence ${frame.seq}`);
          shutdown(1);
          return;
        }
        pendingReplies.delete(frame.seq);
        resolve(frame.reply);
        break;
      }
      case "tool":
        runBash(frame.callId, frame.args);
        break;
      case "tool-cancel":
        cancelTool(frame.callId);
        break;
      case "shutdown":
        shutdown(0);
        return;
      default:
        diagnostic(`unexpected runner frame ${frame.kind}`);
        shutdown(1);
        return;
    }
  }
});

send({
  v: PTC_RUNNER_PROTOCOL_VERSION,
  kind: "ready",
  pid: process.pid,
  node: process.version,
  piCodemode: process.env.PTC_PI_CODEMODE_VERSION ?? "unknown",
  quickjs: process.env.PTC_QUICKJS_VERSION ?? "unknown",
});

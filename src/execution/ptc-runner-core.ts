import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { loadQuickJSWasm, serveCodemodeRemote, type CodemodeRemoteExchange, type CodemodeRemoteReply, type CodemodeRemoteRequest, type CodemodeWasmModule } from "@earendil-works/pi-codemode";
import { OutputWindow } from "./broker.js";
import { PtcHostError } from "./ptc-host.js";
import { PTC_OUTPUT_DIRECTORY } from "./ptc-workspace.js";
import type { HostToRunner, PtcRunnerStart, PtcRunnerToolCall, RunnerToHost } from "./ptc-runner-protocol.js";
import { RPC_MAX_OUTPUT_CHUNK_BYTES, type PtcOutputRef, type PtcToolCallArgs, type PtcToolCallResult, type RpcSkippedOutput } from "./rpc-protocol.js";

export type BashOutcome = {
  readonly exitCode: number;
  readonly outputRef?: PtcOutputRef;
  readonly spillTruncated: boolean;
};

export type BashRunEvents = {
  output(text: string, stream: "stdout" | "stderr", skipped?: RpcSkippedOutput): void;
};

export type BashExecutor = (
  args: PtcToolCallArgs,
  callId: number,
  identity: { jobId: string; sessionId: string },
  events: BashRunEvents,
  signal: AbortSignal,
) => Promise<BashOutcome>;

export type BashOptions = {
  /** Host path of the workspace; `/workspace` inside bwrap, the real path in degraded mode. */
  readonly workspacePath: string;
  /** The path reported in `OutputRef`; always the sandbox path so it survives a mode change. */
  readonly sandboxWorkspace: string;
  readonly shellPath: string;
  readonly outputMaxBytes: number;
  readonly outputMaxLines: number;
  readonly outputBytesPerSecond: number;
  readonly spillMaxBytes: number;
  readonly jobRetentionMs: number;
  readonly now?: () => number;
};

export type PtcRunnerCoreOptions = {
  readonly wasm?: CodemodeWasmModule | Promise<CodemodeWasmModule>;
  readonly maxInterruptBudget?: number;
  readonly maxMemoryLimitBytes?: number;
  readonly bash: BashOptions;
  /** Test seam; production always uses the local bash executor. */
  readonly executeBash?: BashExecutor;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCallMessage(message: unknown): message is { type: "call"; id: number } {
  return isRecord(message) && message.type === "call"
    && Number.isSafeInteger(message.id) && (message.id as number) >= 1;
}

/**
 * Runner side of the PTC bridge. It lives inside the sandbox and owns only what must run there:
 * the QuickJS VM and the bash processes it starts. Tool policy, journaling, credentials and the
 * gateway all stay outside; an exchange resumes only when the gateway answers it.
 */
export class PtcRunnerCore {
  private readonly pending = new Map<number, (reply: CodemodeRemoteReply) => void>();
  private expectedCall: number | undefined;
  private toolController: AbortController | undefined;
  private toolCallId: number | undefined;
  private started = false;
  private stopped = false;
  private identity: { jobId: string; sessionId: string } | undefined;

  constructor(
    private readonly options: PtcRunnerCoreOptions,
    private readonly send: (frame: RunnerToHost) => void,
  ) {}

  async handle(frame: HostToRunner): Promise<void> {
    switch (frame.t) {
      case "start":
        this.start(frame);
        return;
      case "reply": {
        const resolve = this.pending.get(frame.callId);
        if (resolve === undefined) return;
        this.pending.delete(frame.callId);
        this.expectedCall = undefined;
        resolve(frame.reply as CodemodeRemoteReply | null);
        return;
      }
      case "tool.call":
        await this.runToolCall(frame);
        return;
      case "cancel":
        this.cancel();
        return;
    }
  }

  /** Ends every exchange; the agent kills the process when it must stop a computing VM. */
  cancel(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const resolve of this.pending.values()) resolve({ type: "stop" });
    this.pending.clear();
    this.toolController?.abort(new Error("cancelled"));
  }

  private emit(frame: RunnerToHost): void {
    try {
      this.send(frame);
    } catch {
      // A dead transport means nobody can consume this result; the agent observes the exit instead.
    }
  }

  private start(frame: PtcRunnerStart): void {
    if (this.started) {
      this.emit({ t: "error", code: "invalid_request", message: "the runner was already started" });
      return;
    }
    this.started = true;
    this.identity = { jobId: frame.jobId, sessionId: frame.sessionId };
    const exchange: CodemodeRemoteExchange = (messages) => {
      if (this.stopped) return Promise.resolve({ type: "stop" });
      const batch = messages.filter(isRecord);
      const call = batch.find((message) => isCallMessage(message)) as { type: "call"; id: number } | undefined;
      if (call === undefined) {
        this.emit({ t: "vm", messages: batch });
        return Promise.resolve(null);
      }
      if (this.expectedCall !== undefined) {
        this.emit({ t: "error", code: "protocol_error", message: "the VM issued two calls at once" });
        return Promise.resolve({ type: "stop" });
      }
      this.expectedCall = call.id;
      return new Promise<CodemodeRemoteReply>((resolve) => {
        this.pending.set(call.id, resolve);
        this.emit({ t: "vm", callId: call.id, messages: batch });
      });
    };
    void serveCodemodeRemote(frame.request as unknown as CodemodeRemoteRequest, exchange, {
      wasm: this.options.wasm ?? loadQuickJSWasm(),
      ...(this.options.maxInterruptBudget === undefined ? {} : { maxInterruptBudget: this.options.maxInterruptBudget }),
      ...(this.options.maxMemoryLimitBytes === undefined ? {} : { maxMemoryLimitBytes: this.options.maxMemoryLimitBytes }),
    }).then(
      () => this.emit({ t: "done" }),
      (error: unknown) => this.emit({
        t: "error",
        code: "internal",
        message: `the runner failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
    );
  }

  private async runToolCall(frame: PtcRunnerToolCall): Promise<void> {
    if (this.stopped) return;
    if (this.toolCallId !== undefined) {
      this.emit({ t: "tool.error", callId: frame.callId, code: "busy", message: "a tool call is already running" });
      return;
    }
    if (this.expectedCall !== frame.callId) {
      this.emit({
        t: "tool.error",
        callId: frame.callId,
        code: "invalid_request",
        message: "tool.call does not answer the VM's pending call",
      });
      return;
    }
    const identity = this.identity;
    if (identity === undefined) {
      this.emit({ t: "tool.error", callId: frame.callId, code: "invalid_request", message: "the runner was not started" });
      return;
    }
    this.toolCallId = frame.callId;
    const controller = new AbortController();
    this.toolController = controller;
    const startedAt = (this.options.bash.now ?? Date.now)();
    let seq = 0;
    const events: BashRunEvents = {
      output: (text, stream, skipped) => {
        this.emit({ t: "tool.output", callId: frame.callId, seq: seq++, stream, text, ...(skipped === undefined ? {} : { skipped }) });
      },
    };
    try {
      const result = this.options.executeBash !== undefined
        ? await this.options.executeBash(frame.args, frame.callId, identity, events, controller.signal)
        : await executeLocalBash(frame.args, frame.callId, identity, events, controller.signal, this.options.bash);
      const durationMs = Math.max(0, (this.options.bash.now ?? Date.now)() - startedAt);
      const payload: PtcToolCallResult = {
        exitCode: result.exitCode,
        spillTruncated: result.spillTruncated,
        durationMs,
        ...(result.outputRef === undefined ? {} : { outputRef: result.outputRef }),
      };
      this.emit({ t: "tool.done", callId: frame.callId, result: payload });
    } catch (error) {
      const failure = error instanceof PtcHostError
        ? { code: error.code, message: error.message }
        : { code: "internal" as const, message: error instanceof Error ? error.message : "bash failed" };
      this.emit({ t: "tool.error", callId: frame.callId, code: failure.code, message: failure.message.slice(0, 2_048) });
    } finally {
      this.toolCallId = undefined;
      if (this.toolController === controller) this.toolController = undefined;
    }
  }
}

function signalNumber(signal: NodeJS.Signals | null): number {
  if (signal === null) return 0;
  const numbers: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
  return numbers[signal] ?? 1;
}

function clampWindow(args: PtcToolCallArgs, options: BashOptions): PtcToolCallArgs["window"] {
  return {
    // One `tool.output` event cannot exceed the RPC event text limit; the tail is what matters.
    maxBytes: Math.max(1, Math.min(args.window.maxBytes, options.outputMaxBytes, RPC_MAX_OUTPUT_CHUNK_BYTES)),
    maxLines: Math.max(1, Math.min(args.window.maxLines, options.outputMaxLines)),
    minIntervalMs: Math.min(Math.max(0, args.window.minIntervalMs), 1_000),
    bytesPerSecond: Math.max(0, Math.min(args.window.bytesPerSecond, Math.max(0, options.outputBytesPerSecond))),
  };
}

/** Splits a window tail into frames the wire format accepts, preserving order. */
function chunkText(text: string, maxBytes: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let bytes = 0;
    while (end < text.length) {
      const code = text.codePointAt(end);
      const width = code === undefined ? 1 : code > 0xffff ? 4 : Buffer.byteLength(String.fromCodePoint(code), "utf8");
      if (bytes + width > maxBytes && end > start) break;
      end += code !== undefined && code > 0xffff ? 2 : 1;
      bytes += width;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

/**
 * Runs one bash command inside the sandbox. Output is merged and windowed on arrival; the stored
 * copy is hashed and spilled content-addressed from the first written byte, so its digest and size
 * describe exactly the bytes that can later be read back.
 */
export async function executeLocalBash(
  args: PtcToolCallArgs,
  callId: number,
  identity: { jobId: string; sessionId: string },
  events: BashRunEvents,
  signal: AbortSignal,
  options: BashOptions,
): Promise<BashOutcome> {
  if (signal.aborted) throw new PtcHostError("aborted", "command was aborted before it started", "not_started");
  const window = clampWindow(args, options);
  const sink = new OutputWindow(window.maxBytes, window.maxLines);
  let timer: NodeJS.Timeout | undefined;
  let nextFlushDelay = 0;
  let ended = false;

  const flush = () => {
    timer = undefined;
    const taken = sink.take();
    if (taken === undefined) return;
    if (taken.text.length > 0) {
      const parts = chunkText(taken.text, RPC_MAX_OUTPUT_CHUNK_BYTES);
      for (const [index, text] of parts.entries()) {
        events.output(text, "stdout", index === 0 ? taken.skipped : undefined);
      }
      const bytes = Buffer.byteLength(taken.text, "utf8");
      nextFlushDelay = window.bytesPerSecond > 0 ? Math.ceil((bytes / window.bytesPerSecond) * 1_000) : 0;
    }
    if (!ended) schedule();
  };
  const schedule = () => {
    if (ended || timer !== undefined) return;
    const wait = Math.max(window.minIntervalMs, nextFlushDelay);
    if (wait === 0) {
      flush();
      return;
    }
    timer = setTimeout(flush, wait);
    timer.unref();
  };

  const outputsDirectory = `${options.workspacePath}/${PTC_OUTPUT_DIRECTORY}`;
  const refPathPrefix = `${options.sandboxWorkspace}/${PTC_OUTPUT_DIRECTORY}`;
  const temporary = `${outputsDirectory}/.tmp-${callId}-${randomBytes(6).toString("hex")}`;
  const stream = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  const hash = createHash("sha256");
  let spilled = 0;
  let truncated = false;
  let streamFailed: Error | undefined;
  stream.on("error", (error) => {
    streamFailed = error;
  });

  const writeChunk = (chunk: Buffer) => {
    const room = options.spillMaxBytes - spilled;
    const slice = chunk.subarray(0, Math.max(0, room));
    if (slice.length > 0) {
      hash.update(slice);
      spilled += slice.length;
      if (streamFailed === undefined) stream.write(slice);
    }
    if (slice.length < chunk.length) truncated = true;
  };

  const command = typeof args.command === "string"
    ? { file: options.shellPath, argv: ["-c", args.command] }
    : { file: args.command[0], argv: args.command.slice(1) };
  if (command.file === undefined) throw new PtcHostError("invalid_request", "command is empty", "failed");

  let child: ChildProcess;
  let spawnError: Error | undefined;
  try {
    child = spawn(command.file, command.argv, {
      cwd: options.workspacePath,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: {
        ...(args.inheritEnv ? process.env : {}),
        ...args.env,
        PATH: args.env.PATH ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: args.env.HOME ?? options.workspacePath,
        TMPDIR: args.env.TMPDIR ?? "/tmp",
        LANG: args.env.LANG ?? "C.UTF-8",
      },
    });
    child.once("error", (error) => {
      spawnError = error;
    });
  } catch (error) {
    stream.destroy();
    await unlink(temporary).catch(() => undefined);
    throw new PtcHostError("spawn_error", `command could not start: ${error instanceof Error ? error.message : "unknown"}`, "failed");
  }

  const stdout = new StringDecoder("utf8");
  const stderr = new StringDecoder("utf8");
  child.stdout?.on("data", (chunk: Buffer) => {
    writeChunk(chunk);
    sink.push(stdout.write(chunk));
    schedule();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    writeChunk(chunk);
    sink.push(stderr.write(chunk));
    schedule();
  });

  let timedOut = false;
  const killTree = () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      // The process may already be gone.
    }
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    killTree();
  }, args.timeoutMs);
  timeout.unref();
  const onAbort = () => killTree();
  signal.addEventListener("abort", onAbort, { once: true });

  const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });
  clearTimeout(timeout);
  signal.removeEventListener("abort", onAbort);
  ended = true;
  if (timer !== undefined) clearTimeout(timer);
  sink.push(stdout.end());
  sink.push(stderr.end());
  flush();

  await new Promise<void>((resolve) => {
    if (stream.writableEnded || stream.destroyed) {
      resolve();
      return;
    }
    stream.once("error", () => resolve());
    stream.end(() => resolve());
  });
  if (spawnError !== undefined || streamFailed !== undefined) {
    await unlink(temporary).catch(() => undefined);
    if (spawnError !== undefined) {
      throw new PtcHostError("spawn_error", `command could not start: ${spawnError.message}`, "failed");
    }
    throw new PtcHostError("internal", `output could not be written: ${streamFailed!.message}`, "failed");
  }

  if (timedOut) {
    await unlink(temporary).catch(() => undefined);
    throw new PtcHostError("timeout", `command timed out after ${args.timeoutMs} ms`, "unknown");
  }
  if (signal.aborted) {
    await unlink(temporary).catch(() => undefined);
    throw new PtcHostError("aborted", "command was aborted", "unknown");
  }

  let outputRef: PtcOutputRef | undefined;
  if (spilled > 0) {
    const digest = hash.digest("hex");
    try {
      await rename(temporary, `${outputsDirectory}/${digest}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // An existing blob with the same name holds the same bytes; either way the temp file goes.
      if (code !== "EEXIST" && code !== "EPERM") {
        await unlink(temporary).catch(() => undefined);
        throw new PtcHostError("internal", "complete output could not be stored", "failed");
      }
      await unlink(temporary).catch(() => undefined);
    }
    const now = (options.now ?? Date.now)();
    outputRef = {
      blobId: digest,
      jobId: identity.jobId,
      sessionId: identity.sessionId,
      callId,
      path: `${refPathPrefix}/${digest}`,
      size: spilled,
      sha256: digest,
      createdAt: now,
      expiresAt: now + options.jobRetentionMs,
      state: "available",
    };
  } else {
    await unlink(temporary).catch(() => undefined);
  }

  return {
    exitCode: closed.code ?? (128 + signalNumber(closed.signal)),
    spillTruncated: truncated,
    ...(outputRef === undefined ? {} : { outputRef }),
  };
}

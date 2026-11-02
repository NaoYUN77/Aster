/**
 * Control-plane half of remote PTC.
 *
 * pi-durable runs a nested tool task under the harness's own context, so a nested `bash` cannot
 * receive a PTC marker through its arguments or context. Instead, the code mode wrapper registers
 * the active execution per conversation before the script runs; `HarnessOptions.env` consults that
 * map, and nested bash reaches the sandbox through `PtcExecutionEnv`. The same execution is exposed
 * to `RemoteCodemodeSandbox.remote()` through an AsyncLocalStorage store.
 *
 * The gateway keeps the tool journal, the durable output references and the budgets. The runner
 * keeps the VM and the commands: only the script's final value returns to the model.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { err, ok, ExecutionError, type ExecutionEnv, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-durable/env";
import type { Session } from "@earendil-works/pi-durable";
import type {
  CodemodeRemote,
  CodemodeRemoteExchange,
  CodemodeRemoteMessage,
  CodemodeRemoteReply,
  CodemodeRemoteRequest,
} from "@earendil-works/pi-codemode";
import { RpcClientError, RpcExecutionClient, type RpcSessionResult, type RpcVmHandle } from "../execution/rpc-client.js";
import {
  parseCwd,
  parsePtcToolCallPayload,
  PTC_WORKSPACE,
  type OutputRef,
  type PtcBashResult,
  type PtcOutputWindow,
  type PtcToolCallPayload,
} from "../execution/ptc-protocol.js";
import { RemoteExecutionEnv, type RemoteShellClient } from "../execution/remote-env.js";
import { createPtcSessionId, derivePtcJobId, PtcJobDoc, PtcOutputDoc, ptcOutputKey } from "./identity.js";

const OPEN_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 10_000;
const REPLY_TIMEOUT_MS = 15_000;
const TOOL_DEADLINE_SLACK_MS = 5_000;
const DEFAULT_WINDOW_BYTES = 50 * 1024;
const DEFAULT_WINDOW_LINES = 2_000;
const DEFAULT_MIN_INTERVAL_MS = 25;
const DEFAULT_BYTES_PER_SECOND = 1024 * 1024;

/** The PTC file half is deliberately unusable; the broker client exists only to satisfy the base. */
const UNUSED_BROKER: RemoteShellClient = {
  exec: async () => {
    throw new Error("PTC does not use the SSH broker client");
  },
  abortAll: () => {},
};

const CONTEXT_NOT_PTC =
  "Remote PTC phase 1 runs bash only inside code mode; file tools are unavailable.";

export type PtcControlOptions = {
  readonly client: RpcExecutionClient;
  /** Whole-script deadline; includes nested calls and leaves slack for the sandbox's own timeout. */
  readonly deadlineMs: number;
  readonly maxToolCalls: number;
  readonly maxJournalBytes: number;
  /** Upper clamp for the output window sent to the sandbox. */
  readonly maxOutputBytes: number;
  readonly maxOutputLines: number;
  /** Per nested command bound, independent of the remaining script deadline. */
  readonly toolTimeoutMs: number;
  readonly now?: () => number;
};

export type PtcBeginOptions = {
  readonly conversationId: number;
  readonly taskId: number;
  readonly context: Context;
};

export class PtcWorkspaceMissingError extends Error {
  override name = "PtcWorkspaceMissingError";
  readonly code = "workspace_missing" as const;

  constructor(message: string) {
    super(message);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A clamped window that satisfies the protocol's minimums. */
export function ptcOutputWindow(
  requested: ShellExecOptions["window"],
  maxBytes: number,
  maxLines: number,
): PtcOutputWindow {
  const bytes = requested === undefined ? DEFAULT_WINDOW_BYTES : Math.floor(requested.maxBytes);
  const lines = requested === undefined ? DEFAULT_WINDOW_LINES : Math.floor(requested.maxLines);
  return {
    maxBytes: Math.min(Math.max(256, bytes), Math.max(256, maxBytes)),
    maxLines: Math.min(Math.max(1, lines), Math.max(1, maxLines)),
    minIntervalMs: Math.min(
      60_000,
      Math.max(0, Math.floor(requested?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)),
    ),
    bytesPerSecond: Math.min(
      1_000_000_000,
      Math.max(1, Math.floor(requested?.bytesPerSecond ?? DEFAULT_BYTES_PER_SECOND)),
    ),
  };
}

/** Resolve the command's cwd relative to the sandbox's fixed working directory. */
export function ptcCwd(requested: string | undefined, cwd: string): Result<string, ExecutionError> {
  const candidate = requested === undefined
    ? cwd
    : requested.startsWith("/")
      ? requested
      : posix.resolve(PTC_WORKSPACE, requested);
  const parsed = parseCwd(posix.normalize(candidate));
  if (!parsed.ok) return err(new ExecutionError("unknown", `Invalid PTC working directory: ${parsed.message}`));
  return ok(parsed.value);
}

type PtcExecutionEnvOptions = {
  readonly client: RpcExecutionClient;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly toolTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxOutputLines: number;
  readonly now: () => number;
  readonly takeCallId: () => number | undefined;
  readonly recordOutput: (ref: OutputRef, context: Context) => Promise<void>;
};

/**
 * The environment nested `bash` sees inside a PTC script: command execution goes to `tool.call`,
 * while the ordinary file methods stay fail-closed. `inheritEnv` is never honored; the sandbox has
 * a fixed base environment and cannot inherit the control plane's.
 */
class PtcExecutionEnv extends RemoteExecutionEnv {
  constructor(private readonly ptc: PtcExecutionEnvOptions) {
    super({
      client: UNUSED_BROKER,
      executionId: `ptc-${ptc.sessionId}`,
      cwd: PTC_WORKSPACE,
      // Unused by exec(), which applies the script deadline instead.
      defaultTimeoutSeconds: Math.max(1, Math.floor(ptc.toolTimeoutMs / 1000)),
      maxTimeoutSeconds: Math.max(1, Math.floor(ptc.toolTimeoutMs / 1000)),
    });
  }

  override async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "Command aborted"));
    if (this.ptc.signal.aborted) return err(new ExecutionError("aborted", "PTC execution was aborted"));
    const remaining = this.ptc.deadlineAt - this.ptc.now();
    if (remaining <= 0) return err(new ExecutionError("timeout", "PTC execution deadline exceeded"));
    const callId = this.ptc.takeCallId();
    if (callId === undefined) {
      return err(new ExecutionError("unknown", "No reserved PTC call id for this command"));
    }
    const cwd = ptcCwd(options?.cwd, this.cwd);
    if (!cwd.ok) return err(cwd.error);
    const requestedMs = options?.timeout === undefined ? remaining : Math.ceil(options.timeout * 1000);
    const timeoutMs = Math.max(1, Math.min(requestedMs, remaining, this.ptc.toolTimeoutMs));
    const payload: PtcToolCallPayload = {
      tool: "bash",
      callId,
      args: {
        command,
        cwd: cwd.value,
        env: options?.env ?? {},
        inheritEnv: false,
        timeoutMs,
        window: ptcOutputWindow(options?.window, this.ptc.maxOutputBytes, this.ptc.maxOutputLines),
      },
    };
    const parsed = parsePtcToolCallPayload(payload);
    if (!parsed.ok) return err(new ExecutionError("unknown", `Invalid PTC bash call: ${parsed.message}`));
    const signal = context.abortSignal === undefined
      ? this.ptc.signal
      : AbortSignal.any([context.abortSignal, this.ptc.signal]);
    const onOutput = options?.onOutput;
    try {
      const handle = this.ptc.client.startToolCall(this.ptc.sessionId, parsed.value, {
        deadlineMs: timeoutMs + TOOL_DEADLINE_SLACK_MS,
        signal,
        ...(onOutput === undefined ? {} : {
          onOutput: (event) => onOutput(event.text, context, {
            stream: event.stream,
            ...(event.skipped === undefined ? {} : { skipped: event.skipped }),
          }),
        }),
      });
      const result = await handle.result;
      if (result.outputRef !== undefined) await this.ptc.recordOutput(result.outputRef, context);
      return ok({
        exitCode: result.exitCode,
        ...(result.outputRef === undefined ? {} : { spillPath: result.outputRef.path }),
      });
    } catch (error) {
      return err(mapPtcError(error));
    }
  }

  override async cleanup(_context: Context): Promise<void> {
    // The session owns cancellation; cleaning one tool's environment must not abort the script.
  }
}

function mapPtcError(error: unknown): ExecutionError {
  if (!(error instanceof RpcClientError)) return new ExecutionError("unknown", "PTC tool call failed");
  switch (error.code) {
    case "aborted":
      return new ExecutionError("aborted", "PTC tool call was aborted", error);
    case "timeout":
      return new ExecutionError("timeout", "PTC tool call timed out; its outcome is unknown", error);
    case "spawn_error":
      return new ExecutionError("spawn_error", error.message, error);
    case "output_unavailable":
      return new ExecutionError("unknown", `PTC output is unavailable: ${error.message}`, error);
    case "workspace_missing":
      return new ExecutionError("unknown", `PTC workspace is missing: ${error.message}`, error);
    default:
      return new ExecutionError("unknown", `PTC tool call failed: ${error.message}`, error);
  }
}

type ExecutionOptions = {
  readonly client: RpcExecutionClient;
  readonly session: Session;
  readonly sessionId: string;
  readonly jobId: string;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  readonly maxToolCalls: number;
  readonly maxJournalBytes: number;
  readonly maxOutputBytes: number;
  readonly maxOutputLines: number;
  readonly toolTimeoutMs: number;
  readonly now: () => number;
};

/**
 * One script execution. It owns the RPC session, the reserved nested call id, the budgets, and the
 * bridge replies. Nested calls are serialized by the code mode host, so a single reserved id slot
 * is enough; a second reservation before the environment consumes the first is a protocol error.
 */
export class PtcExecution {
  readonly env: ExecutionEnv;
  readonly remote: CodemodeRemote;

  private readonly options: ExecutionOptions;
  private readonly deadlineAt: number;
  private readonly abort = new AbortController();
  private pendingCallId: number | undefined;
  private toolCalls = 0;
  private journalBytes = 0;
  private closed = false;
  private started = false;
  private chain: Promise<void> = Promise.resolve();
  private bridgeFailure: Error | undefined;

  constructor(options: ExecutionOptions) {
    this.options = options;
    this.deadlineAt = options.now() + options.deadlineMs;
    this.signal = AbortSignal.any([options.signal, this.abort.signal]);
    this.env = new PtcExecutionEnv({
      client: options.client,
      sessionId: options.sessionId,
      signal: this.signal,
      deadlineAt: this.deadlineAt,
      toolTimeoutMs: options.toolTimeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      maxOutputLines: options.maxOutputLines,
      now: options.now,
      takeCallId: () => this.takeCallId(),
      recordOutput: (ref, context) => this.recordOutput(ref, context),
    });
    this.remote = {
      execute: (request, exchange) => this.executeRemote(request, exchange),
    };
  }

  /** The caller's abort plus the execution's own; either one stops the bridge. */
  readonly signal: AbortSignal;

  get jobId(): string {
    return this.options.jobId;
  }

  get sessionId(): string {
    return this.options.sessionId;
  }

  /** Reserve the id the next nested call will use. The environment consumes it. */
  reserveToolCall(callId: number): void {
    if (this.closed) throw new Error("PTC execution is already closed");
    if (!Number.isSafeInteger(callId) || callId < 1) throw new Error("PTC call id is invalid");
    this.toolCalls++;
    if (this.toolCalls > this.options.maxToolCalls) {
      throw new Error(
        `PTC budget exceeded: a script may make at most ${this.options.maxToolCalls} nested tool calls`,
      );
    }
    this.pendingCallId = callId;
  }

  /** Count a completed nested result toward the journal bound. */
  accountJournal(value: unknown): void {
    let text: string;
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      text = "";
    }
    this.journalBytes += Buffer.byteLength(text, "utf8");
    if (this.journalBytes > this.options.maxJournalBytes) {
      throw new Error(
        `PTC budget exceeded: nested results exceed ${this.options.maxJournalBytes} bytes for one script`,
      );
    }
  }

  takeCallId(): number | undefined {
    const id = this.pendingCallId;
    this.pendingCallId = undefined;
    return id;
  }

  async recordOutput(ref: OutputRef, context: Context): Promise<void> {
    const key = ptcOutputKey(this.jobId, this.sessionId, ref.callId);
    const existing = await this.options.session.snapshot(PtcOutputDoc, key, context);
    if (existing !== undefined) {
      if (existing.outputRef.sha256 !== ref.sha256 || existing.outputRef.path !== ref.path) {
        throw new Error("PTC output reference changed for an already recorded call");
      }
      return;
    }
    const recordedAt = this.options.now();
    await this.options.session.commit(async (tx) => {
      await tx.doc(PtcOutputDoc, key, {
        jobId: this.jobId,
        sessionId: this.sessionId,
        callId: ref.callId,
        outputRef: ref,
        recordedAt,
      });
    }, context);
  }

  /** Stop the bridge and close the RPC session. Never throws; closing must not mask a tool error. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort(new Error("PTC execution closed"));
    await this.chain.catch(() => undefined);
    try {
      await this.options.client.closeSession(this.sessionId, { deadlineMs: CLOSE_TIMEOUT_MS });
    } catch {
      // The connection may already be gone; the agent kills its runner on disconnect.
    }
  }

  private async executeRemote(
    request: CodemodeRemoteRequest,
    exchange: CodemodeRemoteExchange,
  ): Promise<void> {
    if (this.started) throw new Error("a PTC execution runs exactly one VM");
    this.started = true;
    let handle: RpcVmHandle;
    try {
      handle = this.options.client.startVm(this.sessionId, request, {
        deadlineMs: this.options.deadlineMs,
        signal: this.signal,
        onMessage: (event) => this.enqueue(event.messages, event.seq, exchange, () => handle),
      });
    } catch (error) {
      throw error;
    }
    try {
      await handle.result;
    } finally {
      await this.chain.catch(() => undefined);
    }
  }

  private enqueue(
    messages: readonly unknown[],
    seq: number,
    exchange: CodemodeRemoteExchange,
    handle: () => RpcVmHandle,
  ): void {
    if (this.closed || this.bridgeFailure !== undefined) return;
    this.chain = this.chain.then(async () => {
      let reply: CodemodeRemoteReply = { type: "stop" };
      try {
        reply = await exchange(messages as CodemodeRemoteMessage[]);
      } catch {
        reply = { type: "stop" };
      }
      await this.options.client.vmReply(this.sessionId, seq, reply, {
        deadlineMs: REPLY_TIMEOUT_MS,
        signal: this.abort.signal,
      });
    }).catch((error: unknown) => {
      this.bridgeFailure = error instanceof Error ? error : new Error("PTC VM bridge failed");
      // The runner is waiting for an answer; cancel the VM so the script does not hang.
      void handle().cancel("VM reply failed").catch(() => undefined);
    });
  }
}

/**
 * Active executions keyed by conversation, plus the AsyncLocalStorage selection used by the remote
 * sandbox. `begin` opens the RPC session and commits `workspaceReady` only after the agent
 * confirmed the workspace, so a restart never recreates a workspace the control plane already used.
 */
export class PtcControl {
  private readonly options: PtcControlOptions;
  private readonly active = new Map<number, PtcExecution>();
  private readonly als = new AsyncLocalStorage<PtcExecution>();
  private session: Session | undefined;
  private closing = false;

  constructor(options: PtcControlOptions) {
    this.options = options;
  }

  bindSession(session: Session): void {
    this.session = session;
  }

  /** The execution that the current codemode run belongs to; only valid inside `runWith`. */
  current(): PtcExecution {
    const execution = this.als.getStore();
    if (execution === undefined) throw new Error("No active PTC execution for this remote sandbox call");
    return execution;
  }

  envFor(conversationId: number): ExecutionEnv | undefined {
    return this.active.get(conversationId)?.env;
  }

  hasActive(conversationId: number): boolean {
    return this.active.has(conversationId);
  }

  runWith<T>(execution: PtcExecution, run: () => Promise<T>): Promise<T> {
    return this.als.run(execution, run);
  }

  async begin(input: PtcBeginOptions): Promise<PtcExecution> {
    const session = this.session;
    if (session === undefined) throw new Error("PTC control is not bound to a durable session");
    if (this.closing) throw new Error("PTC control is closing");
    if (this.active.has(input.conversationId)) {
      throw new Error("a PTC execution is already active for this conversation");
    }
    const jobId = derivePtcJobId(input.conversationId, input.taskId);
    const prior = await session.snapshot(PtcJobDoc, jobId, input.context);
    const workspaceReady = prior?.workspaceReady === true;
    const sessionId = createPtcSessionId();
    let opened: RpcSessionResult;
    try {
      opened = await this.options.client.openSession(sessionId, {
        jobId,
        workspaceReady,
        sandbox: true,
        deadlineMs: OPEN_TIMEOUT_MS,
        ...(input.context.abortSignal === undefined ? {} : { signal: input.context.abortSignal }),
      });
    } catch (error) {
      if (error instanceof RpcClientError && error.code === "workspace_missing") {
        throw new PtcWorkspaceMissingError(
          `PTC workspace ${jobId} is missing on the execution host; refusing to recreate recorded work`,
        );
      }
      throw new Error(`PTC sandbox is unavailable: ${errorText(error)}`, { cause: error });
    }
    if (!workspaceReady) {
      const at = (this.options.now ?? Date.now)();
      try {
        await session.commit(async (tx) => {
          const doc = await tx.doc(PtcJobDoc, jobId, {
            jobId,
            workspaceReady: false,
            createdAt: at,
            updatedAt: at,
          });
          doc.workspaceReady = true;
          doc.updatedAt = at;
        }, input.context);
      } catch (error) {
        await this.options.client.closeSession(sessionId, { deadlineMs: CLOSE_TIMEOUT_MS }).catch(() => undefined);
        throw error;
      }
    }
    const execution = new PtcExecution({
      client: this.options.client,
      session: session,
      sessionId,
      jobId,
      signal: input.context.abortSignal ?? new AbortController().signal,
      deadlineMs: this.options.deadlineMs,
      maxToolCalls: this.options.maxToolCalls,
      maxJournalBytes: this.options.maxJournalBytes,
      maxOutputBytes: this.options.maxOutputBytes,
      maxOutputLines: this.options.maxOutputLines,
      toolTimeoutMs: this.options.toolTimeoutMs,
      now: this.options.now ?? Date.now,
    });
    this.active.set(input.conversationId, execution);
    // An open session with a recorded job must not be left behind if construction failed.
    if (opened.sessionId !== sessionId) {
      await execution.close();
      throw new Error("execution agent returned a mismatched session id");
    }
    return execution;
  }

  async end(conversationId: number, execution: PtcExecution): Promise<void> {
    if (this.active.get(conversationId) === execution) this.active.delete(conversationId);
    await execution.close();
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const executions = [...this.active.values()];
    this.active.clear();
    await Promise.allSettled(executions.map((execution) => execution.close()));
    await this.options.client.close();
  }
}

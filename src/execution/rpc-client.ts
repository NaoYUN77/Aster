import { randomUUID } from "node:crypto";
import {
  RPC_MAX_DEADLINE_MS,
  RPC_MIN_DEADLINE_MS,
  type RpcErrorCode,
  type RpcEventFrame,
  type RpcFrame,
  type RpcOutcome,
  type RpcOutputEvent,
  type RpcRequestFrame,
  type RpcResponseFrame,
  type RpcTestExecutePayload,
  type RpcVmMessageEvent,
} from "./rpc-protocol.js";
import type { PtcBashResult, PtcToolCallPayload } from "./ptc-protocol.js";
import type { RpcClientTransport, RpcConnection } from "./rpc-transport.js";
import type { TestExecutionResult } from "./rpc-test-executor.js";

export class RpcClientError extends Error {
  override name = "RpcClientError";

  constructor(
    readonly code: RpcErrorCode | "unavailable",
    message: string,
    readonly options: {
      readonly outcome?: RpcOutcome;
      readonly retryable?: boolean;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
  }
}

export type RpcClientOptions = {
  readonly transport: RpcClientTransport;
  readonly requestTimeoutMs?: number;
  readonly idFactory?: () => string;
};

export type RpcRequestOptions = {
  readonly sessionId?: string;
  readonly jobId?: string;
  readonly correlationId?: string;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  readonly onOutput?: (event: RpcOutputEvent) => void;
  readonly onMessage?: (event: RpcVmMessageEvent) => void;
};

function truncateUtf8(value: string, maxBytes: number): string {
  let truncated = value;
  while (Buffer.byteLength(truncated, "utf8") > maxBytes) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}

export type RpcExecuteHandle = {
  readonly id: string;
  readonly result: Promise<TestExecutionResult>;
  cancel(reason?: string): Promise<void>;
};

export type RpcVmHandle = {
  readonly id: string;
  readonly result: Promise<unknown>;
  cancel(reason?: string): Promise<void>;
};

export type RpcToolCallHandle = {
  readonly id: string;
  readonly result: Promise<PtcBashResult>;
  cancel(reason?: string): Promise<void>;
};

type Pending = {
  readonly id: string;
  readonly method: RpcRequestFrame["method"];
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
  readonly onOutput?: (event: RpcOutputEvent) => void;
  readonly onMessage?: (event: RpcVmMessageEvent) => void;
};

export type RpcHealthResult = {
  readonly executionId: string;
  readonly protocol: 1;
  readonly agentVersion: string;
  readonly phase: number;
  readonly transport: "unix" | "tls";
  readonly peer: string | null;
  readonly methods: readonly string[];
  readonly testExecutor: boolean;
  /** True when the agent built a PTC sandbox manager (`EXECUTION_AGENT_PTC=1`). */
  readonly ptc?: boolean;
};

export type RpcPreflightResult = {
  readonly ok: boolean;
  readonly executionId: string;
  readonly agentVersion: string;
  readonly checks: Record<string, boolean | null>;
  /** Sandbox preflight detail; absent when the agent has no PTC manager. */
  readonly ptc?: {
    readonly ok: boolean;
    readonly isolation: {
      readonly mode: "bwrap" | "bwrap-prlimit" | "degraded-prlimit";
      readonly cgroup: "v2" | "none";
      readonly network: "none" | "host";
    };
    readonly checks: Record<string, boolean>;
    readonly diagnostics: readonly string[];
  };
};

export type RpcSessionResult = {
  readonly sessionId: string;
  readonly executionId: string;
  readonly jobId?: string;
  readonly workspace?: {
    readonly path: string;
    readonly created: boolean;
    readonly reused: boolean;
  };
  readonly isolation?: {
    readonly mode: "bwrap" | "bwrap-prlimit" | "degraded-prlimit";
    readonly cgroup: "v2" | "none";
    readonly network: "none" | "host";
  };
  readonly limits: {
    readonly maxSessions: number;
    readonly maxConcurrent: number;
    readonly sessionTtlMs: number;
  };
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CANCELLABLE_METHODS = new Set<RpcRequestFrame["method"]>(["execute", "vm.start", "tool.call"]);

function clampDeadline(value: number | undefined, fallback: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate)) return fallback;
  return Math.min(RPC_MAX_DEADLINE_MS, Math.max(RPC_MIN_DEADLINE_MS, candidate));
}

/**
 * Gateway-side RPC client. It owns pending requests, deadlines, and cancellation, but it does not
 * authorize tools or write durable records. A dropped connection fails pending requests; it never
 * reconnects and replays an execution on its own.
 */
export class RpcExecutionClient {
  private readonly pending = new Map<string, Pending>();
  private readonly defaultTimeoutMs: number;
  private readonly idFactory: () => string;
  private connection: RpcConnection | undefined;
  private closing = false;

  constructor(private readonly options: RpcClientOptions) {
    this.defaultTimeoutMs = clampDeadline(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.idFactory = options.idFactory ?? (() => randomUUID());
  }

  get connected(): boolean {
    return this.connection !== undefined && !this.connection.closed;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.closing) throw new RpcClientError("unavailable", "RPC client is closed");
    const connection = await this.options.transport.connect();
    this.connection = connection;
    connection.onFrame((frame) => this.handleFrame(frame));
    connection.onClose((error) => this.handleClose(error));
  }

  async close(): Promise<void> {
    this.closing = true;
    const connection = this.connection;
    this.connection = undefined;
    this.failPending(new RpcClientError("unavailable", "RPC client closed", { outcome: "unknown" }));
    connection?.close();
  }

  async health(options: { readonly deadlineMs?: number; readonly signal?: AbortSignal } = {}): Promise<RpcHealthResult> {
    const result = await this.request("health.check", {}, options);
    return result as RpcHealthResult;
  }

  async preflight(options: { readonly deadlineMs?: number; readonly signal?: AbortSignal } = {}): Promise<RpcPreflightResult> {
    const result = await this.request("preflight", {}, options);
    return result as RpcPreflightResult;
  }

  async openSession(
    sessionId: string,
    options: {
      readonly jobId?: string;
      readonly workspaceReady?: boolean;
      /** Start a PTC sandbox for this session; requires `jobId`. */
      readonly sandbox?: boolean;
      readonly deadlineMs?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<RpcSessionResult> {
    const result = await this.request("session.open", {
      sessionId,
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
      ...(options.workspaceReady === undefined ? {} : { workspaceReady: options.workspaceReady }),
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    }, {
      sessionId,
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return result as RpcSessionResult;
  }

  async closeSession(
    sessionId: string,
    options: { readonly deadlineMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.request("session.close", { sessionId }, {
      sessionId,
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  startTestExecute(
    sessionId: string,
    payload: RpcTestExecutePayload,
    options: { readonly deadlineMs?: number; readonly signal?: AbortSignal; readonly onOutput?: (event: RpcOutputEvent) => void } = {},
  ): RpcExecuteHandle {
    const request = this.beginRequest("execute", payload, {
      sessionId,
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
    });
    return {
      id: request.id,
      result: request.promise as Promise<TestExecutionResult>,
      cancel: (reason?: string) => this.cancel(sessionId, request.id, reason),
    };
  }

  /**
   * Starts a VM inside an already-open PTC session. The returned handle resolves when the script
   * finishes. VM messages are delivered through `onMessage`; each must be answered with `vmReply`
   * carrying the event's `seq` as the request correlation id.
   */
  startVm(
    sessionId: string,
    request: unknown,
    options: {
      readonly deadlineMs?: number;
      readonly signal?: AbortSignal;
      readonly onMessage?: (event: RpcVmMessageEvent) => void;
    } = {},
  ): RpcVmHandle {
    const begun = this.beginRequest("vm.start", { request }, {
      sessionId,
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onMessage === undefined ? {} : { onMessage: options.onMessage }),
    });
    return {
      id: begun.id,
      result: begun.promise,
      cancel: (reason?: string) => this.cancel(sessionId, begun.id, reason),
    };
  }

  async vmReply(
    sessionId: string,
    seq: number,
    reply: unknown,
    options: { readonly deadlineMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.request("vm.reply", { reply }, {
      sessionId,
      correlationId: String(seq),
      deadlineMs: options.deadlineMs ?? 10_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /** Runs one nested `bash` call in the PTC sandbox. Output events belong to this request id. */
  startToolCall(
    sessionId: string,
    payload: PtcToolCallPayload,
    options: {
      readonly deadlineMs?: number;
      readonly signal?: AbortSignal;
      readonly onOutput?: (event: RpcOutputEvent) => void;
    } = {},
  ): RpcToolCallHandle {
    const begun = this.beginRequest("tool.call", payload as unknown as Record<string, unknown>, {
      sessionId,
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
    });
    return {
      id: begun.id,
      result: begun.promise as Promise<PtcBashResult>,
      cancel: (reason?: string) => this.cancel(sessionId, begun.id, reason),
    };
  }

  async cancel(
    sessionId: string,
    targetId: string,
    reason?: string,
    options: { readonly deadlineMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    if (targetId.length === 0) {
      throw new RpcClientError("invalid_request", "targetId is required");
    }
    await this.request("cancel", {
      targetId,
      ...(reason === undefined ? {} : { reason: truncateUtf8(reason, 512) }),
    }, {
      sessionId,
      deadlineMs: options.deadlineMs ?? 5_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  private request(
    method: RpcRequestFrame["method"],
    payload: Record<string, unknown>,
    options: RpcRequestOptions = {},
  ): Promise<unknown> {
    return this.beginRequest(method, payload, options).promise;
  }

  private beginRequest(
    method: RpcRequestFrame["method"],
    payload: Record<string, unknown>,
    options: RpcRequestOptions = {},
  ): { readonly id: string; readonly promise: Promise<unknown> } {
    const connection = this.connection;
    if (connection === undefined || connection.closed) {
      return {
        id: "",
        promise: Promise.reject(new RpcClientError("unavailable", "RPC client is not connected")),
      };
    }
    if (options.signal?.aborted) {
      return {
        id: "",
        promise: Promise.reject(new RpcClientError("aborted", "request aborted", { outcome: "unknown" })),
      };
    }
    const id = this.idFactory();
    if (this.pending.has(id)) {
      return { id, promise: Promise.reject(new RpcClientError("invalid_request", "duplicate request id")) };
    }
    const deadlineMs = clampDeadline(options.deadlineMs, this.defaultTimeoutMs);
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => {
      this.settleError(id, new RpcClientError("timeout", "RPC request deadline exceeded", { outcome: "unknown" }));
      if (CANCELLABLE_METHODS.has(method) && options.sessionId !== undefined) {
        void this.cancel(options.sessionId, id, "deadline exceeded").catch(() => undefined);
      }
    }, deadlineMs);
    timer.unref();
    const onAbort = options.signal === undefined ? undefined : () => {
      this.settleError(id, new RpcClientError("aborted", "RPC request aborted", { outcome: "unknown" }));
      if (CANCELLABLE_METHODS.has(method) && options.sessionId !== undefined) {
        void this.cancel(options.sessionId, id, "aborted").catch(() => undefined);
      }
    };
    options.signal?.addEventListener("abort", onAbort!, { once: true });
    this.pending.set(id, {
      id,
      method,
      resolve,
      reject,
      timer,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(onAbort === undefined ? {} : { onAbort }),
      ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
      ...(options.onMessage === undefined ? {} : { onMessage: options.onMessage }),
    });
    const frame: RpcRequestFrame = {
      v: 1,
      kind: "request",
      id,
      method,
      deadlineMs,
      payload,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
      ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
    };
    try {
      connection.send(frame);
    } catch (error) {
      this.settleError(id, new RpcClientError("unavailable", "failed to send RPC request", { cause: error }));
    }
    return { id, promise };
  }

  private handleFrame(frame: RpcFrame): void {
    if (frame.kind === "event") {
      this.handleEvent(frame);
      return;
    }
    if (frame.kind !== "response") return;
    const pending = this.pending.get(frame.id);
    if (pending === undefined) return;
    if (frame.status === "ok") {
      this.settleOk(frame.id, frame.result);
      return;
    }
    this.settleError(frame.id, new RpcClientError(
      frame.error.code,
      frame.error.message,
      {
        ...(frame.error.outcome === undefined ? {} : { outcome: frame.error.outcome }),
        ...(frame.error.retryable === undefined ? {} : { retryable: frame.error.retryable }),
      },
    ));
  }

  private handleEvent(frame: RpcEventFrame): void {
    if (frame.event === "vm.message") {
      const pending = this.pending.get(frame.id);
      if (pending === undefined) return;
      try {
        pending.onMessage?.(frame);
      } catch (error) {
        this.settleError(pending.id, new RpcClientError("internal", "VM message handler failed", { cause: error }));
        void this.cancel(frame.sessionId, pending.id, "VM message handler failed").catch(() => undefined);
      }
      return;
    }
    if (frame.event !== "output") return;
    const pending = this.pending.get(frame.id);
    if (pending === undefined) return;
    try {
      pending.onOutput?.(frame);
    } catch (error) {
      this.settleError(pending.id, new RpcClientError("internal", "output handler failed", { cause: error }));
      if (CANCELLABLE_METHODS.has(pending.method)) {
        void this.cancel(frame.sessionId, pending.id, "output handler failed").catch(() => undefined);
      }
    }
  }

  private settleOk(id: string, value: unknown): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.cleanup(pending);
    pending.resolve(value);
  }

  private settleError(id: string, error: RpcClientError): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.cleanup(pending);
    pending.reject(error);
  }

  private cleanup(pending: Pending): void {
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    this.pending.delete(pending.id);
  }

  private handleClose(error?: Error): void {
    this.connection = undefined;
    this.failPending(new RpcClientError(
      "unavailable",
      "RPC connection closed",
      { outcome: "unknown", ...(error === undefined ? {} : { cause: error }) },
    ));
  }

  private failPending(error: RpcClientError): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      if (entry.signal !== undefined && entry.onAbort !== undefined) {
        entry.signal.removeEventListener("abort", entry.onAbort);
      }
      entry.reject(CANCELLABLE_METHODS.has(entry.method)
        ? error
        : new RpcClientError(error.code, error.message, { ...error.options, outcome: "failed" }));
    }
  }
}

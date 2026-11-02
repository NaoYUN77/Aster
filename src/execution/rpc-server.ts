import {
  RPC_PROTOCOL_VERSION,
  parseTestExecutePayload,
  type RpcErrorCode,
  type RpcFrame,
  type RpcOutcome,
  type RpcRequestFrame,
  type RpcTestExecutePayload,
} from "./rpc-protocol.js";
import {
  parsePtcToolCallPayload,
  type PtcToolCallPayload,
} from "./ptc-protocol.js";
import type { RunnerFrame } from "./ptc-runner-protocol.js";
import type { PtcRunnerHandle, PtcSandboxManager, PtcSandboxStart } from "./ptc-sandbox.js";
import { WorkspaceMissingError } from "./ptc-workspace.js";
import type { CodemodeRemoteReply, CodemodeRemoteRequest } from "@earendil-works/pi-codemode";
import { RpcAbortError, TestExecutionError, executeTestOperation } from "./rpc-test-executor.js";
import type { RpcConnection, RpcPeerInfo, RpcServer } from "./rpc-transport.js";

export type RpcAgentOptions = {
  readonly server: RpcServer;
  readonly executionId: string;
  readonly transport: "unix" | "tls";
  /** Present when the operator enabled the PTC sandbox on this execution host. */
  readonly ptc?: PtcSandboxManager;
  readonly maxSessions?: number;
  readonly maxConcurrent?: number;
  readonly sessionTtlMs?: number;
  readonly heartbeatMs?: number;
  readonly testExecutorEnabled?: boolean;
  readonly agentVersion?: string;
  readonly now?: () => number;
};

export type RpcAgent = {
  close(): Promise<void>;
};

type PtcVm = {
  readonly requestId: string;
  done: boolean;
  lastSeq: number;
  timer?: NodeJS.Timeout;
};

type PtcTool = {
  readonly requestId: string;
  readonly callId: number;
  timer?: NodeJS.Timeout;
};

type PtcSession = {
  readonly runner: PtcRunnerHandle;
  readonly workspace: PtcSandboxStart["workspace"];
  readonly isolation: PtcRunnerHandle["isolation"];
  vm?: PtcVm;
  readonly tools: Map<number, PtcTool>;
  closed: boolean;
};

type Session = {
  readonly sessionId: string;
  readonly jobId?: string;
  readonly createdAt: number;
  lastActiveAt: number;
  readonly requests: Set<string>;
  readonly ptc?: PtcSession;
};

type PendingExecution = {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: "execute" | "vm" | "tool";
  readonly callId?: number;
  /** Only `execute` counts against `maxConcurrent`; PTC calls belong to an already-admitted VM. */
  readonly counted: boolean;
  readonly controller: AbortController;
  deadline: NodeJS.Timeout | undefined;
  abortReason: "cancel" | "timeout" | "disconnect" | "session_close" | "server_shutdown" | undefined;
  settled: boolean;
  seq: number;
};

type Failure = {
  readonly code: RpcErrorCode;
  readonly message: string;
  readonly outcome: RpcOutcome;
};

function ptcToolFailure(
  code: "timeout" | "spawn_error" | "aborted" | "output_too_large" | "failed",
  message: string,
): Failure {
  switch (code) {
    case "timeout":
      return { code: "timeout", message, outcome: "unknown" };
    case "aborted":
      return { code: "aborted", message, outcome: "unknown" };
    case "spawn_error":
      return { code: "spawn_error", message, outcome: "failed" };
    case "output_too_large":
      return { code: "too_large", message, outcome: "failed" };
    case "failed":
      return { code: "internal", message, outcome: "failed" };
  }
}

const AGENT_METHODS = [
  "health.check",
  "preflight",
  "session.open",
  "session.close",
  "execute",
  "cancel",
  "vm.start",
  "vm.reply",
  "tool.call",
] as const;

function nowMs(): number {
  return Date.now();
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * One authenticated RPC connection. Session state is connection-scoped: a reconnect gets a fresh
 * session, and pending execution outcomes are not replayed. Request-id deduplication is therefore
 * only a guard against a duplicate frame on this connection, never durable replay.
 */
class AgentConnection {
  private readonly sessions = new Map<string, Session>();
  private readonly requests = new Map<string, PendingExecution>();
  private readonly seenRequestIds = new Set<string>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly sweeper: NodeJS.Timeout;
  private active = 0;
  private closed = false;
  private readonly maxSessions: number;
  private readonly maxConcurrent: number;
  private readonly sessionTtlMs: number;
  private readonly testExecutorEnabled: boolean;

  constructor(
    private readonly connection: RpcConnection,
    private readonly peer: RpcPeerInfo,
    private readonly options: RpcAgentOptions,
    private readonly onClosed: () => void,
  ) {
    this.maxSessions = positiveInteger(options.maxSessions, 16);
    this.maxConcurrent = positiveInteger(options.maxConcurrent, 4);
    this.sessionTtlMs = positiveInteger(options.sessionTtlMs, 270_000);
    this.testExecutorEnabled = options.testExecutorEnabled !== false;
    const heartbeatMs = positiveInteger(options.heartbeatMs, 15_000);
    this.heartbeat = setInterval(() => {
      this.send({
        v: 1,
        kind: "event",
        event: "heartbeat",
        timestamp: (options.now ?? nowMs)(),
      });
    }, heartbeatMs);
    this.heartbeat.unref();
    this.sweeper = setInterval(() => this.sweepSessions(), Math.max(1_000, Math.min(30_000, heartbeatMs)));
    this.sweeper.unref();
    connection.onFrame((frame) => {
      if (frame.kind !== "request") {
        this.close("only requests are accepted from the gateway");
        return;
      }
      void this.dispatch(frame);
    });
    connection.onClose(() => this.handleClose());
  }

  close(reason: string): void {
    if (this.closed) return;
    clearInterval(this.heartbeat);
    clearInterval(this.sweeper);
    for (const pending of this.requests.values()) {
      pending.abortReason = "disconnect";
      pending.controller.abort("disconnected");
    }
    for (const session of this.sessions.values()) {
      if (session.ptc !== undefined) this.closePtc(session.ptc, reason);
      this.send({
        v: 1,
        kind: "event",
        event: "session.closed",
        sessionId: session.sessionId,
        reason,
      });
    }
    this.requests.clear();
    this.sessions.clear();
    this.closed = true;
    this.connection.close();
  }

  private send(frame: RpcFrame): void {
    if (this.closed || this.connection.closed) return;
    try {
      this.connection.send(frame);
    } catch {
      this.close("failed to send a frame");
    }
  }

  private respondOk(id: string, result: unknown): void {
    this.send({ v: 1, kind: "response", id, status: "ok", result });
  }

  private respondError(id: string, code: RpcErrorCode, message: string, outcome?: RpcOutcome): void {
    this.send({
      v: 1,
      kind: "response",
      id,
      status: "error",
      error: { code, message, ...(outcome === undefined ? {} : { outcome }), retryable: false },
    });
  }

  private async dispatch(frame: RpcRequestFrame): Promise<void> {
    if (this.closed) return;
    if (this.seenRequestIds.has(frame.id)) {
      this.respondError(frame.id, "invalid_request", "duplicate request id on this connection", "not_started");
      return;
    }
    this.seenRequestIds.add(frame.id);
    if (this.seenRequestIds.size > 100_000) {
      this.close("request id table exceeded its bound");
      return;
    }
    try {
      switch (frame.method) {
        case "health.check":
          this.respondOk(frame.id, this.health());
          return;
        case "preflight":
          void this.preflight().then((result) => this.respondOk(frame.id, result), () => {
            this.respondError(frame.id, "internal", "execution agent preflight failed", "failed");
          });
          return;
        case "session.open":
          void this.openSession(frame).catch(() => {
            this.respondError(frame.id, "internal", "failed to open the session", "not_started");
          });
          return;
        case "session.close":
          this.closeSessionFromRequest(frame);
          return;
        case "execute":
          this.startExecution(frame);
          return;
        case "cancel":
          this.cancelRequest(frame);
          return;
        case "vm.start":
          this.startVm(frame);
          return;
        case "vm.message":
          this.respondError(frame.id, "not_implemented", "VM messages are delivered as events, not requests", "not_started");
          return;
        case "vm.reply":
          this.vmReply(frame);
          return;
        case "tool.call":
          this.startToolCall(frame);
          return;
      }
    } catch {
      this.respondError(frame.id, "internal", "execution agent failed to handle the request", "failed");
    }
  }

  private health(): Record<string, unknown> {
    return {
      executionId: this.options.executionId,
      protocol: RPC_PROTOCOL_VERSION,
      agentVersion: this.options.agentVersion ?? "phase1",
      phase: 1,
      transport: this.options.transport,
      peer: this.peer.peer ?? null,
      methods: AGENT_METHODS,
      testExecutor: this.testExecutorEnabled,
      ptc: this.options.ptc !== undefined,
    };
  }

  private async preflight(): Promise<Record<string, unknown>> {
    const ptc = this.options.ptc === undefined ? undefined : await this.options.ptc.preflight();
    return {
      // A gateway needs one usable capability, not both: PTC deployments may keep the Phase 0
      // test executor switched off, and vice versa.
      ok: (this.testExecutorEnabled || ptc !== undefined) && (ptc?.ok ?? true),
      executionId: this.options.executionId,
      agentVersion: this.options.agentVersion ?? "phase1",
      checks: {
        testExecutor: this.testExecutorEnabled,
        mutualTls: this.options.transport === "tls" ? this.peer.authorized : null,
        ptc: ptc === undefined ? null : ptc.ok,
      },
      ...(ptc === undefined ? {} : {
        ptc: {
          ok: ptc.ok,
          isolation: ptc.isolation,
          checks: ptc.checks,
          diagnostics: ptc.diagnostics,
        },
      }),
    };
  }

  private async openSession(frame: RpcRequestFrame): Promise<void> {
    if (this.closed) return;
    const sessionId = frame.payload.sessionId;
    if (typeof sessionId !== "string") {
      this.respondError(frame.id, "invalid_request", "sessionId is required", "not_started");
      return;
    }
    if (this.sessions.has(sessionId)) {
      this.respondError(frame.id, "busy", "session already exists on this connection", "not_started");
      return;
    }
    if (this.sessions.size >= this.maxSessions) {
      this.respondError(frame.id, "busy", "maximum sessions reached", "not_started");
      return;
    }
    const now = (this.options.now ?? nowMs)();
    const jobId = frame.payload.jobId;
    const sandboxRequested = frame.payload.sandbox === true;
    const workspaceReady = frame.payload.workspaceReady === true;
    let ptc: PtcSession | undefined;
    if (sandboxRequested) {
      if (typeof jobId !== "string") {
        this.respondError(frame.id, "invalid_request", "a sandbox session requires a jobId", "not_started");
        return;
      }
      const sandbox = this.options.ptc;
      if (sandbox === undefined) {
        this.respondError(frame.id, "not_implemented", "PTC is not enabled on this execution agent", "not_started");
        return;
      }
      let started: PtcSandboxStart;
      try {
        started = await sandbox.open(jobId, sessionId, workspaceReady, {
          onFrame: (runnerFrame) => this.handleRunnerFrame(sessionId, runnerFrame),
          onExit: (info) => this.handleRunnerExit(sessionId, info),
          onStderr: (text) => process.stderr.write(`[ptc ${sessionId}] ${text}`),
        });
      } catch (error) {
        const failure = this.ptcOpenFailure(error);
        this.respondError(frame.id, failure.code, failure.message, "not_started");
        return;
      }
      if (this.closed) {
        await started.runner.kill("connection closed while the session was opening", true);
        return;
      }
      ptc = {
        runner: started.runner,
        workspace: started.workspace,
        isolation: started.runner.isolation,
        tools: new Map(),
        closed: false,
      };
    }
    const session: Session = {
      sessionId,
      ...(typeof jobId === "string" ? { jobId } : {}),
      createdAt: now,
      lastActiveAt: now,
      requests: new Set(),
      ...(ptc === undefined ? {} : { ptc }),
    };
    this.sessions.set(sessionId, session);
    this.respondOk(frame.id, {
      sessionId,
      executionId: this.options.executionId,
      ...(session.jobId === undefined ? {} : { jobId: session.jobId }),
      ...(ptc === undefined ? {} : {
        workspace: {
          path: ptc.workspace.hostPath,
          created: ptc.workspace.created,
          reused: ptc.workspace.reused,
        },
        isolation: {
          mode: ptc.isolation.mode,
          cgroup: ptc.isolation.cgroup,
          network: ptc.isolation.network,
        },
      }),
      limits: {
        maxSessions: this.maxSessions,
        maxConcurrent: this.maxConcurrent,
        sessionTtlMs: this.sessionTtlMs,
      },
    });
  }

  private ptcOpenFailure(error: unknown): Failure {
    if (error instanceof WorkspaceMissingError) {
      return { code: "workspace_missing", message: error.message, outcome: "not_started" };
    }
    return {
      code: "unavailable",
      message: `PTC sandbox could not start: ${error instanceof Error ? error.message : "unknown error"}`,
      outcome: "not_started",
    };
  }

  private closeSessionFromRequest(frame: RpcRequestFrame): void {
    const sessionId = frame.payload.sessionId;
    if (typeof sessionId !== "string") {
      this.respondError(frame.id, "invalid_request", "sessionId is required", "not_started");
      return;
    }
    const existed = this.sessions.has(sessionId);
    this.closeSession(sessionId, "session.close");
    this.respondOk(frame.id, { sessionId, closed: existed });
  }

  private closeSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.delete(sessionId);
    for (const requestId of [...session.requests]) {
      const pending = this.requests.get(requestId);
      if (pending === undefined) continue;
      pending.abortReason = "session_close";
      pending.controller.abort("session closed");
      // A VM or tool request has no abort listener: the runner is about to be killed, so settle
      // those requests here instead of leaving the caller to wait for its own deadline.
      if (pending.kind === "vm" || pending.kind === "tool") {
        this.finish(pending, session);
        this.respondError(requestId, "aborted", "the session closed before the request completed", "unknown");
      }
    }
    if (session.ptc !== undefined) this.closePtc(session.ptc, reason);
    this.send({ v: 1, kind: "event", event: "session.closed", sessionId, reason });
  }

  /** Stops the runner and clears server-side deadlines; the workspace itself is retained. */
  private closePtc(ptc: PtcSession, reason: string): void {
    if (ptc.closed) return;
    ptc.closed = true;
    for (const tool of ptc.tools.values()) {
      if (tool.timer !== undefined) clearTimeout(tool.timer);
    }
    ptc.tools.clear();
    if (ptc.vm?.timer !== undefined) clearTimeout(ptc.vm.timer);
    void ptc.runner.kill(reason).catch(() => undefined);
  }

  private sweepSessions(): void {
    if (this.closed) return;
    const now = (this.options.now ?? nowMs)();
    for (const session of this.sessions.values()) {
      if (session.requests.size === 0 && now - session.lastActiveAt > this.sessionTtlMs) {
        this.closeSession(session.sessionId, "idle timeout");
      }
    }
  }

  private startExecution(frame: RpcRequestFrame): void {
    const sessionId = frame.sessionId;
    if (typeof sessionId !== "string") {
      this.respondError(frame.id, "invalid_request", "execute requires a sessionId", "not_started");
      return;
    }
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      this.respondError(frame.id, "not_found", "session is not open on this connection", "not_started");
      return;
    }
    if (!this.testExecutorEnabled) {
      this.respondError(frame.id, "not_implemented", "the test executor is disabled", "not_started");
      return;
    }
    if (frame.payload.executor !== "test") {
      this.respondError(
        frame.id,
        "not_implemented",
        `executor ${String(frame.payload.executor).slice(0, 32)} is not implemented in Phase 0`,
        "not_started",
      );
      return;
    }
    const payload = parseTestExecutePayload(frame.payload);
    if (!payload.ok) {
      this.respondError(frame.id, "invalid_request", payload.message, "not_started");
      return;
    }
    if (this.active >= this.maxConcurrent) {
      this.respondError(frame.id, "busy", "execution concurrency limit reached", "not_started");
      return;
    }
    const controller = new AbortController();
    const pending: PendingExecution = {
      id: frame.id,
      sessionId,
      kind: "execute",
      counted: true,
      controller,
      deadline: undefined,
      abortReason: undefined,
      settled: false,
      seq: 0,
    };
    pending.deadline = setTimeout(() => {
      pending.abortReason = "timeout";
      controller.abort("deadline exceeded");
    }, frame.deadlineMs);
    pending.deadline.unref();
    this.requests.set(frame.id, pending);
    session.requests.add(frame.id);
    session.lastActiveAt = (this.options.now ?? nowMs)();
    this.active++;
    void this.runTest(frame, payload.value, pending, session);
  }

  private async runTest(
    frame: RpcRequestFrame,
    payload: RpcTestExecutePayload,
    pending: PendingExecution,
    session: Session,
  ): Promise<void> {
    try {
      const result = await executeTestOperation(payload, pending.controller.signal, (text) => {
        if (pending.settled || this.closed) return;
        pending.seq++;
        this.send({
          v: 1,
          kind: "event",
          event: "output",
          id: frame.id,
          sessionId: pending.sessionId,
          seq: pending.seq,
          stream: "stdout",
          text,
        });
      });
      if (pending.settled) return;
      this.finish(pending, session);
      this.respondOk(frame.id, result);
    } catch (error) {
      if (pending.settled) return;
      const failure = this.failureFor(error, pending);
      this.finish(pending, session);
      this.respondError(frame.id, failure.code, failure.message, failure.outcome);
    }
  }

  private beginPtcRequest(
    frame: RpcRequestFrame,
    session: Session,
    kind: "vm" | "tool",
    callId?: number,
  ): PendingExecution {
    const pending: PendingExecution = {
      id: frame.id,
      sessionId: session.sessionId,
      kind,
      counted: false,
      ...(callId === undefined ? {} : { callId }),
      controller: new AbortController(),
      deadline: undefined,
      abortReason: undefined,
      settled: false,
      seq: 0,
    };
    this.requests.set(frame.id, pending);
    session.requests.add(frame.id);
    session.lastActiveAt = (this.options.now ?? nowMs)();
    return pending;
  }

  private ptcSession(frame: RpcRequestFrame): { session: Session; ptc: PtcSession } | undefined {
    const sessionId = frame.sessionId;
    if (typeof sessionId !== "string") {
      this.respondError(frame.id, "invalid_request", "sessionId is required", "not_started");
      return undefined;
    }
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      this.respondError(frame.id, "not_found", "session is not open on this connection", "not_started");
      return undefined;
    }
    const ptc = session.ptc;
    if (ptc === undefined || ptc.closed) {
      this.respondError(frame.id, "unavailable", "session has no running PTC sandbox", "not_started");
      return undefined;
    }
    return { session, ptc };
  }

  private startVm(frame: RpcRequestFrame): void {
    const target = this.ptcSession(frame);
    if (target === undefined) return;
    if (target.ptc.vm !== undefined) {
      this.respondError(frame.id, "busy", "a VM is already running in this session", "not_started");
      return;
    }
    const pending = this.beginPtcRequest(frame, target.session, "vm");
    const vm: PtcVm = { requestId: frame.id, done: false, lastSeq: 0 };
    target.ptc.vm = vm;
    vm.timer = setTimeout(() => {
      if (vm.done || pending.settled) return;
      this.finish(pending, target.session);
      this.respondError(frame.id, "timeout", "the PTC script deadline was exceeded", "unknown");
      this.closeSession(target.session.sessionId, "PTC script deadline exceeded");
    }, frame.deadlineMs);
    vm.timer.unref();
    if (!target.ptc.runner.send({
      v: 1,
      kind: "start",
      request: frame.payload.request as CodemodeRemoteRequest,
    })) {
      if (vm.timer !== undefined) clearTimeout(vm.timer);
      this.finish(pending, target.session);
      target.ptc.vm = undefined;
      this.respondError(frame.id, "unavailable", "the PTC runner is not accepting input", "not_started");
    }
  }

  private vmReply(frame: RpcRequestFrame): void {
    const target = this.ptcSession(frame);
    if (target === undefined) return;
    const vm = target.ptc.vm;
    if (vm === undefined || vm.done) {
      this.respondError(frame.id, "not_found", "no VM exchange is waiting for a reply", "not_started");
      return;
    }
    const seq = Number(frame.correlationId);
    if (!Number.isSafeInteger(seq) || seq < 1 || seq > vm.lastSeq) {
      this.respondError(frame.id, "invalid_request", "vm.reply correlationId must name a delivered exchange", "not_started");
      return;
    }
    if (!target.ptc.runner.send({
      v: 1,
      kind: "reply",
      seq,
      reply: frame.payload.reply as CodemodeRemoteReply,
    })) {
      this.respondError(frame.id, "unavailable", "the PTC runner is not accepting input", "unknown");
      return;
    }
    target.session.lastActiveAt = (this.options.now ?? nowMs)();
    this.respondOk(frame.id, { accepted: true, seq });
  }

  private startToolCall(frame: RpcRequestFrame): void {
    const target = this.ptcSession(frame);
    if (target === undefined) return;
    const parsed = parsePtcToolCallPayload(frame.payload);
    if (!parsed.ok) {
      this.respondError(frame.id, "invalid_request", parsed.message, "not_started");
      return;
    }
    const callId = parsed.value.callId;
    if (target.ptc.tools.size > 0) {
      this.respondError(frame.id, "busy", "a PTC tool call is already running in this session", "not_started");
      return;
    }
    const pending = this.beginPtcRequest(frame, target.session, "tool", callId);
    const tool: PtcTool = { requestId: frame.id, callId };
    target.ptc.tools.set(callId, tool);
    const hardDeadline = Math.min(frame.deadlineMs, parsed.value.args.timeoutMs + 10_000);
    tool.timer = setTimeout(() => {
      if (pending.settled) return;
      target.ptc.tools.delete(callId);
      target.ptc.runner.send({ v: 1, kind: "tool-cancel", callId });
      this.finish(pending, target.session);
      this.respondError(frame.id, "timeout", "the PTC command deadline was exceeded", "unknown");
    }, hardDeadline);
    tool.timer.unref();
    const payload: PtcToolCallPayload = parsed.value;
    if (!target.ptc.runner.send({ v: 1, kind: "tool", callId, args: payload.args })) {
      clearTimeout(tool.timer);
      target.ptc.tools.delete(callId);
      this.finish(pending, target.session);
      this.respondError(frame.id, "unavailable", "the PTC runner is not accepting input", "not_started");
    }
  }

  private handleRunnerFrame(sessionId: string, frame: RunnerFrame): void {
    const session = this.sessions.get(sessionId);
    const ptc = session?.ptc;
    if (session === undefined || ptc === undefined || ptc.closed) return;
    switch (frame.kind) {
      case "message": {
        const vm = ptc.vm;
        if (vm === undefined || vm.done) return;
        if (frame.seq <= vm.lastSeq) {
          this.closeSession(sessionId, "runner sent an out-of-order VM message");
          return;
        }
        vm.lastSeq = frame.seq;
        this.send({
          v: 1,
          kind: "event",
          event: "vm.message",
          id: vm.requestId,
          sessionId,
          seq: frame.seq,
          messages: frame.messages,
        });
        return;
      }
      case "done": {
        const vm = ptc.vm;
        if (vm === undefined || vm.done) return;
        vm.done = true;
        if (vm.timer !== undefined) clearTimeout(vm.timer);
        ptc.vm = undefined;
        const pending = this.requests.get(vm.requestId);
        if (pending !== undefined) {
          this.finish(pending, session);
          this.respondOk(vm.requestId, {});
        }
        return;
      }
      case "tool-output": {
        const tool = ptc.tools.get(frame.callId);
        if (tool === undefined) return;
        const pending = this.requests.get(tool.requestId);
        if (pending === undefined) return;
        pending.seq++;
        this.send({
          v: 1,
          kind: "event",
          event: "output",
          id: tool.requestId,
          sessionId,
          seq: pending.seq,
          stream: frame.stream,
          text: frame.text,
          ...(frame.skipped === undefined ? {} : { skipped: frame.skipped }),
        });
        return;
      }
      case "tool-result": {
        const tool = ptc.tools.get(frame.callId);
        if (tool === undefined) return;
        if (tool.timer !== undefined) clearTimeout(tool.timer);
        ptc.tools.delete(frame.callId);
        const pending = this.requests.get(tool.requestId);
        if (pending === undefined) return;
        this.finish(pending, session);
        this.respondOk(tool.requestId, frame.result);
        return;
      }
      case "tool-error": {
        const tool = ptc.tools.get(frame.callId);
        if (tool === undefined) return;
        if (tool.timer !== undefined) clearTimeout(tool.timer);
        ptc.tools.delete(frame.callId);
        const pending = this.requests.get(tool.requestId);
        if (pending === undefined) return;
        this.finish(pending, session);
        const failure = ptcToolFailure(frame.code, frame.message);
        this.respondError(tool.requestId, failure.code, failure.message, failure.outcome);
        return;
      }
      case "ready":
        return;
      default:
        this.closeSession(sessionId, "runner sent an unexpected frame");
    }
  }

  private handleRunnerExit(
    sessionId: string,
    info: { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly stderr: string },
  ): void {
    const session = this.sessions.get(sessionId);
    const ptc = session?.ptc;
    if (session === undefined || ptc === undefined || ptc.closed) return;
    ptc.closed = true;
    if (ptc.vm?.timer !== undefined) clearTimeout(ptc.vm.timer);
    const vm = ptc.vm;
    ptc.vm = undefined;
    if (vm !== undefined && !vm.done) {
      const pending = this.requests.get(vm.requestId);
      if (pending !== undefined) {
        this.finish(pending, session);
        this.respondError(vm.requestId, "unavailable", "the PTC sandbox exited while the script was running", "unknown");
      }
    }
    for (const tool of ptc.tools.values()) {
      if (tool.timer !== undefined) clearTimeout(tool.timer);
      const pending = this.requests.get(tool.requestId);
      if (pending === undefined) continue;
      this.finish(pending, session);
      this.respondError(tool.requestId, "unavailable", "the PTC sandbox exited during the command", "unknown");
    }
    ptc.tools.clear();
    this.sessions.delete(sessionId);
    const detail = info.stderr.trim().slice(0, 512);
    this.send({
      v: 1,
      kind: "event",
      event: "session.closed",
      sessionId,
      reason: `PTC sandbox exited (${info.signal ?? info.code ?? "unknown"})${detail === "" ? "" : `: ${detail}`}`,
    });
  }

  private failureFor(error: unknown, pending: PendingExecution): Failure {
    if (error instanceof RpcAbortError) {
      if (pending.abortReason === "timeout") {
        return { code: "timeout", message: "execution deadline exceeded", outcome: "unknown" };
      }
      return { code: "aborted", message: "execution was aborted", outcome: "unknown" };
    }
    if (error instanceof TestExecutionError) {
      return { code: "test_error", message: error.message, outcome: "failed" };
    }
    return { code: "internal", message: "test executor failed", outcome: "failed" };
  }

  private finish(pending: PendingExecution, session: Session): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.deadline !== undefined) clearTimeout(pending.deadline);
    this.requests.delete(pending.id);
    session.requests.delete(pending.id);
    if (pending.counted) this.active--;
  }

  private cancelRequest(frame: RpcRequestFrame): void {
    const targetId = frame.payload.targetId;
    if (typeof targetId !== "string") {
      this.respondError(frame.id, "invalid_request", "targetId is required", "not_started");
      return;
    }
    const pending = this.requests.get(targetId);
    if (pending === undefined) {
      this.respondError(frame.id, "not_found", "target request is not active", "not_started");
      return;
    }
    if (pending.kind === "tool") {
      const session = this.sessions.get(pending.sessionId);
      const tool = pending.callId === undefined ? undefined : session?.ptc?.tools.get(pending.callId);
      if (session?.ptc !== undefined && tool !== undefined) {
        session.ptc.runner.send({ v: 1, kind: "tool-cancel", callId: tool.callId });
      }
      // The runner answers with tool-error aborted; the request settles there, not here.
      this.respondOk(frame.id, { targetId, cancelled: true });
      return;
    }
    if (pending.kind === "vm") {
      // A computing remote VM cannot be interrupted; ending the session kills the runner.
      const session = this.sessions.get(pending.sessionId);
      if (session !== undefined) this.finish(pending, session);
      this.respondError(targetId, "aborted", "the PTC script was cancelled", "unknown");
      this.closeSession(pending.sessionId, "script cancelled");
      this.respondOk(frame.id, { targetId, cancelled: true });
      return;
    }
    pending.abortReason = "cancel";
    pending.controller.abort("cancelled");
    this.respondOk(frame.id, { targetId, cancelled: true });
  }

  private handleClose(): void {
    clearInterval(this.heartbeat);
    clearInterval(this.sweeper);
    for (const pending of this.requests.values()) {
      pending.abortReason = "disconnect";
      pending.controller.abort("disconnected");
    }
    for (const session of this.sessions.values()) {
      if (session.ptc !== undefined) this.closePtc(session.ptc, "connection closed");
    }
    this.requests.clear();
    this.sessions.clear();
    this.closed = true;
    this.onClosed();
  }
}

export function startRpcAgent(options: RpcAgentOptions): RpcAgent {
  const connections = new Set<AgentConnection>();
  options.server.onConnection((connection, peer) => {
    const agentConnection = new AgentConnection(connection, peer, options, () => {
      connections.delete(agentConnection);
    });
    connections.add(agentConnection);
  });
  let closing: Promise<void> | undefined;
  return {
    close() {
      closing ??= (async () => {
        for (const connection of connections) connection.close("server shutdown");
        connections.clear();
        await options.server.close();
      })();
      return closing;
    },
  };
}

import {
  RPC_PROTOCOL_VERSION,
  parsePtcToolCallPayload,
  parsePtcVmReplyPayload,
  parseTestExecutePayload,
  type RpcErrorCode,
  type RpcFrame,
  type RpcOutcome,
  type RpcRequestFrame,
  type RpcTestExecutePayload,
  type PtcToolCallPayload,
  type PtcVmStartPayload,
} from "./rpc-protocol.js";
import { PtcHostError, type PtcEventSink, type PtcHost } from "./ptc-host.js";
import { RpcAbortError, TestExecutionError, executeTestOperation } from "./rpc-test-executor.js";
import type { RpcConnection, RpcPeerInfo, RpcServer } from "./rpc-transport.js";

export type RpcAgentOptions = {
  readonly server: RpcServer;
  readonly executionId: string;
  readonly transport: "unix" | "tls";
  readonly maxSessions?: number;
  readonly maxConcurrent?: number;
  readonly sessionTtlMs?: number;
  readonly heartbeatMs?: number;
  readonly testExecutorEnabled?: boolean;
  /** Remote PTC sandbox; absent or disabled keeps the Phase 0 surface. */
  readonly ptc?: PtcHost;
  readonly agentVersion?: string;
  readonly now?: () => number;
};

export type RpcAgent = {
  close(): Promise<void>;
};

type Session = {
  readonly sessionId: string;
  readonly jobId?: string;
  readonly createdAt: number;
  lastActiveAt: number;
  readonly requests: Set<string>;
  vmRequestId?: string;
  toolCallRequestId?: string;
};

type PendingExecution = {
  readonly id: string;
  readonly method: RpcRequestFrame["method"];
  readonly sessionId: string;
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

const PHASE0_METHODS = [
  "health.check",
  "preflight",
  "session.open",
  "session.close",
  "execute",
  "cancel",
] as const;

const PHASE1_METHODS = [
  ...PHASE0_METHODS,
  "tool.call",
  "vm.start",
  "vm.reply",
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
      this.options.ptc?.cancel(pending.sessionId, pending.id);
      pending.controller.abort("disconnected");
    }
    for (const session of this.sessions.values()) {
      this.send({
        v: 1,
        kind: "event",
        event: "session.closed",
        sessionId: session.sessionId,
        reason,
      });
      void this.options.ptc?.closeSession(session.sessionId).catch(() => undefined);
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
          this.respondOk(frame.id, await this.preflight());
          return;
        case "session.open":
          await this.openSession(frame);
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
        case "tool.call":
          this.startToolCall(frame);
          return;
        case "vm.start":
          this.startVm(frame);
          return;
        case "vm.reply":
          await this.replyVm(frame);
          return;
        case "vm.message":
          this.respondError(
            frame.id,
            "not_implemented",
            "vm.message is an agent-to-gateway event, not a request",
            "not_started",
          );
          return;
      }
    } catch {
      this.respondError(frame.id, "internal", "execution agent failed to handle the request", "failed");
    }
  }

  private health(): Record<string, unknown> {
    const ptc = this.options.ptc?.enabled === true;
    return {
      executionId: this.options.executionId,
      protocol: RPC_PROTOCOL_VERSION,
      agentVersion: this.options.agentVersion ?? (ptc ? "phase1" : "phase0"),
      phase: ptc ? 1 : 0,
      transport: this.options.transport,
      peer: this.peer.peer ?? null,
      methods: ptc ? PHASE1_METHODS : PHASE0_METHODS,
      testExecutor: this.testExecutorEnabled,
      ...(ptc && this.options.ptc !== undefined ? { ptc: true, isolation: this.options.ptc.isolation } : { ptc: false }),
    };
  }

  private async preflight(): Promise<Record<string, unknown>> {
    const ptc = this.options.ptc;
    const checks: Record<string, boolean | null> = {
      testExecutor: this.testExecutorEnabled,
      mutualTls: this.options.transport === "tls" ? this.peer.authorized : null,
    };
    if (ptc?.enabled === true) {
      Object.assign(checks, await ptc.preflight());
      checks.ptc = true;
    }
    // A Phase 1 agent reports the sandbox's own checks; the test executor is a Phase 0 facility and
    // is expected to be off in production. A Phase 0 agent has nothing else to prove.
    const ok = ptc?.enabled === true
      ? Object.entries(checks).every(([key, value]) => key === "testExecutor" || value !== false)
      : this.testExecutorEnabled;
    return {
      ok,
      executionId: this.options.executionId,
      agentVersion: this.options.agentVersion ?? (ptc?.enabled === true ? "phase1" : "phase0"),
      checks,
    };
  }

  private async openSession(frame: RpcRequestFrame): Promise<void> {
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
    const session: Session = {
      sessionId,
      ...(typeof jobId === "string" ? { jobId } : {}),
      createdAt: now,
      lastActiveAt: now,
      requests: new Set(),
    };
    let workspaceReady: unknown;
    if (session.jobId !== undefined && this.options.ptc?.enabled === true) {
      try {
        workspaceReady = await this.options.ptc.openSession(
          sessionId,
          session.jobId,
          frame.payload.workspaceReady === true,
        );
      } catch (error) {
        const failure = this.hostFailure(error);
        this.respondError(frame.id, failure.code, failure.message, failure.outcome);
        return;
      }
      if (this.closed) return;
    }
    this.sessions.set(sessionId, session);
    this.respondOk(frame.id, {
      sessionId,
      executionId: this.options.executionId,
      ...(session.jobId === undefined ? {} : { jobId: session.jobId }),
      ...(workspaceReady === undefined ? {} : { workspaceReady }),
      limits: {
        maxSessions: this.maxSessions,
        maxConcurrent: this.maxConcurrent,
        sessionTtlMs: this.sessionTtlMs,
      },
    });
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
    for (const requestId of session.requests) {
      const pending = this.requests.get(requestId);
      if (pending === undefined) continue;
      pending.abortReason = "session_close";
      this.options.ptc?.cancel(sessionId, requestId);
      pending.controller.abort("session closed");
    }
    void this.options.ptc?.closeSession(sessionId).catch(() => undefined);
    this.send({ v: 1, kind: "event", event: "session.closed", sessionId, reason });
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
      method: "execute",
      sessionId,
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

  private sessionFor(frame: RpcRequestFrame, method: string): Session | undefined {
    const sessionId = frame.sessionId;
    if (typeof sessionId !== "string") {
      this.respondError(frame.id, "invalid_request", `${method} requires a sessionId`, "not_started");
      return undefined;
    }
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      this.respondError(frame.id, "not_found", "session is not open on this connection", "not_started");
      return undefined;
    }
    return session;
  }

  private beginPending(
    frame: RpcRequestFrame,
    session: Session,
    method: PendingExecution["method"],
  ): PendingExecution {
    const controller = new AbortController();
    const pending: PendingExecution = {
      id: frame.id,
      method,
      sessionId: session.sessionId,
      controller,
      deadline: undefined,
      abortReason: undefined,
      settled: false,
      seq: 0,
    };
    pending.deadline = setTimeout(() => {
      pending.abortReason = "timeout";
      this.options.ptc?.cancel(session.sessionId, frame.id);
      controller.abort("deadline exceeded");
    }, frame.deadlineMs);
    pending.deadline.unref();
    this.requests.set(frame.id, pending);
    session.requests.add(frame.id);
    session.lastActiveAt = (this.options.now ?? nowMs)();
    this.active++;
    return pending;
  }

  private startVm(frame: RpcRequestFrame): void {
    const ptc = this.options.ptc;
    if (ptc?.enabled !== true) {
      this.respondError(frame.id, "not_implemented", "the PTC sandbox is disabled", "not_started");
      return;
    }
    const session = this.sessionFor(frame, "vm.start");
    if (session === undefined) return;
    if (session.jobId === undefined) {
      this.respondError(frame.id, "invalid_request", "vm.start requires a session opened with a jobId", "not_started");
      return;
    }
    if (session.vmRequestId !== undefined) {
      this.respondError(frame.id, "busy", "a VM is already running in this session", "not_started");
      return;
    }
    if (session.toolCallRequestId !== undefined) {
      this.respondError(frame.id, "busy", "a nested call is still running in this session", "not_started");
      return;
    }
    if (this.active >= this.maxConcurrent) {
      this.respondError(frame.id, "busy", "execution concurrency limit reached", "not_started");
      return;
    }
    const payload = frame.payload as PtcVmStartPayload;
    const pending = this.beginPending(frame, session, "vm.start");
    session.vmRequestId = frame.id;
    const sink: PtcEventSink = {
      vmMessage: (callId, messages) => {
        if (pending.settled || this.closed) return;
        this.send({
          v: 1,
          kind: "event",
          event: "vm.message",
          id: frame.id,
          sessionId: session.sessionId,
          ...(callId === undefined ? {} : { callId }),
          messages,
        });
      },
      toolOutput: () => undefined,
    };
    void this.runVm(frame, payload.request, pending, session, sink, ptc);
  }

  private async runVm(
    frame: RpcRequestFrame,
    request: PtcVmStartPayload["request"],
    pending: PendingExecution,
    session: Session,
    sink: PtcEventSink,
    ptc: PtcHost,
  ): Promise<void> {
    try {
      await ptc.startVm({ sessionId: session.sessionId, request, signal: pending.controller.signal, sink });
      if (pending.settled) return;
      this.finish(pending, session);
      this.respondOk(frame.id, {});
    } catch (error) {
      if (pending.settled) return;
      const failure = this.failureFor(error, pending);
      this.finish(pending, session);
      this.respondError(frame.id, failure.code, failure.message, failure.outcome);
    }
  }

  private startToolCall(frame: RpcRequestFrame): void {
    const ptc = this.options.ptc;
    if (ptc?.enabled !== true) {
      this.respondError(frame.id, "not_implemented", "the PTC sandbox is disabled", "not_started");
      return;
    }
    const session = this.sessionFor(frame, "tool.call");
    if (session === undefined) return;
    if (session.vmRequestId === undefined) {
      this.respondError(frame.id, "not_found", "no VM is running in this session", "not_started");
      return;
    }
    if (session.toolCallRequestId !== undefined) {
      this.respondError(frame.id, "busy", "a nested call is already running in this session", "not_started");
      return;
    }
    if (this.active >= this.maxConcurrent) {
      this.respondError(frame.id, "busy", "execution concurrency limit reached", "not_started");
      return;
    }
    const parsed = parsePtcToolCallPayload(frame.payload);
    if (!parsed.ok) {
      this.respondError(frame.id, "invalid_request", parsed.message, "not_started");
      return;
    }
    const pending = this.beginPending(frame, session, "tool.call");
    session.toolCallRequestId = frame.id;
    const sink: PtcEventSink = {
      vmMessage: () => undefined,
      toolOutput: (seq, stream, text, skipped) => {
        if (pending.settled || this.closed) return;
        this.send({
          v: 1,
          kind: "event",
          event: "tool.output",
          id: frame.id,
          sessionId: session.sessionId,
          seq,
          stream,
          text,
          ...(skipped === undefined ? {} : { skipped }),
        });
      },
    };
    void this.runToolCall(frame, parsed.value, pending, session, sink, ptc);
  }

  private async runToolCall(
    frame: RpcRequestFrame,
    payload: PtcToolCallPayload,
    pending: PendingExecution,
    session: Session,
    sink: PtcEventSink,
    ptc: PtcHost,
  ): Promise<void> {
    try {
      const result = await ptc.toolCall({
        sessionId: session.sessionId,
        payload,
        signal: pending.controller.signal,
        sink,
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

  private async replyVm(frame: RpcRequestFrame): Promise<void> {
    const ptc = this.options.ptc;
    if (ptc?.enabled !== true) {
      this.respondError(frame.id, "not_implemented", "the PTC sandbox is disabled", "not_started");
      return;
    }
    const session = this.sessionFor(frame, "vm.reply");
    if (session === undefined) return;
    if (session.vmRequestId === undefined) {
      this.respondError(frame.id, "not_found", "no VM is running in this session", "not_started");
      return;
    }
    const parsed = parsePtcVmReplyPayload(frame.payload);
    if (!parsed.ok) {
      this.respondError(frame.id, "invalid_request", parsed.message, "not_started");
      return;
    }
    try {
      await ptc.replyVm(session.sessionId, parsed.value);
      if (this.closed) return;
      this.respondOk(frame.id, { callId: parsed.value.callId, delivered: true });
    } catch (error) {
      const failure = this.hostFailure(error);
      this.respondError(frame.id, failure.code, failure.message, failure.outcome);
    }
  }

  private hostFailure(error: unknown): Failure {
    if (error instanceof PtcHostError) {
      return { code: error.code, message: error.message, outcome: error.outcome };
    }
    return { code: "internal", message: "PTC sandbox failed to handle the request", outcome: "failed" };
  }

  private failureFor(error: unknown, pending: PendingExecution): Failure {
    if (pending.abortReason === "timeout") {
      return { code: "timeout", message: "execution deadline exceeded", outcome: "unknown" };
    }
    if (pending.abortReason !== undefined) {
      return { code: "aborted", message: "execution was aborted", outcome: "unknown" };
    }
    if (error instanceof PtcHostError) {
      return { code: error.code, message: error.message, outcome: error.outcome };
    }
    if (error instanceof RpcAbortError) {
      return { code: "aborted", message: "execution was aborted", outcome: "unknown" };
    }
    if (error instanceof TestExecutionError) {
      return { code: "test_error", message: error.message, outcome: "failed" };
    }
    return { code: "internal", message: "executor failed", outcome: "failed" };
  }

  private finish(pending: PendingExecution, session: Session): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.deadline !== undefined) clearTimeout(pending.deadline);
    this.requests.delete(pending.id);
    session.requests.delete(pending.id);
    if (session.vmRequestId === pending.id) session.vmRequestId = undefined;
    if (session.toolCallRequestId === pending.id) session.toolCallRequestId = undefined;
    this.active--;
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
    pending.abortReason = "cancel";
    this.options.ptc?.cancel(pending.sessionId, targetId);
    pending.controller.abort("cancelled");
    this.respondOk(frame.id, { targetId, cancelled: true });
  }

  private handleClose(): void {
    clearInterval(this.heartbeat);
    clearInterval(this.sweeper);
    for (const pending of this.requests.values()) {
      pending.abortReason = "disconnect";
      this.options.ptc?.cancel(pending.sessionId, pending.id);
      pending.controller.abort("disconnected");
    }
    for (const sessionId of this.sessions.keys()) {
      void this.options.ptc?.closeSession(sessionId).catch(() => undefined);
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

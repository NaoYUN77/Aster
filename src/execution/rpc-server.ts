import {
  RPC_PROTOCOL_VERSION,
  parseTestExecutePayload,
  type RpcErrorCode,
  type RpcFrame,
  type RpcOutcome,
  type RpcRequestFrame,
  type RpcTestExecutePayload,
} from "./rpc-protocol.js";
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
};

type PendingExecution = {
  readonly id: string;
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
          this.respondOk(frame.id, this.preflight());
          return;
        case "session.open":
          this.openSession(frame);
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
        case "vm.start":
        case "vm.message":
        case "vm.reply":
          this.respondError(frame.id, "not_implemented", `${frame.method} is not implemented in Phase 0`);
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
      agentVersion: this.options.agentVersion ?? "phase0",
      phase: 0,
      transport: this.options.transport,
      peer: this.peer.peer ?? null,
      methods: PHASE0_METHODS,
      testExecutor: this.testExecutorEnabled,
    };
  }

  private preflight(): Record<string, unknown> {
    return {
      ok: this.testExecutorEnabled,
      executionId: this.options.executionId,
      agentVersion: this.options.agentVersion ?? "phase0",
      checks: {
        testExecutor: this.testExecutorEnabled,
        mutualTls: this.options.transport === "tls" ? this.peer.authorized : null,
      },
    };
  }

  private openSession(frame: RpcRequestFrame): void {
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
    this.sessions.set(sessionId, session);
    this.respondOk(frame.id, {
      sessionId,
      executionId: this.options.executionId,
      ...(session.jobId === undefined ? {} : { jobId: session.jobId }),
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
      pending.controller.abort("session closed");
    }
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

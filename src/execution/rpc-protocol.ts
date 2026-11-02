/**
 * Phase 0 wire contract for the resident execution agent. Frames are length-prefixed JSON: a
 * 4-byte big-endian payload length followed by UTF-8 JSON. The protocol is deliberately small and
 * strict; the transport may be a Unix socket for local tests or TCP/TLS with mutual certificates
 * across VPS hosts. Phase 0 only exposes the restricted test executor through this protocol.
 */

export const RPC_PROTOCOL_VERSION = 1;
export const RPC_HEADER_BYTES = 4;
export const RPC_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const RPC_MAX_OUTPUT_CHUNK_BYTES = 64 * 1024;
export const RPC_MIN_DEADLINE_MS = 1;
export const RPC_MAX_DEADLINE_MS = 3_600_000;
export const RPC_MAX_ID_BYTES = 64;
export const RPC_MAX_JOB_ID_BYTES = 128;
export const RPC_MAX_REASON_BYTES = 512;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type RpcMethod =
  | "health.check"
  | "preflight"
  | "session.open"
  | "session.close"
  | "execute"
  | "tool.call"
  | "cancel"
  | "vm.start"
  | "vm.message"
  | "vm.reply";

export type RpcErrorCode =
  | "invalid_request"
  | "unsupported_version"
  | "not_found"
  | "busy"
  | "not_implemented"
  | "timeout"
  | "aborted"
  | "too_large"
  | "spawn_error"
  | "unavailable"
  | "protocol_error"
  | "test_error"
  | "internal";

export type RpcOutcome = "not_started" | "failed" | "unknown";

export type RpcErrorPayload = {
  readonly code: RpcErrorCode;
  readonly message: string;
  readonly outcome?: RpcOutcome;
  readonly retryable?: boolean;
};

export type RpcRequestFrame = {
  readonly v: 1;
  readonly kind: "request";
  readonly id: string;
  readonly method: RpcMethod;
  readonly sessionId?: string;
  readonly jobId?: string;
  readonly correlationId?: string;
  readonly deadlineMs: number;
  readonly payload: Record<string, unknown>;
};

export type RpcResponseFrame =
  | {
      readonly v: 1;
      readonly kind: "response";
      readonly id: string;
      readonly correlationId?: string;
      readonly status: "ok";
      readonly result?: unknown;
    }
  | {
      readonly v: 1;
      readonly kind: "response";
      readonly id: string;
      readonly correlationId?: string;
      readonly status: "error";
      readonly error: RpcErrorPayload;
    };

export type RpcOutputEvent = {
  readonly v: 1;
  readonly kind: "event";
  readonly event: "output";
  readonly id: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
};

export type RpcHeartbeatEvent = {
  readonly v: 1;
  readonly kind: "event";
  readonly event: "heartbeat";
  readonly timestamp: number;
  readonly sessionId?: string;
};

export type RpcSessionClosedEvent = {
  readonly v: 1;
  readonly kind: "event";
  readonly event: "session.closed";
  readonly sessionId: string;
  readonly reason: string;
};

export type RpcEventFrame = RpcOutputEvent | RpcHeartbeatEvent | RpcSessionClosedEvent;

export type RpcFrame = RpcRequestFrame | RpcResponseFrame | RpcEventFrame;

export type ParseResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly message: string };

export class RpcProtocolError extends Error {
  override name = "RpcProtocolError";

  constructor(
    readonly code: "invalid_request" | "too_large" | "protocol_error",
    message: string,
  ) {
    super(message);
  }
}

export type RpcTestExecutePayload =
  | {
      readonly executor: "test";
      readonly operation: "echo";
      readonly text: string;
    }
  | {
      readonly executor: "test";
      readonly operation: "stream";
      readonly chunks: number;
      readonly chunkBytes: number;
      readonly delayMs?: number;
    }
  | {
      readonly executor: "test";
      readonly operation: "sleep";
      readonly ms: number;
    }
  | {
      readonly executor: "test";
      readonly operation: "fail";
      readonly code: "test_error";
    };

const METHODS = new Set<RpcMethod>([
  "health.check",
  "preflight",
  "session.open",
  "session.close",
  "execute",
  "tool.call",
  "cancel",
  "vm.start",
  "vm.message",
  "vm.reply",
]);

const ERROR_CODES = new Set<RpcErrorCode>([
  "invalid_request",
  "unsupported_version",
  "not_found",
  "busy",
  "not_implemented",
  "timeout",
  "aborted",
  "too_large",
  "spawn_error",
  "unavailable",
  "protocol_error",
  "test_error",
  "internal",
]);

const OUTCOMES = new Set<RpcOutcome>(["not_started", "failed", "unknown"]);

function fail<TValue>(message: string): ParseResult<TValue> {
  return { ok: false, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function unexpectedKey(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  const accepted = new Set(allowed);
  return Object.keys(value).find((key) => !accepted.has(key));
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value) && byteLength(value) <= RPC_MAX_ID_BYTES;
}

function isSafeJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID_PATTERN.test(value) && byteLength(value) <= RPC_MAX_JOB_ID_BYTES;
}

function isSafeReason(value: unknown): value is string {
  return typeof value === "string" && byteLength(value) <= RPC_MAX_REASON_BYTES;
}

function isSafeCorrelationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && byteLength(value) <= 128;
}

function isSafeText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && byteLength(value) <= maxBytes;
}

function validateErrorPayload(value: unknown): ParseResult<RpcErrorPayload> {
  if (!isPlainObject(value)) return fail("error must be an object");
  const unknown = unexpectedKey(value, ["code", "message", "outcome", "retryable"]);
  if (unknown !== undefined) return fail(`unknown error field: ${unknown}`);
  if (typeof value.code !== "string" || !ERROR_CODES.has(value.code as RpcErrorCode)) {
    return fail("error.code is invalid");
  }
  if (!isSafeText(value.message, 4096)) return fail("error.message is invalid");
  if (Object.hasOwn(value, "outcome")
    && (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome as RpcOutcome))) {
    return fail("error.outcome is invalid");
  }
  if (Object.hasOwn(value, "retryable") && typeof value.retryable !== "boolean") {
    return fail("error.retryable must be a boolean");
  }
  return {
    ok: true,
    value: {
      code: value.code as RpcErrorCode,
      message: value.message,
      ...(Object.hasOwn(value, "outcome") ? { outcome: value.outcome as RpcOutcome } : {}),
      ...(Object.hasOwn(value, "retryable") ? { retryable: value.retryable as boolean } : {}),
    },
  };
}

export function parseTestExecutePayload(value: unknown): ParseResult<RpcTestExecutePayload> {
  if (!isPlainObject(value)) return fail("execute payload must be an object");
  if (value.executor !== "test") return fail("Phase 0 only implements the test executor");
  switch (value.operation) {
    case "echo": {
      const unknown = unexpectedKey(value, ["executor", "operation", "text"]);
      if (unknown !== undefined) return fail(`unknown echo field: ${unknown}`);
      if (!isSafeText(value.text, 4096)) return fail("text must be a string of at most 4096 bytes");
      return { ok: true, value: { executor: "test", operation: "echo", text: value.text } };
    }
    case "stream": {
      const unknown = unexpectedKey(value, ["executor", "operation", "chunks", "chunkBytes", "delayMs"]);
      if (unknown !== undefined) return fail(`unknown stream field: ${unknown}`);
      if (!Number.isSafeInteger(value.chunks) || (value.chunks as number) < 1 || (value.chunks as number) > 100) {
        return fail("chunks must be an integer in 1..100");
      }
      if (!Number.isSafeInteger(value.chunkBytes) || (value.chunkBytes as number) < 1
        || (value.chunkBytes as number) > 16 * 1024) {
        return fail("chunkBytes must be an integer in 1..16384");
      }
      if (Object.hasOwn(value, "delayMs")
        && (!Number.isSafeInteger(value.delayMs) || (value.delayMs as number) < 0 || (value.delayMs as number) > 1000)) {
        return fail("delayMs must be an integer in 0..1000");
      }
      return {
        ok: true,
        value: {
          executor: "test",
          operation: "stream",
          chunks: value.chunks as number,
          chunkBytes: value.chunkBytes as number,
          ...(Object.hasOwn(value, "delayMs") ? { delayMs: value.delayMs as number } : {}),
        },
      };
    }
    case "sleep": {
      const unknown = unexpectedKey(value, ["executor", "operation", "ms"]);
      if (unknown !== undefined) return fail(`unknown sleep field: ${unknown}`);
      if (!Number.isSafeInteger(value.ms) || (value.ms as number) < 1 || (value.ms as number) > 60_000) {
        return fail("ms must be an integer in 1..60000");
      }
      return { ok: true, value: { executor: "test", operation: "sleep", ms: value.ms as number } };
    }
    case "fail": {
      const unknown = unexpectedKey(value, ["executor", "operation", "code"]);
      if (unknown !== undefined) return fail(`unknown fail field: ${unknown}`);
      if (value.code !== "test_error") return fail("code must be test_error");
      return { ok: true, value: { executor: "test", operation: "fail", code: "test_error" } };
    }
    default:
      return fail("unknown test operation");
  }
}

function validateRequestPayload(method: RpcMethod, payload: unknown): ParseResult<Record<string, unknown>> {
  if (!isPlainObject(payload)) return fail("request payload must be an object");
  switch (method) {
    case "health.check":
    case "preflight": {
      const unknown = unexpectedKey(payload, []);
      return unknown === undefined ? { ok: true, value: payload } : fail(`unknown payload field: ${unknown}`);
    }
    case "session.open": {
      const unknown = unexpectedKey(payload, ["sessionId", "jobId"]);
      if (unknown !== undefined) return fail(`unknown session.open field: ${unknown}`);
      if (!isSafeId(payload.sessionId)) return fail("sessionId is invalid");
      if (Object.hasOwn(payload, "jobId") && !isSafeJobId(payload.jobId)) return fail("jobId is invalid");
      return { ok: true, value: payload };
    }
    case "session.close": {
      const unknown = unexpectedKey(payload, ["sessionId"]);
      if (unknown !== undefined) return fail(`unknown session.close field: ${unknown}`);
      if (!isSafeId(payload.sessionId)) return fail("sessionId is invalid");
      return { ok: true, value: payload };
    }
    case "cancel": {
      const unknown = unexpectedKey(payload, ["targetId", "reason"]);
      if (unknown !== undefined) return fail(`unknown cancel field: ${unknown}`);
      if (!isSafeId(payload.targetId)) return fail("targetId is invalid");
      if (Object.hasOwn(payload, "reason") && !isSafeReason(payload.reason)) return fail("reason is invalid");
      return { ok: true, value: payload };
    }
    case "execute": {
      if (typeof payload.executor !== "string" || payload.executor.length > 32) {
        return fail("execute.executor must be a string of at most 32 bytes");
      }
      if (payload.executor === "test") {
        const parsed = parseTestExecutePayload(payload);
        if (!parsed.ok) return fail(parsed.message);
      }
      // Non-test executors are parsed but rejected by the dispatcher; they are never executed.
      return { ok: true, value: payload };
    }
    case "tool.call": {
      const unknown = unexpectedKey(payload, ["tool", "callId", "args"]);
      if (unknown !== undefined) return fail(`unknown tool.call field: ${unknown}`);
      if (typeof payload.tool !== "string" || byteLength(payload.tool) > 64) return fail("tool is invalid");
      if (Object.hasOwn(payload, "callId")
        && (!Number.isSafeInteger(payload.callId) || (payload.callId as number) < 1)) {
        return fail("callId must be a positive integer");
      }
      if (Object.hasOwn(payload, "args") && !isPlainObject(payload.args)) return fail("args must be an object");
      return { ok: true, value: payload };
    }
    case "vm.start": {
      const unknown = unexpectedKey(payload, ["request"]);
      if (unknown !== undefined) return fail(`unknown vm.start field: ${unknown}`);
      if (!isPlainObject(payload.request)) return fail("request must be an object");
      return { ok: true, value: payload };
    }
    case "vm.message": {
      const unknown = unexpectedKey(payload, ["messages"]);
      if (unknown !== undefined) return fail(`unknown vm.message field: ${unknown}`);
      if (!Array.isArray(payload.messages)) return fail("messages must be an array");
      return { ok: true, value: payload };
    }
    case "vm.reply": {
      const unknown = unexpectedKey(payload, ["reply"]);
      if (unknown !== undefined) return fail(`unknown vm.reply field: ${unknown}`);
      if (!isPlainObject(payload.reply)) return fail("reply must be an object");
      return { ok: true, value: payload };
    }
    default:
      return fail("unknown method");
  }
}

function parseRequest(value: Record<string, unknown>): ParseResult<RpcRequestFrame> {
  const unknown = unexpectedKey(value, [
    "v", "kind", "id", "method", "sessionId", "jobId", "correlationId", "deadlineMs", "payload",
  ]);
  if (unknown !== undefined) return fail(`unknown request field: ${unknown}`);
  if (!isSafeId(value.id)) return fail("id is invalid");
  if (typeof value.method !== "string" || !METHODS.has(value.method as RpcMethod)) return fail("method is invalid");
  if (Object.hasOwn(value, "sessionId") && !isSafeId(value.sessionId)) return fail("sessionId is invalid");
  if (Object.hasOwn(value, "jobId") && !isSafeJobId(value.jobId)) return fail("jobId is invalid");
  if (Object.hasOwn(value, "correlationId") && !isSafeCorrelationId(value.correlationId)) {
    return fail("correlationId is invalid");
  }
  if (!Number.isSafeInteger(value.deadlineMs)
    || (value.deadlineMs as number) < RPC_MIN_DEADLINE_MS
    || (value.deadlineMs as number) > RPC_MAX_DEADLINE_MS) {
    return fail(`deadlineMs must be an integer in ${RPC_MIN_DEADLINE_MS}..${RPC_MAX_DEADLINE_MS}`);
  }
  const method = value.method as RpcMethod;
  const payload = validateRequestPayload(method, value.payload);
  if (!payload.ok) return fail(payload.message);
  return {
    ok: true,
    value: {
      v: 1,
      kind: "request",
      id: value.id,
      method,
      deadlineMs: value.deadlineMs as number,
      payload: payload.value,
      ...(Object.hasOwn(value, "sessionId") ? { sessionId: value.sessionId as string } : {}),
      ...(Object.hasOwn(value, "jobId") ? { jobId: value.jobId as string } : {}),
      ...(Object.hasOwn(value, "correlationId") ? { correlationId: value.correlationId as string } : {}),
    },
  };
}

function parseResponse(value: Record<string, unknown>): ParseResult<RpcResponseFrame> {
  const unknown = unexpectedKey(value, ["v", "kind", "id", "correlationId", "status", "result", "error"]);
  if (unknown !== undefined) return fail(`unknown response field: ${unknown}`);
  if (!isSafeId(value.id)) return fail("id is invalid");
  if (Object.hasOwn(value, "correlationId") && !isSafeCorrelationId(value.correlationId)) {
    return fail("correlationId is invalid");
  }
  const correlationId = Object.hasOwn(value, "correlationId")
    ? { correlationId: value.correlationId as string }
    : {};
  if (value.status === "ok") {
    return { ok: true, value: { v: 1, kind: "response", id: value.id, status: "ok", result: value.result, ...correlationId } };
  }
  if (value.status === "error") {
    const error = validateErrorPayload(value.error);
    if (!error.ok) return fail(error.message);
    return { ok: true, value: { v: 1, kind: "response", id: value.id, status: "error", error: error.value, ...correlationId } };
  }
  return fail("response.status is invalid");
}

function parseEvent(value: Record<string, unknown>): ParseResult<RpcEventFrame> {
  if (value.event === "output") {
    const unknown = unexpectedKey(value, ["v", "kind", "event", "id", "sessionId", "seq", "stream", "text"]);
    if (unknown !== undefined) return fail(`unknown output event field: ${unknown}`);
    if (!isSafeId(value.id)) return fail("id is invalid");
    if (!isSafeId(value.sessionId)) return fail("sessionId is invalid");
    if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0) return fail("seq is invalid");
    if (value.stream !== "stdout" && value.stream !== "stderr") return fail("stream is invalid");
    if (!isSafeText(value.text, RPC_MAX_OUTPUT_CHUNK_BYTES)) return fail("text is invalid");
    return {
      ok: true,
      value: {
        v: 1,
        kind: "event",
        event: "output",
        id: value.id,
        sessionId: value.sessionId,
        seq: value.seq as number,
        stream: value.stream,
        text: value.text,
      },
    };
  }
  if (value.event === "heartbeat") {
    const unknown = unexpectedKey(value, ["v", "kind", "event", "timestamp", "sessionId"]);
    if (unknown !== undefined) return fail(`unknown heartbeat field: ${unknown}`);
    if (!Number.isSafeInteger(value.timestamp)) return fail("timestamp is invalid");
    if (Object.hasOwn(value, "sessionId") && !isSafeId(value.sessionId)) return fail("sessionId is invalid");
    return {
      ok: true,
      value: {
        v: 1,
        kind: "event",
        event: "heartbeat",
        timestamp: value.timestamp as number,
        ...(Object.hasOwn(value, "sessionId") ? { sessionId: value.sessionId as string } : {}),
      },
    };
  }
  if (value.event === "session.closed") {
    const unknown = unexpectedKey(value, ["v", "kind", "event", "sessionId", "reason"]);
    if (unknown !== undefined) return fail(`unknown session.closed field: ${unknown}`);
    if (!isSafeId(value.sessionId)) return fail("sessionId is invalid");
    if (!isSafeReason(value.reason)) return fail("reason is invalid");
    return {
      ok: true,
      value: { v: 1, kind: "event", event: "session.closed", sessionId: value.sessionId, reason: value.reason },
    };
  }
  return fail("event is invalid");
}

export function parseRpcFrame(value: unknown): ParseResult<RpcFrame> {
  if (!isPlainObject(value)) return fail("frame must be an object");
  if (value.v !== RPC_PROTOCOL_VERSION) {
    return fail(`unsupported protocol version; expected ${RPC_PROTOCOL_VERSION}`);
  }
  if (value.kind === "request") return parseRequest(value);
  if (value.kind === "response") return parseResponse(value);
  if (value.kind === "event") return parseEvent(value);
  return fail("kind is invalid");
}

export function encodeRpcFrame(frame: RpcFrame, maxFrameBytes = RPC_MAX_FRAME_BYTES): Buffer {
  const payload = Buffer.from(JSON.stringify(frame), "utf8");
  if (payload.length > maxFrameBytes) {
    throw new RpcProtocolError("too_large", `frame exceeds ${maxFrameBytes} bytes`);
  }
  const header = Buffer.allocUnsafe(RPC_HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** Incremental decoder for a byte stream. Oversized or malformed frames fail the connection. */
export class RpcFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = RPC_MAX_FRAME_BYTES) {}

  push(chunk: Buffer): RpcFrame[] {
    if (chunk.length === 0) return [];
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: RpcFrame[] = [];
    while (this.buffer.length >= RPC_HEADER_BYTES) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0) throw new RpcProtocolError("protocol_error", "empty frame");
      if (length > this.maxFrameBytes) {
        throw new RpcProtocolError("too_large", `frame exceeds ${this.maxFrameBytes} bytes`);
      }
      if (this.buffer.length < RPC_HEADER_BYTES + length) break;
      const body = this.buffer.subarray(RPC_HEADER_BYTES, RPC_HEADER_BYTES + length).toString("utf8");
      this.buffer = this.buffer.subarray(RPC_HEADER_BYTES + length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new RpcProtocolError("protocol_error", "frame is not valid JSON");
      }
      const frame = parseRpcFrame(parsed);
      if (!frame.ok) throw new RpcProtocolError("protocol_error", frame.message);
      frames.push(frame.value);
    }
    return frames;
  }

  get bufferedBytes(): number {
    return this.buffer.length;
  }
}

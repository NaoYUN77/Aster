/**
 * Frames between the execution agent and the PTC runner that lives inside the bwrap sandbox.
 *
 * This is a private stdio protocol, not the gateway RPC protocol: stdout carries frames only, and
 * every diagnostic goes to stderr. The runner never receives a host path or a credential; its
 * world is the mounted workspace and the read-only application tree.
 */

import type {
  CodemodeRemoteMessage,
  CodemodeRemoteReply,
  CodemodeRemoteRequest,
} from "@earendil-works/pi-codemode";
import type { PtcBashArgs, PtcBashResult } from "./ptc-protocol.js";
import { RpcProtocolError } from "./rpc-protocol.js";

export const PTC_RUNNER_PROTOCOL_VERSION = 1;
export const PTC_RUNNER_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const PTC_RUNNER_HEADER_BYTES = 4;

export type RunnerFrame =
  | {
      readonly v: 1;
      readonly kind: "start";
      readonly request: CodemodeRemoteRequest;
    }
  | {
      readonly v: 1;
      readonly kind: "reply";
      readonly seq: number;
      readonly reply: CodemodeRemoteReply;
    }
  | {
      readonly v: 1;
      readonly kind: "tool";
      readonly callId: number;
      readonly args: PtcBashArgs;
    }
  | {
      readonly v: 1;
      readonly kind: "tool-cancel";
      readonly callId: number;
    }
  | {
      readonly v: 1;
      readonly kind: "shutdown";
    }
  | {
      readonly v: 1;
      readonly kind: "ready";
      readonly pid: number;
      readonly node: string;
      readonly piCodemode: string;
      readonly quickjs: string;
    }
  | {
      readonly v: 1;
      readonly kind: "message";
      readonly seq: number;
      readonly messages: readonly CodemodeRemoteMessage[];
    }
  | {
      readonly v: 1;
      readonly kind: "done";
    }
  | {
      readonly v: 1;
      readonly kind: "tool-output";
      readonly callId: number;
      readonly stream: "stdout" | "stderr";
      readonly text: string;
      readonly skipped?: {
        readonly bytes: number;
        readonly newlines: number;
        readonly endsWithNewline: boolean;
      };
    }
  | {
      readonly v: 1;
      readonly kind: "tool-result";
      readonly callId: number;
      readonly result: PtcBashResult;
    }
  | {
      readonly v: 1;
      readonly kind: "tool-error";
      readonly callId: number;
      readonly code: "timeout" | "spawn_error" | "aborted" | "output_too_large" | "failed";
      readonly message: string;
    };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function parseFrame(value: unknown): RunnerFrame {
  if (!isPlainObject(value)) throw new RpcProtocolError("protocol_error", "runner frame must be an object");
  if (value.v !== PTC_RUNNER_PROTOCOL_VERSION) {
    throw new RpcProtocolError("protocol_error", "runner protocol version mismatch");
  }
  switch (value.kind) {
    case "start":
      if (!isPlainObject(value.request) || !isPlainObject(value.request.data)) {
        throw new RpcProtocolError("protocol_error", "start.request is invalid");
      }
      return value as unknown as RunnerFrame;
    case "reply":
      if (!positiveInteger(value.seq)) throw new RpcProtocolError("protocol_error", "reply.seq is invalid");
      if (value.reply !== null && (!isPlainObject(value.reply) || typeof value.reply.type !== "string")) {
        throw new RpcProtocolError("protocol_error", "reply.reply is invalid");
      }
      return value as unknown as RunnerFrame;
    case "tool":
      if (!positiveInteger(value.callId) || !isPlainObject(value.args)) {
        throw new RpcProtocolError("protocol_error", "tool frame is invalid");
      }
      return value as unknown as RunnerFrame;
    case "tool-cancel":
      if (!positiveInteger(value.callId)) throw new RpcProtocolError("protocol_error", "tool-cancel.callId is invalid");
      return value as unknown as RunnerFrame;
    case "shutdown":
      return value as unknown as RunnerFrame;
    case "ready":
      if (!nonNegativeInteger(value.pid) || typeof value.node !== "string"
        || typeof value.piCodemode !== "string" || typeof value.quickjs !== "string") {
        throw new RpcProtocolError("protocol_error", "ready frame is invalid");
      }
      return value as unknown as RunnerFrame;
    case "message":
      if (!positiveInteger(value.seq) || !Array.isArray(value.messages) || value.messages.length === 0) {
        throw new RpcProtocolError("protocol_error", "message frame is invalid");
      }
      return value as unknown as RunnerFrame;
    case "done":
      return value as unknown as RunnerFrame;
    case "tool-output":
      if (!positiveInteger(value.callId) || (value.stream !== "stdout" && value.stream !== "stderr")
        || typeof value.text !== "string") {
        throw new RpcProtocolError("protocol_error", "tool-output frame is invalid");
      }
      return value as unknown as RunnerFrame;
    case "tool-result":
      if (!positiveInteger(value.callId) || !isPlainObject(value.result)) {
        throw new RpcProtocolError("protocol_error", "tool-result frame is invalid");
      }
      return value as unknown as RunnerFrame;
    case "tool-error":
      if (!positiveInteger(value.callId) || typeof value.code !== "string" || typeof value.message !== "string") {
        throw new RpcProtocolError("protocol_error", "tool-error frame is invalid");
      }
      return value as unknown as RunnerFrame;
    default:
      throw new RpcProtocolError("protocol_error", "runner frame kind is invalid");
  }
}

export function encodeRunnerFrame(frame: RunnerFrame, maxFrameBytes = PTC_RUNNER_MAX_FRAME_BYTES): Buffer {
  const payload = Buffer.from(JSON.stringify(frame), "utf8");
  if (payload.length > maxFrameBytes) {
    throw new RpcProtocolError("too_large", `runner frame exceeds ${maxFrameBytes} bytes`);
  }
  const header = Buffer.allocUnsafe(PTC_RUNNER_HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** Incremental decoder for the runner's stdio stream. A malformed frame ends the sandbox. */
export class RunnerFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = PTC_RUNNER_MAX_FRAME_BYTES) {}

  push(chunk: Buffer): RunnerFrame[] {
    if (chunk.length === 0) return [];
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: RunnerFrame[] = [];
    while (this.buffer.length >= PTC_RUNNER_HEADER_BYTES) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0) throw new RpcProtocolError("protocol_error", "empty runner frame");
      if (length > this.maxFrameBytes) {
        throw new RpcProtocolError("too_large", `runner frame exceeds ${this.maxFrameBytes} bytes`);
      }
      if (this.buffer.length < PTC_RUNNER_HEADER_BYTES + length) break;
      const body = this.buffer.subarray(PTC_RUNNER_HEADER_BYTES, PTC_RUNNER_HEADER_BYTES + length).toString("utf8");
      this.buffer = this.buffer.subarray(PTC_RUNNER_HEADER_BYTES + length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new RpcProtocolError("protocol_error", "runner frame is not valid JSON");
      }
      frames.push(parseFrame(parsed));
    }
    return frames;
  }

  get bufferedBytes(): number {
    return this.buffer.length;
  }
}

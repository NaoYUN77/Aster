/**
 * Phase 1 remote PTC payloads carried inside the Phase 0 RPC envelope.
 *
 * The VM itself talks to the runner that runs beside it in the bwrap sandbox. The gateway only sees
 * the payloads below, and every payload is parsed strictly before anything is forwarded or executed.
 * All paths named by the control plane are sandbox paths (`/workspace`); host paths never cross the
 * RPC boundary.
 */

import type {
  CodemodeRemoteMessage,
  CodemodeRemoteReply,
  CodemodeRemoteRequest,
} from "@earendil-works/pi-codemode";
import type { ParseResult } from "./rpc-protocol.js";

export const PTC_MAX_COMMAND_BYTES = 1024 * 1024;
export const PTC_MAX_ARGV_ITEMS = 256;
export const PTC_MAX_ENV_ENTRIES = 64;
export const PTC_MAX_ENV_VALUE_BYTES = 4096;
export const PTC_MAX_VM_MESSAGES = 1000;
export const PTC_MAX_OUTPUT_REF_PATH_BYTES = 4096;

export const PTC_WORKSPACE = "/workspace";
export const PTC_OUTPUT_DIRECTORY = "/workspace/.ptc/outputs";

/** The merged tail the runner keeps and the control plane receives. Values are clamped by the agent. */
export type PtcOutputWindow = {
  readonly maxBytes: number;
  readonly maxLines: number;
  readonly minIntervalMs: number;
  readonly bytesPerSecond: number;
};

export type PtcBashArgs = {
  readonly command: string | readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly inheritEnv: boolean;
  readonly timeoutMs: number;
  readonly window: PtcOutputWindow;
};

export type PtcToolCallPayload = {
  readonly tool: "bash";
  readonly callId: number;
  readonly args: PtcBashArgs;
};

/**
 * A content-addressed reference to the complete output kept on the execution host. The control
 * plane stores this metadata only; it never receives the blob itself.
 */
export type OutputRef = {
  readonly blobId: string;
  readonly jobId: string;
  readonly sessionId: string;
  readonly callId: number;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: "available" | "evicted" | "unknown";
};

export type PtcBashResult = {
  readonly exitCode: number;
  readonly truncated: boolean;
  readonly skippedBytes: number;
  readonly skippedLines: number;
  readonly outputRef?: OutputRef;
  readonly spillTruncated?: boolean;
  readonly durationMs: number;
};

export type PtcVmStartPayload = {
  readonly request: CodemodeRemoteRequest;
};

export type PtcVmMessagePayload = {
  readonly messages: readonly CodemodeRemoteMessage[];
};

export type PtcVmReplyPayload = {
  readonly reply: CodemodeRemoteReply;
};

const WINDOW_MIN_BYTES = 256;
const WINDOW_MAX_BYTES = 16 * 1024 * 1024;
const WINDOW_MAX_LINES = 1_000_000;
const WINDOW_MAX_INTERVAL_MS = 60_000;
const WINDOW_MAX_RATE = 1_000_000_000;
const MAX_TIMEOUT_MS = 3_600_000;
const MAX_SHA256 = /^[a-f0-9]{64}$/;
const BLOB_ID = /^[a-f0-9]{64}$/;
const SAFE_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED_ENV_KEYS = new Set([
  "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT",
  "BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH", "IFS", "SHELLOPTS", "BASHOPTS",
]);

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

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parsePtcOutputWindow(value: unknown): ParseResult<PtcOutputWindow> {
  if (!isPlainObject(value)) return fail("window must be an object");
  const unknown = unexpectedKey(value, ["maxBytes", "maxLines", "minIntervalMs", "bytesPerSecond"]);
  if (unknown !== undefined) return fail(`unknown window field: ${unknown}`);
  if (!Number.isSafeInteger(value.maxBytes) || (value.maxBytes as number) < WINDOW_MIN_BYTES
    || (value.maxBytes as number) > WINDOW_MAX_BYTES) {
    return fail(`window.maxBytes must be an integer in ${WINDOW_MIN_BYTES}..${WINDOW_MAX_BYTES}`);
  }
  if (!Number.isSafeInteger(value.maxLines) || (value.maxLines as number) < 1
    || (value.maxLines as number) > WINDOW_MAX_LINES) {
    return fail(`window.maxLines must be an integer in 1..${WINDOW_MAX_LINES}`);
  }
  if (!Number.isSafeInteger(value.minIntervalMs) || (value.minIntervalMs as number) < 0
    || (value.minIntervalMs as number) > WINDOW_MAX_INTERVAL_MS) {
    return fail(`window.minIntervalMs must be an integer in 0..${WINDOW_MAX_INTERVAL_MS}`);
  }
  if (!Number.isSafeInteger(value.bytesPerSecond) || (value.bytesPerSecond as number) < 1
    || (value.bytesPerSecond as number) > WINDOW_MAX_RATE) {
    return fail(`window.bytesPerSecond must be an integer in 1..${WINDOW_MAX_RATE}`);
  }
  return {
    ok: true,
    value: {
      maxBytes: value.maxBytes as number,
      maxLines: value.maxLines as number,
      minIntervalMs: value.minIntervalMs as number,
      bytesPerSecond: value.bytesPerSecond as number,
    },
  };
}

function parseCommand(value: unknown): ParseResult<string | readonly string[]> {
  if (typeof value === "string") {
    if (value.length === 0) return fail("command must not be empty");
    if (byteLength(value) > PTC_MAX_COMMAND_BYTES) return fail("command is too large");
    return { ok: true, value };
  }
  if (!Array.isArray(value)) return fail("command must be a string or an argument array");
  if (value.length === 0) return fail("command argv must not be empty");
  if (value.length > PTC_MAX_ARGV_ITEMS) return fail("command argv has too many items");
  for (const item of value) {
    if (typeof item !== "string") return fail("command argv items must be strings");
    if (item.includes("\0")) return fail("command argv items must not contain NUL");
    if (byteLength(item) > PTC_MAX_COMMAND_BYTES) return fail("command argv item is too large");
  }
  return { ok: true, value: value as string[] };
}

export function parseCwd(value: unknown): ParseResult<string> {
  if (typeof value !== "string") return fail("args.cwd must be a string");
  if (value.includes("\0")) return fail("args.cwd must not contain NUL");
  if (value !== PTC_WORKSPACE && !value.startsWith(`${PTC_WORKSPACE}/`)) {
    return fail("args.cwd must be /workspace or a path below it");
  }
  // Resolve `..` segments and require the result to remain inside /workspace. The prefix check
  // above only sees the literal spelling, so a path like `/workspace/../etc` must be rejected
  // after resolution as well.
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return fail("args.cwd must not escape /workspace");
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const normalized = `/${segments.join("/")}`;
  if (normalized !== PTC_WORKSPACE && !normalized.startsWith(`${PTC_WORKSPACE}/`)) {
    return fail("args.cwd must not escape /workspace");
  }
  return { ok: true, value: normalized };
}

function parseEnv(value: unknown): ParseResult<Record<string, string>> {
  if (!isPlainObject(value)) return fail("args.env must be an object");
  const entries = Object.entries(value);
  if (entries.length > PTC_MAX_ENV_ENTRIES) return fail("args.env has too many entries");
  const env: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!SAFE_ENV_KEY.test(key)) return fail(`args.env key is invalid: ${key.slice(0, 64)}`);
    if (RESERVED_ENV_KEYS.has(key)) return fail(`args.env must not override ${key}`);
    if (typeof entry !== "string") return fail(`args.env.${key} must be a string`);
    if (entry.includes("\0")) return fail(`args.env.${key} must not contain NUL`);
    if (byteLength(entry) > PTC_MAX_ENV_VALUE_BYTES) return fail(`args.env.${key} is too large`);
    env[key] = entry;
  }
  return { ok: true, value: env };
}

export function parsePtcToolCallPayload(value: unknown): ParseResult<PtcToolCallPayload> {
  if (!isPlainObject(value)) return fail("tool.call payload must be an object");
  const unknown = unexpectedKey(value, ["tool", "callId", "args"]);
  if (unknown !== undefined) return fail(`unknown tool.call field: ${unknown}`);
  if (value.tool !== "bash") return fail("Phase 1 only implements the bash PTC tool");
  if (!positiveInteger(value.callId)) return fail("callId must be a positive integer");
  if (!isPlainObject(value.args)) return fail("args must be an object");
  const argsUnknown = unexpectedKey(value.args, [
    "command", "cwd", "env", "inheritEnv", "timeoutMs", "window",
  ]);
  if (argsUnknown !== undefined) return fail(`unknown args field: ${argsUnknown}`);
  const command = parseCommand(value.args.command);
  if (!command.ok) return fail(command.message);
  const cwd = parseCwd(value.args.cwd);
  if (!cwd.ok) return fail(cwd.message);
  const env = parseEnv(value.args.env);
  if (!env.ok) return fail(env.message);
  if (typeof value.args.inheritEnv !== "boolean") return fail("args.inheritEnv must be a boolean");
  if (!Number.isSafeInteger(value.args.timeoutMs) || (value.args.timeoutMs as number) < 1
    || (value.args.timeoutMs as number) > MAX_TIMEOUT_MS) {
    return fail(`args.timeoutMs must be an integer in 1..${MAX_TIMEOUT_MS}`);
  }
  const window = parsePtcOutputWindow(value.args.window);
  if (!window.ok) return fail(window.message);
  return {
    ok: true,
    value: {
      tool: "bash",
      callId: value.callId,
      args: {
        command: command.value,
        cwd: cwd.value,
        env: env.value,
        // The sandbox never inherits the agent's environment; the caller's flag is recorded but
        // cannot widen the sandbox.
        inheritEnv: value.args.inheritEnv,
        timeoutMs: value.args.timeoutMs as number,
        window: window.value,
      },
    },
  };
}

export function parseOutputRef(value: unknown): ParseResult<OutputRef> {
  if (!isPlainObject(value)) return fail("outputRef must be an object");
  const unknown = unexpectedKey(value, [
    "blobId", "jobId", "sessionId", "callId", "path", "size", "sha256",
    "createdAt", "expiresAt", "state",
  ]);
  if (unknown !== undefined) return fail(`unknown outputRef field: ${unknown}`);
  for (const key of ["blobId", "sha256"] as const) {
    if (typeof value[key] !== "string" || !MAX_SHA256.test(value[key] as string)) {
      return fail(`outputRef.${key} must be a lowercase sha256`);
    }
  }
  if (typeof value.jobId !== "string" || !/^ptc-[a-f0-9]{32}$/.test(value.jobId)) {
    return fail("outputRef.jobId is invalid");
  }
  if (typeof value.sessionId !== "string" || !/^[a-f0-9]{16}$/.test(value.sessionId)) {
    return fail("outputRef.sessionId is invalid");
  }
  if (!positiveInteger(value.callId)) return fail("outputRef.callId is invalid");
  if (typeof value.path !== "string" || value.path.length === 0
    || byteLength(value.path) > PTC_MAX_OUTPUT_REF_PATH_BYTES
    || !value.path.startsWith(`${PTC_OUTPUT_DIRECTORY}/`)) {
    return fail("outputRef.path is invalid");
  }
  if (!nonNegativeInteger(value.size)) return fail("outputRef.size is invalid");
  if (!nonNegativeInteger(value.createdAt) || !nonNegativeInteger(value.expiresAt)) {
    return fail("outputRef timestamps are invalid");
  }
  if (value.state !== "available" && value.state !== "evicted" && value.state !== "unknown") {
    return fail("outputRef.state is invalid");
  }
  if (!BLOB_ID.test(value.blobId as string)) return fail("outputRef.blobId is invalid");
  return {
    ok: true,
    value: {
      blobId: value.blobId as string,
      jobId: value.jobId,
      sessionId: value.sessionId,
      callId: value.callId,
      path: value.path,
      size: value.size as number,
      sha256: value.sha256 as string,
      createdAt: value.createdAt as number,
      expiresAt: value.expiresAt as number,
      state: value.state,
    },
  };
}

export function parsePtcBashResult(value: unknown): ParseResult<PtcBashResult> {
  if (!isPlainObject(value)) return fail("tool result must be an object");
  const unknown = unexpectedKey(value, [
    "exitCode", "truncated", "skippedBytes", "skippedLines", "outputRef", "spillTruncated", "durationMs",
  ]);
  if (unknown !== undefined) return fail(`unknown tool result field: ${unknown}`);
  if (!Number.isSafeInteger(value.exitCode)) return fail("exitCode is invalid");
  if (typeof value.truncated !== "boolean") return fail("truncated must be a boolean");
  if (!nonNegativeInteger(value.skippedBytes)) return fail("skippedBytes is invalid");
  if (!nonNegativeInteger(value.skippedLines)) return fail("skippedLines is invalid");
  if (!nonNegativeInteger(value.durationMs)) return fail("durationMs is invalid");
  if (Object.hasOwn(value, "spillTruncated") && typeof value.spillTruncated !== "boolean") {
    return fail("spillTruncated must be a boolean");
  }
  let outputRef: OutputRef | undefined;
  if (Object.hasOwn(value, "outputRef")) {
    const parsed = parseOutputRef(value.outputRef);
    if (!parsed.ok) return fail(parsed.message);
    outputRef = parsed.value;
  }
  return {
    ok: true,
    value: {
      exitCode: value.exitCode as number,
      truncated: value.truncated,
      skippedBytes: value.skippedBytes as number,
      skippedLines: value.skippedLines as number,
      durationMs: value.durationMs as number,
      ...(outputRef === undefined ? {} : { outputRef }),
      ...(Object.hasOwn(value, "spillTruncated") ? { spillTruncated: value.spillTruncated as boolean } : {}),
    },
  };
}

export function parsePtcVmStartPayload(value: unknown): ParseResult<PtcVmStartPayload> {
  if (!isPlainObject(value)) return fail("vm.start payload must be an object");
  const unknown = unexpectedKey(value, ["request"]);
  if (unknown !== undefined) return fail(`unknown vm.start field: ${unknown}`);
  if (!isPlainObject(value.request)) return fail("vm.start request must be an object");
  const requestUnknown = unexpectedKey(value.request, ["data", "interruptBudget"]);
  if (requestUnknown !== undefined) return fail(`unknown vm.start request field: ${requestUnknown}`);
  if (!isPlainObject(value.request.data)) return fail("vm.start request.data must be an object");
  if (Object.hasOwn(value.request, "interruptBudget")
    && (!Number.isSafeInteger(value.request.interruptBudget) || (value.request.interruptBudget as number) < 1)) {
    return fail("vm.start interruptBudget must be a positive integer");
  }
  return { ok: true, value: { request: value.request as unknown as CodemodeRemoteRequest } };
}

export function parsePtcVmMessagePayload(value: unknown): ParseResult<PtcVmMessagePayload> {
  if (!isPlainObject(value)) return fail("vm.message payload must be an object");
  const unknown = unexpectedKey(value, ["messages"]);
  if (unknown !== undefined) return fail(`unknown vm.message field: ${unknown}`);
  if (!Array.isArray(value.messages)) return fail("messages must be an array");
  if (value.messages.length === 0) return fail("messages must not be empty");
  if (value.messages.length > PTC_MAX_VM_MESSAGES) return fail("messages has too many items");
  for (const message of value.messages) {
    if (!isPlainObject(message) || typeof message.type !== "string") {
      return fail("each VM message must be an object with a type");
    }
  }
  return { ok: true, value: { messages: value.messages as unknown as CodemodeRemoteMessage[] } };
}

export function parsePtcVmReplyPayload(value: unknown): ParseResult<PtcVmReplyPayload> {
  if (!isPlainObject(value)) return fail("vm.reply payload must be an object");
  const unknown = unexpectedKey(value, ["reply"]);
  if (unknown !== undefined) return fail(`unknown vm.reply field: ${unknown}`);
  if (value.reply === null) return { ok: true, value: { reply: null } };
  if (!isPlainObject(value.reply) || typeof value.reply.type !== "string") {
    return fail("vm.reply reply must be an object with a type or null");
  }
  return { ok: true, value: { reply: value.reply as unknown as CodemodeRemoteReply } };
}

/** The call ids inside one VM exchange; the agent only admits a tool.call for one of them. */
export function callIdsInMessages(messages: readonly CodemodeRemoteMessage[]): number[] {
  const ids: number[] = [];
  for (const message of messages) {
    if (message.type === "call" && positiveInteger(message.id)) ids.push(message.id);
  }
  return ids;
}

// A PTC host for tests that runs the real runner-side bridge (`PtcRunnerCore`) and its QuickJS VM
// in-process, with `executeBash` standing in for the sandboxed command. Everything between the
// gateway and the agent still crosses real RPC framing, payload validation, session state and the
// vm.reply cycle, so control-plane tests cover their half of Phase 1 without bwrap or cgroups.
import { PtcHostError, type PtcEventSink, type PtcHost } from "../src/execution/ptc-host.js";
import { PtcRunnerCore } from "../src/execution/ptc-runner-core.js";
import type { HostToRunner, RunnerToHost } from "../src/execution/ptc-runner-protocol.js";
import type {
  PtcIsolationState,
  PtcToolCallArgs,
  PtcToolCallPayload,
  PtcToolCallResult,
  PtcVmReplyPayload,
  PtcVmStartPayload,
  PtcWorkspaceState,
} from "../src/execution/rpc-protocol.js";

export type TestPtcCall = {
  readonly callId: number;
  readonly args: PtcToolCallArgs;
};

type PendingTool = {
  resolve(result: PtcToolCallResult): void;
  reject(error: unknown): void;
};

type TestSession = {
  readonly jobId: string;
  core?: PtcRunnerCore;
  pending?: Map<number, PendingTool>;
  /** The running tool.call's sink; its events belong to that request, not to vm.start. */
  toolSink?: PtcEventSink;
};

export class TestPtcHost implements PtcHost {
  readonly enabled = true;
  readonly isolation: PtcIsolationState = {
    mode: "degraded-prlimit",
    bwrap: false,
    userNamespace: false,
    cgroup: "none",
    network: "none",
  };
  /** Every nested call the agent's sandbox actually ran, in order. */
  readonly calls: TestPtcCall[] = [];
  readonly #sessions = new Map<string, TestSession>();

  async preflight(): Promise<Record<string, boolean | null>> {
    return { usable: true };
  }

  async openSession(sessionId: string, jobId: string, workspaceReady: boolean): Promise<PtcWorkspaceState> {
    if (this.#sessions.has(sessionId)) throw new PtcHostError("busy", "session already exists", "not_started");
    this.#sessions.set(sessionId, { jobId });
    return { path: "/workspace", created: !workspaceReady, reused: workspaceReady };
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    this.#sessions.delete(sessionId);
    session?.core?.cancel();
  }

  async startVm(input: {
    sessionId: string;
    request: PtcVmStartPayload["request"];
    signal: AbortSignal;
    sink: PtcEventSink;
  }): Promise<unknown> {
    const session = this.#sessions.get(input.sessionId);
    if (session === undefined) throw new PtcHostError("not_found", "session is not open", "not_started");
    if (session.core !== undefined) throw new PtcHostError("busy", "a VM is already running", "not_started");

    let settle: (error?: Error) => void = () => undefined;
    const done = new Promise<void>((resolve, reject) => {
      settle = (error) => error === undefined ? resolve() : reject(error);
    });
    const pending = new Map<number, PendingTool>();
    const send = (frame: RunnerToHost): void => {
      switch (frame.t) {
        case "vm":
          input.sink.vmMessage(frame.callId, frame.messages);
          return;
        case "tool.output":
          (session.toolSink ?? input.sink).toolOutput(frame.seq, frame.stream, frame.text, frame.skipped);
          return;
        case "tool.done":
          pending.get(frame.callId)?.resolve(frame.result);
          pending.delete(frame.callId);
          return;
        case "tool.error":
          pending.get(frame.callId)?.reject(new PtcHostError(frame.code, frame.message));
          pending.delete(frame.callId);
          return;
        case "done":
          settle(undefined);
          return;
        case "error":
          settle(new PtcHostError(frame.code, frame.message));
          return;
      }
    };
    const core = new PtcRunnerCore({
      bash: {
        workspacePath: "/workspace",
        sandboxWorkspace: "/workspace",
        shellPath: "/bin/sh",
        outputMaxBytes: 64 * 1024,
        outputMaxLines: 1_000,
        outputBytesPerSecond: 0,
        spillMaxBytes: 1024 * 1024,
        jobRetentionMs: 60_000,
      },
      executeBash: async (args, callId, _identity, events) => {
        this.calls.push({ callId, args });
        events.output(`out-${callId}`, "stdout");
        return { exitCode: 0, spillTruncated: false };
      },
    }, send);
    session.core = core;
    session.pending = pending;
    try {
      const start: HostToRunner = {
        t: "start",
        jobId: session.jobId,
        sessionId: input.sessionId,
        request: input.request,
      };
      await core.handle(start);
      await done;
    } finally {
      session.core = undefined;
      session.pending = undefined;
    }
    return {};
  }

  async replyVm(sessionId: string, payload: PtcVmReplyPayload): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session?.core === undefined) throw new PtcHostError("not_found", "no VM is running", "not_started");
    await session.core.handle({ t: "reply", callId: payload.callId, reply: payload.reply });
  }

  async toolCall(input: {
    sessionId: string;
    payload: PtcToolCallPayload;
    signal: AbortSignal;
    sink: PtcEventSink;
  }): Promise<PtcToolCallResult> {
    const session = this.#sessions.get(input.sessionId);
    if (session?.core === undefined || session.pending === undefined) {
      throw new PtcHostError("not_found", "no VM is running", "not_started");
    }
    const result = new Promise<PtcToolCallResult>((resolve, reject) => {
      session.pending!.set(input.payload.callId, { resolve, reject });
    });
    session.toolSink = input.sink;
    try {
      await session.core.handle({ t: "tool.call", callId: input.payload.callId, args: input.payload.args });
      return await result;
    } finally {
      session.pending.delete(input.payload.callId);
      if (session.toolSink === input.sink) session.toolSink = undefined;
    }
  }

  cancel(sessionId: string, _requestId: string): void {
    this.#sessions.get(sessionId)?.core?.cancel();
  }
}

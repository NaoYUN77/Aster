// The control-plane half of the remote PTC sandbox.
//
// Interface
//   derivePtcJobId(conversationId, taskId)     stable identity for one code mode task
//   SessionBoundCodemodeSandbox                remote VM sandbox whose session is the one bound around start()
//   PtcGateway.start()                         prove the agent speaks PTC before accepting work
//   PtcGateway.wrapCodemodeTool(tool)          open one PTC session per code mode call, close it in finally
//   PtcGateway.wrapScriptTools(extension)      run nested bash calls through the session's VM
//   PtcGateway.close()                         close sessions, then the shared RPC connection
//
// Inputs: the validated RPC client configuration, the code mode bounds, the execution timeout bounds,
// and pi-durable's per-call API. Identity is host-derived: jobId from the conversation and the code
// mode task, sessionId from the host's random source, callId from the durable nested key. The model
// supplies only script text and tool arguments.
//
// Errors: a missing session, an unexpected nested key and a failed RPC call are errors; the bash
// wrapper never falls back to the direct broker path. Closing a session is best-effort and logged,
// because the script result is already committed and a close failure must not turn it into a lie.
//
// Side effects: RPC sessions and VM runs on the execution host, durable PtcJobDoc/PtcOutputDoc
// commits, and the sandbox binding. Full output never crosses to the control plane.

import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "@earendil-works/chord/context";
import type {
  ConversationId,
  Extension,
  TaskId,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  RemoteCodemodeSandbox,
  type CodemodeRemote,
  type CodemodeRemoteExchange,
  type CodemodeRemoteMessage,
  type CodemodeRemoteReply,
  type CodemodeRemoteRequest,
} from "@earendil-works/pi-codemode";
import { Type } from "typebox";
import { RpcClientError, type RpcExecutionClient } from "./execution/rpc-client.js";
import { connectRpcClient } from "./execution/rpc-connect.js";
import type { RpcClientConfig } from "./execution/rpc-config.js";
import {
  PTC_WORKSPACE_PATH,
  RPC_MAX_DEADLINE_MS,
  type PtcToolCallResult,
  type PtcVmStartPayload,
} from "./execution/rpc-protocol.js";
import {
  appendPtcOutputInTx,
  ensurePtcJobInTx,
  initialPtcJob,
  markPtcWorkspaceReady,
  PtcOutputRefSchema,
  type PtcOutputRef,
} from "./ptc-docs.js";
import { PtcExecutionEnv } from "./ptc-env.js";
import { parseNestedCallKey, type PtcRpcClient, type PtcSession } from "./ptc-session.js";

/** Slack over the script deadline for the runner to report its own stop. */
const VM_DEADLINE_SLACK_MS = 60_000;

/** `jobId` names one code mode task's workspace; a rerun of the same task derives the same id. */
export function derivePtcJobId(conversationId: ConversationId, taskId: TaskId): string {
  const digest = createHash("sha256")
    .update(`remote-ptc-sandbox\0${conversationId}\0${taskId}`)
    .digest("hex");
  return `ptc-${digest.slice(0, 32)}`;
}

const PTC_BASH_STRUCTURED_OUTPUT_SCHEMA = Type.Object(
  {
    output: Type.String({ description: "Combined stdout and stderr: the retained tail" }),
    truncated: Type.Boolean({ description: "Whether earlier output was dropped" }),
    exitCode: Type.Number(),
    outputRef: Type.Optional(PtcOutputRefSchema),
    spillTruncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A durable task input is an opaque JSON value; only a plain object can carry a task contract. */
function taskInputRecord(input: unknown): Record<string, unknown> | undefined {
  return isPlainRecord(input) ? input : undefined;
}

/** A nested call's `parent` is the durable task id of the code mode call that made it. */
function taskIdOrUndefined(value: unknown): TaskId | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value as TaskId
    : undefined;
}

/** The remote is looked up through the ambient binding; no script can start a VM without a session. */
class MissingSessionRemote implements CodemodeRemote {
  async execute(_request: CodemodeRemoteRequest, _exchange: CodemodeRemoteExchange): Promise<void> {
    throw new Error("No PTC session is bound to this code mode execution");
  }
}

/** One execution's bridge between the host-side exchange and the RPC `vm.*` methods. */
class RpcCodemodeRemote implements CodemodeRemote {
  constructor(
    private readonly session: PtcSession,
    private readonly deadlineMs: number,
  ) {}

  async execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange): Promise<void> {
    const data = request.data;
    const payload: PtcVmStartPayload = {
      request: {
        data: {
          code: data.code,
          tools: data.tools.map((tool) => ({
            name: tool.name,
            jsName: tool.jsName,
            description: tool.description,
          })),
          globals: data.globals.map((global) => ({ name: global.name, spread: global.spread === true })),
          store: { ...data.store },
          ...(data.memoryLimitBytes === undefined ? {} : { memoryLimitBytes: data.memoryLimitBytes }),
          ...(data.deterministic === undefined
            ? {}
            : { deterministic: { startedAt: data.deterministic.startedAt, seed: data.deterministic.seed } }),
        },
        ...(request.interruptBudget === undefined ? {} : { interruptBudget: request.interruptBudget }),
      },
    };

    let chain: Promise<void> = Promise.resolve();
    let batchFailure: unknown;
    let rpcFailure: unknown;
    const handle = this.session.client.startVm(this.session.sessionId, payload, {
      deadlineMs: this.deadlineMs,
      onVmMessage: (event) => {
        const messages = event.messages as unknown as CodemodeRemoteMessage[];
        const callId = event.callId;
        chain = chain.then(async () => {
          if (batchFailure !== undefined || rpcFailure !== undefined) return;
          let reply: CodemodeRemoteReply;
          try {
            reply = await exchange(messages);
          } catch (error) {
            batchFailure = error;
            return;
          }
          // A batch without a call is output only; the host's exchange answered null and the runner
          // expects no reply. Anything else means the two sides disagree about the protocol.
          if (callId === undefined) {
            if (reply !== null) batchFailure = new Error("The code mode host answered a batch that carried no call");
            return;
          }
          // A missing reply would leave the VM waiting forever; stop is the honest terminal answer.
          const answer = reply ?? { type: "stop" as const };
          try {
            await this.session.client.replyVm(this.session.sessionId, { callId, reply: answer });
          } catch (error) {
            batchFailure = error;
          }
        });
        // Observe the batch promise here; `execute` awaits the tail and reports the first failure.
        chain = chain.catch((error: unknown) => {
          batchFailure ??= error;
        });
      },
    });
    this.session.registerVm(() => {
      void handle.cancel("the code mode call ended").catch(() => undefined);
    });
    try {
      await handle.result;
    } catch (error) {
      rpcFailure = error;
    }
    await chain;
    this.session.registerVm(undefined);
    const failure = rpcFailure ?? batchFailure;
    if (failure !== undefined) {
      await handle.cancel("the code mode execution failed").catch(() => undefined);
      throw failure;
    }
  }
}

export type SessionBoundSandboxOptions = {
  readonly timeoutMs: number;
  readonly memoryLimitBytes: number;
};

/**
 * A remote sandbox whose VM belongs to the PTC session bound around the code mode tool call.
 * The binding is an `AsyncLocalStorage` value set before the sandbox starts the VM, so a concurrent
 * call in another conversation can never be handed this call's session.
 */
export class SessionBoundCodemodeSandbox extends RemoteCodemodeSandbox {
  readonly #bound: AsyncLocalStorage<PtcSession>;

  constructor(options: SessionBoundSandboxOptions) {
    const holder: { current?: AsyncLocalStorage<PtcSession> } = {};
    super({
      timeoutMs: options.timeoutMs,
      memoryLimitBytes: options.memoryLimitBytes,
      remote: () => {
        const session = holder.current?.getStore();
        if (session === undefined) return new MissingSessionRemote();
        const deadlineMs = Math.min(RPC_MAX_DEADLINE_MS, options.timeoutMs + VM_DEADLINE_SLACK_MS);
        return new RpcCodemodeRemote(session, deadlineMs);
      },
    });
    this.#bound = new AsyncLocalStorage<PtcSession>();
    holder.current = this.#bound;
  }

  bind<T>(session: PtcSession, run: () => T): T {
    return this.#bound.run(session, run);
  }
}

export type PtcGatewayOptions = {
  readonly rpc: RpcClientConfig;
  readonly sandbox: SessionBoundCodemodeSandbox;
  readonly defaultTimeoutSeconds: number;
  readonly maxTimeoutSeconds: number;
  /** Test seam; production connects with mutual TLS or the host socket. */
  readonly connect?: (config: RpcClientConfig) => Promise<RpcExecutionClient>;
  readonly now?: () => number;
  readonly log?: (event: Record<string, unknown>) => void;
};

type TrackedSession = {
  readonly session: PtcSession;
  close(): Promise<void>;
};

export class PtcGateway {
  readonly #options: PtcGatewayOptions;
  readonly #sandbox: SessionBoundCodemodeSandbox;
  readonly #sessions = new Map<TaskId, TrackedSession>();
  #client: RpcExecutionClient | undefined;
  #connecting: Promise<RpcExecutionClient> | undefined;

  constructor(options: PtcGatewayOptions) {
    this.#options = options;
    this.#sandbox = options.sandbox;
  }

  /** Fail closed at startup when the agent is unreachable or does not advertise PTC. */
  async start(): Promise<void> {
    const client = await this.#clientHandle();
    const health = await client.health();
    if (health.protocol !== 1 || health.ptc !== true) {
      throw new Error("The execution agent does not support the PTC sandbox");
    }
  }

  async #clientHandle(): Promise<RpcExecutionClient> {
    if (this.#client !== undefined) return this.#client;
    this.#connecting ??= (async () => {
      const connect = this.#options.connect ?? connectRpcClient;
      const client = await connect(this.#options.rpc);
      this.#client = client;
      return client;
    })();
    try {
      return await this.#connecting;
    } catch (error) {
      this.#connecting = undefined;
      throw error;
    }
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #log(event: Record<string, unknown>): void {
    this.#options.log?.(event);
  }

  /** Open the session for one code mode task; the durable job record gates workspace reuse. */
  async openSession(api: ToolExecutionApi, context: Context): Promise<TrackedSession> {
    const task = await api.getTask(api.taskId, context);
    if (task === undefined) throw new Error("The code mode task is not available");
    const input = taskInputRecord(task.input);
    if (input?.kind !== "model") {
      throw new Error("The code mode tool cannot be called from a script; start it from the model instead");
    }
    if (this.#sessions.has(api.taskId)) {
      throw new Error("A PTC session already exists for this code mode task");
    }
    const client = await this.#clientHandle();
    const jobId = derivePtcJobId(api.conversationId, api.taskId);
    const now = this.#now();
    const job = await api.commit(
      async (tx) => await ensurePtcJobInTx(tx, api.conversationId, initialPtcJob(jobId, now)),
      context,
    );
    const sessionId = randomBytes(8).toString("hex");
    let opened = false;
    try {
      const openedSession = await client.openSession(sessionId, {
        jobId,
        workspaceReady: job.workspaceReady,
        ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
      });
      opened = true;
      if (openedSession.workspaceReady === undefined) {
        throw new Error("The execution agent did not report the workspace state");
      }
      if (!job.workspaceReady) {
        if (!openedSession.workspaceReady.created) {
          // A crashed attempt may have left files; they belong to the same job and stay available.
          this.#log({ event: "ptc.workspace.reused", jobId });
        }
        await api.commit(
          async (tx) => await markPtcWorkspaceReady(tx, api.conversationId, jobId, this.#now()),
          context,
        );
      }
    } catch (error) {
      if (opened) {
        await client.closeSession(sessionId).catch(() => undefined);
      }
      throw error;
    }

    let vmCancel: (() => void) | undefined;
    let closed = false;
    const session: PtcSession = {
      client: client as PtcRpcClient,
      sessionId,
      jobId,
      conversationId: api.conversationId,
      taskId: api.taskId,
      registerVm(cancel) {
        vmCancel = cancel;
        if (closed && cancel !== undefined) cancel();
      },
    };
    const tracked: TrackedSession = {
      session,
      close: async () => {
        closed = true;
        vmCancel?.();
        vmCancel = undefined;
        try {
          await client.closeSession(sessionId);
        } catch (error) {
          const code = error instanceof RpcClientError ? error.code : "unknown";
          this.#log({ event: "ptc.session.close_failed", jobId, code });
        }
      },
    };
    this.#sessions.set(session.taskId, tracked);
    return tracked;
  }

  async closeSession(tracked: TrackedSession): Promise<void> {
    if (this.#sessions.get(tracked.session.taskId) === tracked) {
      this.#sessions.delete(tracked.session.taskId);
    }
    await tracked.close();
  }

  /** The session a nested call belongs to, resolved from its parent task only. */
  #sessionForParent(parent: TaskId): PtcSession | undefined {
    return this.#sessions.get(parent)?.session;
  }

  /** Wrap the code mode tool so its whole execution runs inside one bound PTC session. */
  wrapCodemodeTool(tool: ToolRegistration): ToolRegistration {
    const execute = tool.execute;
    return {
      ...tool,
      execute: async (args, api, context) => {
        const tracked = await this.openSession(api, context);
        try {
          return await this.#sandbox.bind(tracked.session, () => execute(args, api, context));
        } finally {
          await this.closeSession(tracked);
        }
      },
    };
  }

  /**
   * Route nested `bash` calls through the session's VM. A model-issued call keeps the environment
   * the host built for it; a nested call always gets the PTC environment or fails closed.
   */
  wrapScriptTools(extension: Extension): Extension {
    if (extension.tools === undefined) return extension;
    return {
      ...extension,
      tools: extension.tools.map((tool) => tool.name === "bash" ? this.#wrapBash(tool) : tool),
    };
  }

  #wrapBash(tool: ToolRegistration): ToolRegistration {
    const execute = tool.execute;
    return {
      ...tool,
      structuredOutputSchema: PTC_BASH_STRUCTURED_OUTPUT_SCHEMA,
      execute: async (args, api, context) => {
        const task = await api.getTask(api.taskId, context);
        const input = task === undefined ? undefined : taskInputRecord(task.input);
        if (input?.kind !== "nested") {
          return execute(args, api, context);
        }
        const parent = taskIdOrUndefined(input.parent);
        const session = parent === undefined ? undefined : this.#sessionForParent(parent);
        if (session === undefined) {
          throw new Error("No active PTC session for this nested call");
        }
        const callId = parseNestedCallKey(typeof input.key === "string" ? input.key : undefined);
        if (callId === undefined) {
          throw new Error("The nested call key is not a PTC VM call id");
        }
        const env = new PtcExecutionEnv({
          session,
          callId,
          cwd: PTC_WORKSPACE_PATH,
          defaultTimeoutSeconds: this.#options.defaultTimeoutSeconds,
          maxTimeoutSeconds: this.#options.maxTimeoutSeconds,
          onOutputRef: async (ref, commitContext) => {
            await api.commit(
              async (tx) => await appendPtcOutputInTx(
                tx,
                api.conversationId,
                session.jobId,
                ref as PtcOutputRef,
                this.#now(),
              ),
              commitContext,
            );
          },
        });
        const result = await execute(args, { ...api, env }, context);
        return withPtcBashOutput(result, env.outputRef, env.spillTruncated);
      },
    };
  }

  /** Close every open session, then the shared connection. */
  async close(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map((tracked) => tracked.close()));
    const client = this.#client;
    this.#client = undefined;
    this.#connecting = undefined;
    await client?.close();
  }
}

function withPtcBashOutput(
  result: ToolExecutionResult,
  outputRef: PtcToolCallResult["outputRef"] | undefined,
  spillTruncated: boolean,
): ToolExecutionResult {
  const structured = result.structuredOutput;
  if (!isPlainRecord(structured)) return result;
  return {
    ...result,
    structuredOutput: {
      ...structured,
      ...(outputRef === undefined ? {} : { outputRef }),
      spillTruncated,
    },
  };
}

import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { contentText } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import { AssistantEntry, Harness, type Conversation, type Extension, type Storage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  evaluateSensitiveOperation,
  isOutsideWorkspace,
  type ApprovalService,
} from "../approvals/index.js";
import type { EventHub } from "../http/events.js";
import type { UsageLedger } from "../usage/index.js";
import { createToolRegistry, personalTools, type ToolAuthority } from "../tools.js";

const context = BACKGROUND_CONTEXT;
const DEFAULT_SUBAGENT_TOOLS = ["read", "current_time"] as const;
/** Default execution budget for one sub-agent run (15 minutes; paused during approval waits). */
const DEFAULT_SUBAGENT_TIMEOUT_MS = 900_000;
const MAX_SUBAGENT_TIMEOUT_MS = 1_800_000;
const MAX_PARTIAL_SUMMARY_CHARS = 8_000;
const MAX_SUBAGENT_TURNS = 30;
const MAX_FINISHED_RESULTS = 64;
const BLOCKED_SUBAGENT_TOOLS = new Set(["spawn_subagent", "wait_subagent", "cancel_subagent"]);

export type SubagentStatus = "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

export type SubagentSnapshot = {
  readonly id: string;
  readonly task: string;
  readonly status: SubagentStatus;
  readonly currentTool: string | null;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly error?: string;
};

export type SubagentResult = {
  readonly id: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly task: string;
  readonly summary: string;
  readonly durationMs: number;
  readonly error?: string;
};

export type SubagentWaitResult =
  | SubagentResult
  | {
      readonly id: string;
      readonly status: "running" | "waiting_approval";
      readonly task: string;
      readonly summary: string;
      readonly currentTool: string | null;
      readonly durationMs: number;
      readonly timedOut: true;
    };

export type SubagentSpawnInput = {
  readonly task: string;
  readonly systemPrompt?: string;
  readonly tools?: readonly string[];
  readonly cwd?: string;
  readonly mode?: "wait" | "background";
  readonly allowWrite?: boolean;
  readonly timeoutMs?: number;
};

export type SubagentManagerOptions = {
  readonly dataDir: string;
  readonly workspace: string;
  readonly models: Models;
  readonly defaultModel: { readonly provider: string; readonly modelId: string };
  /** Base extensions available to sub-agents (filtered by `tools` allowlist). Defaults to [CodingTools, personalTools]. */
  readonly extensions?: readonly Extension[];
  readonly approvals?: ApprovalService;
  /** Optional SSE hub for broadcasting `subagent.updated` live status events. */
  readonly hub?: EventHub;
  /** Optional standalone token usage ledger (ADR-0007). */
  readonly usageLedger?: UsageLedger;
  readonly authority?: ToolAuthority;
  /** Optional custom storage factory for unit tests (defaults to disposable SQLite file). */
  readonly storageFactory?: (id: string, dbPath: string) => Promise<Storage>;
  readonly log?: (line: string) => void;
};

type ActiveSubagent = {
  readonly id: string;
  readonly task: string;
  readonly startedAt: number;
  status: "running" | "waiting_approval";
  currentTool: string | null;
  readonly controller: AbortController;
  readonly promise: Promise<SubagentResult>;
};

function buildDefaultSubagentPrompt(workingDirectory: string): string {
  return [
    "You are a bounded sub-agent executing a delegated task for the main agent.",
    `Your working directory is ${workingDirectory}. Keep file changes inside this workspace unless explicitly approved by the owner.`,
    "Work independently, use only the tools provided to you, and do not ask the user follow-up questions.",
    "When finished, return a concise, factual summary of what you observed, changed, and verified.",
  ].join("\n");
}

function createPauseableTimeout(
  timeoutMs: number,
  approvals: ApprovalService | undefined,
  onTimeout: () => void,
): { dispose: () => void } {
  let remaining = Math.max(1, timeoutMs);
  let startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let paused = (approvals?.pendingCount ?? 0) > 0;
  let disposed = false;

  const arm = () => {
    if (disposed || paused) return;
    startedAt = Date.now();
    timer = setTimeout(() => {
      timer = undefined;
      if (!disposed) onTimeout();
    }, remaining);
    timer.unref();
  };

  const pause = () => {
    if (paused || disposed) return;
    paused = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      remaining = Math.max(1, remaining - (Date.now() - startedAt));
    }
  };

  const resume = () => {
    if (!paused || disposed) return;
    paused = false;
    arm();
  };

  const unsubscribe = approvals?.subscribeWaitActive((waiting) => {
    if (waiting) pause();
    else resume();
  });

  arm();

  return {
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      unsubscribe?.();
    },
  };
}

async function extractPartialSummary(conversation: Conversation): Promise<string> {
  try {
    const page = await conversation.entries({ order: "descending" }, 20, undefined, context);
    const chunks: string[] = [];
    for (const entry of page.items) {
      if (!AssistantEntry.is(entry)) continue;
      const messages = (entry.model ?? []).flatMap((m) => (m.role === "assistant" ? [m] : []));
      const text = contentText(messages.flatMap((m) => m.content)).trim();
      if (text !== "") chunks.push(text);
    }
    if (chunks.length === 0) return "";
    chunks.reverse();
    const combined = chunks.join("\n\n");
    if (combined.length <= MAX_PARTIAL_SUMMARY_CHARS) return combined;
    return `…${combined.slice(-MAX_PARTIAL_SUMMARY_CHARS)}`;
  } catch {
    return "";
  }
}

/**
 * Manages dynamically spawned, bounded sub-agent runs (ADR-0005).
 *
 * Each sub-agent runs in its own disposable SQLite store (`subagents/sub_<id>.sqlite`) with
 * explicit instructions and tool allowlist, shares the host's `ApprovalService`, enforces a
 * single-writer workspace mutex, and unlinks its temporary SQLite files on completion or cancel.
 */
export class SubagentManager {
  private readonly subagentsDir: string;
  private readonly workspace: string;
  private readonly models: Models;
  private readonly defaultModel: { readonly provider: string; readonly modelId: string };
  private readonly extensions: readonly Extension[];
  private readonly approvals: ApprovalService | undefined;
  private readonly hub: EventHub | undefined;
  private readonly usageLedger: UsageLedger | undefined;
  private readonly authority: ToolAuthority;
  private readonly storageFactory: ((id: string, dbPath: string) => Promise<Storage>) | undefined;
  private readonly log: (line: string) => void;
  private readonly active = new Map<string, ActiveSubagent>();
  private readonly finished = new Map<string, SubagentResult>();
  private readonly waitListeners = new Set<(waiting: boolean) => void>();
  private activeWaits = 0;
  private workspaceWriterId: string | undefined;
  private closed = false;

  constructor(options: SubagentManagerOptions) {
    this.subagentsDir = join(options.dataDir, "subagents");
    this.workspace = resolve(options.workspace);
    this.models = options.models;
    this.defaultModel = options.defaultModel;
    this.extensions = options.extensions ?? [CodingTools, personalTools];
    this.approvals = options.approvals;
    this.hub = options.hub;
    this.usageLedger = options.usageLedger;
    this.authority = options.authority ?? "owner";
    this.storageFactory = options.storageFactory;
    this.log = options.log ?? ((line) => console.error(line));
  }

  get isWaiting(): boolean {
    return this.activeWaits > 0;
  }

  subscribeWaitActive(listener: (waiting: boolean) => void): () => void {
    this.waitListeners.add(listener);
    return () => {
      this.waitListeners.delete(listener);
    };
  }

  private enterWait(): () => void {
    const wasWaiting = this.activeWaits > 0;
    this.activeWaits += 1;
    if (!wasWaiting) {
      for (const listener of [...this.waitListeners]) listener(true);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeWaits = Math.max(0, this.activeWaits - 1);
      if (this.activeWaits === 0) {
        for (const listener of [...this.waitListeners]) listener(false);
      }
    };
  }

  private emitSnapshot(snapshot: SubagentSnapshot): void {
    this.hub?.broadcast("subagent.updated", snapshot);
  }

  private updateActiveState(
    id: string,
    patch: { readonly status?: "running" | "waiting_approval"; readonly currentTool?: string | null },
  ): void {
    const item = this.active.get(id);
    if (item === undefined) return;
    if (patch.status !== undefined) item.status = patch.status;
    if (patch.currentTool !== undefined) item.currentTool = patch.currentTool;
    this.emitSnapshot({
      id: item.id,
      task: item.task,
      status: item.status,
      currentTool: item.currentTool,
      startedAt: item.startedAt,
      finishedAt: null,
    });
  }

  /** Live snapshots of all currently active sub-agent runs (for SSE snapshot & HTTP GET). */
  listSnapshots(): SubagentSnapshot[] {
    return [...this.active.values()].map((item) => ({
      id: item.id,
      task: item.task,
      status: item.status,
      currentTool: item.currentTool,
      startedAt: item.startedAt,
      finishedAt: null,
    }));
  }

  /** Remove any orphaned disposable SQLite files left behind by a prior crashed process. */
  async cleanupOrphans(): Promise<void> {
    try {
      const entries = await readdir(this.subagentsDir);
      await Promise.all(
        entries
          .filter((name) => name.startsWith("sub_") && name.includes(".sqlite"))
          .map((name) => rm(join(this.subagentsDir, name), { force: true }).catch(() => undefined)),
      );
    } catch {
      // Directory does not exist yet — nothing to clean.
    }
  }

  /** List currently active sub-agent runs. */
  listActive(): { readonly id: string; readonly task: string; readonly startedAt: number }[] {
    return [...this.active.values()].map(({ id, task, startedAt }) => ({ id, task, startedAt }));
  }

  async spawn(
    input: SubagentSpawnInput,
    callerSignal?: AbortSignal,
  ): Promise<
    | { readonly mode: "wait"; readonly result: SubagentResult }
    | { readonly mode: "background"; readonly id: string; readonly status: "running" }
  > {
    if (this.closed) {
      throw Object.assign(new Error("Subagent manager is closed"), { code: "SUBAGENT_CLOSED" });
    }
    const task = input.task.trim();
    if (task === "") {
      throw Object.assign(new Error("Subagent task must be non-empty"), { code: "INVALID_REQUEST" });
    }

    const runCwd = input.cwd === undefined || input.cwd.trim() === ""
      ? this.workspace
      : resolve(this.workspace, input.cwd.trim());
    if (isOutsideWorkspace(this.workspace, this.workspace, runCwd)) {
      throw Object.assign(
        new Error(`Subagent cwd must stay inside workspace (${this.workspace})`),
        { code: "SUBAGENT_CWD_OUTSIDE_WORKSPACE" },
      );
    }

    const id = `sub_${randomBytes(6).toString("hex")}`;
    const mode = input.mode ?? "wait";
    const requestedTools = (input.tools && input.tools.length > 0 ? input.tools : DEFAULT_SUBAGENT_TOOLS)
      .filter((name) => !BLOCKED_SUBAGENT_TOOLS.has(name));
    const allowedToolSet = new Set(requestedTools);
    const wantsWrite = input.allowWrite ?? (allowedToolSet.has("write") || allowedToolSet.has("edit"));

    // Single-writer workspace mutex: if another sub-agent holds the lock, this sub-agent runs
    // without write authority so any mutating tool call escalates to the owner's approval dialog.
    let holdsWriteLock = false;
    if (wantsWrite && this.workspaceWriterId === undefined) {
      this.workspaceWriterId = id;
      holdsWriteLock = true;
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    const requestedTimeout = input.timeoutMs;
    const timeoutMs =
      requestedTimeout !== undefined && Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? Math.min(Math.trunc(requestedTimeout), MAX_SUBAGENT_TIMEOUT_MS)
        : DEFAULT_SUBAGENT_TIMEOUT_MS;

    const promise = this.runIsolated({
      id,
      task,
      systemPrompt: input.systemPrompt?.trim() || buildDefaultSubagentPrompt(runCwd),
      allowedToolSet,
      runCwd,
      holdsWriteLock,
      timeoutMs,
      controller,
    });

    const record: ActiveSubagent = {
      id,
      task,
      startedAt,
      status: "running",
      currentTool: null,
      controller,
      promise,
    };
    this.active.set(id, record);
    this.emitSnapshot({
      id,
      task,
      status: "running",
      currentTool: null,
      startedAt,
      finishedAt: null,
    });
    void promise.finally(() => {
      this.active.delete(id);
    });

    if (mode === "background") {
      return { mode: "background", id, status: "running" };
    }

    const releaseWait = this.enterWait();
    try {
      const result = await this.awaitWithCallerSignal(promise, controller, callerSignal);
      return { mode: "wait", result };
    } finally {
      releaseWait();
    }
  }

  async wait(
    ids: readonly string[],
    options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<SubagentWaitResult[]> {
    const uniqueIds = [...new Set(ids)];
    const pendingPromises: Promise<SubagentResult>[] = [];

    for (const id of uniqueIds) {
      if (this.finished.has(id)) continue;
      const running = this.active.get(id);
      if (running !== undefined) pendingPromises.push(running.promise);
    }

    const collectSnapshot = (timedOut: boolean): SubagentWaitResult[] => {
      const now = Date.now();
      return uniqueIds.map((id) => {
        const done = this.finished.get(id);
        if (done !== undefined) return done;
        const running = this.active.get(id);
        if (running !== undefined) {
          const elapsedMs = Math.max(0, now - running.startedAt);
          const stateText = running.status === "waiting_approval"
            ? "waiting for owner approval"
            : "still running in background";
          const toolNote = running.currentTool ? ` (current tool: ${running.currentTool})` : "";
          return {
            id: running.id,
            status: running.status,
            task: running.task,
            summary: timedOut
              ? `Sub-agent is ${stateText}${toolNote} after ${Math.round(elapsedMs / 1000)}s. It was NOT cancelled; call wait_subagent again to keep waiting.`
              : "",
            currentTool: running.currentTool,
            durationMs: elapsedMs,
            timedOut: true as const,
          };
        }
        return {
          id,
          status: "failed" as const,
          task: "",
          summary: "",
          durationMs: 0,
          error: `Unknown sub-agent id: ${id}`,
        };
      });
    };

    if (pendingPromises.length === 0) return collectSnapshot(false);

    const releaseWait = this.enterWait();
    try {
      const waitTimedOut = await new Promise<boolean>((resolveWait, rejectWait) => {
        let settled = false;
        let pauseableTimeout: { dispose: () => void } | undefined;

        const cleanup = () => {
          pauseableTimeout?.dispose();
          pauseableTimeout = undefined;
          options.signal?.removeEventListener("abort", onCallerAbort);
        };

        const onCallerAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          rejectWait(options.signal?.reason ?? Object.assign(new Error("Wait aborted"), { name: "AbortError" }));
        };

        if (options.signal?.aborted) {
          onCallerAbort();
          return;
        }
        options.signal?.addEventListener("abort", onCallerAbort, { once: true });

        if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
          pauseableTimeout = createPauseableTimeout(options.timeoutMs, this.approvals, () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolveWait(true);
          });
        }

        Promise.all(pendingPromises)
          .then(() => {
            if (settled) return;
            settled = true;
            cleanup();
            resolveWait(false);
          })
          .catch((error) => {
            if (settled) return;
            settled = true;
            cleanup();
            rejectWait(error);
          });
      });

      return collectSnapshot(waitTimedOut);
    } finally {
      releaseWait();
    }
  }

  async cancel(id: string): Promise<{ readonly ok: boolean; readonly status: string }> {
    const running = this.active.get(id);
    if (running === undefined) {
      const done = this.finished.get(id);
      return done === undefined
        ? { ok: false, status: "not_found" }
        : { ok: false, status: done.status };
    }
    running.controller.abort(Object.assign(new Error("Sub-agent cancelled by main agent"), { name: "AbortError" }));
    await running.promise.catch(() => undefined);
    return { ok: true, status: "cancelled" };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const running = [...this.active.values()];
    for (const item of running) {
      item.controller.abort(Object.assign(new Error("Sub-agent manager shutting down"), { name: "AbortError" }));
    }
    await Promise.allSettled(running.map((item) => item.promise));
    await this.cleanupOrphans();
  }

  private async awaitWithCallerSignal(
    promise: Promise<SubagentResult>,
    controller: AbortController,
    callerSignal?: AbortSignal,
  ): Promise<SubagentResult> {
    if (callerSignal === undefined) return promise;
    const onCallerAbort = () => {
      controller.abort(callerSignal.reason ?? Object.assign(new Error("Caller aborted"), { name: "AbortError" }));
    };
    if (callerSignal.aborted) {
      onCallerAbort();
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
    try {
      return await promise;
    } finally {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
  }

  private recordFinished(result: SubagentResult, startedAt?: number): SubagentResult {
    this.finished.set(result.id, result);
    if (this.finished.size > MAX_FINISHED_RESULTS) {
      const oldest = this.finished.keys().next().value;
      if (oldest !== undefined) this.finished.delete(oldest);
    }
    const now = Date.now();
    this.emitSnapshot({
      id: result.id,
      task: result.task,
      status: result.status,
      currentTool: null,
      startedAt: startedAt ?? Math.max(0, now - result.durationMs),
      finishedAt: now,
      ...(result.error === undefined ? {} : { error: result.error }),
    });
    return result;
  }

  private async runIsolated(params: {
    readonly id: string;
    readonly task: string;
    readonly systemPrompt: string;
    readonly allowedToolSet: ReadonlySet<string>;
    readonly runCwd: string;
    readonly holdsWriteLock: boolean;
    readonly timeoutMs: number;
    readonly controller: AbortController;
  }): Promise<SubagentResult> {
    const { id, task, systemPrompt, allowedToolSet, runCwd, holdsWriteLock, timeoutMs, controller } = params;
    const startedAt = Date.now();
    const dbPath = join(this.subagentsDir, `${id}.sqlite`);
    let storage: Storage | undefined;
    let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
    let timedOut = false;

    const pauseableTimeout = createPauseableTimeout(timeoutMs, this.approvals, () => {
      timedOut = true;
      controller.abort(Object.assign(new Error("Sub-agent timed out"), { code: "SUBAGENT_TIMEOUT", name: "AbortError" }));
    });

    try {
      await mkdir(this.subagentsDir, { recursive: true });
      await mkdir(runCwd, { recursive: true });

      const approvals = this.approvals;
      const usageLedger = this.usageLedger;
      const registry = createToolRegistry(this.extensions, {
        authority: this.authority,
        log: this.log,
        ...(usageLedger === undefined ? {} : {
          onGeneration: (message, api) => {
            const u = message.usage;
            if (u === undefined) return;
            usageLedger.record({
              timestamp: message.timestamp,
              source: "subagent",
              conversationId: api.conversationId,
              subagentId: id,
              provider: message.provider,
              modelId: message.model || message.responseModel || this.defaultModel.modelId,
              inputTokens: u.input,
              outputTokens: u.output,
              cacheReadTokens: u.cacheRead,
              cacheWriteTokens: u.cacheWrite,
              ...(u.reasoning === undefined ? {} : { reasoningTokens: u.reasoning }),
              totalTokens: u.totalTokens,
              costUsd: u.cost?.total ?? null,
              stopReason: message.stopReason,
              ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
            });
          },
        }),
        onToolLifecycle: ({ phase, tool }) => {
          this.updateActiveState(id, { currentTool: phase === "start" ? tool : null });
        },
        ...(approvals === undefined ? {} : {
          approvals: async ({ tool, args, record, signal }) => {
            const evaluation = evaluateSensitiveOperation(tool, args, record, {
              workspace: this.workspace,
              cwd: runCwd,
              caller: { kind: "subagent", subagentId: id, task },
              workspaceWriteAllowed: holdsWriteLock,
            });
            if (!evaluation.sensitive) return { allowed: true };
            this.updateActiveState(id, { status: "waiting_approval", currentTool: tool });
            try {
              return await approvals.requestApproval({
                runScopeId: id,
                caller: { kind: "subagent", subagentId: id, task },
                toolName: tool,
                args,
                evaluation,
              }, signal);
            } finally {
              this.updateActiveState(id, { status: "running" });
            }
          },
        }),
      });

      const remove = registry.snapshot().tools()
        .filter(({ tool }) => !allowedToolSet.has(tool.name))
        .map(({ tool }) => tool);

      storage = this.storageFactory !== undefined
        ? await this.storageFactory(id, dbPath)
        : await openNodeSqliteStorage(dbPath);

      harness = await Harness.open(storage, {
        models: this.models,
        registry,
        settings: { toolExecution: "sequential" },
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? runCwd }),
      }, context);

      const conversation = await harness.createConversation({
        ownership: { kind: "ownerless" },
        agent: {
          model: this.defaultModel,
          cwd: runCwd,
          instructions: systemPrompt,
          maxTurns: MAX_SUBAGENT_TURNS,
          ...(remove.length === 0 ? {} : { tools: { remove } }),
        },
      }, context);

      harness.resume();
      const submission = await conversation.submit({
        type: "input",
        content: task,
        requestId: `subagent:${id}`,
      }, context);

      let settled;
      try {
        settled = await submission.wait(withAbortSignal(controller.signal, context));
      } catch (error) {
        await conversation.abort(context).catch(() => undefined);
        const durationMs = Date.now() - startedAt;
        const partial = await extractPartialSummary(conversation);
        if (timedOut) {
          return this.recordFinished({
            id,
            status: "failed",
            task,
            summary: partial
              ? `[Timed out after ${Math.round(durationMs / 1000)}s — partial output preserved]\n${partial}`
              : "",
            durationMs,
            error: `Sub-agent timed out after ${Math.round(durationMs / 1000)}s`,
          });
        }
        if (controller.signal.aborted) {
          return this.recordFinished({
            id,
            status: "cancelled",
            task,
            summary: partial
              ? `[Cancelled after ${Math.round(durationMs / 1000)}s — partial output preserved]\n${partial}`
              : "",
            durationMs,
            error: "Sub-agent cancelled",
          });
        }
        throw error;
      }

      const durationMs = Date.now() - startedAt;
      if (settled.status !== "done" || settled.type !== "input") {
        return this.recordFinished({
          id,
          status: controller.signal.aborted ? "cancelled" : "failed",
          task,
          summary: "",
          durationMs,
          error: settled.status === "unanswered" ? `Sub-agent unanswered: ${settled.reason}` : "Sub-agent did not finish",
        });
      }

      const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
      const messages = (answer?.model ?? []).flatMap((message) => message.role === "assistant" ? [message] : []);
      const text = contentText(messages.flatMap((message) => message.content)).trim();

      return this.recordFinished({
        id,
        status: "completed",
        task,
        summary: text || "(Sub-agent completed with no text output)",
        durationMs,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      return this.recordFinished({
        id,
        status: controller.signal.aborted ? "cancelled" : "failed",
        task,
        summary: "",
        durationMs,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      pauseableTimeout.dispose();
      this.approvals?.clearRunScope(id);
      if (this.workspaceWriterId === id) {
        this.workspaceWriterId = undefined;
      }
      await harness?.close(context).catch(() => undefined);
      await storage?.close(context).catch(() => undefined);
      if (this.storageFactory === undefined) {
        await Promise.all([
          rm(dbPath, { force: true }).catch(() => undefined),
          rm(`${dbPath}-wal`, { force: true }).catch(() => undefined),
          rm(`${dbPath}-shm`, { force: true }).catch(() => undefined),
        ]);
      }
    }
  }
}

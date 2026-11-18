import type { HistoryPage, UiMessage } from "./projection.js";
import type { EventHub } from "./events.js";
import type { AgentGate } from "./agent-gate.js";
import type { ModelSelectionService } from "../model-control.js";
import type { TextRequest } from "../messages.js";
import type { RequestModelInfo, WebRequestRow, WebRequestStore } from "./store.js";

/**
 * One FIFO worker for the single-owner conversation.
 *
 * A request is claimed from `web_requests` and handed to `agent.reply()`. Only one runs at a time,
 * which is what keeps two devices from writing the same durable conversation simultaneously.
 * Progress is broadcast over SSE; the final text stays in the durable transcript.
 */

export type WebAgent = {
  reply(request: TextRequest, signal: AbortSignal): Promise<string>;
  /**
   * Join the running durable run. `done` settles with the projected assistant message, if any;
   * the worker tracks it in the background and never awaits it on shutdown.
   */
  steer(request: TextRequest): Promise<{ readonly steerId: string; readonly done: Promise<UiMessage | undefined> }>;
  abort(): Promise<void>;
  history(options?: { readonly before?: string; readonly limit?: number }): Promise<HistoryPage>;
  modelService: ModelSelectionService;
};

export type RequestWorkerOptions = {
  readonly store: WebRequestStore;
  readonly agent: WebAgent;
  readonly hub: EventHub;
  readonly ownerId: string;
  /** Serializes model turns with host notifications and routine runs. */
  readonly gate?: AgentGate;
  readonly log?: (line: string) => void;
  /** How long shutdown waits for the current generation before aborting it. */
  readonly shutdownTimeoutMs?: number;
};

export type PromoteResult =
  | { readonly ok: true; readonly mode: "steered"; readonly steerId: string }
  | { readonly ok: true; readonly mode: "started" }
  | { readonly ok: false; readonly reason: "not_queued" };

type ActiveRun = {
  readonly requestId: string;
  readonly controller: AbortController;
  readonly done: Promise<void>;
};

type LoopOutcome = { kind: "busy"; done: Promise<void> } | { kind: "idle" } | { kind: "started" };

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  MODEL_UNAVAILABLE: "模型暂时不可用",
  MODEL_INCOMPATIBLE: "所选模型不支持本次请求（例如包含图片），请先切换模型",
  AGENT_TIMEOUT: "回复超时，请重试",
  AGENT_UNANSWERED: "模型没有给出回复，请重试",
  AGENT_TRUNCATED: "回复过长被截断，请重试",
  EMPTY_REPLY: "模型没有返回内容，请重试",
  AGENT_LOOP_DETECTED: "检测到重复工具调用，已停止",
  AGENT_SESSION_FAILED: "服务内部错误，请重启服务后重试",
  PROCESS_INTERRUPTED: "服务重启，请重试",
  ABORTED: "已停止",
};

export function safeErrorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? "回复失败，请重试";
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  return "EXECUTION_ERROR";
}

export class RequestWorker {
  private readonly store: WebRequestStore;
  private readonly agent: WebAgent;
  private readonly hub: EventHub;
  private readonly ownerId: string;
  private readonly gate: AgentGate | undefined;
  private readonly log: (line: string) => void;
  private readonly shutdownTimeoutMs: number;
  private closed = false;
  private wakeUp: (() => void) | undefined;
  private loopPromise: Promise<void> | undefined;
  private running: ActiveRun | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;
  /** Serializes claim/start decisions with promote, so only one run can ever hold the slot. */
  private transition: Promise<unknown> = Promise.resolve();
  /** Steer ids admitted by this process, so an HTTP retry does not broadcast the same user row twice. */
  private readonly admittedSteers = new Set<string>();

  constructor(options: RequestWorkerOptions) {
    this.store = options.store;
    this.agent = options.agent;
    this.hub = options.hub;
    this.ownerId = options.ownerId;
    this.gate = options.gate;
    this.log = options.log ?? ((line) => console.error(line));
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 15_000;
  }

  get runningRequestId(): string | undefined {
    return this.running?.requestId;
  }

  start(): void {
    if (this.loopPromise !== undefined) return;
    this.store.cleanup();
    this.cleanupTimer = setInterval(() => {
      try {
        this.store.cleanup();
      } catch (error) {
        this.log(`web_requests cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 6 * 60 * 60 * 1000);
    this.cleanupTimer.unref();
    this.loopPromise = this.loop();
  }

  /** Wake the loop after an enqueue. Cheap and idempotent. */
  notify(): void {
    const wake = this.wakeUp;
    this.wakeUp = undefined;
    wake?.();
  }

  private waitForWork(): Promise<void> {
    return new Promise((resolve) => {
      this.wakeUp = resolve;
      // A missed wake-up must not park the queue forever; the poll is only a backstop.
      const timer = setTimeout(() => {
        if (this.wakeUp === resolve) this.wakeUp = undefined;
        resolve();
      }, 1_000);
      timer.unref();
    });
  }

  /**
   * Run `work` with no other claim/start decision in flight. The lock is held only for the
   * transition, never for the duration of a run; promote awaits `agent.steer` under it because a
   * steer must be decided against the same running request the queue decision saw.
   */
  private serialize<T>(work: () => T | Promise<T>): Promise<T> {
    const previous = this.transition;
    let release!: () => void;
    this.transition = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = (async () => {
      await previous;
      return work();
    })();
    return result.finally(release);
  }

  private async loop(): Promise<void> {
    while (!this.closed) {
      const outcome = await this.serialize((): LoopOutcome => {
        if (this.running !== undefined) return { kind: "busy", done: this.running.done };
        const row = this.store.claimNext();
        if (row === undefined) return { kind: "idle" };
        this.broadcastQueue();
        this.beginRun(row);
        return { kind: "started" };
      });
      if (outcome.kind === "busy") {
        await outcome.done;
        continue;
      }
      if (outcome.kind === "idle") await this.waitForWork();
      // "started": the run is active; the next turn observes it as busy and waits for it.
    }
  }

  /** Take the running slot and launch the generation. Only called under `serialize`. */
  private beginRun(row: WebRequestRow): void {
    const controller = new AbortController();
    const settled = Promise.withResolvers<void>();
    const active: ActiveRun = { requestId: row.request_id, controller, done: settled.promise };
    this.running = active;
    this.hub.broadcast("request.running", { requestId: row.request_id });
    void this.execute(row, controller).finally(() => {
      if (this.running === active) this.running = undefined;
      settled.resolve();
    });
  }

  private broadcastQueue(): void {
    this.hub.broadcast("queue.changed", { items: this.store.listQueued() });
  }

  private async execute(row: WebRequestRow, controller: AbortController): Promise<void> {
    const requested = this.agent.modelService.catalog().current;
    try {
      const runReply = () => this.agent.reply({
        requestId: row.request_id,
        conversationId: "owner",
        senderId: this.ownerId,
        text: row.text,
      }, controller.signal);
      const text = this.gate === undefined ? await runReply() : await this.gate.run(runReply);
      // An abort (or a shutdown) wins even if the generation raced to a result.
      if (!this.store.isRunning(row.request_id)) return;
      const message = await this.doneMessage(row.request_id, row.client_message_id, text, requested);
      const model = modelInfo(requested, message);
      if (this.store.markDone(row.request_id, text, model)) {
        this.hub.broadcast("request.done", { requestId: row.request_id, message, model });
      }
    } catch (error) {
      if (controller.signal.aborted) {
        this.markAbortedIfRunning(row.request_id);
        return;
      }
      const code = errorCodeOf(error);
      const message = safeErrorMessage(code);
      this.log(`Request ${row.request_id} failed: ${code}`);
      if (this.store.markFailed(row.request_id, code, message, {
        requested: { ...requested, kind: requested.kind },
        actual: null,
        kind: requested.kind,
        degraded: false,
      })) {
        this.hub.broadcast("request.failed", { requestId: row.request_id, code, message });
      }
    }
  }

  /** The assistant row to append right after `request.done`; durable id when the transcript has it. */
  private async doneMessage(
    requestId: string,
    clientMessageId: string,
    text: string,
    requested: { readonly id: string; readonly label: string; readonly provider: string; readonly kind: "primary" | "manual" | "auto" },
  ): Promise<UiMessage> {
    try {
      const page = await this.agent.history({ limit: 20 });
      const durable = [...page.messages].reverse().find(
        (message) => message.role === "assistant" && message.tool === null && message.text.trim() === text.trim(),
      );
      if (durable !== undefined) return { ...durable, requestId, clientMessageId };
    } catch (error) {
      this.log(`Could not read the transcript for request.done: ${error instanceof Error ? error.message : String(error)}`);
    }
    // A host-side `$model` reply produces no durable turn, so it gets a request-scoped id.
    return {
      id: `req:${requestId}`,
      role: "assistant",
      text,
      createdAt: Date.now(),
      status: "complete",
      requestId,
      clientMessageId,
      model: { id: requested.id, label: requested.label, provider: requested.provider },
      errorCode: null,
      tool: null,
    };
  }

  private markAbortedIfRunning(requestId: string): void {
    const result = this.store.markAborted(requestId);
    if (result.found && result.previous === "running") {
      this.hub.broadcast("request.aborted", { requestId });
    }
  }

  /**
   * Inject text into the running request. Unlike `reply`, this never queues a new web request: the
   * durable submission joins the current run. The path id protects a late steer from landing on a
   * newer request; without a running request we still call the agent so an idempotent replay of a
   * known steer succeeds, and a genuinely new steer is refused with NO_ACTIVE_REQUEST.
   */
  async steer(
    requestId: string,
    clientMessageId: string,
    text: string,
  ): Promise<{ ok: true; steerId: string } | { ok: false; reason: "no_active_request" | "not_active" }> {
    const running = this.running?.requestId;
    if (running !== undefined && running !== requestId) return { ok: false, reason: "not_active" };
    const steerId = `steer:${clientMessageId}`;
    let result: Awaited<ReturnType<WebAgent["steer"]>>;
    try {
      result = await this.agent.steer({
        requestId: steerId,
        conversationId: "owner",
        senderId: this.ownerId,
        text,
      });
    } catch (error) {
      if (errorCodeOf(error) === "NO_ACTIVE_REQUEST") return { ok: false, reason: "no_active_request" };
      throw error;
    }
    // A replay of an already-admitted steer returns the same durable submission; do not show the
    // user message twice. Clients also dedupe by steerId, which covers a replay after a restart.
    if (!this.admittedSteers.has(result.steerId)) {
      if (this.admittedSteers.size >= 1_000) this.admittedSteers.clear();
      this.admittedSteers.add(result.steerId);
      this.hub.broadcast("request.steered", {
        requestId,
        steerId: result.steerId,
        clientMessageId,
        text,
        createdAt: Date.now(),
      });
    }
    this.log(`Steer ${result.steerId} admitted to request ${requestId} (${text.length} chars)`);
    // Background only: a late steer can start one more run, and this is the event that carries its
    // answer. Shutdown never waits on it, and a settle failure is a log line, not a request failure.
    void result.done.then((message) => {
      if (message !== undefined) this.hub.broadcast("steer.done", { requestId, steerId: result.steerId, message });
    }).catch((error: unknown) => {
      this.log(`Steer ${result.steerId} completion failed: ${errorCodeOf(error)}`);
    });
    return { ok: true, steerId: result.steerId };
  }

  /**
   * Take one queued message out of the FIFO and make it take effect now.
   *
   * With a run active, the text is injected through the same steer path and the row becomes
   * `promoted`. With nothing running, the row starts immediately ahead of older queued rows. The
   * decision, the status transition and the injection are serialized with the worker's claim, so
   * two runs can never hold the slot. A replay on an already-promoted row is idempotent.
   */
  async promote(requestId: string): Promise<PromoteResult> {
    return this.serialize(async (): Promise<PromoteResult> => {
      const row = this.store.get(requestId);
      if (row === undefined) return { ok: false, reason: "not_queued" };
      const steerId = `steer:${row.client_message_id}`;
      if (row.status === "promoted") return { ok: true, mode: "steered", steerId };
      if (row.status !== "queued") return { ok: false, reason: "not_queued" };

      const running = this.running;
      if (running !== undefined) {
        if (!this.store.markPromoted(requestId)) {
          // The worker claimed it under us (or it settled); report what actually happened.
          const fresh = this.store.get(requestId);
          this.broadcastQueue();
          return fresh?.status === "promoted"
            ? { ok: true, mode: "steered", steerId }
            : { ok: false, reason: "not_queued" };
        }
        this.broadcastQueue();
        let steered: Awaited<ReturnType<RequestWorker["steer"]>>;
        try {
          steered = await this.steer(running.requestId, row.client_message_id, row.text);
        } catch (error) {
          // Nothing joined the run; put the row back so a retry can try again.
          this.store.revertPromoted(requestId);
          this.broadcastQueue();
          throw error;
        }
        if (steered.ok) return { ok: true, mode: "steered", steerId: steered.steerId };
        // The durable run went idle between the check and the injection. Wait for the web slot to
        // clear (its execute may still be settling) and then start this message instead.
        await running.done;
      }

      const started = this.store.startSpecific(requestId);
      if (started === undefined) {
        this.broadcastQueue();
        return { ok: false, reason: "not_queued" };
      }
      this.broadcastQueue();
      this.beginRun(started);
      this.log(`Promoted ${requestId} started immediately (${started.text.length} chars)`);
      return { ok: true, mode: "started" };
    });
  }

  /**
   * Abort a queued or running request. Throws stable codes the route maps to 404/409.
   */
  abort(requestId: string): { ok: true } | { ok: false; reason: "not_found" | "not_active" } {
    const result = this.store.markAborted(requestId);
    if (!result.found) return { ok: false, reason: "not_found" };
    if (result.previous !== "queued" && result.previous !== "running") {
      return { ok: false, reason: "not_active" };
    }
    if (result.previous === "queued") this.broadcastQueue();
    if (result.previous === "running" && this.running?.requestId === requestId) {
      this.running.controller.abort();
      // The durable run must stop too; the wait alone does not cancel it.
      void this.agent.abort().catch((error: unknown) => {
        this.log(`agent.abort() failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    this.hub.broadcast("request.aborted", { requestId });
    return { ok: true };
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.cleanupTimer !== undefined) clearInterval(this.cleanupTimer);
    this.notify();
    if (this.loopPromise !== undefined) {
      let timedOut = false;
      const timeout = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, this.shutdownTimeoutMs);
        timer.unref();
      });
      await Promise.race([this.loopPromise, timeout]);
      if (timedOut && this.running !== undefined) {
        this.log(`Shutdown: aborting the running request ${this.running.requestId}`);
        this.running.controller.abort();
        await this.agent.abort().catch(() => undefined);
        await Promise.race([this.loopPromise, new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref())]);
      }
    }
  }
}

/** Derive the reported model metadata without parsing user-visible text. */
export function modelInfo(
  requested: { readonly id: string; readonly label: string; readonly kind: "primary" | "manual" | "auto" },
  message: UiMessage,
): RequestModelInfo {
  const actual = message.model === null ? null : { id: message.model.id, label: message.model.label };
  return {
    requested: { id: requested.id, label: requested.label, kind: requested.kind },
    actual,
    kind: requested.kind,
    degraded: requested.kind === "manual" && actual !== null && actual.id !== requested.id,
  };
}

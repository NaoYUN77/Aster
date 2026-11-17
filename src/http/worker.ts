import type { HistoryPage, UiMessage } from "./projection.js";
import type { EventHub } from "./events.js";
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
  abort(): Promise<void>;
  history(options?: { readonly before?: string; readonly limit?: number }): Promise<HistoryPage>;
  modelService: ModelSelectionService;
};

export type RequestWorkerOptions = {
  readonly store: WebRequestStore;
  readonly agent: WebAgent;
  readonly hub: EventHub;
  readonly ownerId: string;
  readonly log?: (line: string) => void;
  /** How long shutdown waits for the current generation before aborting it. */
  readonly shutdownTimeoutMs?: number;
};

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
  private readonly log: (line: string) => void;
  private readonly shutdownTimeoutMs: number;
  private closed = false;
  private wakeUp: (() => void) | undefined;
  private loopPromise: Promise<void> | undefined;
  private running: { requestId: string; controller: AbortController } | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(options: RequestWorkerOptions) {
    this.store = options.store;
    this.agent = options.agent;
    this.hub = options.hub;
    this.ownerId = options.ownerId;
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

  private async loop(): Promise<void> {
    while (!this.closed) {
      const row = this.store.claimNext();
      if (row === undefined) {
        await this.waitForWork();
        continue;
      }
      await this.execute(row);
    }
  }

  private async execute(row: WebRequestRow): Promise<void> {
    const controller = new AbortController();
    this.running = { requestId: row.request_id, controller };
    this.hub.broadcast("request.running", { requestId: row.request_id });
    const requested = this.agent.modelService.catalog().current;
    try {
      const text = await this.agent.reply({
        requestId: row.request_id,
        conversationId: "owner",
        senderId: this.ownerId,
        text: row.text,
      }, controller.signal);
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
    } finally {
      this.running = undefined;
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
   * Abort a queued or running request. Throws stable codes the route maps to 404/409.
   */
  abort(requestId: string): { ok: true } | { ok: false; reason: "not_found" | "not_active" } {
    const result = this.store.markAborted(requestId);
    if (!result.found) return { ok: false, reason: "not_found" };
    if (result.previous !== "queued" && result.previous !== "running") {
      return { ok: false, reason: "not_active" };
    }
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

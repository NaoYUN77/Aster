import type { DeliveryChannel } from "../channel.js";
import { errorCode } from "../errors.js";
import type { HostMessageSource, UiMessage } from "./projection.js";
import type { AgentGate } from "./agent-gate.js";
import type { EventHub } from "./events.js";

/**
 * The single delivery path for host-originated messages on the web channel. Reminders, watch
 * events and routine results all become one durable entry plus one `host.message` SSE frame. The
 * entry is what history reads after a reconnect or restart; the SSE frame is only the live hint.
 */
export type HostMessageAgent = {
  hostMessage(input: {
    readonly text: string;
    readonly source: HostMessageSource;
    readonly key?: string;
  }): Promise<UiMessage>;
};

export type WebHostDeliveryOptions = {
  readonly agent: HostMessageAgent;
  readonly hub: EventHub;
  readonly gate: AgentGate;
  readonly log?: (line: string) => void;
};

export class WebHostDelivery {
  readonly #agent: HostMessageAgent;
  readonly #hub: EventHub;
  readonly #gate: AgentGate;
  readonly #log: (line: string) => void;

  constructor(options: WebHostDeliveryOptions) {
    this.#agent = options.agent;
    this.#hub = options.hub;
    this.#gate = options.gate;
    this.#log = options.log ?? ((line) => console.error(line));
  }

  async send(
    source: HostMessageSource,
    text: string,
    signal: AbortSignal,
    key?: string,
  ): Promise<UiMessage> {
    const message = await this.#gate.run(async () => {
      signal.throwIfAborted();
      return this.#agent.hostMessage({
        text,
        source,
        ...(key === undefined || key === "" ? {} : { key }),
      });
    });
    // A client that disconnected simply re-reads history; the durable entry is authoritative.
    this.#hub.broadcast("host.message", { message });
    return message;
  }

  /**
   * The reminder scheduler's view of this delivery path. It keeps the scheduler transport-agnostic
   * while the durable entry, not a chat API, is what records the outcome.
   */
  reminderChannel(): DeliveryChannel {
    return {
      label: "WebHost",
      send: async (_target, text, signal, _threadTs, deliveryKey) => {
        const message = await this.send("reminder", text, signal, deliveryKey);
        return message.id;
      },
      classifyFailure: (error: unknown) =>
        (error as { name?: unknown } | null)?.name === "AbortError" ? "uncertain" : "failed",
      failureCode: (error: unknown) => {
        const code = errorCode(error);
        // Error codes are stable identifiers; provider text and row content never reach the log.
        return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "HOST_DELIVERY_FAILED";
      },
    };
  }

  /** One log-safe record of a failed host delivery; no message text is included. */
  logFailure(source: HostMessageSource, error: unknown): void {
    this.#log(`Host ${source} delivery failed (${errorCode(error)})`);
  }
}

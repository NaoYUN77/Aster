/**
 * One outbound delivery surface. Host-originated sends — reminders, watch events and routine
 * results — go through this interface, so their bookkeeping and failure classification stay
 * transport-independent; only the transport itself differs.
 */
export interface DeliveryChannel {
  /** Operator-facing name for log lines. */
  readonly label: string;
  /**
   * Sends one already-segmented message part and returns the transport's message id. `threadTs` is
   * the anchor to answer inside when the request arrived in a thread; a channel that has no threads
   * ignores it, and an absent anchor means a flat message.
   */
  send(
    target: string,
    text: string,
    signal: AbortSignal,
    threadTs?: string,
    /** Host-side idempotency key for deliveries that must not repeat after a restart. */
    deliveryKey?: string,
  ): Promise<string>;
  /** `failed` means the channel rejected the send; `uncertain` means the outcome is unknown. */
  classifyFailure(error: unknown): "failed" | "uncertain";
  /** A short, log-safe code for this error. Never carries message text or credentials. */
  failureCode(error: unknown): string;
}

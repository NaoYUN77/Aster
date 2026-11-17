import type { ServerResponse } from "node:http";

/**
 * SSE fan-out for the single-owner adapter. Every connected client receives the same events; there
 * is no replay, so a reconnecting client re-reads history and takes the new snapshot.
 */

export type SseEventName =
  | "snapshot"
  | "request.queued"
  | "request.running"
  | "request.done"
  | "request.failed"
  | "request.aborted"
  | "model.changed"
  | "host.message"
  | "heartbeat";

type Client = { readonly id: number; readonly res: ServerResponse };

const HEARTBEAT_MS = 15_000;

export class EventHub {
  private readonly clients = new Map<number, Client>();
  private readonly heartbeat: NodeJS.Timeout;
  private nextId = 1;
  private closed = false;

  constructor(private readonly log: (line: string) => void = (line) => console.error(line)) {
    this.heartbeat = setInterval(() => this.sendComment("heartbeat"), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  /** Register a response that already has the SSE headers, and optionally send its first events. */
  add(res: ServerResponse, initial: readonly { event: SseEventName; data: unknown }[] = []): () => void {
    if (this.closed) {
      res.end();
      return () => {};
    }
    const id = this.nextId++;
    this.clients.set(id, { id, res });
    // Browser EventSource reconnect delay; harmless for the fetch-based clients.
    this.write(res, "retry: 2000\n\n");
    for (const event of initial) this.sendTo(res, event.event, event.data);
    const remove = () => this.clients.delete(id);
    res.on("close", remove);
    res.on("error", remove);
    return remove;
  }

  broadcast(event: SseEventName, data: unknown): void {
    for (const { res } of [...this.clients.values()]) this.sendTo(res, event, data);
  }

  private sendTo(res: ServerResponse, event: SseEventName, data: unknown): void {
    this.write(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private sendComment(comment: string): void {
    for (const { res } of [...this.clients.values()]) this.write(res, `: ${comment}\n\n`);
  }

  private write(res: ServerResponse, chunk: string): void {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(chunk);
    } catch (error) {
      this.log(`SSE write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const { res } of this.clients.values()) {
      try {
        res.end();
      } catch {
        // The client already went away.
      }
    }
    this.clients.clear();
  }
}

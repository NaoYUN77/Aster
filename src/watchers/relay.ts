import type { WatchRuntimeStore } from "./store.js";
import { eventsForSource, normalizeWebhook } from "./github.js";
import { WatchError } from "./store.js";

/**
 * Long-poll client for the public relay.
 *
 * The cursor is the only position the client keeps, and it lives in the source rows so a restart
 * resumes instead of replaying. A missing sequence is not retried message-by-message: it resets the
 * cursor and lets reconciliation fill the hole from GitHub's terminal state. The relay loop is
 * independent of the poll loop, so a relay outage delays only push deliveries, never RSS checks.
 */

const MAX_PULL_EVENTS = 500;
const DEFAULT_LONG_POLL_SECONDS = 50;
const MAX_BACKOFF_MS = 60_000;
const IDLE_WAIT_MS = 60_000;

export type RelayRecord = {
  readonly seq: number;
  readonly deliveryId?: string;
  readonly event: string;
  readonly payload: unknown;
};

export type RelayPull = {
  readonly seq: number | null;
  readonly events: readonly RelayRecord[];
};

export type RelayClientOptions = {
  readonly url: string;
  readonly token: string;
  readonly timeoutSec?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
};

function failure(code: "TRIGGER_RELAY_DOWN" | "TRIGGER_PAYLOAD_INVALID"): WatchError {
  return new WatchError(code, code === "TRIGGER_RELAY_DOWN" ? "the relay is unavailable" : "the relay returned an invalid body");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeSequence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** The one operation the loop needs, so tests can supply a deterministic puller. */
export interface RelayPuller {
  pull(after: string | null, signal: AbortSignal): Promise<RelayPull>;
}

export class RelayClient implements RelayPuller {
  readonly #url: string;
  readonly #token: string;
  readonly #timeoutSec: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: RelayClientOptions) {
    this.#url = options.url.replace(/\/+$/, "");
    this.#token = options.token.trim();
    this.#timeoutSec = Math.max(1, Math.min(options.timeoutSec ?? DEFAULT_LONG_POLL_SECONDS, 120));
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#fetch = options.fetch ?? fetch;
  }

  async pull(after: string | null, signal: AbortSignal): Promise<RelayPull> {
    if (this.#url === "" || this.#token === "") throw failure("TRIGGER_RELAY_DOWN");
    let url: URL;
    try {
      url = new URL(`${this.#url}/pull`);
    } catch {
      throw failure("TRIGGER_RELAY_DOWN");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw failure("TRIGGER_RELAY_DOWN");
    url.searchParams.set("timeout", String(this.#timeoutSec));
    if (after !== null) url.searchParams.set("after", after);

    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.#timeoutMs + this.#timeoutSec * 1_000);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#token}`,
          "user-agent": "aster-watchers/1",
        },
        signal: AbortSignal.any([signal, deadline.signal]),
      });
    } catch {
      throw failure("TRIGGER_RELAY_DOWN");
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw failure("TRIGGER_RELAY_DOWN");
    }
    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      throw failure("TRIGGER_PAYLOAD_INVALID");
    }
    return parsePull(body);
  }
}

export function parsePull(body: unknown): RelayPull {
  if (!record(body)) throw failure("TRIGGER_PAYLOAD_INVALID");
  const seq = body.seq === null ? null : safeSequence(body.seq);
  if (seq === undefined) throw failure("TRIGGER_PAYLOAD_INVALID");
  if (!Array.isArray(body.events) || body.events.length > MAX_PULL_EVENTS) throw failure("TRIGGER_PAYLOAD_INVALID");
  const events: RelayRecord[] = [];
  let previous = -1;
  for (const raw of body.events) {
    if (!record(raw)) throw failure("TRIGGER_PAYLOAD_INVALID");
    const recordSeq = safeSequence(raw.seq);
    const event = raw.event;
    if (recordSeq === undefined || recordSeq <= previous || typeof event !== "string"
      || event.length === 0 || event.length > 64 || !record(raw.payload)) {
      throw failure("TRIGGER_PAYLOAD_INVALID");
    }
    const deliveryId = raw.deliveryId;
    if (deliveryId !== undefined && (typeof deliveryId !== "string" || deliveryId.length > 128)) {
      throw failure("TRIGGER_PAYLOAD_INVALID");
    }
    previous = recordSeq;
    events.push({
      seq: recordSeq,
      ...(deliveryId === undefined ? {} : { deliveryId }),
      event,
      payload: raw.payload,
    });
  }
  return { seq, events };
}

export type RelayTickOptions = {
  readonly store: WatchRuntimeStore;
  readonly client: RelayPuller;
  readonly now: () => Date;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
};

export type RelayTickResult = {
  readonly ok: boolean;
  readonly gap: boolean;
  readonly advanced: boolean;
  readonly dropped: number;
  readonly code?: string;
};

/**
 * One pull. On a sequence gap the cursor is discarded; the next pull starts from the relay tail and
 * reconciliation is what actually recovers the missing terminal states.
 */
export async function runRelayOnce(options: RelayTickOptions): Promise<RelayTickResult> {
  const log = options.log ?? ((line: string) => console.error(line));
  const at = options.now().toISOString();
  const cursor = options.store.relayCursor();
  let pull: RelayPull;
  try {
    pull = await options.client.pull(cursor, options.signal ?? new AbortController().signal);
  } catch (error) {
    const code = error instanceof WatchError ? error.code : "TRIGGER_RELAY_DOWN";
    log(`Watch relay pull failed (${code})`);
    return { ok: false, gap: false, advanced: false, dropped: 0, code };
  }
  if (options.signal?.aborted === true) return { ok: false, gap: false, advanced: false, dropped: 0 };

  if (cursor !== null) {
    const expected = Number(cursor);
    const first = pull.events[0];
    const outOfOrder = (first !== undefined && first.seq !== expected + 1)
      || (pull.seq !== null && pull.seq < expected)
      // An advanced tail with nothing to hand over means rows in between were unusable.
      || (first === undefined && pull.seq !== null && pull.seq > expected);
    if (outOfOrder) {
      options.store.resetRelayCursor();
      log("Watch relay cursor gap; reconcile will fill the hole");
      return { ok: true, gap: true, advanced: false, dropped: 0, code: "TRIGGER_CURSOR_GAP" };
    }
  }

  const sources = options.store.sources("push");
  let dropped = 0;
  for (const delivery of pull.events) {
    const normalized = normalizeWebhook(delivery.event, delivery.payload, delivery.deliveryId);
    let matched = 0;
    for (const source of sources) {
      const events = eventsForSource(source, normalized);
      for (const event of events) {
        try {
          options.store.ingest(source.id, event, at);
          matched += 1;
        } catch (error) {
          log(`Watch ingest failed for source ${source.id} (${error instanceof WatchError ? error.code : "WATCH_STORE_ERROR"})`);
        }
      }
    }
    if (matched === 0) dropped += 1;
  }
  if (pull.seq !== null && sources.length > 0) options.store.advanceRelay(String(pull.seq), at);
  return { ok: true, gap: false, advanced: pull.seq !== null && sources.length > 0, dropped };
}

export type RelayLoopOptions = RelayTickOptions & {
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * The relay's own loop. A long poll that returns immediately (baseline pull) is followed by no
 * artificial delay, while failures back off exponentially up to a minute. Nothing here is shared
 * with the poll timer except the SQLite connection.
 */
export async function runRelayLoop(options: RelayLoopOptions): Promise<void> {
  const signal = options.signal ?? new AbortController().signal;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? ((line: string) => console.error(line));
  let failures = 0;
  while (!signal.aborted) {
    if (options.store.sources("push").length === 0) {
      await sleep(IDLE_WAIT_MS, signal);
      continue;
    }
    const result = await runRelayOnce({ ...options, signal });
    if (signal.aborted) break;
    if (!result.ok) {
      failures += 1;
      log(`Watch relay retry ${failures} scheduled`);
      await sleep(Math.min(1_000 * 2 ** Math.min(failures, 6), MAX_BACKOFF_MS), signal);
      continue;
    }
    failures = 0;
    if (result.gap) await sleep(1_000, signal);
  }
}

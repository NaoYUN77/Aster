/**
 * Long-poll client for the public relay Worker (spec 5.4).
 *
 * The relay is the only ingress for GitHub push events, so the client is deliberately narrow: one
 * HTTP GET per check, a strict page shape, and one semantic decision — whether the returned
 * sequence is contiguous with what we already consumed. A detected gap is never papered over by
 * re-fetching; it is reported as TRIGGER_CURSOR_GAP and reconciliation rebuilds the missing facts
 * from REST. Network failures surface as TRIGGER_RELAY_DOWN so the scheduler's standard backoff
 * curve drives reconnection; the client itself never sleeps or loops, which keeps one source's
 * outage from stalling the others.
 *
 * Driver contract (the seam shared with the polling half, spec 5.2): `processSource` is the small
 * piece both halves need — baseline vs. delivery. A source whose state columns are all null is
 * on its first successful read; its events are recorded through `finish` (which inserts without
 * queueing the outbox) so history can never flood the user. Afterwards each event goes through
 * `ingest`, which dedups by key and queues delivery in the same transaction.
 */

import { composeGithubText, createGithubNormalizer, parseGithubTarget, type GithubDraft } from "./github.js";
import type { SourceCheck, SourceCheckResult, SourceRow, WatchEventInput, WatchStore } from "./protocol.js";

const MAX_PAGE_BYTES = 1024 * 1024;
const DEFAULT_PULL_TIMEOUT_SEC = 20;
const MAX_PULL_TIMEOUT_SEC = 25;
const BACKOFF_CAP_SEC = 3600;

/** Host-written failure for relay transport problems; codes come from the fixed reason list. */
export class RelayError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RelayError";
  }
}

export type RelayEnvelope = {
  readonly seq: number;
  readonly delivery: string;
  readonly event: string;
  readonly payload: Record<string, unknown>;
};

export type RelayPullPage = {
  readonly seq: number;
  readonly oldest: number | null;
  readonly events: readonly RelayEnvelope[];
};

export type RelayPullOptions = {
  /** WATCHERS_RELAY_URL without a trailing slash; enforced here rather than trusted. */
  readonly url: string;
  /** WATCHERS_RELAY_TOKEN; passed in, never read from env. */
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly pullTimeoutSec?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPage(value: unknown): RelayPullPage {
  if (!isRecord(value)) throw new RelayError("TRIGGER_PAYLOAD_INVALID", "relay page is not an object");
  const seq = value["seq"];
  const oldest = value["oldest"];
  const rawEvents = value["events"];
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
    throw new RelayError("TRIGGER_PAYLOAD_INVALID", "relay page seq is invalid");
  }
  if (oldest !== null && (typeof oldest !== "number" || !Number.isSafeInteger(oldest) || oldest < 1)) {
    throw new RelayError("TRIGGER_PAYLOAD_INVALID", "relay page oldest is invalid");
  }
  if (!Array.isArray(rawEvents)) throw new RelayError("TRIGGER_PAYLOAD_INVALID", "relay page events is not an array");
  const events: RelayEnvelope[] = rawEvents.map((entry) => {
    if (!isRecord(entry)) throw new RelayError("TRIGGER_PAYLOAD_INVALID", "relay event is not an object");
    const eventSeq = entry["seq"];
    const delivery = entry["delivery"];
    const event = entry["event"];
    const payload = entry["payload"];
    if (typeof eventSeq !== "number" || !Number.isSafeInteger(eventSeq) || eventSeq < 1
      || typeof delivery !== "string" || delivery.length === 0
      || typeof event !== "string" || event.length === 0
      || !isRecord(payload)) {
      throw new RelayError("TRIGGER_PAYLOAD_INVALID", "relay event fields are invalid");
    }
    return { seq: eventSeq, delivery, event, payload };
  });
  return { seq, oldest, events };
}

/**
 * One long-poll request. Throws TRIGGER_CURSOR_GAP when the page is not contiguous with the
 * caller's cursor, TRIGGER_PAYLOAD_INVALID for a malformed page and TRIGGER_RELAY_DOWN for any
 * transport or availability failure. Everything else (timeout handling, reconnect) is the
 * scheduler's job through the standard backoff path.
 */
export function createRelayPull(options: RelayPullOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = options.url.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new RelayError("TRIGGER_RELAY_DOWN", "relay url must be absolute http(s)");
  const timeoutSec = Math.min(MAX_PULL_TIMEOUT_SEC, Math.max(1, options.pullTimeoutSec ?? DEFAULT_PULL_TIMEOUT_SEC));

  return {
    pullTimeoutSec: timeoutSec,
    async pull(cursor: string | null, signal: AbortSignal): Promise<RelayPullPage> {
      const url = new URL(`${base}/pull`);
      url.searchParams.set("after", cursor === null ? "0" : cursor);
      url.searchParams.set("timeout", String(timeoutSec));
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutSec * 1000 + 5_000)]);
      let response: Response;
      try {
        response = await doFetch(url, {
          redirect: "error",
          headers: { authorization: `Bearer ${options.token}`, accept: "application/json" },
          signal: deadline,
        });
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof RelayError) throw error;
        throw new RelayError("TRIGGER_RELAY_DOWN", "relay could not be reached");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new RelayError("TRIGGER_RELAY_DOWN", "relay answered with an error status");
      }
      let page: RelayPullPage;
      try {
        const text = await response.text();
        if (text.length > MAX_PAGE_BYTES) throw new RelayError("TRIGGER_PAYLOAD_INVALID", "relay page exceeds the size limit");
        page = asPage(JSON.parse(text));
      } catch (error) {
        if (error instanceof RelayError) throw error;
        throw new RelayError("TRIGGER_PAYLOAD_INVALID", "relay page was not valid JSON");
      }

      // Contiguity: the first event must be exactly cursor+1 (or the oldest retained row for a
      // fresh cursor), and the rest must follow without holes. Otherwise facts were lost between
      // the client and D1 retention — report the gap instead of guessing.
      const first = page.events.length > 0 ? page.events[0]!.seq : null;
      const expected = cursor === null ? page.oldest : Number(cursor) + 1;
      if (first !== null && expected === null) throw new RelayError("TRIGGER_PAYLOAD_INVALID", "relay returned events with an empty table");
      if (first !== null && expected !== null && first !== expected) {
        throw new RelayError("TRIGGER_CURSOR_GAP", "relay events are not contiguous with the stored cursor");
      }
      for (let index = 1; index < page.events.length; index++) {
        if (page.events[index]!.seq !== page.events[index - 1]!.seq + 1) {
          throw new RelayError("TRIGGER_CURSOR_GAP", "relay events have a hole inside one page");
        }
      }
      if (first === null && cursor !== null && page.oldest !== null && page.oldest > Number(cursor) + 1) {
        throw new RelayError("TRIGGER_CURSOR_GAP", "relay no longer retains events the cursor has not seen");
      }
      return page;
    },
  };
}

export type RelayPull = ReturnType<typeof createRelayPull>;

export type RelayCheckOptions = {
  readonly relay: RelayPull;
  readonly normalizer?: ReturnType<typeof createGithubNormalizer>;
  /** Compose the delivery line; defaults to the built-in deterministic composer. */
  readonly compose?: (watcherId: number, draft: GithubDraft) => string;
  readonly now?: () => string;
};

/**
 * The push-side `SourceCheck` for GitHub sources. One call is one long-poll plus normalization;
 * it never writes the store, so the driver keeps sole control of baseline and delivery semantics.
 */
export function createRelayCheck(options: RelayCheckOptions): SourceCheck {
  const normalizer = options.normalizer ?? createGithubNormalizer();
  const compose = options.compose ?? composeGithubText;
  const now = options.now ?? (() => new Date().toISOString());

  const asEvent = (source: SourceRow, draft: GithubDraft, deliveryId: string): WatchEventInput => ({
    dedupKey: draft.dedupKey,
    deliveryId,
    kind: draft.kind,
    occurredAt: draft.occurredAt,
    facts: draft.facts,
    text: compose(source.watcherId, draft),
  });

  return {
    async check(source: SourceRow, signal: AbortSignal): Promise<SourceCheckResult> {
      if (source.mode !== "push") {
        throw new RelayError("TRIGGER_PAYLOAD_INVALID", "the relay check only serves push sources");
      }
      const target = parseGithubTarget(source.kind, source.location);
      const repo = `${target.owner}/${target.repo}`.toLowerCase();
      const page = await options.relay.pull(source.cursor, signal);
      const nowIso = now();
      const events: WatchEventInput[] = [];
      for (const envelope of page.events) {
        const normalized = normalizer.normalize(envelope.event, envelope.payload, nowIso);
        for (const draft of normalized.events) {
          if (draft.facts["repo"] !== repo) continue;
          if (source.kind === "github_pr" && draft.kind !== "github_pr") continue;
          if (source.kind === "github_run" && draft.kind !== "github_run") continue;
          if (source.kind === "github_run" && target.workflow !== undefined) {
            const workflow = typeof draft.facts["workflow"] === "string" ? draft.facts["workflow"].toLowerCase() : "";
            if (workflow !== target.workflow.toLowerCase()) continue;
          }
          if (source.kind === "github_pr" && draft.facts["number"] !== target.number) continue;
          events.push(asEvent(source, draft, envelope.delivery));
        }
      }
      // The last delivered event's seq is the safe cursor: the worker page is capped, so jumping
      // straight to page.seq on a large backlog would silently skip the tail.
      const nextCursor = page.events.length > 0
        ? String(page.events[page.events.length - 1]!.seq)
        : String(Math.max(page.seq, Number(source.cursor ?? 0)));
      return { events, state: { cursor: nextCursor } };
    },
  };
}

export type SourceProcessOptions = {
  readonly now: string;
  /** Where the scheduler wants this source next; success paths never move it backwards. */
  readonly nextCheckAt: string;
  /** True when this path's own state columns show a previous successful read. */
  readonly baselined: boolean;
  readonly signal?: AbortSignal;
};

/**
 * The shared driver for one claimed source (spec 5.2): the first successful read only records
 * baseline facts and state, never notifies; every later read ingests events (dedup + outbox in
 * one transaction) and persists the returned state. Returns how many events were queued.
 */
export async function processSource(
  store: WatchStore,
  source: SourceRow,
  check: SourceCheck,
  options: SourceProcessOptions,
): Promise<number> {
  const signal = options.signal ?? new AbortController().signal;
  const result = await check.check(source, signal);
  if (!options.baselined) {
    store.finish(source.id, { events: result.events, state: result.state }, options.now, options.nextCheckAt);
    return 0;
  }
  let queued = 0;
  for (const event of result.events) {
    if (store.ingest(source.id, event, options.now)) queued += 1;
  }
  store.finish(source.id, { events: [], state: result.state }, options.now, options.nextCheckAt);
  return queued;
}

/** Spec 5.3 curve: interval * 2^failures capped at one hour. */
export function nextBackoffAt(source: Pick<SourceRow, "intervalSec" | "failures">, nowIso: string): string {
  const scaled = Math.min(source.intervalSec * 2 ** Math.max(0, source.failures), BACKOFF_CAP_SEC);
  return new Date(Date.parse(nowIso) + scaled * 1000).toISOString();
}

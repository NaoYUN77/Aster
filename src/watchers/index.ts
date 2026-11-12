import type { Extension } from "@earendil-works/pi-durable";
import type { DeliveryChannel } from "../channel.js";
import { errorCode } from "../errors.js";
import type { SourceMode, SourceRow, WatchersConfig } from "./protocol.js";
import { FeedSource } from "./feed.js";
import { backoffSeconds, runPollTick } from "./poll.js";
import { WatcherStore } from "./store.js";
import { createWatcherExtension } from "./tools.js";
import { createGithubRest, runReconcile } from "./reconcile.js";
import { createRelayCheck, createRelayPull, nextBackoffAt, processSource } from "./relay.js";
import { composeGithubText } from "./github.js";

/**
 * Integration facade for the two halves of the watchers feature.
 *
 * The coordinator owns the database path, the channel and the startup order; this factory owns what
 * belongs to the feature: one periodic tick (deliver, then poll the feed sources, then reconcile the
 * push sources) and one long-poll loop for the relay. Nothing here reads the environment, and there
 * is exactly one timer per loop, so shutdown is a single abort.
 */

const TICK_MS = 15_000;
const PUSH_IDLE_MS = 750;
const PUSH_BATCH = 2;

export type DeliverFn = (
  chatId: string,
  text: string,
  threadTs: string | undefined,
  signal: AbortSignal,
) => Promise<string>;

export type WatchersOptions = {
  readonly store: WatcherStore;
  readonly config: WatchersConfig;
  /** Host delivery callback; the chat id always comes from the watcher row, never from the model. */
  readonly deliver: DeliverFn;
  readonly chatId?: string;
  readonly threadTs?: string;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
  readonly fetch?: typeof fetch;
  readonly classifyFailure?: (error: unknown) => "failed" | "uncertain";
  readonly failureCode?: (error: unknown) => string;
  /** Tests point the REST reader at a local server. */
  readonly githubBaseUrl?: string;
};

export type WatchersRuntime = {
  readonly extension: Extension | undefined;
  start(): void;
  stop(): Promise<void>;
  tickOnce(signal?: AbortSignal): Promise<{ polled: number; reconciled: number; delivered: number }>;
  relayOnce(signal?: AbortSignal): Promise<number>;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function failureCodeOf(error: unknown): string {
  return errorCode(error);
}

export function createWatchers(options: WatchersOptions): WatchersRuntime {
  const { store, config } = options;
  const log = options.log ?? ((line: string) => console.error(line));
  const now = options.now ?? (() => new Date());
  const doFetch = options.fetch ?? fetch;
  const stop = new AbortController();
  const signal = options.signal === undefined ? stop.signal : AbortSignal.any([options.signal, stop.signal]);

  const channel: DeliveryChannel = {
    label: "watchers",
    send: (target, text, sig, threadTs) => options.deliver(target, text, threadTs, sig),
    classifyFailure: options.classifyFailure ?? (() => "failed"),
    failureCode: options.failureCode ?? ((error: unknown) => failureCodeOf(error)),
  };

  const feed = new FeedSource({ fetch: doFetch, timeoutMs: config.fetchTimeoutMs, now });
  const relay = config.relayUrl === undefined || config.relayToken === undefined
    ? undefined
    : createRelayCheck({
        relay: createRelayPull({ url: config.relayUrl, token: config.relayToken, fetch: doFetch }),
        compose: composeGithubText,
        now: () => now().toISOString(),
      });
  const rest = config.githubToken === undefined
    ? undefined
    : createGithubRest({
        token: config.githubToken,
        fetch: doFetch,
        timeoutMs: config.fetchTimeoutMs,
        ...(options.githubBaseUrl === undefined ? {} : { apiBase: options.githubBaseUrl }),
      });

  const extension = options.chatId === undefined
    ? undefined
    : createWatcherExtension(store, {
        config,
        chatId: options.chatId,
        ...(options.threadTs === undefined ? {} : { threadTs: () => options.threadTs }),
        now,
      });

  /** A poll source is a feed; a push source is the relay. Unknown kinds back off in the poller. */
  const sourceFor = (source: SourceRow) =>
    source.kind === "feed" || source.kind === "x" ? feed : (source.mode === "push" ? relay : undefined);

  let lastReconcile = 0;

  async function reconcileTick(runSignal: AbortSignal): Promise<number> {
    if (rest === undefined || config.githubReconcileMin <= 0) return 0;
    const elapsed = Date.now() - lastReconcile;
    if (elapsed < config.githubReconcileMin * 60_000) return 0;
    lastReconcile = Date.now();
    try {
      const summary = await runReconcile({ store, rest, log }, now().toISOString(), runSignal);
      return summary.queued;
    } catch (error) {
      log(`watchers reconcile pass failed code=${failureCodeOf(error)}`);
      return 0;
    }
  }

  /** One pass over the claimed push sources; the relay long-poll is what makes this prompt. */
  async function pushTick(runSignal: AbortSignal): Promise<number> {
    if (relay === undefined) return 0;
    const nowIso = now().toISOString();
    const lease = Math.max(30, Math.ceil((config.fetchTimeoutMs * 2) / 1_000));
    const claimed = store.claimDue(nowIso, PUSH_BATCH, lease, "push" satisfies SourceMode);
    let queued = 0;
    for (const source of claimed) {
      if (runSignal.aborted) break;
      try {
        // A push source is pulled again as soon as this long poll returns: the relay holds the
        // request open, so an immediate re-claim is a wait, not a busy loop.
        const next = new Date(now().getTime() + 1_000).toISOString();
        queued += await processSource(store, source, relay, {
          now: nowIso,
          nextCheckAt: next,
          baselined: source.cursor !== null,
          signal: runSignal,
        });
      } catch (error) {
        if (runSignal.aborted) break;
        const code = failureCodeOf(error);
        try {
          store.fail(source.id, code as never, nowIso, nextBackoffAt(source, nowIso));
        } catch (recordError) {
          log(`watchers push failure could not be recorded source=${source.id} code=${failureCodeOf(recordError)}`);
        }
        log(`watchers push failed source=${source.id} code=${code}`);
      }
    }
    return queued;
  }

  let ticker: NodeJS.Timeout | undefined;
  let pushLoop: Promise<void> | undefined;

  async function tickOnce(runSignal: AbortSignal = signal) {
    const polled = await runPollTick({
      store,
      config,
      sourceFor,
      channel,
      signal: runSignal,
      log,
      now,
    });
    const reconciled = await reconcileTick(runSignal);
    const pushed = await pushTick(runSignal);
    return { polled: polled.checked, reconciled: reconciled + pushed, delivered: polled.delivered };
  }

  return {
    extension,
    start() {
      if (ticker !== undefined) return;
      ticker = setInterval(() => {
        void tickOnce(signal).catch((error) => log(`watchers tick failed code=${failureCodeOf(error)}`));
      }, TICK_MS);
      pushLoop = (async () => {
        while (!signal.aborted) {
          try {
            await pushTick(signal);
          } catch (error) {
            if (signal.aborted) break;
            log(`watchers push loop failed code=${failureCodeOf(error)}`);
          }
          await sleep(PUSH_IDLE_MS, signal);
        }
      })();
    },
    async stop() {
      stop.abort();
      if (ticker !== undefined) clearInterval(ticker);
      ticker = undefined;
      await pushLoop?.catch(() => undefined);
      pushLoop = undefined;
    },
    tickOnce,
    async relayOnce(runSignal: AbortSignal = signal) {
      return pushTick(runSignal);
    },
  };
}

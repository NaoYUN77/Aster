import { isIP } from "node:net";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { SourceMode, WatchDeliveryMode, WatchKind, WatchersConfig } from "./protocol.js";
import { parseGithubTarget } from "./github.js";
import { WatchError, watchReasonCode, type WatchRuntimeStore } from "./store.js";

/**
 * Model-facing watcher tools.
 *
 * The model names *what* to watch; the host owns *where the message goes*. A tool call can only
 * create, list or stop watchers for the conversation the harness reported, and the destination is
 * read from the watcher row at delivery time — never from an argument. Targets are parsed here, not
 * fetched here, so a malformed or private address is refused before a source row exists.
 */

const WATCH_KINDS: readonly WatchKind[] = ["github_run", "github_pr", "github_events", "feed", "x"];
const WATCH_DELIVERY_MODES: readonly WatchDeliveryMode[] = ["triage", "direct"];
const MAX_TARGET_CHARS = 2_048;
const MAX_LABEL_CHARS = 200;
const MAX_TRIAGE_PROMPT_CHARS = 1_000;

export type WatchToolOptions = {
  readonly config: WatchersConfig;
  /** Host-resolved conversation; defaults to the harness's conversation id. */
  readonly chatId?: string;
  /** Host-resolved thread anchor. Never a tool parameter. */
  readonly threadTs?: string;
  /** Optional host callback for `watch_digest(action="flush")` to immediately deliver queued digest items. */
  readonly flushDigest?: (chatId: string, signal?: AbortSignal) => Promise<{ readonly count: number; readonly text: string }>;
};

type TargetPlan = {
  readonly target: string;
  readonly location: string;
  readonly label: string;
  readonly mode: SourceMode;
  readonly intervalSec: number;
};

function toolFailure(error: unknown): ToolExecutionResult {
  const code = watchReasonCode(error);
  const message = error instanceof WatchError ? error.message : "the watcher store could not complete the operation";
  return {
    isError: true,
    output: [{ type: "text", text: `Watch operation failed (${code}): ${message}` }],
    details: { code },
    diagnostics: [{ severity: "error", code, message }],
  };
}

function toolText(text: string, details: Record<string, string | number | boolean | null>): ToolExecutionResult {
  return { output: [{ type: "text", text }], details };
}

/** A public HTTP(S) URL without credentials, port or local name; DNS is resolved only at fetch time. */
export function parseFeedTarget(raw: string): string {
  const value = raw.trim();
  if (value === "" || value.length > MAX_TARGET_CHARS) throw new WatchError("WATCH_TARGET_INVALID", "target must be a URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WatchError("WATCH_TARGET_INVALID", "target must be an absolute HTTP(S) URL");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if ((url.protocol !== "https:" && url.protocol !== "http:")
    || url.username !== "" || url.password !== "" || url.port !== ""
    || hostname === "" || isIP(hostname) !== 0
    || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new WatchError("WATCH_TARGET_INVALID", "target must be a public HTTP(S) URL without credentials, a custom port or an IP literal");
  }
  url.hash = "";
  return url.toString();
}

function planTarget(kind: WatchKind, rawTarget: string, label: string | undefined, config: WatchersConfig): TargetPlan {
  const target = rawTarget.trim();
  if (target === "" || target.length > MAX_TARGET_CHARS) {
    throw new WatchError("WATCH_TARGET_INVALID", "target must not be empty");
  }
  const explicitLabel = label?.trim();
  if (explicitLabel !== undefined && explicitLabel.length > MAX_LABEL_CHARS) {
    throw new WatchError("WATCH_TARGET_INVALID", "label is too long");
  }
  if (kind === "feed" || kind === "x") {
    const url = parseFeedTarget(target);
    return {
      target: url,
      location: url,
      label: explicitLabel === undefined || explicitLabel === "" ? new URL(url).hostname : explicitLabel,
      mode: "poll",
      intervalSec: kind === "feed" ? config.feedIntervalSec : config.xIntervalSec,
    };
  }
  const parsed = parseGithubTarget(target);
  if (parsed === undefined) {
    throw new WatchError("WATCH_TARGET_INVALID", "target must be owner/repo, owner/repo#123 or a GitHub URL");
  }
  if (kind === "github_pr" && parsed.number === undefined) {
    throw new WatchError("WATCH_TARGET_INVALID", "a pull request watcher needs a number, such as owner/repo#123");
  }
  if ((kind === "github_run" || kind === "github_events") && parsed.number !== undefined) {
    throw new WatchError("WATCH_TARGET_INVALID", "this watcher kind covers the whole repository; drop the number");
  }
  const location = parsed.number === undefined ? parsed.repo : `${parsed.repo}#${parsed.number}`;
  return {
    target: location,
    location,
    label: explicitLabel === undefined || explicitLabel === "" ? location : explicitLabel,
    mode: "push",
    intervalSec: Math.max(60, Math.min(86_400, Math.round(config.githubReconcileMin * 60))),
  };
}

function formatWatcher(watcher: ReturnType<WatchRuntimeStore["list"]>[number]): string {
  const source = watcher.source;
  const next = source.nextCheckAt ?? source.reconcileAt ?? "—";
  const error = source.lastError === null ? "" : ` (${source.lastError})`;
  const modeNote = watcher.deliveryMode === "direct" ? "direct" : "triage";
  const filterNote = watcher.triagePrompt === null ? "" : ` | filter: ${watcher.triagePrompt.slice(0, 80)}`;
  return `#${watcher.id} | ${watcher.status}/${source.status}${error} | ${watcher.kind} | ${modeNote} | ${watcher.label} | ${watcher.target} | next ${next}${filterNote}`;
}

export function createWatchersExtension(store: WatchRuntimeStore, options: WatchToolOptions): Extension {
  const config = options.config;
  const fixedChatId = options.chatId;
  const threadTs = options.threadTs;

  const create = defineTool({
    name: "watch_create",
    description:
      "Start watching something and notify this conversation when new events arrive. "
      + "kind=feed or x watches an RSS/Atom URL; github_run watches completed CI runs in owner/repo; "
      + "github_pr watches one pull request (owner/repo#123); github_events watches closed issues in owner/repo. "
      + "By default (deliveryMode='triage'), new events are evaluated by a read-only Sub-agent to decide notify / digest / suppress; "
      + "pass deliveryMode='direct' to push raw updates immediately without LLM triage, or pass triagePrompt to specify custom filter criteria. "
      + "The first check is always a silent baseline.",
    parameters: obj({
      kind: oneOf(WATCH_KINDS),
      target: str({ minLength: 1, maxLength: MAX_TARGET_CHARS, description: "Feed URL, owner/repo, owner/repo#123, or a GitHub URL" }),
      label: opt(str({ maxLength: MAX_LABEL_CHARS, description: "Short human name shown in watch_list" })),
      deliveryMode: opt(oneOf(WATCH_DELIVERY_MODES, { description: "Optional delivery mode: 'triage' (default, Sub-agent filters notify/digest/suppress) or 'direct' (push raw events immediately)." })),
      triagePrompt: opt(str({ maxLength: MAX_TRIAGE_PROMPT_CHARS, description: "Optional custom filter/priority instructions for the triage Sub-agent (e.g. 'Only notify immediately for major releases or security fixes')." })),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const chatId = fixedChatId ?? String(api.conversationId);
        const plan = planTarget(args.kind, args.target, args.label, config);
        const duplicate = store.list(chatId).some((watcher) => watcher.kind === args.kind && watcher.target === plan.target);
        if (duplicate) throw new WatchError("WATCH_DUPLICATE", "this target is already being watched in this conversation");
        if (store.liveCount(chatId) >= config.maxActive) {
          throw new WatchError("WATCH_LIMIT_EXCEEDED", `at most ${config.maxActive} watchers are allowed per conversation`);
        }
        const deliveryMode: WatchDeliveryMode = args.deliveryMode ?? "triage";
        const created = store.create({
          chatId,
          ...(threadTs === undefined ? {} : { threadTs }),
          kind: args.kind,
          target: plan.target,
          label: plan.label,
          location: plan.location,
          mode: plan.mode,
          intervalSec: plan.intervalSec,
          deliveryMode,
          ...(args.triagePrompt === undefined ? {} : { triagePrompt: args.triagePrompt }),
          now: new Date().toISOString(),
        });
        return toolText(
          `Watcher #${created.watcherId} created for ${plan.target} (${args.kind}, ${deliveryMode}). The first check records the current state without sending anything.`,
          {
            id: created.watcherId,
            kind: args.kind,
            target: plan.target,
            mode: plan.mode,
            deliveryMode,
            intervalSec: plan.intervalSec,
          },
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  });

  const list = defineTool({
    name: "watch_list",
    description: "List this conversation's watchers with status, target and next check time.",
    parameters: obj({}),
    replay: "safe",
    execute: async (_args, api) => {
      try {
        const chatId = fixedChatId ?? String(api.conversationId);
        const watchers = store.list(chatId);
        if (watchers.length === 0) return toolText("No watchers.", { count: 0 });
        return toolText(watchers.map(formatWatcher).join("\n"), { count: watchers.length });
      } catch (error) {
        return toolFailure(error);
      }
    },
  });

  const stop = defineTool({
    name: "watch_stop",
    description: "Stop a watcher by its numeric ID. Its source stops being checked and no further messages are sent.",
    parameters: obj({ id: int({ minimum: 1 }) }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const chatId = fixedChatId ?? String(api.conversationId);
        const stopped = store.stop(chatId, args.id, new Date().toISOString());
        if (!stopped) throw new WatchError("WATCH_TARGET_INVALID", `watcher ${args.id} was not found or was already stopped`);
        return toolText(`Watcher #${args.id} stopped.`, { id: args.id, status: "stopped" });
      } catch (error) {
        return toolFailure(error);
      }
    },
  });

  const digest = defineTool({
    name: "watch_digest",
    description:
      "Inspect or immediately flush monitor updates currently queued for the daily watch digest. "
      + "Use action='list' (default) to preview queued items without clearing them, or action='flush' to summarize, deliver, and clear them now.",
    parameters: obj({
      action: opt(oneOf(["list", "flush"] as const, { description: "'list' (default) or 'flush' to deliver and clear now." })),
    }),
    replay: "unsafe",
    execute: async (args, api, context) => {
      try {
        const chatId = fixedChatId ?? String(api.conversationId);
        const action = args.action ?? "list";
        if (action === "flush") {
          if (options.flushDigest === undefined) {
            return toolText("Digest flushing is not available in this host.", { count: 0, flushed: false });
          }
          const flushed = await options.flushDigest(chatId, context.abortSignal);
          if (flushed.count === 0) {
            return toolText("No queued watch digest items.", { count: 0, flushed: false });
          }
          return toolText(`Delivered watch digest with ${flushed.count} item(s).`, { count: flushed.count, flushed: true });
        }
        const queued = store.queuedDigest(chatId, 50);
        if (queued.length === 0) return toolText("No queued watch digest items.", { count: 0 });
        const lines = queued.map((item, idx) => {
          const reason = item.triageReason ? ` (${item.triageReason})` : "";
          return `${idx + 1}. [watcher #${item.watcherId}] ${item.text}${reason}`;
        });
        return toolText(lines.join("\n"), { count: queued.length });
      } catch (error) {
        return toolFailure(error);
      }
    },
  });

  return defineExtension({ name: "watchers", tools: [create, list, stop, digest] });
}

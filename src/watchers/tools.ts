import { isIP } from "node:net";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { SourceMode, WatchKind, WatchersConfig } from "./protocol.js";
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
const MAX_TARGET_CHARS = 2_048;
const MAX_LABEL_CHARS = 200;

export type WatchToolOptions = {
  readonly config: WatchersConfig;
  /** Host-resolved conversation; defaults to the harness's conversation id. */
  readonly chatId?: string;
  /** Host-resolved thread anchor. Never a tool parameter. */
  readonly threadTs?: string;
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
  return `#${watcher.id} | ${watcher.status}/${source.status}${error} | ${watcher.kind} | ${watcher.label} | ${watcher.target} | next ${next}`;
}

export function createWatchersExtension(store: WatchRuntimeStore, options: WatchToolOptions): Extension {
  const config = options.config;
  const fixedChatId = options.chatId;
  const threadTs = options.threadTs;

  const create = defineTool({
    name: "watch_create",
    description: "Start watching something and notify this conversation when it reaches a final state. kind=feed or x watches an RSS/Atom URL; github_run watches completed CI runs in owner/repo; github_pr watches one pull request (owner/repo#123); github_events watches closed issues in owner/repo. Only terminal changes produce messages; the first check is a silent baseline.",
    parameters: obj({
      kind: oneOf(WATCH_KINDS),
      target: str({ minLength: 1, maxLength: MAX_TARGET_CHARS, description: "Feed URL, owner/repo, owner/repo#123, or a GitHub URL" }),
      label: opt(str({ maxLength: MAX_LABEL_CHARS, description: "Short human name shown in watch_list" })),
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
        const created = store.create({
          chatId,
          ...(threadTs === undefined ? {} : { threadTs }),
          kind: args.kind,
          target: plan.target,
          label: plan.label,
          location: plan.location,
          mode: plan.mode,
          intervalSec: plan.intervalSec,
          now: new Date().toISOString(),
        });
        return toolText(
          `Watcher #${created.watcherId} created for ${plan.target} (${args.kind}). The first check records the current state without sending anything.`,
          {
            id: created.watcherId,
            kind: args.kind,
            target: plan.target,
            mode: plan.mode,
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

  return defineExtension({ name: "watchers", tools: [create, list, stop] });
}

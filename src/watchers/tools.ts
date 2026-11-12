import { int, lit, obj, opt, str, union } from "@earendil-works/pi-schema";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { normalizeFeedUrl } from "./feed.js";
import type { SourceMode, WatchersConfig, WatchKind } from "./protocol.js";
import { WatcherError, type WatcherStore } from "./store.js";

/**
 * The model-facing half of watchers. Two invariants shape it:
 *
 * 1. The chat and thread a watch reports to come from the host (the conversation that asked), never
 *    from a tool argument. A model can therefore start a watch but cannot redirect one elsewhere.
 * 2. Targets are canonicalized here before they reach the store, so a duplicate watch is recognized
 *    regardless of whether the user pasted a URL, a short form, or the same URL with a trailing slash.
 *
 * GitHub targets use one canonical shape, shared with the push half: `owner/repo#<n>` for a pull
 * request, `owner/repo#run:<id>` for a workflow run, and `owner/repo` for the repository's events.
 * The source row stores that canonical text as both target and location.
 */

const OWNER_OR_REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const TARGET_MAX_CHARS = 500;

const KIND_SCHEMA = union([
  lit("github_pr"),
  lit("github_run"),
  lit("github_events"),
  lit("feed"),
  lit("x"),
]);

export type WatcherToolsOptions = {
  readonly config: WatchersConfig;
  /** The conversation the host is answering; captured once, never taken from the arguments. */
  readonly chatId: string;
  /** The thread the current request arrived in, when the channel has one. */
  readonly threadTs?: () => string | undefined;
  /** Host clock, for tests; production uses the wall clock. */
  readonly now?: () => Date;
};

function failure(code: string, message: string): ToolExecutionResult {
  return {
    isError: true,
    output: [{ type: "text", text: message }],
    details: { code },
    diagnostics: [{ severity: "error", code, message }],
  };
}

function text(value: string, details: Record<string, string | number | boolean | null>): ToolExecutionResult {
  return { output: [{ type: "text", text: value }], details };
}

/** The error a tool reports; only host-written codes are surfaced, never a foreign message. */
function toolFailure(error: unknown): ToolExecutionResult {
  if (error instanceof WatcherError) {
    return failure(error.code, error.message);
  }
  return failure("WATCH_STORE_ERROR", "the watcher store could not complete the operation");
}

type ResolvedTarget = { readonly target: string; readonly location: string; readonly label: string; readonly mode: SourceMode; readonly intervalSec: number };

/**
 * Canonicalizes a GitHub target. Only the three shapes above are accepted; anything else is a user
 * mistake the model should fix rather than a URL the host should guess about.
 */
export function normalizeGithubTarget(kind: WatchKind, raw: string): string {
  const value = raw.trim();
  if (value === "" || value.length > TARGET_MAX_CHARS) throw invalidTarget(kind);
  const repo = (owner: string, name: string): string => {
    if (!OWNER_OR_REPO.test(owner) || !OWNER_OR_REPO.test(name)) throw invalidTarget(kind);
    return `${owner}/${name}`;
  };
  if (kind === "github_pr") {
    const url = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(value);
    if (url) return `${repo(url[1]!, url[2]!)}#${url[3]!}`;
    const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(value);
    if (short) return `${repo(short[1]!, short[2]!)}#${short[3]!}`;
    throw invalidTarget(kind);
  }
  if (kind === "github_run") {
    const url = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:[/?#].*)?$/i.exec(value);
    if (url) return `${repo(url[1]!, url[2]!)}#run:${url[3]!}`;
    const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#run:(\d+)$/.exec(value);
    if (short) return `${repo(short[1]!, short[2]!)}#run:${short[3]!}`;
    throw invalidTarget(kind);
  }
  if (kind === "github_events") {
    const url = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(value);
    if (url) return repo(url[1]!, url[2]!);
    const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
    if (short) return repo(short[1]!, short[2]!);
    throw invalidTarget(kind);
  }
  throw invalidTarget(kind);
}

function invalidTarget(kind: WatchKind): WatcherError {
  const expected = kind === "github_pr"
    ? "a GitHub pull request URL or owner/repo#number"
    : kind === "github_run"
      ? "a GitHub Actions run URL or owner/repo#run:id"
      : kind === "github_events"
        ? "a GitHub repository URL or owner/repo"
        : "an absolute public HTTP(S) feed URL";
  return new WatcherError("WATCH_TARGET_INVALID", `the target must be ${expected}`);
}

function githubKind(kind: WatchKind): boolean {
  return kind === "github_pr" || kind === "github_run" || kind === "github_events";
}

/** Resolves the store's target/location/interval from the kind and the user's raw target. */
export function resolveTarget(kind: WatchKind, raw: string, config: WatchersConfig): ResolvedTarget {
  if (githubKind(kind)) {
    const target = normalizeGithubTarget(kind, raw);
    const repoPath = target.split("#")[0] ?? target;
    return {
      target,
      location: target,
      label: `${kind === "github_pr" ? "PR" : kind === "github_run" ? "Actions" : "仓库"} ${repoPath}`,
      mode: "push",
      intervalSec: Math.max(60, Math.trunc(config.githubReconcileMin) * 60),
    };
  }
  const location = normalizeFeedUrl(raw);
  const intervalSec = Math.max(60, Math.trunc(kind === "x" ? config.xIntervalSec : config.feedIntervalSec));
  const hostname = new URL(location).hostname;
  return {
    target: location,
    location,
    label: `${kind === "x" ? "X" : "订阅"} ${hostname}`.slice(0, 120),
    mode: "poll",
    intervalSec,
  };
}

function formatWatcher(entry: ReturnType<WatcherStore["list"]>[number]): string {
  const next = entry.source.nextCheckAt ?? entry.source.reconcileAt;
  return `#${entry.id} | ${entry.kind} | ${entry.label} | ${entry.target} | ${entry.source.status}`
    + ` | ${next === null ? "no schedule" : next}`;
}

export function createWatcherExtension(store: WatcherStore, options: WatcherToolsOptions): Extension {
  const { config, chatId } = options;
  const now = (): string => (options.now ?? (() => new Date()))().toISOString();

  const create = defineTool({
    name: "watch_create",
    description: "Start tracking something and tell this conversation when it changes. Kinds:"
      + " github_pr (a pull request's merge or close), github_run (a workflow run finishing),"
      + " github_events (a repository's issues and pull requests), feed (an RSS/Atom URL), x (an"
      + " RSS-shaped timeline URL). The host checks feeds on its own schedule; GitHub notifications"
      + " arrive by webhook and are reconciled. The first check only records a baseline, so no history"
      + " is sent. You cannot choose the destination conversation.",
    parameters: obj({
      kind: KIND_SCHEMA,
      target: str({
        minLength: 1,
        maxLength: TARGET_MAX_CHARS,
        description: "PR URL or owner/repo#number, Actions run URL or owner/repo#run:id, repository URL or owner/repo, or a public feed URL",
      }),
      label: opt(str({ maxLength: 120, description: "Short human name for the watch; defaults from the target" })),
    }),
    replay: "unsafe",
    execute: async (args) => {
      try {
        const kind = args.kind as WatchKind;
        const resolved = resolveTarget(kind, args.target, config);
        const threadTs = options.threadTs?.();
        const created = store.create({
          chatId,
          ...(threadTs === undefined || threadTs === "" ? {} : { threadTs }),
          kind,
          target: resolved.target,
          label: (args.label ?? resolved.label).trim().slice(0, 120) || resolved.label,
          location: resolved.location,
          mode: resolved.mode,
          intervalSec: resolved.intervalSec,
          now: now(),
        });
        return text(
          `Watcher #${created.watcherId} created for ${kind} ${resolved.target}. The first check is a baseline.`,
          { id: created.watcherId, kind, mode: resolved.mode },
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  });

  const list = defineTool({
    name: "watch_list",
    description: "List this conversation's active watches with their kind, target and schedule state.",
    parameters: obj({}),
    replay: "safe",
    execute: async () => {
      try {
        const watchers = store.list(chatId);
        if (watchers.length === 0) return text("No watchers.", { count: 0 });
        return text(watchers.map(formatWatcher).join("\n"), { count: watchers.length });
      } catch (error) {
        return toolFailure(error);
      }
    },
  });

  const stop = defineTool({
    name: "watch_stop",
    description: "Stop a watch by its numeric ID. Stopping an already stopped watch reports that it is stopped.",
    parameters: obj({ id: int({ minimum: 1 }) }),
    replay: "unsafe",
    execute: async (args) => {
      try {
        const stopped = store.stop(chatId, args.id, now());
        return text(
          stopped ? `Watcher #${args.id} is stopped.` : `Watcher #${args.id} was already stopped.`,
          { id: args.id, stopped },
        );
      } catch (error) {
        return toolFailure(error);
      }
    },
  });

  return defineExtension({ name: "watchers", tools: [create, list, stop] });
}

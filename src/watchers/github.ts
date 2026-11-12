/**
 * GitHub push-side adapters: webhook normalization and REST reconciliation reads.
 *
 * Everything here produces the same shape the polling half produces — a semantic dedup key plus a
 * deterministic one-line text — so the store, not the transport, decides whether the user sees
 * something. Three decisions shape the file:
 *
 * 1. Only terminal states become events (spec 5.1). Intermediate actions such as `opened`,
 *    `synchronize`, `queued` or `in_progress` are counted as skipped and never reach the store.
 * 2. Webhook and REST must produce byte-identical dedup keys for the same fact, or reconciliation
 *    would double-notify. The draft builders below are shared by both paths for exactly that
 *    reason. The one place where they cannot agree is the issues endpoint, whose `updated_at`
 *    drifts after the close (comments, labels); there the REST reader only emits a row whose
 *    `closed_at` still equals `updated_at`, i.e. the close is the latest change, which keeps the
 *    spec key (`state@updated_at`) stable on both paths.
 * 3. Zombie runs (an older revision of a branch completing after a newer one was already seen) are
 *    dropped by the webhook normalizer using per-branch start timestamps. The tracker is
 *    in-memory; after a restart the first event for a branch re-anchors it, and reconciliation is
 *    the backstop that never depends on webhook delivery at all.
 *
 * Baseline ownership: the relay client owns `sources.cursor`, REST reconciliation owns
 * `sources.etag` / `sources.last_modified`. Each path decides "this is my first successful read"
 * from its own columns being null, so the two paths baseline independently and neither can flood
 * the user with history the other one already recorded.
 */

import type { SourceRow, WatchKind } from "./protocol.js";

const MAX_FACT_CHARS = 256;
const MAX_TITLE_CHARS = 120;
const MAX_LIST_ITEMS = 20;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

/** Host-written failure for GitHub reads; the message is operator-facing and value-free. */
export class GithubWatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Rate limits abort the whole reconcile pass instead of failing every remaining source. */
    readonly passAbort = false,
  ) {
    super(message);
    this.name = "GithubWatchError";
  }
}

/** One terminal fact before text composition. `revision` feeds zombie detection on the webhook path. */
export type GithubDraft = {
  readonly dedupKey: string;
  readonly kind: string;
  readonly occurredAt: string;
  readonly facts: Readonly<Record<string, string | number | boolean>>;
  readonly revision?: { readonly branch: string; readonly sha: string; readonly at: number };
};

export type NormalizedWebhook = {
  readonly events: readonly GithubDraft[];
  readonly zombie: number;
  readonly skipped: number;
};

export type GithubTarget = {
  readonly owner: string;
  readonly repo: string;
  readonly number?: number;
  readonly workflow?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, max = MAX_FACT_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!trimmed) return undefined;
  return [...trimmed].length > max ? [...trimmed].slice(0, max).join("") : trimmed;
}

function asInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  return undefined;
}

function asTimestamp(value: unknown): number | undefined {
  const text = asString(value, 40);
  if (text === undefined) return undefined;
  const time = Date.parse(text);
  return Number.isFinite(time) ? time : undefined;
}

/** Canonical `owner/repo`, lower-cased so webhook and REST comparisons agree. */
function repoName(value: unknown): string | undefined {
  const name = asString(value, 256);
  if (name === undefined) return undefined;
  const normalized = name.toLowerCase();
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(normalized) ? normalized : undefined;
}

function isoOrNow(value: unknown, nowIso: string): string {
  const time = asTimestamp(value);
  return time === undefined ? nowIso : new Date(time).toISOString();
}

const iso = (time: number): string => new Date(time).toISOString();

/** Parse a watcher target for the GitHub kinds; anything else is a configuration error. */
export function parseGithubTarget(kind: WatchKind, target: string): GithubTarget {
  const raw = target.trim();
  const ident = "[A-Za-z0-9][A-Za-z0-9_.-]*";
  // The regex guarantees the groups exist; the casts only satisfy noUncheckedIndexedAccess.
  let match: RegExpExecArray | null;
  if (kind === "github_pr") {
    if (!(match = new RegExp(`^(${ident})\\/(${ident})#(\\d+)$`).exec(raw))) {
      throw new GithubWatchError("WATCH_TARGET_INVALID", "github_pr target must be owner/repo#number");
    }
    return { owner: match[1] as string, repo: match[2] as string, number: Number(match[3]) };
  }
  if (kind === "github_run") {
    if (!(match = new RegExp(`^(${ident})\\/(${ident})(?:@(.{1,200}))?$`).exec(raw))) {
      throw new GithubWatchError("WATCH_TARGET_INVALID", "github_run target must be owner/repo or owner/repo@workflow");
    }
    const workflow = asString(match[3], 200);
    return { owner: match[1] as string, repo: match[2] as string, ...(workflow !== undefined ? { workflow } : {}) };
  }
  if (kind === "github_events") {
    if (!(match = new RegExp(`^(${ident})\\/(${ident})$`).exec(raw))) {
      throw new GithubWatchError("WATCH_TARGET_INVALID", "github_events target must be owner/repo");
    }
    return { owner: match[1] as string, repo: match[2] as string };
  }
  throw new GithubWatchError("WATCH_TARGET_INVALID", `kind ${kind} is not a GitHub kind`);
}

/** Shared draft builders: the webhook and the REST reader must agree on keys byte for byte. */

function runDraft(repo: string, run: Record<string, unknown>): GithubDraft | undefined {
  const runId = asInteger(run["id"]);
  const conclusion = asString(run["conclusion"], 32);
  if (runId === undefined || conclusion === undefined) return undefined;
  const branch = asString(run["head_branch"], 200) ?? "";
  const sha = asString(run["head_sha"], 64) ?? "";
  const facts: Record<string, string | number | boolean> = {
    repo,
    runId,
    conclusion,
    ...(branch ? { branch } : {}),
    ...(SHA_PATTERN.test(sha) ? { sha } : {}),
    ...(asString(run["name"], MAX_TITLE_CHARS) !== undefined ? { workflow: asString(run["name"], MAX_TITLE_CHARS)! } : {}),
    ...(asString(run["html_url"], MAX_FACT_CHARS) !== undefined ? { link: asString(run["html_url"], MAX_FACT_CHARS)! } : {}),
  };
  const startedAt = asTimestamp(run["run_started_at"]) ?? asTimestamp(run["created_at"]);
  const at = startedAt ?? asTimestamp(run["updated_at"]);
  return {
    dedupKey: `gh:${repo}:run:${runId}:${conclusion}`,
    kind: "github_run",
    occurredAt: isoOrNow(run["updated_at"] ?? run["completed_at"], new Date(0).toISOString()),
    facts,
    ...(branch && sha && at !== undefined ? { revision: { branch, sha, at } } : {}),
  };
}

function suiteDraft(repo: string, suite: Record<string, unknown>): GithubDraft | undefined {
  const suiteId = asInteger(suite["id"]);
  const conclusion = asString(suite["conclusion"], 32);
  if (suiteId === undefined || conclusion === undefined) return undefined;
  const branch = asString(suite["head_branch"], 200) ?? "";
  const sha = asString(suite["head_sha"], 64) ?? "";
  const at = asTimestamp(suite["created_at"]) ?? asTimestamp(suite["updated_at"]);
  const facts: Record<string, string | number | boolean> = {
    repo,
    suiteId,
    conclusion,
    ...(branch ? { branch } : {}),
    ...(SHA_PATTERN.test(sha) ? { sha, link: `https://github.com/${repo}/commit/${sha}` } : {}),
  };
  return {
    dedupKey: `gh:${repo}:suite:${suiteId}:${conclusion}`,
    kind: "github_check",
    occurredAt: isoOrNow(suite["updated_at"] ?? suite["created_at"], new Date(0).toISOString()),
    facts,
    ...(branch && sha && at !== undefined ? { revision: { branch, sha, at } } : {}),
  };
}

function prDraft(repo: string, pr: Record<string, unknown>): GithubDraft | undefined {
  const number = asInteger(pr["number"]);
  if (number === undefined) return undefined;
  const closedAt = asString(pr["closed_at"], 40);
  const merged = pr["merged"] === true;
  const sha = asString(pr["merge_commit_sha"], 64);
  const title = asString(pr["title"], MAX_TITLE_CHARS);
  const link = asString(pr["html_url"], MAX_FACT_CHARS);
  if (merged && sha !== undefined) {
    const occurredAt = asString(pr["merged_at"], 40) ?? closedAt;
    if (occurredAt === undefined) return undefined;
    return {
      dedupKey: `gh:${repo}:pr:${number}:merged@${sha}`,
      kind: "github_pr",
      occurredAt,
      facts: { repo, number, outcome: "merged", ...(title !== undefined ? { title } : {}), ...(link !== undefined ? { link } : {}) },
    };
  }
  if (closedAt === undefined) return undefined;
  return {
    dedupKey: `gh:${repo}:pr:${number}:closed@${closedAt}`,
    kind: "github_pr",
    occurredAt: closedAt,
    facts: { repo, number, outcome: "closed", ...(title !== undefined ? { title } : {}), ...(link !== undefined ? { link } : {}) },
  };
}

function issueDraft(repo: string, issue: Record<string, unknown>): GithubDraft | undefined {
  const number = asInteger(issue["number"]);
  const state = asString(issue["state"], 16);
  const updatedAt = asString(issue["updated_at"], 40);
  if (number === undefined || state === undefined || updatedAt === undefined) return undefined;
  const title = asString(issue["title"], MAX_TITLE_CHARS);
  const link = asString(issue["html_url"], MAX_FACT_CHARS);
  return {
    dedupKey: `gh:${repo}:issue:${number}:${state}@${updatedAt}`,
    kind: "github_issue",
    occurredAt: updatedAt,
    facts: { repo, number, state, ...(title !== undefined ? { title } : {}), ...(link !== undefined ? { link } : {}) },
  };
}

function commentDraft(repo: string, issue: Record<string, unknown>, comment: Record<string, unknown>): GithubDraft | undefined {
  const number = asInteger(issue["number"]);
  const commentId = asInteger(comment["id"]);
  if (number === undefined || commentId === undefined) return undefined;
  const author = comment && isRecord(comment["user"]) ? asString((comment["user"] as Record<string, unknown>)["login"], 64) : undefined;
  const link = asString(comment["html_url"], MAX_FACT_CHARS);
  return {
    dedupKey: `gh:${repo}:issue:${number}:comment:${commentId}`,
    kind: "github_comment",
    occurredAt: isoOrNow(comment["created_at"], new Date(0).toISOString()),
    facts: {
      repo,
      number,
      commentId,
      ...(author !== undefined ? { author } : {}),
      ...(link !== undefined ? { link } : {}),
    },
  };
}

/**
 * Webhook normalizer. Subscribe list per spec 5.4; anything else is counted as skipped. The
 * returned drafts are transport-neutral: the relay client and the reconcile pass assemble the
 * final `WatchEventInput` (including the one-line text) themselves.
 */
export function createGithubNormalizer() {
  // Per (repo, branch): the newest completion seen so far. An older revision finishing after it
  // is a zombie. Losing this map on restart only weakens detection; reconcile is the backstop.
  const revisions = new Map<string, { at: number }>();
  const zombieCheck = (repo: string, revision: GithubDraft["revision"]): boolean => {
    if (revision === undefined) return false;
    const key = `${repo}@${revision.branch}`;
    const previous = revisions.get(key);
    if (previous !== undefined && revision.at < previous.at) return true;
    revisions.set(key, { at: previous !== undefined && previous.at > revision.at ? previous.at : revision.at });
    return false;
  };

  return {
    normalize(eventName: string, payload: unknown, nowIso: string): NormalizedWebhook {
      let skipped = 0;
      let zombie = 0;
      const skip = () => { skipped += 1; return undefined; };
      if (!isRecord(payload)) return { events: [], zombie, skipped: 1 };
      const repo = repoName(isRecord(payload["repository"]) ? payload["repository"]["full_name"] : undefined);
      if (repo === undefined) return { events: [], zombie, skipped: 1 };
      const action = asString(payload["action"], 32);
      const events: GithubDraft[] = [];
      const push = (draft: GithubDraft | undefined, revision?: GithubDraft["revision"]): void => {
        if (draft === undefined) { skipped += 1; return; }
        if (revision !== undefined && zombieCheck(repo, revision)) { zombie += 1; return; }
        events.push(draft);
      };

      switch (eventName) {
        case "pull_request": {
          if (action !== "closed" || !isRecord(payload["pull_request"])) { skip(); break; }
          push(prDraft(repo, payload["pull_request"]));
          break;
        }
        case "issues": {
          if ((action !== "closed" && action !== "reopened") || !isRecord(payload["issue"])) { skip(); break; }
          push(issueDraft(repo, payload["issue"]));
          break;
        }
        case "issue_comment": {
          if (action !== "created" || !isRecord(payload["issue"]) || !isRecord(payload["comment"])) { skip(); break; }
          push(commentDraft(repo, payload["issue"], payload["comment"]));
          break;
        }
        case "workflow_run": {
          if (action !== "completed" || !isRecord(payload["workflow_run"])) { skip(); break; }
          // runDraft is undefined exactly when the run completed without a conclusion (spec 5.1).
          const draft = runDraft(repo, payload["workflow_run"]);
          if (draft === undefined) { skip(); break; }
          push(draft, draft.revision);
          break;
        }
        case "check_suite": {
          if (action !== "completed" || !isRecord(payload["check_suite"])) { skip(); break; }
          const draft = suiteDraft(repo, payload["check_suite"]);
          if (draft === undefined) { skip(); break; }
          push(draft, draft.revision);
          break;
        }
        default:
          skip();
          break;
      }
      return { events, zombie, skipped };
    },
  };
}

export type GithubNormalizer = ReturnType<typeof createGithubNormalizer>;

/** The one deterministic delivery line (spec 5.5); the model may rephrase it, never re-derive it. */
export function composeGithubText(watcherId: number, draft: GithubDraft): string {
  const facts = draft.facts;
  const link = typeof facts["link"] === "string" && facts["link"] ? ` ${facts["link"]}` : "";
  const repo = typeof facts["repo"] === "string" ? facts["repo"] : "";
  let line: string;
  switch (draft.kind) {
    case "github_run": {
      const conclusion = typeof facts["conclusion"] === "string" ? facts["conclusion"] : "unknown";
      line = `CI 运行 #${facts["runId"]} 在 ${repo} ${conclusion === "success" ? "成功" : `结束（${conclusion}）`}`;
      break;
    }
    case "github_check": {
      const conclusion = typeof facts["conclusion"] === "string" ? facts["conclusion"] : "unknown";
      line = `提交检查套件 #${facts["suiteId"]} 在 ${repo} ${conclusion === "success" ? "通过" : `结束（${conclusion}）`}`;
      break;
    }
    case "github_pr":
      line = typeof facts["outcome"] === "string" && facts["outcome"] === "merged"
        ? `PR #${facts["number"]} 在 ${repo} 已合并`
        : `PR #${facts["number"]} 在 ${repo} 已关闭`;
      break;
    case "github_issue":
      line = typeof facts["state"] === "string" && facts["state"] === "closed"
        ? `Issue #${facts["number"]} 在 ${repo} 已关闭`
        : `Issue #${facts["number"]} 在 ${repo} 已重新打开`;
      break;
    case "github_comment":
      line = `Issue #${facts["number"]} 在 ${repo} 有新评论`;
      break;
    default:
      line = `${draft.kind} 在 ${repo} 有更新`;
      break;
  }
  return `[跟踪 #${watcherId}] ${line}${link}`;
}

export type RestPlanRequest = {
  readonly path: string;
  readonly select: (body: unknown) => readonly GithubDraft[];
};

export type RestOutcome =
  | { readonly status: "ok"; readonly events: readonly GithubDraft[]; readonly etag: string | null }
  | { readonly status: "notModified" };

export type GithubRestOptions = {
  /** From WATCHERS_GITHUB_TOKEN; never from env inside this module. */
  readonly token?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Tests point this at a local server; production uses the public API. */
  readonly apiBase?: string;
};

/** Read one response body with a hard byte cap; oversize is a parse-class failure, never a crash. */
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new GithubWatchError("WATCH_FEED_TOO_LARGE", "GitHub response exceeds the size limit");
  if (response.body === null) throw new GithubWatchError("WATCH_PARSE_FAILED", "GitHub response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new GithubWatchError("WATCH_FEED_TOO_LARGE", "GitHub response exceeds the size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function httpError(status: number, remaining: string | null): GithubWatchError {
  if (status === 404 || status === 410) return new GithubWatchError("WATCH_SOURCE_GONE", "GitHub target no longer exists");
  if (status === 401) return new GithubWatchError("WATCH_SOURCE_AUTH", "GitHub rejected the credentials");
  if (status === 403 || status === 429) {
    return remaining === "0" || status === 429
      ? new GithubWatchError("WATCH_RATE_LIMITED", "GitHub rate limit exhausted", true)
      : new GithubWatchError("WATCH_SOURCE_AUTH", "GitHub denied access to the target");
  }
  return new GithubWatchError("WATCH_FETCH_TIMEOUT", "GitHub returned a transient error", true);
}

/**
 * REST reconciliation reader (spec 5.4): per source, one plan of list/detail requests, each sent
 * with `If-None-Match` when a stored ETag part exists. The stored ETag is the per-request parts
 * joined with "\n" (header values cannot contain a newline, so the join is unambiguous). An
 * all-304 outcome produces no events and no state write, so it neither floods nor resets backoff.
 */
export function createGithubRest(options: GithubRestOptions = {}) {
  const base = options.apiBase ?? "https://api.github.com";
  const doFetch = options.fetch ?? fetch;
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const timeoutMs = options.timeoutMs ?? 15_000;

  const plans = new Map<WatchKind, (target: GithubTarget) => readonly RestPlanRequest[]>([
    ["github_pr", (target) => [{
      path: `/repos/${target.owner}/${target.repo}/pulls/${target.number}`,
      select: (body) => {
        if (!isRecord(body) || body["state"] !== "closed") return [];
        const draft = prDraft(`${target.owner}/${target.repo}`.toLowerCase(), body);
        return draft === undefined ? [] : [draft];
      },
    }]],
    ["github_run", (target) => [{
      path: `/repos/${target.owner}/${target.repo}/actions/runs?per_page=${MAX_LIST_ITEMS}`,
      select: (body) => {
        if (!isRecord(body) || !Array.isArray(body["workflow_runs"])) return [];
        const repo = `${target.owner}/${target.repo}`.toLowerCase();
        return body["workflow_runs"]
          .filter((run): run is Record<string, unknown> => isRecord(run) && asString(run["status"], 32) === "completed")
          .map((run) => runDraft(repo, run))
          .filter((draft): draft is GithubDraft => {
            if (draft === undefined) return false;
            if (target.workflow === undefined) return true;
            const name = typeof draft.facts["workflow"] === "string" ? draft.facts["workflow"].toLowerCase() : "";
            return name === target.workflow.toLowerCase();
          });
      },
    }]],
    ["github_events", (target) => [
      {
        path: `/repos/${target.owner}/${target.repo}/issues?state=closed&sort=updated&direction=desc&per_page=${MAX_LIST_ITEMS}`,
        select: (body) => {
          if (!Array.isArray(body)) return [];
          const repo = `${target.owner}/${target.repo}`.toLowerCase();
          return body
            .filter((item): item is Record<string, unknown> => isRecord(item) && item["pull_request"] === undefined)
            .map((issue) => {
              const draft = issueDraft(repo, issue);
              if (draft === undefined) return undefined;
              // Only a close that is still the latest change keeps the spec key stable across
              // webhook and REST; later comment/label activity would drift `updated_at`.
              const closedAt = asString(issue["closed_at"], 40);
              const updatedAt = asString(issue["updated_at"], 40);
              if (closedAt === undefined || updatedAt === undefined || closedAt !== updatedAt) return undefined;
              return draft;
            })
            .filter((draft): draft is GithubDraft => draft !== undefined);
        },
      },
      {
        path: `/repos/${target.owner}/${target.repo}/actions/runs?per_page=${MAX_LIST_ITEMS}`,
        select: (body) => {
          if (!isRecord(body) || !Array.isArray(body["workflow_runs"])) return [];
          const repo = `${target.owner}/${target.repo}`.toLowerCase();
          return body["workflow_runs"]
            .filter((run): run is Record<string, unknown> => isRecord(run) && asString(run["status"], 32) === "completed")
            .map((run) => runDraft(repo, run))
            .filter((draft): draft is GithubDraft => draft !== undefined);
        },
      },
    ]],
  ]);

  const requestOne = async (
    path: string,
    etagPart: string | undefined,
    select: (body: unknown) => readonly GithubDraft[],
    signal: AbortSignal,
  ): Promise<{ events: readonly GithubDraft[]; etagPart: string | null; modified: boolean }> => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        redirect: "error",
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "aster-watchers",
          ...(options.token !== undefined && options.token !== "" ? { authorization: `Bearer ${options.token}` } : {}),
          ...(etagPart !== undefined ? { "if-none-match": etagPart } : {}),
        },
        signal: deadline,
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof GithubWatchError) throw error;
      throw new GithubWatchError("WATCH_FETCH_TIMEOUT", "GitHub REST request failed", true);
    }
    if (response.status === 304) return { events: [], etagPart: etagPart ?? null, modified: false };
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw httpError(response.status, response.headers.get("x-ratelimit-remaining"));
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBounded(response, maxBytes));
    } catch (error) {
      if (error instanceof GithubWatchError) throw error;
      throw new GithubWatchError("WATCH_PARSE_FAILED", "GitHub REST response was not valid JSON");
    }
    return { events: select(body), etagPart: response.headers.get("etag"), modified: true };
  };

  return {
    /** Read the current terminal-state set for one source. Throws GithubWatchError on failure. */
    async read(source: Pick<SourceRow, "kind" | "location" | "etag">, signal: AbortSignal): Promise<RestOutcome> {
      const target = parseGithubTarget(source.kind, source.location);
      const build = plans.get(source.kind);
      if (build === undefined) throw new GithubWatchError("WATCH_TARGET_INVALID", `kind ${source.kind} has no GitHub REST plan`);
      const stored = source.etag === null ? [] : source.etag.split("\n");
      const plan = build(target);
      const parts: string[] = [];
      const events: GithubDraft[] = [];
      let anyModified = false;
      for (let index = 0; index < plan.length; index++) {
        const result = await requestOne(plan[index]!.path, stored[index], plan[index]!.select, signal);
        parts.push(result.etagPart ?? "");
        events.push(...result.events);
        if (result.modified) anyModified = true;
      }
      if (!anyModified) return { status: "notModified" };
      const etag = parts.some((part) => part !== "") ? parts.join("\n") : null;
      return { status: "ok", events, etag };
    },
  };
}

export type GithubRest = ReturnType<typeof createGithubRest>;

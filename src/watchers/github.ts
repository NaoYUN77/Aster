import type { SourceCheck, SourceCheckResult, SourceRow, SourceState, WatchEventInput, WatchKind } from "./protocol.js";
import { boundedFacts, checksText, eventText, issueText, pullRequestText, safeLink } from "./normalize.js";
import type { SourceCheckOutcome } from "./poll.js";

/**
 * GitHub normalization and reconciliation.
 *
 * The webhook and the REST path must produce the *same* event for the same terminal state, because
 * the store dedupes on that semantic key: a run's conclusion, a pull request's merge/close, an
 * issue's close. Intermediate states (`queued`, `in_progress`, `opened`) are deliberately absent, so
 * a delivery stream can never turn into a progress feed. Payloads are untrusted: identifiers are
 * validated, links are reduced to public URLs, and no payload value becomes a tool call or a target.
 */

const GITHUB_API = "https://api.github.com";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS_PER_CHECK = 25;
const REPO_SHAPE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(`watch github failed (${code})`), { code });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: Record<string, unknown> | undefined, key: string): string {
  const entry = value?.[key];
  return typeof entry === "string" ? entry : "";
}

function numeric(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const entry = value?.[key];
  return typeof entry === "number" && Number.isSafeInteger(entry) ? entry : undefined;
}

function toIso(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

export type GithubTarget = {
  readonly repo: string;
  readonly number?: number;
};

/** Accepts `owner/repo`, `owner/repo#12`, `owner/repo/pull/12` and a github.com URL. */
export function parseGithubTarget(target: string): GithubTarget | undefined {
  const raw = target.trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\/(?:pull|issues)\/(\d+)|#(\d+))?$/i.exec(raw);
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  const repo = `${match[1]}/${match[2]}`;
  if (!REPO_SHAPE.test(repo)) return undefined;
  const numberText = match[3] ?? match[4];
  const number = numberText === undefined ? undefined : Number(numberText);
  if (number !== undefined && (!Number.isSafeInteger(number) || number < 1)) return undefined;
  return number === undefined ? { repo } : { repo, number };
}

function repositoryOf(payload: Record<string, unknown>): string {
  const repository = record(payload.repository) ? payload.repository : undefined;
  const fullName = text(repository, "full_name");
  return REPO_SHAPE.test(fullName) ? fullName : "";
}

export type NormalizedWebhook = {
  /** Repository full name, empty when the payload does not name a valid repository. */
  readonly repo: string;
  readonly events: readonly WatchEventInput[];
  /** Deliveries (or parts of one) that were dropped: non-terminal actions, malformed bodies. */
  readonly ignored: number;
};

/**
 * Turn one GitHub delivery into zero or more terminal events. `issue_comment` is subscribed because
 * GitHub can deliver terminal state changes alongside it, but a comment itself is never an event.
 */
export function normalizeWebhook(event: string, payload: unknown, deliveryId?: string): NormalizedWebhook {
  if (!record(payload)) return { repo: "", events: [], ignored: 1 };
  const repo = repositoryOf(payload);
  if (repo === "") return { repo: "", events: [], ignored: 1 };
  const action = text(payload, "action");
  const build = (
    kind: WatchKind,
    dedupKey: string,
    occurredAt: string,
    facts: Record<string, string | number | boolean | undefined>,
    body: string,
  ): WatchEventInput => ({
    dedupKey,
    ...(deliveryId === undefined ? {} : { deliveryId }),
    kind,
    occurredAt,
    facts: boundedFacts({ repo, ...facts }),
    text: body,
  });

  if (event === "workflow_run") {
    const run = record(payload.workflow_run) ? payload.workflow_run : undefined;
    const id = numeric(run, "id");
    const conclusion = text(run, "conclusion");
    const status = text(run, "status");
    if (action !== "completed" || status !== "completed" || conclusion === "" || id === undefined) {
      return { repo, events: [], ignored: 1 };
    }
    const facts = {
      run_id: id,
      conclusion,
      url: safeLink(text(run, "html_url")),
    };
    return {
      repo,
      events: [build("github_run", `gh:${repo}:run:${id}:${conclusion}`, toIso(text(run, "updated_at")), facts, eventText("github_run", boundedFacts({ repo, ...facts })))],
      ignored: 0,
    };
  }

  if (event === "check_suite") {
    const suite = record(payload.check_suite) ? payload.check_suite : undefined;
    const id = numeric(suite, "id");
    const conclusion = text(suite, "conclusion");
    if (action !== "completed" || conclusion === "" || id === undefined) {
      return { repo, events: [], ignored: 1 };
    }
    const facts = { conclusion, url: safeLink(text(suite, "html_url")) };
    return {
      repo,
      events: [build("github_run", `gh:${repo}:checks:${id}:${conclusion}`, toIso(text(suite, "updated_at")), facts, checksText(boundedFacts({ repo, ...facts })))],
      ignored: 0,
    };
  }

  if (event === "pull_request") {
    const pull = record(payload.pull_request) ? payload.pull_request : undefined;
    const number = numeric(pull, "number");
    const merged = pull?.["merged"] === true;
    const closedAt = text(pull, "closed_at");
    if (action !== "closed" || number === undefined) return { repo, events: [], ignored: 1 };
    const mergeSha = text(pull, "merge_commit_sha");
    const anchor = merged ? mergeSha : closedAt;
    if (anchor === "") return { repo, events: [], ignored: 1 };
    const facts = {
      number,
      state: merged ? "merged" : "closed",
      url: safeLink(text(pull, "html_url")),
    };
    const key = merged
      ? `gh:${repo}:pr:${number}:merged@${mergeSha}`
      : `gh:${repo}:pr:${number}:closed@${closedAt}`;
    return {
      repo,
      events: [build("github_pr", key, toIso(merged ? text(pull, "merged_at") || closedAt : closedAt), facts, pullRequestText(boundedFacts({ repo, ...facts })))],
      ignored: 0,
    };
  }

  if (event === "issues") {
    const issue = record(payload.issue) ? payload.issue : undefined;
    const number = numeric(issue, "number");
    const state = text(issue, "state");
    const updatedAt = text(issue, "updated_at");
    if (action !== "closed" || state !== "closed" || number === undefined || updatedAt === "") {
      return { repo, events: [], ignored: 1 };
    }
    const facts = { number, state, url: safeLink(text(issue, "html_url")) };
    return {
      repo,
      events: [build("github_events", `gh:${repo}:issue:${number}:${state}@${updatedAt}`, toIso(updatedAt), facts, issueText(boundedFacts({ repo, ...facts })))],
      ignored: 0,
    };
  }

  // issue_comment and every unsubscribed event carry no terminal state of their own.
  return { repo, events: [], ignored: 1 };
}

/** Which normalized events belong to one watcher: same repository, same kind, same number when pinned. */
export function eventsForSource(source: SourceRow, normalized: NormalizedWebhook): readonly WatchEventInput[] {
  const target = parseGithubTarget(source.location);
  if (target === undefined || normalized.repo === "") return [];
  if (target.repo.toLowerCase() !== normalized.repo.toLowerCase()) return [];
  return normalized.events.filter((event) => {
    if (event.kind !== source.kind) return false;
    if (target.number === undefined) return true;
    return Number(event.facts.number) === target.number;
  });
}

export type GithubWebhookRecord = {
  readonly event: string;
  readonly payload: unknown;
  readonly deliveryId?: string;
};

/** One REST read; conditional requests keep reconcile cheap when nothing changed. */
class GithubRest {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: { token?: string; timeoutMs: number; fetch?: typeof fetch; baseUrl?: string }) {
    this.#baseUrl = options.baseUrl ?? GITHUB_API;
    this.#token = options.token?.trim() ?? "";
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? fetch;
  }

  get available(): boolean {
    return this.#token !== "";
  }

  async get(path: string, etag: string | null, signal: AbortSignal): Promise<{ readonly notModified: boolean; readonly body?: unknown; readonly etag?: string }> {
    if (this.#token === "") throw failure("WATCH_SOURCE_AUTH");
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.#timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}${path}`, {
          method: "GET",
          redirect: "error",
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            authorization: `Bearer ${this.#token}`,
            "user-agent": "aster-watchers/1",
            ...(etag === null ? {} : { "if-none-match": etag }),
          },
          signal: AbortSignal.any([signal, deadline.signal]),
        });
      } catch {
        throw failure("WATCH_FETCH_TIMEOUT");
      }
      if (response.status === 304) {
        await response.body?.cancel().catch(() => {});
        return { notModified: true };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if ((response.status === 401 || response.status === 403)
          && response.headers.get("x-ratelimit-remaining") === "0") throw failure("WATCH_RATE_LIMITED");
        throw failure(httpCode(response.status));
      }
      const body = await readJson(response);
      const responseEtag = response.headers.get("etag");
      return {
        notModified: false,
        body,
        ...(responseEtag === null ? {} : { etag: responseEtag }),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw failure("WATCH_PARSE_FAILED");
  }
  try {
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_RESPONSE_BYTES) throw failure("WATCH_PARSE_FAILED");
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error) throw error;
    throw failure("WATCH_PARSE_FAILED");
  }
}

function httpCode(status: number): string {
  if (status === 404 || status === 410) return "WATCH_SOURCE_GONE";
  if (status === 401 || status === 403) return "WATCH_SOURCE_AUTH";
  if (status === 429) return "WATCH_RATE_LIMITED";
  if (status === 400 || status === 422) return "WATCH_PARSE_FAILED";
  return "WATCH_FETCH_TIMEOUT";
}

/**
 * Reconciles one push source against GitHub's terminal states. It uses the same key builders as the
 * webhook path, so an event the relay lost is inserted exactly once, and an event the relay already
 * delivered is dropped by the store's uniqueness constraint.
 */
export class GithubReconcileCheck implements SourceCheck {
  readonly #rest: GithubRest;

  constructor(options: { token?: string; timeoutMs: number; fetch?: typeof fetch; baseUrl?: string }) {
    this.#rest = new GithubRest(options);
  }

  async check(source: SourceRow, signal: AbortSignal): Promise<SourceCheckResult> {
    return (await this.checkDetailed(source, signal)).result;
  }

  async checkDetailed(source: SourceRow, signal: AbortSignal): Promise<SourceCheckOutcome> {
    const target = parseGithubTarget(source.location);
    if (target === undefined) throw failure("WATCH_SOURCE_GONE");
    const encoded = target.repo.split("/").map((part) => encodeURIComponent(part)).join("/");
    let path: string;
    let parse: (body: unknown, repo: string) => WatchEventInput[];
    if (source.kind === "github_run") {
      path = `/repos/${encoded}/actions/runs?status=completed&per_page=${MAX_EVENTS_PER_CHECK}`;
      parse = parseCompletedRuns;
    } else if (source.kind === "github_pr") {
      if (target.number === undefined) throw failure("WATCH_TARGET_INVALID");
      path = `/repos/${encoded}/pulls/${target.number}`;
      parse = (body, repo) => parseOnePull(body, repo, target.number as number);
    } else {
      path = `/repos/${encoded}/issues?state=closed&sort=updated&direction=desc&per_page=${MAX_EVENTS_PER_CHECK}`;
      parse = parseClosedIssues;
    }
    const response = await this.#rest.get(path, source.etag, signal);
    if (response.notModified) {
      const state: SourceState = source.etag === null ? {} : { etag: source.etag };
      return { result: { events: [], state }, notModified: true };
    }
    const events = parse(response.body, target.repo);
    const state: SourceState = response.etag === undefined ? {} : { etag: response.etag };
    return { result: { events: events.slice(0, MAX_EVENTS_PER_CHECK), state }, notModified: false };
  }
}

function parseCompletedRuns(body: unknown, repo: string): WatchEventInput[] {
  if (!record(body) || !Array.isArray(body.workflow_runs)) return [];
  const events: WatchEventInput[] = [];
  for (const entry of body.workflow_runs) {
    if (!record(entry)) continue;
    const id = numeric(entry, "id");
    const conclusion = text(entry, "conclusion");
    if (id === undefined || conclusion === "" || text(entry, "status") !== "completed") continue;
    const facts = boundedFacts({ repo, run_id: id, conclusion, url: safeLink(text(entry, "html_url")) });
    events.push({
      dedupKey: `gh:${repo}:run:${id}:${conclusion}`,
      kind: "github_run",
      occurredAt: toIso(text(entry, "updated_at")),
      facts,
      text: eventText("github_run", facts),
    });
  }
  return events;
}

function parseOnePull(body: unknown, repo: string, number: number): WatchEventInput[] {
  if (!record(body) || text(body, "state") !== "closed") return [];
  const merged = body["merged"] === true;
  const closedAt = text(body, "closed_at");
  const mergeSha = text(body, "merge_commit_sha");
  if (!merged && closedAt === "") return [];
  if (merged && mergeSha === "") return [];
  const facts = boundedFacts({
    repo,
    number,
    state: merged ? "merged" : "closed",
    url: safeLink(text(body, "html_url")),
  });
  const dedupKey = merged
    ? `gh:${repo}:pr:${number}:merged@${mergeSha}`
    : `gh:${repo}:pr:${number}:closed@${closedAt}`;
  return [{
    dedupKey,
    kind: "github_pr",
    occurredAt: toIso(merged ? text(body, "merged_at") || closedAt : closedAt),
    facts,
    text: pullRequestText(facts),
  }];
}

function parseClosedIssues(body: unknown, repo: string): WatchEventInput[] {
  if (!Array.isArray(body)) return [];
  const events: WatchEventInput[] = [];
  for (const entry of body) {
    if (!record(entry) || text(entry, "state") !== "closed") continue;
    const number = numeric(entry, "number");
    const updatedAt = text(entry, "updated_at");
    if (number === undefined || updatedAt === "") continue;
    const facts = boundedFacts({ repo, number, state: "closed", url: safeLink(text(entry, "html_url")) });
    events.push({
      dedupKey: `gh:${repo}:issue:${number}:closed@${updatedAt}`,
      kind: "github_events",
      occurredAt: toIso(updatedAt),
      facts,
      text: issueText(facts),
    });
  }
  return events;
}

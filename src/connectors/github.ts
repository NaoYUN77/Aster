import { ConnectorError } from "./errors.js";
import { clip, connectorJson } from "./http.js";

const API = "https://api.github.com";
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const ISSUE_STATES = new Set(["open", "closed", "all"]);

export type GithubClientOptions = {
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
};

export type GithubRepository = {
  readonly fullName: string;
  readonly name: string;
  readonly private: boolean;
  readonly description: string;
  readonly url: string;
  readonly language: string | null;
  readonly updatedAt: string | null;
};

export type GithubIssue = {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly author: string;
  readonly labels: readonly string[];
  readonly comments: number;
  readonly url: string;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly isPullRequest: boolean;
  readonly body?: string;
};

/** Read-only GitHub REST client. It never accepts a token from a model parameter. */
export class GithubClient {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: GithubClientOptions) {
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs;
  }

  async listRepositories(token: string, options: { readonly perPage?: number } = {}): Promise<GithubRepository[]> {
    const perPage = clamp(options.perPage ?? 20, 1, 50);
    const body = await this.#get(token, `/user/repos?visibility=public&sort=updated&per_page=${perPage}`, false);
    if (!Array.isArray(body)) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "GitHub response was invalid");
    return body.slice(0, perPage).flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.full_name !== "string") return [];
      return [{
        fullName: entry.full_name,
        name: typeof entry.name === "string" ? entry.name : entry.full_name,
        private: false,
        description: typeof entry.description === "string" ? clip(entry.description, 300) : "",
        url: typeof entry.html_url === "string" ? entry.html_url : "",
        language: typeof entry.language === "string" ? entry.language : null,
        updatedAt: typeof entry.updated_at === "string" ? entry.updated_at : null,
      }];
    });
  }

  async listIssues(
    token: string,
    repo: string,
    options: { readonly state?: string; readonly perPage?: number } = {},
  ): Promise<GithubIssue[]> {
    assertRepo(repo);
    const state = options.state ?? "open";
    if (!ISSUE_STATES.has(state)) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "state must be open, closed or all");
    const perPage = clamp(options.perPage ?? 20, 1, 50);
    const body = await this.#get(
      token,
      `/repos/${repo}/issues?state=${state}&sort=updated&direction=desc&per_page=${perPage}`,
      true,
    );
    if (!Array.isArray(body)) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "GitHub response was invalid");
    return body.slice(0, perPage).flatMap((entry) => {
      const issue = issueFrom(entry);
      return issue === undefined ? [] : [issue];
    });
  }

  async getIssue(token: string, repo: string, number: number): Promise<GithubIssue> {
    assertRepo(repo);
    if (!Number.isInteger(number) || number < 1 || number > 1_000_000_000) {
      throw new ConnectorError("CONNECTOR_INVALID_INPUT", "number must be a positive issue number");
    }
    const body = await this.#get(token, `/repos/${repo}/issues/${number}`, true);
    const issue = issueFrom(body);
    if (issue === undefined) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "GitHub response was invalid");
    return {
      ...issue,
      body: isRecord(body) && typeof body.body === "string" ? clip(body.body, 8_000) : "",
    };
  }

  async #get(token: string, path: string, notFound: boolean): Promise<unknown> {
    return connectorJson(`${API}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "aster-connector",
      },
    }, { fetch: this.#fetch, timeoutMs: this.#timeoutMs, notFound });
  }
}

function issueFrom(value: unknown): GithubIssue | undefined {
  if (!isRecord(value) || typeof value.number !== "number" || typeof value.title !== "string") return undefined;
  const labels = Array.isArray(value.labels)
    ? value.labels.flatMap((label) => isRecord(label) && typeof label.name === "string" ? [label.name] : [])
    : [];
  return {
    number: value.number,
    title: clip(value.title, 300),
    state: typeof value.state === "string" ? value.state : "unknown",
    author: isRecord(value.user) && typeof value.user.login === "string" ? value.user.login : "",
    labels,
    comments: typeof value.comments === "number" ? value.comments : 0,
    url: typeof value.html_url === "string" ? value.html_url : "",
    createdAt: typeof value.created_at === "string" ? value.created_at : null,
    updatedAt: typeof value.updated_at === "string" ? value.updated_at : null,
    isPullRequest: isRecord(value.pull_request),
  };
}

function assertRepo(repo: string): void {
  if (!REPO.test(repo)) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "repo must be owner/name");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

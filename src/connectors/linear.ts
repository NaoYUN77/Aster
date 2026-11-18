import { ConnectorError } from "./errors.js";
import { clip, connectorJson } from "./http.js";

const API = "https://api.linear.app/graphql";
const IDENTIFIER = /^[A-Z][A-Z0-9]{0,19}-\d{1,10}$/;
const MAX_DESCRIPTION_CHARS = 20_000;
const ISSUE_FIELDS = "identifier title state { name } assignee { name } updatedAt";

export type LinearClientOptions = {
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
};

export type LinearIssueSummary = {
  readonly identifier: string;
  readonly title: string;
  readonly state: string;
  readonly assignee: string | null;
  readonly updatedAt: string;
};

export type LinearIssue = LinearIssueSummary & {
  readonly url: string;
  readonly description: string;
  readonly truncated: boolean;
};

/** Read-only Linear GraphQL client. Only issue queries are built here; no mutation exists. */
export class LinearClient {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: LinearClientOptions) {
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs;
  }

  async listIssues(
    token: string,
    options: { readonly team?: string; readonly state?: string; readonly maxResults?: number } = {},
  ): Promise<LinearIssueSummary[]> {
    const first = clamp(options.maxResults ?? 20, 1, 50);
    const filter: Record<string, unknown> = {};
    if (options.team !== undefined && options.team !== "") {
      const team = options.team.trim();
      if (team.length > 64) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "team key must be at most 64 characters");
      filter.team = { key: { eqIgnoreCase: team } };
    }
    if (options.state !== undefined && options.state !== "") {
      const state = options.state.trim();
      if (state.length > 64) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "state must be at most 64 characters");
      filter.state = { name: { eqIgnoreCase: state } };
    }
    const data = await this.#graphql(
      token,
      `query Issues($first: Int!, $filter: IssueFilter) {
        issues(first: $first, filter: $filter, orderBy: updatedAt) {
          nodes { ${ISSUE_FIELDS} }
        }
      }`,
      { first, filter: Object.keys(filter).length === 0 ? undefined : filter },
      false,
    );
    return nodes(data, first);
  }

  async searchIssues(
    token: string,
    query: string,
    options: { readonly maxResults?: number } = {},
  ): Promise<LinearIssueSummary[]> {
    const q = query.trim();
    if (q === "") throw new ConnectorError("CONNECTOR_INVALID_INPUT", "query must not be empty");
    if (q.length > 256) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "query must be at most 256 characters");
    const first = clamp(options.maxResults ?? 20, 1, 50);
    const data = await this.#graphql(
      token,
      `query Search($first: Int!, $keyword: String!) {
        issues(first: $first, orderBy: updatedAt, filter: {
          or: [
            { title: { containsIgnoreCase: $keyword } },
            { description: { containsIgnoreCase: $keyword } }
          ]
        }) {
          nodes { ${ISSUE_FIELDS} }
        }
      }`,
      { first, keyword: q },
      false,
    );
    return nodes(data, first);
  }

  async getIssue(token: string, identifier: string): Promise<LinearIssue> {
    const id = identifier.trim();
    if (!IDENTIFIER.test(id)) {
      throw new ConnectorError("CONNECTOR_INVALID_INPUT", "identifier must look like ENG-123");
    }
    const data = await this.#graphql(
      token,
      `query Issue($id: String!) {
        issue(id: $id) {
          ${ISSUE_FIELDS}
          url description
        }
      }`,
      { id },
      true,
    );
    const issue = isRecord(data) ? data.issue : undefined;
    const summary = summaryFrom(issue);
    if (summary === undefined) {
      throw new ConnectorError("CONNECTOR_UPSTREAM_NOT_FOUND", "the requested connector resource was not found");
    }
    const description = isRecord(issue) && typeof issue.description === "string" ? issue.description : "";
    const clipped = clip(description, MAX_DESCRIPTION_CHARS);
    return {
      ...summary,
      url: isRecord(issue) && typeof issue.url === "string" ? issue.url : "",
      description: clipped,
      truncated: clipped.length < [...description].length,
    };
  }

  async #graphql(
    token: string,
    query: string,
    variables: Record<string, unknown>,
    notFound: boolean,
  ): Promise<unknown> {
    const body = await connectorJson(API, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    }, { fetch: this.#fetch, timeoutMs: this.#timeoutMs, notFound });
    if (!isRecord(body)) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Linear response was invalid");
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      // GraphQL failures arrive with HTTP 200; the messages can echo query data, so they are dropped.
      throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Linear rejected the connector query");
    }
    return body.data;
  }
}

function nodes(data: unknown, limit: number): LinearIssueSummary[] {
  const connection = isRecord(data) ? data.issues : undefined;
  if (!isRecord(connection) || !Array.isArray(connection.nodes)) {
    throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Linear response was invalid");
  }
  return connection.nodes.slice(0, limit).flatMap((entry) => {
    const summary = summaryFrom(entry);
    return summary === undefined ? [] : [summary];
  });
}

function summaryFrom(value: unknown): LinearIssueSummary | undefined {
  if (!isRecord(value) || typeof value.identifier !== "string" || typeof value.title !== "string") return undefined;
  const state = isRecord(value.state) && typeof value.state.name === "string" ? value.state.name : "";
  const assignee = isRecord(value.assignee) && typeof value.assignee.name === "string" ? value.assignee.name : null;
  return {
    identifier: value.identifier,
    title: clip(value.title, 300),
    state,
    assignee,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

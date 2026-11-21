import { ConnectorError } from "./errors.js";
import { clip, connectorJson } from "./http.js";

const API = "https://api.linear.app/graphql";
const IDENTIFIER = /^[A-Z][A-Z0-9]{0,19}-\d{1,10}$/;
const TEAM_KEY = /^[A-Za-z0-9]{1,20}$/;
const EMAIL = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;
const MAX_TITLE = 256;
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

/** Linear GraphQL client. Issue create/update and comments only; no delete mutation exists here. */
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

  /** Creates an issue in the team identified by its key (e.g. ENG). */
  async createIssue(
    token: string,
    input: { readonly team: string; readonly title: string; readonly description?: string },
  ): Promise<{ readonly identifier: string; readonly title: string; readonly state: string; readonly url: string }> {
    const team = input.team.trim();
    if (!TEAM_KEY.test(team)) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "team must be a short team key such as ENG");
    const title = boundedTitle(input.title);
    const description = boundedDescription(input.description ?? "");
    const teamId = await this.#teamId(token, team);
    const data = await this.#graphql(
      token,
      `mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { identifier title url state { name } }
        }
      }`,
      { input: { teamId, title, ...(description === "" ? {} : { description }) } },
      false,
    );
    const issue = mutationIssue(data);
    if (issue === undefined) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Linear rejected the connector mutation");
    return { identifier: issue.identifier, title: issue.title, state: issue.state, url: issue.url };
  }

  /** Changes state, title or assignee. Identifiers are resolved server-side; raw ids are never accepted. */
  async updateIssue(
    token: string,
    identifier: string,
    input: { readonly state?: string; readonly title?: string; readonly assignee?: string },
  ): Promise<{ readonly identifier: string; readonly title: string; readonly state: string; readonly assignee: string | null; readonly url: string }> {
    const current = await this.#issueForWrite(token, identifier);
    if (input.state === undefined && input.title === undefined && input.assignee === undefined) {
      throw new ConnectorError("CONNECTOR_INVALID_INPUT", "state, title or assignee is required");
    }
    const update: Record<string, unknown> = {};
    if (input.title !== undefined) update.title = boundedTitle(input.title);
    if (input.state !== undefined) update.stateId = await this.#stateId(token, current.teamId, input.state);
    if (input.assignee !== undefined) update.assigneeId = await this.#assigneeId(token, input.assignee);
    const data = await this.#graphql(
      token,
      `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue { identifier title url state { name } assignee { name } }
        }
      }`,
      { id: current.id, input: update },
      false,
    );
    const issue = mutationIssue(data);
    if (issue === undefined) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Linear rejected the connector mutation");
    return {
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state,
      assignee: issue.assignee,
      url: issue.url,
    };
  }

  async commentIssue(
    token: string,
    identifier: string,
    body: string,
  ): Promise<{ readonly id: string; readonly identifier: string; readonly url: string }> {
    const current = await this.#issueForWrite(token, identifier);
    const comment = boundedDescription(body);
    if (comment.trim() === "") throw new ConnectorError("CONNECTOR_INVALID_INPUT", "comment must not be empty");
    const data = await this.#graphql(
      token,
      `mutation CommentCreate($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          success
          comment { id url }
        }
      }`,
      { input: { issueId: current.id, body: comment } },
      false,
    );
    const payload = isRecord(data) ? data.commentCreate : undefined;
    const commentPayload = isRecord(payload) ? payload.comment : undefined;
    if (!isRecord(payload) || payload.success !== true || !isRecord(commentPayload)
      || typeof commentPayload.id !== "string") {
      throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Linear rejected the connector mutation");
    }
    return {
      id: commentPayload.id,
      identifier: current.identifier,
      url: typeof commentPayload.url === "string" ? commentPayload.url : "",
    };
  }

  async #issueForWrite(token: string, identifier: string): Promise<{ readonly id: string; readonly identifier: string; readonly teamId: string }> {
    const id = identifier.trim();
    if (!IDENTIFIER.test(id)) {
      throw new ConnectorError("CONNECTOR_INVALID_INPUT", "identifier must look like ENG-123");
    }
    const data = await this.#graphql(
      token,
      `query IssueForWrite($id: String!) {
        issue(id: $id) { id identifier team { id } }
      }`,
      { id },
      true,
    );
    const issue = isRecord(data) ? data.issue : undefined;
    if (!isRecord(issue) || typeof issue.id !== "string" || typeof issue.identifier !== "string") {
      throw new ConnectorError("CONNECTOR_UPSTREAM_NOT_FOUND", "the requested connector resource was not found");
    }
    const team = isRecord(issue.team) && typeof issue.team.id === "string" ? issue.team.id : "";
    if (team === "") throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Linear response was invalid");
    return { id: issue.id, identifier: issue.identifier, teamId: team };
  }

  async #teamId(token: string, key: string): Promise<string> {
    const data = await this.#graphql(
      token,
      `query TeamByKey($key: String!) {
        teams(filter: { key: { eqIgnoreCase: $key } }) { nodes { id } }
      }`,
      { key },
      false,
    );
    const connection = isRecord(data) ? data.teams : undefined;
    const first = isRecord(connection) && Array.isArray(connection.nodes) ? connection.nodes[0] : undefined;
    if (!isRecord(first) || typeof first.id !== "string") {
      throw new ConnectorError("CONNECTOR_INVALID_INPUT", "team was not found");
    }
    return first.id;
  }

  async #stateId(token: string, teamId: string, name: string): Promise<string> {
    const wanted = name.trim();
    if (wanted === "" || wanted.length > 64) {
      throw new ConnectorError("CONNECTOR_INVALID_INPUT", "state must be 1-64 characters");
    }
    const data = await this.#graphql(
      token,
      `query TeamStates($id: String!) {
        team(id: $id) { states { nodes { id name } } }
      }`,
      { id: teamId },
      false,
    );
    const team = isRecord(data) ? data.team : undefined;
    const states = isRecord(team) && isRecord(team.states) ? team.states.nodes : undefined;
    const match = Array.isArray(states)
      ? states.find((entry) => isRecord(entry) && typeof entry.name === "string"
        && entry.name.toLowerCase() === wanted.toLowerCase() && typeof entry.id === "string")
      : undefined;
    if (!isRecord(match) || typeof match.id !== "string") {
      throw new ConnectorError("CONNECTOR_INVALID_INPUT", "state was not found for this team");
    }
    return match.id;
  }

  async #assigneeId(token: string, email: string): Promise<string> {
    const wanted = email.trim();
    if (!EMAIL.test(wanted)) throw new ConnectorError("CONNECTOR_INVALID_INPUT", "assignee must be an email address");
    const data = await this.#graphql(
      token,
      `query UserByEmail($email: String!) {
        users(filter: { email: { eqIgnoreCase: $email } }) { nodes { id } }
      }`,
      { email: wanted },
      false,
    );
    const connection = isRecord(data) ? data.users : undefined;
    const first = isRecord(connection) && Array.isArray(connection.nodes) ? connection.nodes[0] : undefined;
    if (!isRecord(first) || typeof first.id !== "string") {
      throw new ConnectorError("CONNECTOR_INVALID_INPUT", "assignee was not found in this workspace");
    }
    return first.id;
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

function boundedTitle(value: string): string {
  const title = value.trim();
  if (title === "" || title.length > MAX_TITLE) {
    throw new ConnectorError("CONNECTOR_INVALID_INPUT", "title must be 1-256 characters");
  }
  return title;
}

function boundedDescription(value: string): string {
  if (value.length > MAX_DESCRIPTION_CHARS) {
    throw new ConnectorError("CONNECTOR_INVALID_INPUT", `description must be at most ${MAX_DESCRIPTION_CHARS} characters`);
  }
  return value;
}

/** Both issueCreate and issueUpdate answer `{success, issue}`; only the identity fields are kept. */
function mutationIssue(value: unknown): {
  readonly identifier: string;
  readonly title: string;
  readonly state: string;
  readonly assignee: string | null;
  readonly url: string;
} | undefined {
  if (!isRecord(value)) return undefined;
  const payload = isRecord(value.issueCreate) ? value.issueCreate : isRecord(value.issueUpdate) ? value.issueUpdate : undefined;
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.issue)) return undefined;
  const issue = payload.issue;
  if (typeof issue.identifier !== "string" || typeof issue.title !== "string") return undefined;
  return {
    identifier: issue.identifier,
    title: clip(issue.title, 300),
    state: isRecord(issue.state) && typeof issue.state.name === "string" ? issue.state.name : "",
    assignee: isRecord(issue.assignee) && typeof issue.assignee.name === "string" ? issue.assignee.name : null,
    url: typeof issue.url === "string" ? issue.url : "",
  };
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

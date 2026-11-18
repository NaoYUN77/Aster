import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { ConnectorError, connectorCode, safeConnectorMessage } from "./errors.js";
import type { ConnectorService } from "./service.js";

const CONNECTION = opt(str({
  maxLength: 48,
  description: "Optional connector slug when several connections of this provider exist",
}));
const PER_PAGE = opt(int({
  minimum: 1,
  maximum: 50,
  description: "Maximum results (1-50, default 20)",
}));
const REPO = str({
  minLength: 3,
  maxLength: 201,
  description: "Repository as owner/name, for example octocat/hello-world",
});

type ToolApi = {
  readonly conversationId: number;
  readonly callId?: string;
};

function binding(ownerId: string, tool: string, api: ToolApi) {
  return {
    connectionId: "",
    tool,
    requestId: api.callId ?? String(api.conversationId),
    ownerId,
  };
}

function failure(error: unknown): ToolExecutionResult {
  const code = connectorCode(error);
  const message = error instanceof ConnectorError ? error.message : safeConnectorMessage(code);
  return {
    isError: true,
    output: [{ type: "text", text: `Connector operation failed (${code}): ${message}` }],
    details: { code },
    diagnostics: [{ severity: "error", code, message }],
  };
}

function success(value: unknown, details: Record<string, string | number | boolean | null>): ToolExecutionResult {
  const text = JSON.stringify(value, null, 2);
  return {
    output: [{ type: "text", text: text.length > 24_000 ? `${text.slice(0, 24_000)}\n…[truncated]` : text }],
    details,
  };
}

/**
 * What the model is told about connectors before every request. Rendered per request (not once at
 * startup), so an OAuth completion, disconnect or error is visible on the next turn. It contains
 * only metadata the service already exposes: slug, provider, status, account label and tool names.
 */
export function connectorStatusText(service: ConnectorService): string {
  let view: ReturnType<ConnectorService["list"]>;
  try {
    view = service.list();
  } catch {
    return "连接器状态暂不可用。";
  }
  if (view.connections.length === 0) return "暂无已授权连接。";
  const toolsByProvider = new Map(view.definitions.map((definition) => [definition.provider, definition.tools]));
  const lines = view.connections.map((connection) => {
    const head = `${connection.slug} (${connection.provider}, ${connection.status}`
      + `${connection.accountLabel === null ? "" : `, ${connection.accountLabel}`})`;
    if (connection.status !== "connected") return `- ${head}：工具暂不可用，需要在客户端重新授权`;
    const tools = toolsByProvider.get(connection.provider) ?? [];
    if (tools.length === 0) return `- ${head}：已连接（无内置工具）`;
    return `- ${head}：可用工具 ${tools.join(", ")}`;
  });
  return ["已授权连接：", ...lines].join("\n");
}

/**
 * Model-facing connector tools. Credentials never appear in arguments, results, details or errors:
 * every call resolves a connection by owner-scoped slug and the service injects the token upstream.
 */
export function createConnectorExtension(service: ConnectorService, ownerId: string): Extension {
  const list = defineTool({
    name: "connector_list",
    description: "List server-side connector definitions and this owner's connections with their authorization status. Never returns credentials.",
    parameters: obj({}),
    replay: "safe",
    execute: async () => {
      try {
        const { definitions, connections } = service.list();
        const lines = [
          "Providers:",
          ...definitions.map((definition) =>
            `- ${definition.provider}: ${definition.displayName}${definition.tools.length === 0 ? "" : ` (${definition.tools.join(", ")})`}`),
          "Connections:",
          ...(connections.length === 0
            ? ["- none"]
            : connections.map((connection) =>
              `- ${connection.slug}: ${connection.provider} | ${connection.status}`
              + `${connection.accountLabel === null ? "" : ` | ${connection.accountLabel}`}`)),
        ];
        return {
          output: [{ type: "text" as const, text: lines.join("\n") }],
          details: { connections: connections.length, providers: definitions.length },
        };
      } catch (error) {
        return failure(error);
      }
    },
  });

  const repositories = defineTool({
    name: "connector_github_list_repositories",
    description: "List public GitHub repositories visible to the connected account, most recently updated first. Read-only.",
    parameters: obj({ connection: CONNECTION, per_page: PER_PAGE }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const result = await service.listRepositories(
          { ...(args.connection === undefined ? {} : { connection: args.connection }), ...(args.per_page === undefined ? {} : { perPage: args.per_page }) },
          binding(ownerId, "connector_github_list_repositories", api),
        );
        return success(result, { count: result.length });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const issues = defineTool({
    name: "connector_github_list_issues",
    description: "List issues (and pull requests) in one GitHub repository. Read-only; state is open, closed or all.",
    parameters: obj({
      connection: CONNECTION,
      repo: REPO,
      state: opt(str({ maxLength: 6, description: "open (default), closed or all" })),
      per_page: PER_PAGE,
    }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const result = await service.listIssues({
          repo: args.repo,
          ...(args.connection === undefined ? {} : { connection: args.connection }),
          ...(args.state === undefined ? {} : { state: args.state }),
          ...(args.per_page === undefined ? {} : { perPage: args.per_page }),
        }, binding(ownerId, "connector_github_list_issues", api));
        return success(result, { count: result.length });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const issue = defineTool({
    name: "connector_github_get_issue",
    description: "Read one GitHub issue or pull request, including a bounded body. Read-only.",
    parameters: obj({
      connection: CONNECTION,
      repo: REPO,
      number: int({ minimum: 1, maximum: 1_000_000_000 }),
    }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const result = await service.getIssue({
          repo: args.repo,
          number: args.number,
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_github_get_issue", api));
        return success(result, { number: result.number });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const search = defineTool({
    name: "connector_gmail_search_messages",
    description: "Search Gmail with Gmail query syntax (for example 'from:alice newer_than:7d') and return bounded message metadata. Read-only.",
    parameters: obj({
      connection: CONNECTION,
      query: opt(str({ maxLength: 512, description: "Gmail search query; empty lists recent messages" })),
      max_results: opt(int({ minimum: 1, maximum: 10, description: "Maximum messages (1-10, default 5)" })),
    }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const result = await service.searchMessages({
          ...(args.connection === undefined ? {} : { connection: args.connection }),
          ...(args.query === undefined ? {} : { query: args.query }),
          ...(args.max_results === undefined ? {} : { maxResults: args.max_results }),
        }, binding(ownerId, "connector_gmail_search_messages", api));
        return success(result, { count: result.length });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const message = defineTool({
    name: "connector_gmail_get_message",
    description: "Read one Gmail message by id from a previous search, including subject, headers and bounded plain text. Read-only.",
    parameters: obj({
      connection: CONNECTION,
      id: str({ minLength: 1, maxLength: 128, description: "Gmail message id returned by search" }),
    }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const result = await service.getMessage({
          id: args.id,
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_gmail_get_message", api));
        return success(result, { id: result.id, truncated: result.truncated });
      } catch (error) {
        return failure(error);
      }
    },
  });

  return defineExtension({
    name: "connectors",
    tools: [list, repositories, issues, issue, search, message],
    // Refreshed before every model request by the harness, so a status change needs no restart.
    sections: [{
      key: "connectors",
      render: () => connectorStatusText(service),
    }],
  });
}

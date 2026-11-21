import {
  defineExtension, defineTool, type Extension, type ToolExecutionResult, type ToolRegistration,
} from "@earendil-works/pi-durable";
import { arr, bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { GovernedTool } from "../tools.js";
import { ConnectorError, connectorCode, safeConnectorMessage } from "./errors.js";
import type { ConnectorService } from "./service.js";

/**
 * Tools that only read upstream data. Everything else in this extension is a write by default, so a
 * new tool that is forgotten here stays behind write authority rather than slipping through as read.
 */
const READ_TOOL_NAMES = new Set([
  "connector_list",
  "connector_github_list_repositories", "connector_github_list_issues", "connector_github_get_issue",
  "connector_gmail_search_messages", "connector_gmail_get_message",
  "connector_outlook_list_messages", "connector_outlook_search_messages", "connector_outlook_get_message",
  "connector_linear_list_issues", "connector_linear_search_issues", "connector_linear_get_issue",
  "connector_notion_search", "connector_notion_get_page",
  "connector_google_calendar_list_events", "connector_google_calendar_get_event",
  "connector_google_drive_search_files", "connector_google_drive_get_file",
]);

function governed(tool: ToolRegistration): GovernedTool {
  return Object.assign(tool, {
    governance: {
      source: { kind: "builtin" as const, extension: "connectors" },
      trust: "trusted" as const,
      authz: READ_TOOL_NAMES.has(tool.name) ? "read" as const : "write" as const,
    },
  });
}

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
const MESSAGE_LIMIT = opt(int({
  minimum: 1,
  maximum: 50,
  description: "Maximum messages (1-50, default 10)",
}));
const ISSUE_LIMIT = opt(int({
  minimum: 1,
  maximum: 50,
  description: "Maximum issues (1-50, default 20)",
}));
const MESSAGE_ID = str({
  minLength: 1,
  maxLength: 512,
  description: "Message id returned by a previous Outlook search or list",
});
const LINEAR_IDENTIFIER = str({
  minLength: 3,
  maxLength: 32,
  description: "Linear issue identifier, for example ENG-123",
});
const SEARCH_TEXT = str({
  minLength: 1,
  maxLength: 256,
  description: "Search text",
});
const NOTION_PAGE_ID = str({
  minLength: 32,
  maxLength: 36,
  description: "Notion page id returned by search",
});
const CALENDAR_EVENT_ID = str({
  minLength: 1,
  maxLength: 1024,
  description: "Calendar event id returned by list_events",
});
const DRIVE_FILE_ID = str({
  minLength: 1,
  maxLength: 200,
  description: "Drive file id returned by search",
});
const DAYS = opt(int({ minimum: 1, maximum: 90, description: "Time window in days from now (1-90, default 7)" }));
const EMAIL_TEXT = str({
  minLength: 3,
  maxLength: 320,
  description: "Email address; separate several addresses with commas",
});
const SUBJECT = str({ minLength: 1, maxLength: 256, description: "Subject line" });
const PLAIN_BODY = str({ maxLength: 20_000, description: "Plain-text body" });
const TITLE = str({ minLength: 1, maxLength: 256, description: "Title" });
const ISSUE_NUMBER = int({ minimum: 1, maximum: 1_000_000_000, description: "Issue number, for example 42" });
const LABELS = arr(str({ minLength: 1, maxLength: 100 }), {
  minItems: 1,
  maxItems: 20,
  description: "Label names to set (1-20); replaces the current labels",
});
const NOTION_CONTENT = str({ minLength: 1, maxLength: 20_000, description: "Plain text; each line becomes a paragraph" });
const EVENT_TIME = str({
  minLength: 16,
  maxLength: 40,
  description: "RFC 3339 time such as 2026-11-20T10:00:00+08:00; without an offset, time_zone is required",
});
const TIME_ZONE = opt(str({
  minLength: 1,
  maxLength: 64,
  description: "IANA time zone such as Asia/Shanghai; required when start/end carry no offset",
}));
const DRIVE_NAME = str({ minLength: 1, maxLength: 256, description: "File name" });
const DRIVE_CONTENT = str({ maxLength: 20_000, description: "Plain-text file content" });

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

  const outlookMessages = defineTool({
    name: "connector_outlook_list_messages",
    description: "List the most recent Outlook inbox messages, newest first, with bounded metadata. Read-only.",
    parameters: obj({ connection: CONNECTION, max_results: MESSAGE_LIMIT }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const result = await service.listOutlookMessages({
          ...(args.connection === undefined ? {} : { connection: args.connection }),
          ...(args.max_results === undefined ? {} : { maxResults: args.max_results }),
        }, binding(ownerId, "connector_outlook_list_messages", api));
        return success(result, { count: result.length });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const outlookSearch = defineTool({
    name: "connector_outlook_search_messages",
    description: "Search the connected Outlook mailbox and return bounded message metadata. Read-only.",
    parameters: obj({ connection: CONNECTION, query: SEARCH_TEXT, max_results: MESSAGE_LIMIT }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const result = await service.searchOutlookMessages({
          query: args.query,
          ...(args.connection === undefined ? {} : { connection: args.connection }),
          ...(args.max_results === undefined ? {} : { maxResults: args.max_results }),
        }, binding(ownerId, "connector_outlook_search_messages", api));
        return success(result, { count: result.length });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const outlookMessage = defineTool({
    name: "connector_outlook_get_message",
    description: "Read one Outlook message by id from a previous search, including a bounded plain-text body. Read-only.",
    parameters: obj({ connection: CONNECTION, id: MESSAGE_ID }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const result = await service.getOutlookMessage({
          id: args.id,
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_outlook_get_message", api));
        return success(result, { id: result.id, truncated: result.truncated });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const linearIssues = defineTool({
    name: "connector_linear_list_issues",
    description: "List Linear issues, optionally filtered by team key and state name, most recently updated first. Read-only.",
    parameters: obj({
      connection: CONNECTION,
      team: opt(str({ maxLength: 64, description: "Optional Linear team key, for example ENG" })),
      state: opt(str({ maxLength: 64, description: "Optional state name, for example 'In Progress'" })),
      max_results: ISSUE_LIMIT,
    }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const result = await service.listLinearIssues({
          ...(args.connection === undefined ? {} : { connection: args.connection }),
          ...(args.team === undefined ? {} : { team: args.team }),
          ...(args.state === undefined ? {} : { state: args.state }),
          ...(args.max_results === undefined ? {} : { maxResults: args.max_results }),
        }, binding(ownerId, "connector_linear_list_issues", api));
        return success(result, { count: result.length });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const linearSearch = defineTool({
    name: "connector_linear_search_issues",
    description: "Search Linear issues by keyword in title or description and return bounded metadata. Read-only.",
    parameters: obj({ connection: CONNECTION, query: SEARCH_TEXT, max_results: ISSUE_LIMIT }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const result = await service.searchLinearIssues({
          query: args.query,
          ...(args.connection === undefined ? {} : { connection: args.connection }),
          ...(args.max_results === undefined ? {} : { maxResults: args.max_results }),
        }, binding(ownerId, "connector_linear_search_issues", api));
        return success(result, { count: result.length });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const linearIssue = defineTool({
    name: "connector_linear_get_issue",
    description: "Read one Linear issue by identifier (for example ENG-123), including a bounded description. Read-only.",
    parameters: obj({ connection: CONNECTION, identifier: LINEAR_IDENTIFIER }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const result = await service.getLinearIssue({
          identifier: args.identifier,
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_linear_get_issue", api));
        return success(result, { identifier: result.identifier, truncated: result.truncated });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const notionSearch = defineTool({
    name: "connector_notion_search",
    description: "Search Notion pages and databases visible to the integration and return bounded metadata. Read-only.",
    parameters: obj({ connection: CONNECTION, query: SEARCH_TEXT, max_results: ISSUE_LIMIT }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const result = await service.searchNotion({
          query: args.query,
          ...(args.connection === undefined ? {} : { connection: args.connection }),
          ...(args.max_results === undefined ? {} : { maxResults: args.max_results }),
        }, binding(ownerId, "connector_notion_search", api));
        return success(result, { count: result.length });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const notionPage = defineTool({
    name: "connector_notion_get_page",
    description: "Read one Notion page and the plain text of its blocks, bounded. Read-only.",
    parameters: obj({ connection: CONNECTION, page_id: NOTION_PAGE_ID }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const result = await service.getNotionPage({
          pageId: args.page_id,
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_notion_get_page", api));
        return success(result, { id: result.id, truncated: result.truncated });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const calendarEvents = defineTool({
    name: "connector_google_calendar_list_events",
    description: "List events from the primary Google Calendar in a time window starting now (default 7 days). Read-only.",
    parameters: obj({ connection: CONNECTION, days: DAYS, max_results: ISSUE_LIMIT }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const result = await service.listCalendarEvents({
          ...(args.connection === undefined ? {} : { connection: args.connection }),
          ...(args.days === undefined ? {} : { days: args.days }),
          ...(args.max_results === undefined ? {} : { maxResults: args.max_results }),
        }, binding(ownerId, "connector_google_calendar_list_events", api));
        return success(result, { count: result.length });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const calendarEvent = defineTool({
    name: "connector_google_calendar_get_event",
    description: "Read one Google Calendar event by id, including a bounded description and attendees. Read-only.",
    parameters: obj({ connection: CONNECTION, event_id: CALENDAR_EVENT_ID }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const result = await service.getCalendarEvent({
          eventId: args.event_id,
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_google_calendar_get_event", api));
        return success(result, { id: result.id, truncated: result.truncated });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const driveSearch = defineTool({
    name: "connector_google_drive_search_files",
    description: "Search Google Drive files by name or content and return bounded metadata. Read-only.",
    parameters: obj({ connection: CONNECTION, query: SEARCH_TEXT, max_results: ISSUE_LIMIT }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const result = await service.searchDriveFiles({
          query: args.query,
          ...(args.connection === undefined ? {} : { connection: args.connection }),
          ...(args.max_results === undefined ? {} : { maxResults: args.max_results }),
        }, binding(ownerId, "connector_google_drive_search_files", api));
        return success(result, { count: result.length });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const driveFile = defineTool({
    name: "connector_google_drive_get_file",
    description: "Read one Google Drive file: a Google Doc as bounded plain text, anything else as metadata only. Never returns binary. Read-only.",
    parameters: obj({ connection: CONNECTION, file_id: DRIVE_FILE_ID }),
    replay: "safe",
    execute: async (args, api) => {
      try {
        const result = await service.getDriveFile({
          fileId: args.file_id,
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_google_drive_get_file", api));
        return success(result, { id: result.id, truncated: result.truncated });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const githubCreateIssue = defineTool({
    name: "connector_github_create_issue",
    description: "Create an issue in a GitHub repository. Writes to the repository; returns only the new issue number, title, state and link.",
    parameters: obj({ connection: CONNECTION, repo: REPO, title: TITLE, body: opt(PLAIN_BODY) }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const result = await service.createIssue({
          repo: args.repo,
          title: args.title,
          ...(args.body === undefined ? {} : { body: args.body }),
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_github_create_issue", api));
        return success(result, { number: result.number, state: result.state });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const githubCommentIssue = defineTool({
    name: "connector_github_comment_issue",
    description: "Post a comment on a GitHub issue or pull request. Writes to the repository; returns the new comment id and link.",
    parameters: obj({
      connection: CONNECTION,
      repo: REPO,
      number: ISSUE_NUMBER,
      body: str({ minLength: 1, maxLength: 20_000, description: "Comment text" }),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const result = await service.commentIssue({
          repo: args.repo,
          number: args.number,
          body: args.body,
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_github_comment_issue", api));
        return success(result, { id: result.id, issueNumber: result.issueNumber });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const githubUpdateIssue = defineTool({
    name: "connector_github_update_issue",
    description: "Close or reopen a GitHub issue and/or replace its labels. Writes to the repository; at least one of state or labels is required.",
    parameters: obj({
      connection: CONNECTION,
      repo: REPO,
      number: ISSUE_NUMBER,
      state: opt(oneOf(["open", "closed"], { description: "New issue state" })),
      labels: opt(LABELS),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const result = await service.updateIssue({
          repo: args.repo,
          number: args.number,
          ...(args.state === undefined ? {} : { state: args.state }),
          ...(args.labels === undefined ? {} : { labels: args.labels }),
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_github_update_issue", api));
        return success(result, { number: result.number, state: result.state });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const gmailSend = defineTool({
    name: "connector_gmail_send_message",
    description: "Send a plain-text email from the connected Gmail account. This sends real mail; returns only the new message id.",
    parameters: obj({ connection: CONNECTION, to: EMAIL_TEXT, subject: SUBJECT, body: PLAIN_BODY }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const result = await service.sendGmailMessage({
          to: args.to,
          subject: args.subject,
          body: args.body,
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_gmail_send_message", api));
        return success(result, { id: result.id });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const gmailDraft = defineTool({
    name: "connector_gmail_create_draft",
    description: "Save a plain-text email as a Gmail draft without sending it. Returns the new draft id and message id.",
    parameters: obj({ connection: CONNECTION, to: EMAIL_TEXT, subject: SUBJECT, body: PLAIN_BODY }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const result = await service.createGmailDraft({
          to: args.to,
          subject: args.subject,
          body: args.body,
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_gmail_create_draft", api));
        return success(result, { draftId: result.draftId });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const gmailModifyLabels = defineTool({
    name: "connector_gmail_modify_labels",
    description: "Archive, mark read and/or add one label to a Gmail message. It never deletes, trashes or spams a message. At least one change is required.",
    parameters: obj({
      connection: CONNECTION,
      id: str({ minLength: 1, maxLength: 128, description: "Gmail message id returned by search" }),
      archive: opt(bool({ description: "Remove the message from the inbox" })),
      mark_read: opt(bool({ description: "Mark the message as read" })),
      add_label: opt(str({ minLength: 1, maxLength: 100, description: "Label name to add; it must already exist" })),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const result = await service.modifyGmailLabels({
          id: args.id,
          ...(args.archive === undefined ? {} : { archive: args.archive }),
          ...(args.mark_read === undefined ? {} : { markRead: args.mark_read }),
          ...(args.add_label === undefined ? {} : { addLabel: args.add_label }),
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_gmail_modify_labels", api));
        return success(result, { id: result.id, added: result.added.length, removed: result.removed.length });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const outlookSend = defineTool({
    name: "connector_outlook_send_message",
    description: "Send a plain-text email from the connected Outlook mailbox. This sends real mail.",
    parameters: obj({ connection: CONNECTION, to: EMAIL_TEXT, subject: SUBJECT, body: PLAIN_BODY }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const result = await service.sendOutlookMessage({
          to: args.to,
          subject: args.subject,
          body: args.body,
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_outlook_send_message", api));
        return success(result, { sent: result.sent });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const outlookReply = defineTool({
    name: "connector_outlook_reply_message",
    description: "Reply to an existing Outlook message, keeping the thread. This sends real mail.",
    parameters: obj({
      connection: CONNECTION,
      id: MESSAGE_ID,
      comment: str({ minLength: 1, maxLength: 20_000, description: "Reply text" }),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const result = await service.replyOutlookMessage({
          id: args.id,
          comment: args.comment,
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_outlook_reply_message", api));
        return success(result, { replied: result.replied, inReplyTo: result.inReplyTo });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const outlookUpdate = defineTool({
    name: "connector_outlook_update_message",
    description: "Mark an Outlook message read/unread and/or move it to a standard folder (inbox, archive, drafts, sentitems, junkemail). It cannot delete a message. At least one change is required.",
    parameters: obj({
      connection: CONNECTION,
      id: MESSAGE_ID,
      is_read: opt(bool({ description: "New read state" })),
      move_to: opt(oneOf(["inbox", "archive", "drafts", "sentitems", "junkemail"], {
        description: "Destination folder",
      })),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const result = await service.updateOutlookMessage({
          id: args.id,
          ...(args.is_read === undefined ? {} : { isRead: args.is_read }),
          ...(args.move_to === undefined ? {} : { moveTo: args.move_to }),
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_outlook_update_message", api));
        return success(result, {
          id: result.id,
          ...(result.isRead === undefined ? {} : { isRead: result.isRead }),
          ...(result.movedTo === undefined ? {} : { movedTo: result.movedTo }),
        });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const linearCreateIssue = defineTool({
    name: "connector_linear_create_issue",
    description: "Create a Linear issue in a team (by team key). Writes to Linear; returns the new issue identifier and link.",
    parameters: obj({
      connection: CONNECTION,
      team: str({ minLength: 1, maxLength: 20, description: "Linear team key, for example ENG" }),
      title: TITLE,
      description: opt(PLAIN_BODY),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const result = await service.createLinearIssue({
          team: args.team,
          title: args.title,
          ...(args.description === undefined ? {} : { description: args.description }),
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_linear_create_issue", api));
        return success(result, { identifier: result.identifier, state: result.state });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const linearUpdateIssue = defineTool({
    name: "connector_linear_update_issue",
    description: "Change a Linear issue's state, title or assignee (by email). At least one field is required; values are resolved to workspace ids server-side.",
    parameters: obj({
      connection: CONNECTION,
      identifier: LINEAR_IDENTIFIER,
      state: opt(str({ minLength: 1, maxLength: 64, description: "State name, for example 'In Progress'" })),
      title: opt(TITLE),
      assignee: opt(str({ minLength: 3, maxLength: 320, description: "Assignee email address" })),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const result = await service.updateLinearIssue({
          identifier: args.identifier,
          ...(args.state === undefined ? {} : { state: args.state }),
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.assignee === undefined ? {} : { assignee: args.assignee }),
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_linear_update_issue", api));
        return success(result, { identifier: result.identifier, state: result.state });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const linearComment = defineTool({
    name: "connector_linear_comment_issue",
    description: "Post a comment on a Linear issue. Writes to Linear; returns the new comment id.",
    parameters: obj({
      connection: CONNECTION,
      identifier: LINEAR_IDENTIFIER,
      body: str({ minLength: 1, maxLength: 20_000, description: "Comment text" }),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const result = await service.commentLinearIssue({
          identifier: args.identifier,
          body: args.body,
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_linear_comment_issue", api));
        return success(result, { id: result.id, identifier: result.identifier });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const notionCreatePage = defineTool({
    name: "connector_notion_create_page",
    description: "Create a Notion page under a page or database and optionally add plain-text paragraphs. The parent must be shared with the integration and the integration must allow inserting content.",
    parameters: obj({
      connection: CONNECTION,
      parent_id: str({
        minLength: 32,
        maxLength: 36,
        description: "Parent page or database id returned by search",
      }),
      title: TITLE,
      content: opt(PLAIN_BODY),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const result = await service.createNotionPage({
          parentId: args.parent_id,
          title: args.title,
          ...(args.content === undefined ? {} : { content: args.content }),
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_notion_create_page", api));
        return success(result, { id: result.id, title: result.title });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const notionAppend = defineTool({
    name: "connector_notion_append_blocks",
    description: "Append plain-text paragraphs to an existing Notion page. The integration must allow updating content.",
    parameters: obj({ connection: CONNECTION, page_id: NOTION_PAGE_ID, content: NOTION_CONTENT }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const result = await service.appendNotionBlocks({
          pageId: args.page_id,
          content: args.content,
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_notion_append_blocks", api));
        return success(result, { pageId: result.pageId, blocksAdded: result.blocksAdded });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const calendarCreateEvent = defineTool({
    name: "connector_google_calendar_create_event",
    description: "Create an event on the primary Google Calendar. Times must be unambiguous: either an offset in start/end or a time_zone. No attendees are invited.",
    parameters: obj({
      connection: CONNECTION,
      summary: str({ minLength: 1, maxLength: 256, description: "Event title" }),
      start: EVENT_TIME,
      end: EVENT_TIME,
      time_zone: TIME_ZONE,
      description: opt(PLAIN_BODY),
      location: opt(str({ maxLength: 500, description: "Location text" })),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const result = await service.createCalendarEvent({
          summary: args.summary,
          start: args.start,
          end: args.end,
          ...(args.time_zone === undefined ? {} : { timeZone: args.time_zone }),
          ...(args.description === undefined ? {} : { description: args.description }),
          ...(args.location === undefined ? {} : { location: args.location }),
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_google_calendar_create_event", api));
        return success(result, { id: result.id, start: result.start, end: result.end });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const calendarUpdateEvent = defineTool({
    name: "connector_google_calendar_update_event",
    description: "Update a Google Calendar event's title, description, location or times. Start and end must be given together. At least one field is required.",
    parameters: obj({
      connection: CONNECTION,
      event_id: CALENDAR_EVENT_ID,
      summary: opt(str({ minLength: 1, maxLength: 256, description: "New event title" })),
      description: opt(PLAIN_BODY),
      location: opt(str({ maxLength: 500, description: "Location text" })),
      start: opt(EVENT_TIME),
      end: opt(EVENT_TIME),
      time_zone: TIME_ZONE,
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const result = await service.updateCalendarEvent({
          eventId: args.event_id,
          ...(args.summary === undefined ? {} : { summary: args.summary }),
          ...(args.description === undefined ? {} : { description: args.description }),
          ...(args.location === undefined ? {} : { location: args.location }),
          ...(args.start === undefined ? {} : { start: args.start }),
          ...(args.end === undefined ? {} : { end: args.end }),
          ...(args.time_zone === undefined ? {} : { timeZone: args.time_zone }),
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_google_calendar_update_event", api));
        return success(result, { id: result.id, start: result.start, end: result.end });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const driveCreateFile = defineTool({
    name: "connector_google_drive_create_file",
    description: "Create a plain-text file in Google Drive. Only text is supported; returns the new file id and link.",
    parameters: obj({ connection: CONNECTION, name: DRIVE_NAME, content: DRIVE_CONTENT }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const result = await service.createDriveFile({
          name: args.name,
          content: args.content,
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_google_drive_create_file", api));
        return success(result, { id: result.id, name: result.name });
      } catch (error) {
        return failure(error);
      }
    },
  });

  const driveUpdateFile = defineTool({
    name: "connector_google_drive_update_file",
    description: "Rename and/or replace the text content of a file Aster created or opened in Google Drive. Google Docs and other binary files cannot be updated here.",
    parameters: obj({
      connection: CONNECTION,
      file_id: DRIVE_FILE_ID,
      name: opt(DRIVE_NAME),
      content: opt(DRIVE_CONTENT),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      try {
        const result = await service.updateDriveFile({
          fileId: args.file_id,
          ...(args.name === undefined ? {} : { name: args.name }),
          ...(args.content === undefined ? {} : { content: args.content }),
          ...(args.connection === undefined ? {} : { connection: args.connection }),
        }, binding(ownerId, "connector_google_drive_update_file", api));
        return success(result, { id: result.id, name: result.name });
      } catch (error) {
        return failure(error);
      }
    },
  });

  return defineExtension({
    name: "connectors",
    tools: [list, repositories, issues, issue, search, message,
      outlookMessages, outlookSearch, outlookMessage, linearIssues, linearSearch, linearIssue,
      notionSearch, notionPage, calendarEvents, calendarEvent, driveSearch, driveFile,
      githubCreateIssue, githubCommentIssue, githubUpdateIssue,
      gmailSend, gmailDraft, gmailModifyLabels,
      outlookSend, outlookReply, outlookUpdate,
      linearCreateIssue, linearUpdateIssue, linearComment,
      notionCreatePage, notionAppend,
      calendarCreateEvent, calendarUpdateEvent,
      driveCreateFile, driveUpdateFile].map(governed),
    // Refreshed before every model request by the harness, so a status change needs no restart.
    sections: [{
      key: "connectors",
      render: () => connectorStatusText(service),
    }],
  });
}

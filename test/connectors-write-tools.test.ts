import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Extension, ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { readConnectorsConfig } from "../src/config.js";
import { encryptCredential } from "../src/connectors/crypto.js";
import { ConnectorOAuth } from "../src/connectors/oauth.js";
import { FileSecretProvider } from "../src/connectors/secrets.js";
import { ConnectorService } from "../src/connectors/service.js";
import { ConnectorStore, type OAuthProvider } from "../src/connectors/store.js";
import { createConnectorExtension } from "../src/connectors/tools.js";
import { LocalTokenVault } from "../src/connectors/vault.js";
import { createToolRegistry } from "../src/tools.js";

const KEY = "44".repeat(32);
const NOW = Date.parse("2026-11-19T00:00:00.000Z");
/** Deliberately not credential-shaped: it only has to be unique enough to search for leaks. */
const ACCESS_TOKEN = "connector-write-test-access";

const WRITE_TOOLS = [
  "connector_github_create_issue", "connector_github_comment_issue", "connector_github_update_issue",
  "connector_gmail_send_message", "connector_gmail_create_draft", "connector_gmail_modify_labels",
  "connector_outlook_send_message", "connector_outlook_reply_message", "connector_outlook_update_message",
  "connector_linear_create_issue", "connector_linear_update_issue", "connector_linear_comment_issue",
  "connector_notion_create_page", "connector_notion_append_blocks",
  "connector_google_calendar_create_event", "connector_google_calendar_update_event",
  "connector_google_drive_create_file", "connector_google_drive_update_file",
] as const;

const READ_TOOLS = [
  "connector_github_list_repositories", "connector_github_list_issues", "connector_github_get_issue",
  "connector_gmail_search_messages", "connector_gmail_get_message",
  "connector_outlook_list_messages", "connector_outlook_search_messages", "connector_outlook_get_message",
  "connector_linear_list_issues", "connector_linear_search_issues", "connector_linear_get_issue",
  "connector_notion_search", "connector_notion_get_page",
  "connector_google_calendar_list_events", "connector_google_calendar_get_event",
  "connector_google_drive_search_files", "connector_google_drive_get_file",
] as const;

const NOTION_PARENT = "0123456789abcdef0123456789abcdef";
const NOTION_PAGE = "fedcba9876543210fedcba9876543210";

type Call = { readonly method: string; readonly url: string; readonly body: string };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function empty(status = 202): Response {
  return new Response("", { status });
}

const ISSUE = {
  number: 7,
  title: "New issue",
  state: "open",
  html_url: "https://github.com/octo/repo/issues/7",
  user: { login: "octo" },
  labels: [{ name: "bug" }],
  comments: 0,
  created_at: "2026-11-19T00:00:00.000Z",
  updated_at: "2026-11-19T00:00:00.000Z",
};

function linearResponse(query: string): Response {
  if (query.includes("issueCreate")) {
    return json({ data: { issueCreate: { success: true, issue: {
      identifier: "ENG-9", title: "New", url: "https://linear.app/issue/ENG-9", state: { name: "Triage" },
    } } } });
  }
  if (query.includes("issueUpdate")) {
    return json({ data: { issueUpdate: { success: true, issue: {
      identifier: "ENG-1", title: "Renamed", url: "https://linear.app/issue/ENG-1",
      state: { name: "In Progress" }, assignee: { name: "Dev" },
    } } } });
  }
  if (query.includes("commentCreate")) {
    return json({ data: { commentCreate: { success: true, comment: { id: "comment-1", url: "https://linear.app/c/1" } } } });
  }
  if (query.includes("TeamByKey")) return json({ data: { teams: { nodes: [{ id: "team-1" }] } } });
  if (query.includes("IssueForWrite")) {
    return json({ data: { issue: { id: "issue-1", identifier: "ENG-1", team: { id: "team-1" } } } });
  }
  if (query.includes("TeamStates")) {
    return json({ data: { team: { states: { nodes: [{ id: "state-2", name: "In Progress" }] } } } });
  }
  if (query.includes("UserByEmail")) return json({ data: { users: { nodes: [{ id: "user-1" }] } } });
  return json({ data: {} });
}

function responder(calls: Call[]): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ method, url, body });

    if (url.startsWith("https://api.github.com")) {
      if (url.endsWith("/issues") && method === "POST") return json(ISSUE, 201);
      if (/\/issues\/\d+\/comments$/.test(url)) {
        return json({ id: 99, html_url: "https://github.com/octo/repo/issues/7#issuecomment-99" }, 201);
      }
      if (/\/issues\/7$/.test(url) && method === "PATCH") return json({ ...ISSUE, state: "closed" });
      return json({}, 404);
    }
    if (url.startsWith("https://gmail.googleapis.com")) {
      if (url.endsWith("/messages/send")) return json({ id: "message-1", threadId: "thread-1" });
      if (url.endsWith("/drafts")) return json({ id: "draft-1", message: { id: "message-2" } });
      if (url.endsWith("/labels")) return json({ labels: [{ id: "Label_9", name: "Work" }, { id: "SPAM", name: "SPAM" }] });
      if (url.includes("/messages/message-1/modify")) return json({ id: "message-1" });
      return json({}, 404);
    }
    if (url.startsWith("https://graph.microsoft.com")) {
      if (url.endsWith("/me/sendMail")) return empty();
      if (url.endsWith("/reply")) return empty();
      if (url.endsWith("/move")) return json({ id: "AAAA-2" });
      if (url.startsWith("https://graph.microsoft.com/v1.0/me/messages/")) return json({ id: "AAAA-1" });
      return json({}, 404);
    }
    if (url === "https://api.linear.app/graphql") {
      const parsed = JSON.parse(body) as { query?: string };
      return linearResponse(parsed.query ?? "");
    }
    if (url.startsWith("https://api.notion.com")) {
      if (url.includes(`/databases/${NOTION_PARENT}`)) {
        return json({ object: "database", properties: { Name: { type: "title" } } });
      }
      if (url.includes("/databases/")) return json({ object: "error" }, 404);
      if (url.includes("/pages/") && method === "GET") return json({ object: "page", id: NOTION_PAGE });
      if (url.endsWith("/pages") && method === "POST") {
        return json({ id: "page-new", url: "https://www.notion.so/page-new" });
      }
      if (url.includes("/blocks/") && url.includes("/children") && method === "PATCH") {
        return json({ results: [{}, {}, {}] });
      }
      return json({}, 404);
    }
    if (url.startsWith("https://www.googleapis.com/calendar/v3")) {
      return json({
        id: "event-1",
        summary: "Standup",
        start: { dateTime: "2026-11-20T10:00:00+08:00" },
        end: { dateTime: "2026-11-20T11:00:00+08:00" },
        htmlLink: "https://calendar.google.com/event-1",
      });
    }
    if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")
      || url.startsWith("https://www.googleapis.com/drive/v3/files/")) {
      return json({
        id: "file-1",
        name: "notes.txt",
        mimeType: "text/plain",
        modifiedTime: "2026-11-19T00:00:00.000Z",
        size: "5",
        webViewLink: "https://drive.google.com/file-1",
      });
    }
    return json({}, 404);
  }) as typeof fetch;
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "aster-write-tools-"));
  const secretDir = join(directory, "secrets");
  await mkdir(secretDir, { recursive: true });
  await writeFile(join(secretDir, "credential_master_key"), KEY);
  for (const [name, value] of [
    ["github_client_id", "github-client"], ["github_client_secret", "github-client-secret"],
    ["google_client_id", "google-client"], ["google_client_secret", "google-client-secret"],
    ["outlook_client_id", "outlook-client"], ["outlook_client_secret", "outlook-client-secret"],
    ["linear_client_id", "linear-client"], ["linear_client_secret", "linear-client-secret"],
    ["notion_client_id", "notion-client"], ["notion_client_secret", "notion-client-secret"],
  ] as const) {
    await writeFile(join(secretDir, name), value);
  }
  const config = readConnectorsConfig({
    ASTER_CONNECTOR_SECRET_DIR: secretDir,
    CONNECTOR_OAUTH_REDIRECT_BASE: "https://aster.example",
  });
  const calls: Call[] = [];
  const fake = responder(calls);
  const store = new ConnectorStore(join(directory, "connectors.sqlite"), { now: () => new Date(NOW) });
  const secrets = new FileSecretProvider(secretDir);
  const oauth = new ConnectorOAuth({ secrets, config, fetch: fake, now: () => new Date(NOW) });
  const vault = new LocalTokenVault({ store, secrets, config, fetch: fake, now: () => new Date(NOW) });
  const service = new ConnectorService({
    store, oauth, vault, config, ownerId: "owner", dataDir: directory,
    fetch: fake, now: () => new Date(NOW), log: () => {},
  });
  const extension = createConnectorExtension(service, "owner");

  const providers: OAuthProvider[] = ["github", "gmail", "outlook", "linear", "notion", "google_calendar", "google_drive"];
  for (const provider of providers) {
    const { connection } = store.create({ ownerId: "owner", provider, slug: provider });
    store.saveCredential(connection.id, {
      ciphertext: encryptCredential(
        Buffer.from(KEY, "hex"),
        JSON.stringify({ access_token: ACCESS_TOKEN }),
        `connection:${connection.id}:oauth`,
      ),
      expiresAt: null,
    });
    store.setConnected(connection.id, { accountLabel: `${provider}@example.test`, scopes: [] });
  }

  return {
    directory, calls, extension,
    async close() {
      service.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

type Run = (name: string, args: Record<string, unknown>) => Promise<ToolExecutionResult>;

function runner(extension: Extension): Run {
  return async (name, args) => {
    const tool = (extension.tools ?? []).find((entry) => entry.name === name);
    assert.ok(tool !== undefined, `tool ${name} is not registered`);
    return tool.execute(args as never, { conversationId: 1, callId: "call-1" } as unknown as ToolExecutionApi, BACKGROUND_CONTEXT);
  };
}

function text(result: ToolExecutionResult): string {
  return (result.output ?? []).map((item) => "text" in item ? item.text : "").join("\n");
}

/** `details` is a JSON value; tests read one field at a time. */
function detail(result: ToolExecutionResult, key: string): unknown {
  const details = result.details;
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  return (details as Record<string, unknown>)[key];
}

function assertInvalid(result: ToolExecutionResult, label: string): void {
  assert.equal(result.isError, true, `${label} should be rejected`);
  assert.equal(detail(result, "code"), "CONNECTOR_INVALID_INPUT", `${label} should be an input error`);
}

test("every write tool is registered as write, read tools stay read, and no delete tool exists", async () => {
  const env = await setup();
  try {
    const registry = createToolRegistry([env.extension]);
    for (const name of WRITE_TOOLS) {
      assert.equal(registry.lookup(name)?.authz, "write", `${name} must require write authority`);
    }
    for (const name of READ_TOOLS) {
      assert.equal(registry.lookup(name)?.authz, "read", `${name} must stay read`);
    }
    const names = (env.extension.tools ?? []).map((tool) => tool.name);
    for (const name of names) {
      assert.doesNotMatch(name, /delete|remove|trash|destroy|purge|revoke/i, `${name} is a destructive tool`);
    }
    // GitHub cannot delete an issue through this connector even indirectly: no such route exists.
    assert.equal(names.filter((name) => name.includes("github")).length, 6);
  } finally {
    await env.close();
  }
});

test("github write tools create, comment and update issues with bounded results", async () => {
  const env = await setup();
  try {
    const run = runner(env.extension);

    const created = await run("connector_github_create_issue", {
      repo: "octo/repo", title: "New issue", body: "Details",
    });
    assert.equal(created.isError, undefined);
    assert.equal(detail(created, "number"), 7);
    const createCall = env.calls.find((call) => call.url.endsWith("/repos/octo/repo/issues") && call.method === "POST")!;
    assert.deepEqual(JSON.parse(createCall.body), { title: "New issue", body: "Details" });
    assert.equal(text(created).includes(ACCESS_TOKEN), false);
    // Only the new identity, never the upstream payload.
    assert.equal(text(created).includes("updated_at"), false);

    const commented = await run("connector_github_comment_issue", {
      repo: "octo/repo", number: 7, body: "Looks good",
    });
    assert.equal(commented.isError, undefined);
    assert.equal(detail(commented, "id"), 99);

    const updated = await run("connector_github_update_issue", {
      repo: "octo/repo", number: 7, state: "closed", labels: ["bug", "confirmed"],
    });
    assert.equal(updated.isError, undefined);
    assert.equal(detail(updated, "state"), "closed");
    const updateCall = env.calls.find((call) => call.method === "PATCH" && call.url.endsWith("/issues/7"))!;
    assert.deepEqual(JSON.parse(updateCall.body), { state: "closed", labels: ["bug", "confirmed"] });

    assertInvalid(await run("connector_github_create_issue", { repo: "not a repo", title: "x" }), "repo");
    assertInvalid(await run("connector_github_create_issue", { repo: "octo/repo", title: "   " }), "title");
    assertInvalid(await run("connector_github_update_issue", { repo: "octo/repo", number: 7 }), "empty update");
    assertInvalid(
      await run("connector_github_update_issue", { repo: "octo/repo", number: 7, labels: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u"] }),
      "too many labels",
    );
  } finally {
    await env.close();
  }
});

test("gmail write tools send, draft and relabel without touching trash or spam", async () => {
  const env = await setup();
  try {
    const run = runner(env.extension);

    const sent = await run("connector_gmail_send_message", {
      to: "alice@example.test", subject: "Hello", body: "Body",
    });
    assert.equal(sent.isError, undefined);
    assert.equal(detail(sent, "id"), "message-1");
    const sendCall = env.calls.find((call) => call.url.endsWith("/messages/send"))!;
    const raw = Buffer.from((JSON.parse(sendCall.body) as { raw: string }).raw, "base64url").toString("utf8");
    assert.match(raw, /^To: alice@example\.test/m);
    assert.match(raw, /^Subject: Hello/m);
    assert.equal(text(sent).includes(ACCESS_TOKEN), false);
    assert.equal(detail(sent, "threadId"), undefined); // details stay minimal

    const drafted = await run("connector_gmail_create_draft", {
      to: "alice@example.test, bob@example.test", subject: "Draft", body: "Body",
    });
    assert.equal(drafted.isError, undefined);
    assert.equal(detail(drafted, "draftId"), "draft-1");

    const modified = await run("connector_gmail_modify_labels", {
      id: "message-1", archive: true, mark_read: true, add_label: "Work",
    });
    assert.equal(modified.isError, undefined);
    const modifyCall = env.calls.find((call) => call.url.includes("/messages/message-1/modify"))!;
    assert.deepEqual(JSON.parse(modifyCall.body), {
      addLabelIds: ["Label_9"], removeLabelIds: ["INBOX", "UNREAD"],
    });

    assertInvalid(await run("connector_gmail_send_message", {
      to: "not-an-address", subject: "x", body: "y",
    }), "recipient");
    assertInvalid(await run("connector_gmail_send_message", {
      to: "a@example.test", subject: "bad\nsubject", body: "y",
    }), "subject newline");
    assertInvalid(await run("connector_gmail_modify_labels", { id: "message-1" }), "empty modify");
    // TRASH and SPAM cannot be reached even by id.
    assertInvalid(await run("connector_gmail_modify_labels", { id: "message-1", add_label: "SPAM" }), "spam label");
  } finally {
    await env.close();
  }
});

test("outlook write tools send, reply and flag or move within standard folders", async () => {
  const env = await setup();
  try {
    const run = runner(env.extension);

    const sent = await run("connector_outlook_send_message", {
      to: "alice@example.test", subject: "Hello", body: "Body",
    });
    assert.equal(sent.isError, undefined);
    assert.equal(detail(sent, "sent"), true);
    const sendCall = env.calls.find((call) => call.url.endsWith("/me/sendMail"))!;
    const payload = JSON.parse(sendCall.body) as {
      message: { subject: string; toRecipients: { emailAddress: { address: string } }[] };
      saveToSentItems: boolean;
    };
    assert.equal(payload.message.subject, "Hello");
    assert.deepEqual(payload.message.toRecipients, [{ emailAddress: { address: "alice@example.test" } }]);
    assert.equal(payload.saveToSentItems, true);
    assert.equal(text(sent).includes(ACCESS_TOKEN), false);

    const replied = await run("connector_outlook_reply_message", { id: "AAAA-1", comment: "Thanks" });
    assert.equal(replied.isError, undefined);
    assert.equal(detail(replied, "inReplyTo"), "AAAA-1");

    const updated = await run("connector_outlook_update_message", {
      id: "AAAA-1", is_read: true, move_to: "archive",
    });
    assert.equal(updated.isError, undefined);
    assert.equal(detail(updated, "isRead"), true);
    assert.equal(detail(updated, "movedTo"), "archive");
    const moveCall = env.calls.find((call) => call.url.endsWith("/me/messages/AAAA-1/move"))!;
    assert.deepEqual(JSON.parse(moveCall.body), { destinationId: "archive" });

    assertInvalid(await run("connector_outlook_send_message", {
      to: "a@example.test", subject: "", body: "Body",
    }), "subject");
    assertInvalid(await run("connector_outlook_update_message", { id: "AAAA-1" }), "empty update");
    assertInvalid(
      await run("connector_outlook_update_message", { id: "AAAA-1", move_to: "deleteditems" }),
      "deleted items folder",
    );
  } finally {
    await env.close();
  }
});

test("linear write tools create, update and comment with server-side id resolution", async () => {
  const env = await setup();
  try {
    const run = runner(env.extension);

    const created = await run("connector_linear_create_issue", {
      team: "ENG", title: "New", description: "Details",
    });
    assert.equal(created.isError, undefined);
    assert.equal(detail(created, "identifier"), "ENG-9");
    const createCall = env.calls.find((call) => call.body.includes("issueCreate"))!;
    const variables = (JSON.parse(createCall.body) as { variables: { input: Record<string, unknown> } }).variables;
    assert.deepEqual(variables.input, { teamId: "team-1", title: "New", description: "Details" });

    const updated = await run("connector_linear_update_issue", {
      identifier: "ENG-1", state: "In Progress", title: "Renamed", assignee: "dev@example.test",
    });
    assert.equal(updated.isError, undefined);
    assert.equal(detail(updated, "state"), "In Progress");
    const updateCall = env.calls.find((call) => call.body.includes("issueUpdate"))!;
    const updateVariables = (JSON.parse(updateCall.body) as { variables: { input: Record<string, unknown> } }).variables;
    assert.deepEqual(updateVariables.input, { title: "Renamed", stateId: "state-2", assigneeId: "user-1" });
    assert.equal(text(updated).includes(ACCESS_TOKEN), false);

    const commented = await run("connector_linear_comment_issue", { identifier: "ENG-1", body: "Looks good" });
    assert.equal(commented.isError, undefined);
    assert.equal(detail(commented, "id"), "comment-1");

    assertInvalid(await run("connector_linear_create_issue", { team: "ENG!", title: "x" }), "team key");
    assertInvalid(await run("connector_linear_update_issue", { identifier: "not-an-issue" }), "identifier");
    assertInvalid(await run("connector_linear_update_issue", {
      identifier: "ENG-1", assignee: "not-an-email",
    }), "assignee");
  } finally {
    await env.close();
  }
});

test("notion write tools create pages under a database or page and append paragraphs", async () => {
  const env = await setup();
  try {
    const run = runner(env.extension);

    const created = await run("connector_notion_create_page", {
      parent_id: NOTION_PARENT, title: "New page", content: "First line\nSecond line",
    });
    assert.equal(created.isError, undefined);
    assert.equal(detail(created, "id"), "page-new");
    const createCall = env.calls.find((call) => call.method === "POST" && call.url.endsWith("/pages"))!;
    const payload = JSON.parse(createCall.body) as {
      parent: Record<string, string>;
      properties: Record<string, { title: { text: { content: string } }[] }>;
      children: { type: string; paragraph: { rich_text: { text: { content: string } }[] } }[];
    };
    assert.deepEqual(payload.parent, { database_id: NOTION_PARENT });
    assert.equal(payload.properties.Name!.title[0]!.text.content, "New page");
    assert.deepEqual(payload.children.map((block) => block.paragraph.rich_text[0]!.text.content), ["First line", "Second line"]);
    assert.equal(text(created).includes(ACCESS_TOKEN), false);

    // A page parent is detected when the database probe fails.
    const pageParent = await run("connector_notion_create_page", { parent_id: NOTION_PAGE, title: "Child" });
    assert.equal(pageParent.isError, undefined);

    const appended = await run("connector_notion_append_blocks", {
      page_id: NOTION_PAGE, content: "One\nTwo\nThree",
    });
    assert.equal(appended.isError, undefined);
    assert.equal(detail(appended, "blocksAdded"), 3);

    assertInvalid(await run("connector_notion_create_page", { parent_id: "short", title: "x" }), "parent id");
    assertInvalid(await run("connector_notion_create_page", { parent_id: NOTION_PARENT, title: " " }), "title");
    assertInvalid(await run("connector_notion_append_blocks", { page_id: NOTION_PAGE, content: "\n \n" }), "empty content");
  } finally {
    await env.close();
  }
});

test("calendar write tools require unambiguous times and a real ordering", async () => {
  const env = await setup();
  try {
    const run = runner(env.extension);

    const created = await run("connector_google_calendar_create_event", {
      summary: "Standup",
      start: "2026-11-20T10:00:00+08:00",
      end: "2026-11-20T11:00:00+08:00",
      description: "Daily",
      location: "Room 1",
    });
    assert.equal(created.isError, undefined);
    assert.equal(detail(created, "id"), "event-1");
    const createCall = env.calls.find((call) => call.method === "POST" && call.url.includes("/calendars/primary/events"))!;
    const payload = JSON.parse(createCall.body) as {
      summary: string;
      start: { dateTime: string; timeZone?: string };
      end: { dateTime: string };
      description: string;
      location: string;
    };
    assert.equal(payload.summary, "Standup");
    assert.equal(payload.start.dateTime, "2026-11-20T10:00:00+08:00");
    assert.equal(payload.start.timeZone, undefined);
    assert.equal(text(created).includes(ACCESS_TOKEN), false);

    const zoned = await run("connector_google_calendar_create_event", {
      summary: "Local",
      start: "2026-11-20T10:00:00",
      end: "2026-11-20T11:00:00",
      time_zone: "Asia/Shanghai",
    });
    assert.equal(zoned.isError, undefined);
    const zonedCall = env.calls.filter((call) => call.method === "POST" && call.url.includes("/calendars/primary/events")).at(-1)!;
    const zonedPayload = JSON.parse(zonedCall.body) as { start: { dateTime: string; timeZone?: string } };
    assert.deepEqual(zonedPayload.start, { dateTime: "2026-11-20T10:00:00", timeZone: "Asia/Shanghai" });

    const updated = await run("connector_google_calendar_update_event", {
      event_id: "event-1", summary: "Renamed",
    });
    assert.equal(updated.isError, undefined);

    assertInvalid(await run("connector_google_calendar_create_event", {
      summary: "No zone", start: "2026-11-20T10:00:00", end: "2026-11-20T11:00:00",
    }), "missing time zone");
    assertInvalid(await run("connector_google_calendar_create_event", {
      summary: "Backwards", start: "2026-11-20T11:00:00+08:00", end: "2026-11-20T10:00:00+08:00",
    }), "end before start");
    assertInvalid(await run("connector_google_calendar_update_event", { event_id: "event-1" }), "empty update");
    assertInvalid(await run("connector_google_calendar_update_event", {
      event_id: "event-1", start: "2026-11-20T10:00:00+08:00",
    }), "start without end");
  } finally {
    await env.close();
  }
});

test("drive write tools create and update plain-text files only", async () => {
  const env = await setup();
  try {
    const run = runner(env.extension);

    const created = await run("connector_google_drive_create_file", {
      name: "notes.txt", content: "Hello",
    });
    assert.equal(created.isError, undefined);
    assert.equal(detail(created, "id"), "file-1");
    const createCall = env.calls.find((call) => call.method === "POST" && call.url.includes("upload/drive/v3/files"))!;
    assert.match(createCall.url, /uploadType=multipart/);
    assert.match(createCall.body, /"name":"notes\.txt"/);
    assert.match(createCall.body, /Content-Type: text\/plain/);
    assert.equal(text(created).includes(ACCESS_TOKEN), false);

    const renamed = await run("connector_google_drive_update_file", { file_id: "file-1", name: "renamed.txt" });
    assert.equal(renamed.isError, undefined);
    assert.equal(detail(renamed, "name"), "notes.txt"); // identity comes from the API response
    const renameCall = env.calls.find((call) => call.method === "PATCH" && call.url.includes("/drive/v3/files/file-1"))!;
    assert.deepEqual(JSON.parse(renameCall.body), { name: "renamed.txt" });

    const replaced = await run("connector_google_drive_update_file", { file_id: "file-1", content: "New text" });
    assert.equal(replaced.isError, undefined);
    const replaceCall = env.calls.find((call) => call.method === "PATCH" && call.url.includes("upload/drive/v3/files/file-1"))!;
    assert.match(replaceCall.body, /New text/);

    assertInvalid(await run("connector_google_drive_create_file", { name: "a/b.txt", content: "x" }), "slash");
    assertInvalid(await run("connector_google_drive_update_file", { file_id: "file-1" }), "empty update");
    assertInvalid(await run("connector_google_drive_update_file", { file_id: "bad id!", content: "x" }), "file id");
  } finally {
    await env.close();
  }
});

test("no connector write result, detail or error carries the access token", async () => {
  const env = await setup();
  try {
    const run = runner(env.extension);
    const outcomes = await Promise.all([
      run("connector_github_create_issue", { repo: "octo/repo", title: "T" }),
      run("connector_github_comment_issue", { repo: "octo/repo", number: 7, body: "B" }),
      run("connector_gmail_send_message", { to: "a@example.test", subject: "S", body: "B" }),
      run("connector_outlook_send_message", { to: "a@example.test", subject: "S", body: "B" }),
      run("connector_linear_create_issue", { team: "ENG", title: "T" }),
      run("connector_notion_create_page", { parent_id: NOTION_PARENT, title: "T" }),
      run("connector_google_calendar_create_event", {
        summary: "S", start: "2026-11-20T10:00:00+08:00", end: "2026-11-20T11:00:00+08:00",
      }),
      run("connector_google_drive_create_file", { name: "n.txt", content: "c" }),
      run("connector_gmail_send_message", { to: "bad", subject: "S", body: "B" }),
    ]);
    for (const outcome of outcomes) {
      const serialized = JSON.stringify(outcome);
      assert.equal(serialized.includes(ACCESS_TOKEN), false);
      assert.equal(text(outcome).includes(ACCESS_TOKEN), false);
    }
    for (const call of env.calls) assert.equal(call.body.includes(ACCESS_TOKEN), false);
  } finally {
    await env.close();
  }
});

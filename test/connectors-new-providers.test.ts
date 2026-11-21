import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConnectorsConfig } from "../src/config.js";
import { encryptCredential } from "../src/connectors/crypto.js";
import { ConnectorOAuth } from "../src/connectors/oauth.js";
import { FileSecretProvider } from "../src/connectors/secrets.js";
import { ConnectorService } from "../src/connectors/service.js";
import { ConnectorStore, type ConnectorConnection } from "../src/connectors/store.js";
import { LocalTokenVault } from "../src/connectors/vault.js";

const KEY = "33".repeat(32);
const NOW = Date.parse("2026-11-18T00:00:00.000Z");
const BINDING = { connectionId: "", tool: "", requestId: "req-new", ownerId: "owner" };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function setup(fetchImpl: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), "aster-new-providers-"));
  const secretDir = join(directory, "secrets");
  await mkdir(secretDir, { recursive: true });
  await writeFile(join(secretDir, "credential_master_key"), KEY);
  for (const [name, value] of [
    ["outlook_client_id", "outlook-client"], ["outlook_client_secret", "outlook-secret"],
    ["linear_client_id", "linear-client"], ["linear_client_secret", "linear-secret"],
    ["notion_client_id", "notion-client"], ["notion_client_secret", "notion-secret"],
    ["google_client_id", "google-client"], ["google_client_secret", "google-secret"],
  ] as const) {
    await writeFile(join(secretDir, name), value);
  }
  const config = readConnectorsConfig({
    ASTER_CONNECTOR_SECRET_DIR: secretDir,
    CONNECTOR_OAUTH_REDIRECT_BASE: "https://aster.example",
  });
  const store = new ConnectorStore(join(directory, "connectors.sqlite"), { now: () => new Date(NOW) });
  const secrets = new FileSecretProvider(secretDir);
  const oauth = new ConnectorOAuth({ secrets, config, fetch: fetchImpl, now: () => new Date(NOW) });
  const vault = new LocalTokenVault({ store, secrets, config, fetch: fetchImpl, now: () => new Date(NOW) });
  const service = new ConnectorService({
    store, oauth, vault, config, ownerId: "owner", dataDir: directory,
    fetch: fetchImpl, now: () => new Date(NOW), log: () => {},
  });
  return {
    directory, store, service,
    connect(connection: ConnectorConnection, token: string, scopes: string[] = []) {
      store.saveCredential(connection.id, {
        ciphertext: encryptCredential(Buffer.from(KEY, "hex"), JSON.stringify({ access_token: token }), `connection:${connection.id}:oauth`),
        expiresAt: null,
      });
      store.setConnected(connection.id, { accountLabel: "user@example.test", scopes });
    },
    async close() {
      service.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("outlook OAuth uses PKCE, offline scope and sends the Microsoft token scope", async () => {
  const requests: { url: string; body: string }[] = [];
  const fake = (async (input, init) => {
    const url = String(input);
    requests.push({ url, body: String(init?.body ?? "") });
    if (url === "https://login.microsoftonline.com/common/oauth2/v2.0/token") {
      return json({ access_token: "outlook-access", refresh_token: "outlook-refresh", expires_in: 3600, scope: "Mail.Read" });
    }
    if (url.startsWith("https://graph.microsoft.com/v1.0/me")) {
      return json({ mail: "me@example.test", userPrincipalName: "me@tenant.example.test" });
    }
    return json({}, 404);
  }) as typeof fetch;
  const env = await setup(fake);
  try {
    env.store.create({ ownerId: "owner", provider: "outlook", slug: "mail" });
    const started = await env.service.startOAuth("mail");
    const url = new URL(started.url);
    assert.equal(url.origin + url.pathname, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    assert.equal(url.searchParams.get("scope"), "offline_access User.Read Mail.ReadWrite Mail.Send");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const connected = await env.service.completeOAuth(url.searchParams.get("state")!, "code");
    assert.equal(connected.accountLabel, "me@example.test");
    const exchange = requests.find((request) => request.url.endsWith("/oauth2/v2.0/token"))!;
    const form = new URLSearchParams(exchange.body);
    assert.equal(form.get("scope"), "offline_access User.Read Mail.ReadWrite Mail.Send");
    assert.ok(form.get("code_verifier") !== null && form.get("code_verifier")!.length > 20);
  } finally {
    await env.close();
  }
});

test("linear OAuth uses PKCE and a form exchange", async () => {
  const requests: { url: string; body: string }[] = [];
  const fake = (async (input, init) => {
    const url = String(input);
    requests.push({ url, body: String(init?.body ?? "") });
    if (url === "https://api.linear.app/oauth/token") {
      return json({ access_token: "linear-access", refresh_token: "linear-refresh", expires_in: 86399, scope: "read" });
    }
    if (url === "https://api.linear.app/graphql") {
      return json({ data: { viewer: { name: "Dev", email: "dev@example.test" } } });
    }
    return json({}, 404);
  }) as typeof fetch;
  const env = await setup(fake);
  try {
    env.store.create({ ownerId: "owner", provider: "linear", slug: "issues" });
    const started = await env.service.startOAuth("issues");
    const url = new URL(started.url);
    assert.equal(url.origin + url.pathname, "https://linear.app/oauth/authorize");
    assert.equal(url.searchParams.get("scope"), "read write");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const connected = await env.service.completeOAuth(url.searchParams.get("state")!, "code");
    assert.equal(connected.accountLabel, "Dev");
    const exchange = requests.find((request) => request.url === "https://api.linear.app/oauth/token")!;
    const form = new URLSearchParams(exchange.body);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.ok(form.get("code_verifier") !== null);
  } finally {
    await env.close();
  }
});

test("notion OAuth has no PKCE or scope and exchanges with Basic auth and JSON", async () => {
  const requests: { url: string; headers: Headers; body: string }[] = [];
  const fake = (async (input, init) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    if (url === "https://api.notion.com/v1/oauth/token") {
      return json({ access_token: "notion-access", token_type: "bearer", workspace_name: "Team" });
    }
    if (url === "https://api.notion.com/v1/users/me") {
      return json({ object: "user", name: "Aster Bot", type: "bot", bot: { workspace_name: "Team" } });
    }
    return json({}, 404);
  }) as typeof fetch;
  const env = await setup(fake);
  try {
    env.store.create({ ownerId: "owner", provider: "notion", slug: "wiki" });
    const started = await env.service.startOAuth("wiki");
    const url = new URL(started.url);
    assert.equal(url.origin + url.pathname, "https://api.notion.com/v1/oauth/authorize");
    assert.equal(url.searchParams.get("owner"), "user");
    assert.equal(url.searchParams.get("scope"), null);
    assert.equal(url.searchParams.get("code_challenge"), null);
    const connected = await env.service.completeOAuth(url.searchParams.get("state")!, "code");
    assert.equal(connected.accountLabel, "Aster Bot");

    const exchange = requests.find((request) => request.url === "https://api.notion.com/v1/oauth/token")!;
    assert.equal(exchange.headers.get("content-type"), "application/json");
    assert.equal(exchange.headers.get("authorization"), `Basic ${Buffer.from("notion-client:notion-secret").toString("base64")}`);
    assert.deepEqual(JSON.parse(exchange.body), {
      grant_type: "authorization_code",
      code: "code",
      redirect_uri: "https://aster.example/api/v1/connectors/oauth/callback",
    });
    const profile = requests.find((request) => request.url === "https://api.notion.com/v1/users/me")!;
    assert.equal(profile.headers.get("notion-version"), "2022-06-28");
  } finally {
    await env.close();
  }
});

test("google calendar and drive reuse the Google client with openid profile and offline access", async () => {
  for (const [provider, scope, slug] of [
    ["google_calendar", "https://www.googleapis.com/auth/calendar", "cal"],
    ["google_drive", "https://www.googleapis.com/auth/drive.file", "drive"],
  ] as const) {
    const fake = (async (input) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return json({ access_token: `${provider}-access`, refresh_token: "google-refresh", expires_in: 3600 });
      }
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return json({ email: "owner@example.test" });
      }
      return json({}, 404);
    }) as typeof fetch;
    const env = await setup(fake);
    try {
      env.store.create({ ownerId: "owner", provider, slug });
      const started = await env.service.startOAuth(slug);
      const url = new URL(started.url);
      assert.equal(url.searchParams.get("scope"), `openid email ${scope}`);
      assert.equal(url.searchParams.get("access_type"), "offline");
      assert.equal(url.searchParams.get("prompt"), "consent");
      const connected = await env.service.completeOAuth(url.searchParams.get("state")!, "code");
      assert.equal(connected.accountLabel, "owner@example.test");
    } finally {
      await env.close();
    }
  }
});

test("outlook tools list, search and read bounded messages", async () => {
  const urls: string[] = [];
  const longBody = `<p>${"x".repeat(20_100)}</p>`;
  const fake = (async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/mailFolders/inbox/messages")) {
      return json({ value: [{
        id: "AAMkAD1", subject: "Hello", from: { emailAddress: { name: "Alice", address: "alice@example.test" } },
        receivedDateTime: "2026-11-17T08:00:00Z", bodyPreview: "preview",
      }] });
    }
    if (url.includes("/me/messages?") && url.includes("%24search")) {
      return json({ value: [{ id: "AAMkAD2", subject: "Found", receivedDateTime: "2026-11-16T08:00:00Z", bodyPreview: "s" }] });
    }
    if (url.includes("/me/messages/AAMkAD3")) {
      return json({
        id: "AAMkAD3", subject: "Body", receivedDateTime: "2026-11-15T08:00:00Z", bodyPreview: "p",
        body: { contentType: "html", content: longBody },
        toRecipients: [{ emailAddress: { address: "me@example.test" } }],
      });
    }
    return json({}, 404);
  }) as typeof fetch;
  const env = await setup(fake);
  try {
    const connection = env.store.create({ ownerId: "owner", provider: "outlook", slug: "mail" }).connection;
    env.connect(connection, "outlook-token");
    const listed = await env.service.listOutlookMessages({ maxResults: 5 }, BINDING);
    assert.equal(listed[0]?.subject, "Hello");
    assert.equal(listed[0]?.from, "Alice <alice@example.test>");
    assert.match(urls[0]!, /%24top=5/);

    const found = await env.service.searchOutlookMessages({ query: "budget" }, BINDING);
    assert.equal(found[0]?.subject, "Found");
    assert.match(urls[1]!, /%24search=%22budget%22/);

    const message = await env.service.getOutlookMessage({ id: "AAMkAD3" }, BINDING);
    assert.equal(message.truncated, true);
    assert.ok(message.body.length <= 20_001);
    assert.equal(message.body.includes("<p>"), false, "HTML is flattened");
    assert.deepEqual(message.to, ["me@example.test"]);
    assert.equal(JSON.stringify([listed, found, message]).includes("outlook-token"), false);
  } finally {
    await env.close();
  }
});

test("linear tools list with filters, search and read an issue", async () => {
  const bodies: { query: string; variables: Record<string, unknown> }[] = [];
  const fake = (async (input, init) => {
    const url = String(input);
    if (url !== "https://api.linear.app/graphql") return json({}, 404);
    const parsed = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    bodies.push(parsed);
    if (parsed.query.includes("Search")) {
      return json({ data: { issues: { nodes: [{ identifier: "ENG-2", title: "Budget", state: { name: "Todo" }, assignee: null, updatedAt: "2026-11-17T00:00:00Z" }] } } });
    }
    if (parsed.query.includes("Issue(")) {
      return json({ data: { issue: {
        identifier: "ENG-1", title: "Fix", state: { name: "In Progress" }, assignee: { name: "Dev" },
        updatedAt: "2026-11-17T00:00:00Z", url: "https://linear.app/x/ENG-1", description: "y".repeat(20_100),
      } } });
    }
    return json({ data: { issues: { nodes: [{ identifier: "ENG-1", title: "Fix", state: { name: "In Progress" }, assignee: { name: "Dev" }, updatedAt: "2026-11-17T00:00:00Z" }] } } });
  }) as typeof fetch;
  const env = await setup(fake);
  try {
    const connection = env.store.create({ ownerId: "owner", provider: "linear", slug: "issues" }).connection;
    env.connect(connection, "linear-token");
    const listed = await env.service.listLinearIssues({ team: "ENG", state: "In Progress", maxResults: 5 }, BINDING);
    assert.equal(listed[0]?.identifier, "ENG-1");
    assert.deepEqual(bodies[0]!.variables.filter, {
      team: { key: { eqIgnoreCase: "ENG" } },
      state: { name: { eqIgnoreCase: "In Progress" } },
    });

    const found = await env.service.searchLinearIssues({ query: "budget" }, BINDING);
    assert.equal(found[0]?.identifier, "ENG-2");

    const issue = await env.service.getLinearIssue({ identifier: "ENG-1" }, BINDING);
    assert.equal(issue.truncated, true);
    assert.equal(issue.assignee, "Dev");
  } finally {
    await env.close();
  }
});

test("notion tools search and read a page's block text", async () => {
  const requests: { url: string; version: string; body: string }[] = [];
  const fake = (async (input, init) => {
    const url = String(input);
    requests.push({ url, version: new Headers(init?.headers).get("notion-version") ?? "", body: String(init?.body ?? "") });
    if (url === "https://api.notion.com/v1/search") {
      return json({ object: "list", results: [
        { object: "page", id: "0123456789abcdef0123456789abcdef", url: "https://notion.so/x", last_edited_time: "2026-11-17T00:00:00Z", properties: { Name: { type: "title", title: [{ plain_text: "Roadmap" }] } } },
        { object: "database", id: "fedcba9876543210fedcba9876543210", title: [{ plain_text: "Tasks" }], url: "https://notion.so/db", last_edited_time: "2026-11-16T00:00:00Z" },
      ] });
    }
    if (url.includes("/blocks/0123456789abcdef0123456789abcdef/children")) {
      return json({ object: "list", results: [
        { type: "heading_1", heading_1: { rich_text: [{ plain_text: "Plan" }] } },
        { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Ship it" }] } },
      ], has_more: false });
    }
    if (url.includes("/pages/0123456789abcdef0123456789abcdef")) {
      return json({ object: "page", id: "0123456789abcdef0123456789abcdef", url: "https://notion.so/x", last_edited_time: "2026-11-17T00:00:00Z", properties: { Name: { type: "title", title: [{ plain_text: "Roadmap" }] } } });
    }
    return json({}, 404);
  }) as typeof fetch;
  const env = await setup(fake);
  try {
    const connection = env.store.create({ ownerId: "owner", provider: "notion", slug: "wiki" }).connection;
    env.connect(connection, "notion-token");
    const hits = await env.service.searchNotion({ query: "roadmap" }, BINDING);
    assert.deepEqual(hits.map((hit) => hit.title), ["Roadmap", "Tasks"]);
    assert.ok(requests.every((request) => request.version === "2022-06-28"));

    const page = await env.service.getNotionPage({ pageId: "0123456789abcdef0123456789abcdef" }, BINDING);
    assert.equal(page.title, "Roadmap");
    assert.match(page.content, /# Plan/);
    assert.match(page.content, /Ship it/);
  } finally {
    await env.close();
  }
});

test("google calendar tools list a bounded window and read an event", async () => {
  const urls: string[] = [];
  const fake = (async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/calendars/primary/events?")) {
      return json({ items: [{
        id: "evt1", summary: "Standup", start: { dateTime: "2026-11-18T09:00:00Z" },
        end: { dateTime: "2026-11-18T09:15:00Z" }, status: "confirmed",
      }] });
    }
    if (url.includes("/calendars/primary/events/evt1")) {
      return json({
        id: "evt1", summary: "Standup", start: { dateTime: "2026-11-18T09:00:00Z" },
        end: { dateTime: "2026-11-18T09:15:00Z" }, description: "d".repeat(20_100),
        attendees: [{ email: "a@example.test", displayName: "Alice" }],
      });
    }
    return json({}, 404);
  }) as typeof fetch;
  const env = await setup(fake);
  try {
    const connection = env.store.create({ ownerId: "owner", provider: "google_calendar", slug: "cal" }).connection;
    env.connect(connection, "calendar-token");
    const events = await env.service.listCalendarEvents({ days: 3, maxResults: 10 }, BINDING);
    assert.equal(events[0]?.summary, "Standup");
    const query = new URL(urls[0]!);
    assert.equal(query.searchParams.get("timeMin"), new Date(NOW).toISOString());
    assert.equal(query.searchParams.get("timeMax"), new Date(NOW + 3 * 86_400_000).toISOString());

    const event = await env.service.getCalendarEvent({ eventId: "evt1" }, BINDING);
    assert.equal(event.truncated, true);
    assert.deepEqual(event.attendees, ["Alice <a@example.test>"]);
  } finally {
    await env.close();
  }
});

test("google drive tools search, export Docs as text and never return binary", async () => {
  const urls: string[] = [];
  const fake = (async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/files?") && url.includes("q=")) {
      return json({ files: [
        { id: "doc1", name: "Budget", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-11-17T00:00:00Z", webViewLink: "https://docs.google.com/doc1" },
      ] });
    }
    if (url.includes("/files/doc1/export")) {
      return new Response("Exported document text", { status: 200, headers: { "content-type": "text/plain" } });
    }
    if (url.includes("/files/doc1?")) {
      return json({ id: "doc1", name: "Budget", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-11-17T00:00:00Z", webViewLink: "https://docs.google.com/doc1" });
    }
    if (url.includes("/files/pdf1?")) {
      return json({ id: "pdf1", name: "scan.pdf", mimeType: "application/pdf", modifiedTime: "2026-11-17T00:00:00Z", webViewLink: "https://drive.google.com/pdf1" });
    }
    return json({}, 404);
  }) as typeof fetch;
  const env = await setup(fake);
  try {
    const connection = env.store.create({ ownerId: "owner", provider: "google_drive", slug: "drive" }).connection;
    env.connect(connection, "drive-token");
    const files = await env.service.searchDriveFiles({ query: "budget" }, BINDING);
    assert.equal(files[0]?.name, "Budget");
    assert.match(new URL(urls[0]!).searchParams.get("q") ?? "", /name contains 'budget'/);

    const doc = await env.service.getDriveFile({ fileId: "doc1" }, BINDING);
    assert.equal(doc.content, "Exported document text");
    assert.equal(doc.truncated, false);

    const pdf = await env.service.getDriveFile({ fileId: "pdf1" }, BINDING);
    assert.equal(pdf.content, "");
    assert.match(pdf.note, /metadata/);
    assert.equal(urls.some((url) => url.includes("/export") && url.includes("pdf1")), false);
  } finally {
    await env.close();
  }
});

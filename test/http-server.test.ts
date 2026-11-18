import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WebConfig } from "../src/config.js";
import { hashPassword, SessionStore } from "../src/http/auth.js";
import { EventHub } from "../src/http/events.js";
import { createWebServer } from "../src/http/server.js";
import { WebRequestStore } from "../src/http/store.js";
import { RequestWorker } from "../src/http/worker.js";
import type { HistoryPage } from "../src/http/projection.js";
import { ConnectorError } from "../src/connectors/errors.js";
import type { ConnectorService } from "../src/connectors/service.js";
import { fakeAgent, fixtureSelection, message, waitFor } from "./http-testkit.js";

const PASSWORD = "integration-password";

async function startServer(options: { withSse?: boolean; connectors?: ConnectorService } = {}) {
  const fixture = await fixtureSelection();
  const directory = await mkdtemp(join(tmpdir(), "aster-http-server-"));
  const store = new WebRequestStore(join(directory, "web.sqlite"));
  const sessions = new SessionStore(store.database, 60 * 60 * 1000);
  const hub = new EventHub(() => {});
  const config: WebConfig = {
    port: 0,
    host: "127.0.0.1",
    allowedOrigins: ["http://localhost:5173", "https://localhost", "tauri://localhost"],
    sessionTtlDays: 30,
    staticDir: join(directory, "web-dist"),
    trustProxy: false,
  };
  let historyPage: HistoryPage = {
    messages: [
      message({ id: "41", role: "user", text: "hello", createdAt: 1 }),
      message({
        id: "42",
        text: "reply:hello",
        createdAt: 2,
        requestId: "req-x",
        model: { id: "opencode-go/deepseek-v4.1-flash", label: "magpie/opencode-go/deepseek-v4.1-flash", provider: "magpie" },
      }),
    ],
    nextCursor: null,
    hasMore: false,
  };
  const agent = fakeAgent({
    service: fixture.service,
    reply: async (request) => `reply:${request.text}`,
    history: async () => historyPage,
  });
  const worker = new RequestWorker({ store, hub, ownerId: "owner", agent });
  let modelVersion = 0;
  const app = await createWebServer({
    config,
    ownerId: "owner",
    version: "test",
    auth: hashPassword(PASSWORD),
    sessions,
    store,
    hub,
    worker,
    agent,
    modelService: fixture.service,
    modelVersion: () => modelVersion,
    ...(options.connectors === undefined ? {} : { connectors: options.connectors }),
    log: () => {},
  });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  worker.start();
  const login = async (password = PASSWORD) => app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { password },
  });
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  return {
    app,
    url,
    store,
    worker,
    hub,
    login,
    auth,
    setHistory(page: HistoryPage) {
      historyPage = page;
    },
    async close() {
      await app.close();
      await worker.stop();
      hub.close();
      store.close();
      await rm(fixture.directory, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("login, API auth, idempotent enqueue, history, models, switch, primary and abort", async () => {
  const server = await startServer();
  try {
    assert.equal((await server.app.inject({ method: "GET", url: "/api/v1/health" })).statusCode, 200);

    const wrong = await server.login("wrong");
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json<{ error: { code: string } }>().error.code, "INVALID_CREDENTIALS");

    const login = await server.login();
    assert.equal(login.statusCode, 200);
    const { token, ownerId } = login.json<{ token: string; ownerId: string }>();
    assert.ok(token.length > 20);
    assert.equal(ownerId, "owner");

    assert.equal((await server.app.inject({ method: "GET", url: "/api/v1/models" })).statusCode, 401);
    const me = await server.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: server.auth(token) });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json<{ ownerId: string }>().ownerId, "owner");

    const first = await server.app.inject({
      method: "POST", url: "/api/v1/messages", headers: server.auth(token),
      payload: { clientMessageId: "client-a", text: "hello" },
    });
    assert.equal(first.statusCode, 202);
    const { requestId } = first.json<{ requestId: string; status: string }>();
    const replay = await server.app.inject({
      method: "POST", url: "/api/v1/messages", headers: server.auth(token),
      payload: { clientMessageId: "client-a", text: "hello" },
    });
    assert.equal(replay.json<{ requestId: string }>().requestId, requestId);

    await waitFor(() => server.store.get(requestId)?.status === "done");
    const history = await server.app.inject({ method: "GET", url: "/api/v1/messages?limit=30", headers: server.auth(token) });
    assert.equal(history.statusCode, 200);
    const page = history.json<{ messages: { id: string; text: string }[]; hasMore: boolean }>();
    assert.equal(page.messages.at(-1)?.text, "reply:hello");
    assert.equal(page.hasMore, false);

    const models = await server.app.inject({ method: "GET", url: "/api/v1/models", headers: server.auth(token) });
    const catalog = models.json<{ canSelect: boolean; current: { kind: string }; selectable: { id: string }[] }>();
    assert.equal(catalog.canSelect, true);
    assert.equal(catalog.current.kind, "primary");
    assert.ok(catalog.selectable.some((model) => model.id === "opencode-go/glm-5.3-flash"));

    const selected = await server.app.inject({
      method: "POST", url: "/api/v1/models/select", headers: server.auth(token),
      payload: { action: "select", modelId: "opencode-go/glm-5.3-flash" },
    });
    assert.equal(selected.statusCode, 200);
    assert.equal(selected.json<{ current: { kind: string; id: string } }>().current.kind, "manual");
    assert.equal(selected.json<{ current: { id: string } }>().current.id, "opencode-go/glm-5.3-flash");

    const notFound = await server.app.inject({
      method: "POST", url: "/api/v1/models/select", headers: server.auth(token),
      payload: { action: "select", modelId: "magpie/nope" },
    });
    assert.equal(notFound.statusCode, 404);
    assert.equal(notFound.json<{ error: { code: string } }>().error.code, "MODEL_NOT_FOUND");

    const outOfScope = await server.app.inject({
      method: "POST", url: "/api/v1/models/select", headers: server.auth(token),
      payload: { action: "select", modelId: "commandcode/claude-haiku-5-5" },
    });
    assert.equal(outOfScope.statusCode, 422);
    assert.equal(outOfScope.json<{ error: { code: string } }>().error.code, "MODEL_OUT_OF_SCOPE");

    const primary = await server.app.inject({
      method: "POST", url: "/api/v1/models/select", headers: server.auth(token),
      payload: { action: "primary" },
    });
    assert.equal(primary.statusCode, 200);
    assert.equal(primary.json<{ current: { kind: string } }>().current.kind, "primary");

    const abortDone = await server.app.inject({
      method: "POST", url: `/api/v1/requests/${requestId}/abort`, headers: server.auth(token),
    });
    assert.equal(abortDone.statusCode, 409);
    assert.equal(abortDone.json<{ error: { code: string } }>().error.code, "REQUEST_NOT_ACTIVE");

    const logout = await server.app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: server.auth(token) });
    assert.equal(logout.statusCode, 204);
    assert.equal((await server.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: server.auth(token) })).statusCode, 401);
  } finally {
    await server.close();
  }
});

test("GET /messages links durable user and assistant rows to requestId and clientMessageId", async () => {
  const server = await startServer();
  try {
    const { token } = (await server.login()).json<{ token: string }>();
    const posted = await server.app.inject({
      method: "POST", url: "/api/v1/messages", headers: server.auth(token),
      payload: { clientMessageId: "history-link", text: "hello" },
    });
    const { requestId } = posted.json<{ requestId: string }>();
    server.setHistory({
      messages: [
        message({ id: "41", role: "user", text: "hello", createdAt: 1, requestId }),
        message({ id: "42", text: "reply:hello", createdAt: 2, requestId }),
      ],
      nextCursor: null,
      hasMore: false,
    });
    const history = await server.app.inject({
      method: "GET", url: "/api/v1/messages?limit=30", headers: server.auth(token),
    });
    assert.equal(history.statusCode, 200);
    const page = history.json<{
      messages: { role: string; requestId: string | null; clientMessageId: string | null }[];
    }>();
    assert.deepEqual(page.messages.map((entry) => entry.role), ["user", "assistant"]);
    for (const entry of page.messages) {
      assert.equal(entry.requestId, requestId);
      assert.equal(entry.clientMessageId, "history-link");
    }
  } finally {
    await server.close();
  }
});

test("connector routes create, list, start OAuth and complete the public callback safely", async () => {
  const connection = {
    id: "connection-1",
    provider: "github" as const,
    slug: "work",
    ownerId: "owner",
    status: "connected" as const,
    accountLabel: "octocat",
    scopes: ["read:user"],
    createdAt: "2026-11-18T00:00:00.000Z",
    updatedAt: "2026-11-18T00:00:01.000Z",
    lastErrorCode: null,
  };
  const calls: string[] = [];
  const connectors = {
    list() {
      calls.push("list");
      return {
        definitions: [{
          provider: "github", displayName: "GitHub", transport: "oauth" as const,
          defaultScopes: ["read:user"], tools: ["connector_github_list_repositories"],
        }],
        connections: [connection],
      };
    },
    create(input: { provider: unknown; slug: unknown; command?: unknown; args?: unknown }) {
      calls.push(`create:${String(input.provider)}:${String(input.slug)}:${String(input.command)}`);
      return { connection, created: true };
    },
    async startOAuth(slug: string) {
      calls.push(`start:${slug}`);
      return { url: "https://github.com/login/oauth/authorize?state=server-state" };
    },
    async completeOAuth(state: string, code: string) {
      calls.push(`complete:${state}:${code}`);
      if (state !== "good-state") throw new ConnectorError("CONNECTOR_OAUTH_STATE_INVALID", "OAuth state is invalid or has expired");
      return connection;
    },
  } as unknown as ConnectorService;
  const server = await startServer({ connectors });
  try {
    assert.equal((await server.app.inject({ method: "GET", url: "/api/v1/connectors" })).statusCode, 401);
    const { token } = (await server.login()).json<{ token: string }>();
    const headers = server.auth(token);

    const created = await server.app.inject({
      method: "POST", url: "/api/v1/connectors", headers,
      payload: { provider: "github", slug: "work" },
    });
    assert.equal(created.statusCode, 201);
    {
      const body = created.json<{ created: boolean; connection: { slug: string; status: string } }>();
      assert.equal(body.created, true);
      assert.equal(body.connection.slug, "work");
      assert.equal(body.connection.status, "connected");
    }

    // Local stdio connectors carry their command and args through the same route.
    const local = await server.app.inject({
      method: "POST", url: "/api/v1/connectors", headers,
      payload: { provider: "mcp_stdio", slug: "local", command: "node", args: ["server.js"] },
    });
    assert.equal(local.statusCode, 201);
    assert.ok(calls.includes("create:mcp_stdio:local:node"));

    const listed = await server.app.inject({ method: "GET", url: "/api/v1/connectors", headers });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json<{ connections: { slug: string }[] }>().connections[0]?.slug, "work");
    assert.equal(listed.json<{ providers: { provider: string }[] }>().providers[0]?.provider, "github");

    const started = await server.app.inject({
      method: "POST", url: "/api/v1/connectors/work/oauth/start", headers,
    });
    assert.equal(started.statusCode, 200);
    assert.match(started.json<{ url: string }>().url, /^https:\/\/github\.com\/login\/oauth\/authorize/);

    // The provider redirects a browser without our Bearer token; a valid one-time state is enough.
    const callback = await server.app.inject({
      method: "GET", url: "/api/v1/connectors/oauth/callback?state=good-state&code=code-1",
    });
    assert.equal(callback.statusCode, 200);
    assert.match(callback.headers["content-type"] ?? "", /text\/html/);
    assert.match(callback.body, /授权成功/);

    const replay = await server.app.inject({
      method: "GET", url: "/api/v1/connectors/oauth/callback?state=bad-state&code=code-1",
    });
    assert.equal(replay.statusCode, 400);
    assert.match(replay.body, /CONNECTOR_OAUTH_STATE_INVALID/);
    const denied = await server.app.inject({
      method: "GET", url: "/api/v1/connectors/oauth/callback?error=access_denied&state=good-state",
    });
    assert.equal(denied.statusCode, 400);
    assert.deepEqual(calls, [
      "create:github:work:undefined",
      "create:mcp_stdio:local:node",
      "list",
      "start:work",
      "complete:good-state:code-1",
      "complete:bad-state:code-1",
    ]);
  } finally {
    await server.close();
  }
});

test("connector routes report disabled when the feature is off", async () => {
  const server = await startServer();
  try {
    const { token } = (await server.login()).json<{ token: string }>();
    const response = await server.app.inject({
      method: "GET", url: "/api/v1/connectors", headers: server.auth(token),
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json<{ error: { code: string } }>().error.code, "CONNECTORS_DISABLED");
  } finally {
    await server.close();
  }
});

test("CORS accepts the SSE Cache-Control header from Web, Tauri and Capacitor origins", async () => {
  const server = await startServer();
  try {
    for (const origin of ["http://localhost:5173", "https://localhost"]) {
      const preflight = await server.app.inject({
        method: "OPTIONS",
        url: "/api/v1/events",
        headers: {
          origin,
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization,cache-control",
        },
      });
      assert.equal(preflight.statusCode, 204, origin);
      assert.equal(preflight.headers["access-control-allow-origin"], origin);
      assert.match(String(preflight.headers["access-control-allow-headers"]), /cache-control/i);
    }
    const other = await server.app.inject({
      method: "OPTIONS",
      url: "/api/v1/events",
      headers: {
        origin: "https://not-allowed.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,cache-control",
      },
    });
    assert.equal(other.headers["access-control-allow-origin"], undefined);
  } finally {
    await server.close();
  }
});

test("text over 32000 characters is TEXT_TOO_LONG, not a generic 400 or 413", async () => {
  const server = await startServer();
  try {
    const { token } = (await server.login()).json<{ token: string }>();
    const atLimit = await server.app.inject({
      method: "POST", url: "/api/v1/messages", headers: server.auth(token),
      payload: { clientMessageId: "limit-ok", text: "a".repeat(32_000) },
    });
    assert.equal(atLimit.statusCode, 202);

    // Chinese text above the character limit is ~96 KiB of UTF-8: it must still reach the route,
    // so the error is the contract's TEXT_TOO_LONG rather than a transport-level 413.
    const tooLong = await server.app.inject({
      method: "POST", url: "/api/v1/messages", headers: server.auth(token),
      payload: { clientMessageId: "limit-over", text: "字".repeat(32_001) },
    });
    assert.equal(tooLong.statusCode, 400);
    const body = tooLong.json<{ error: { code: string; message: string } }>();
    assert.equal(body.error.code, "TEXT_TOO_LONG");
    assert.match(body.error.message, /32000/);
  } finally {
    await server.close();
  }
});

test("login is rate limited per IP", async () => {
  const server = await startServer();
  try {
    let last: Awaited<ReturnType<typeof server.login>> | undefined;
    for (let attempt = 0; attempt < 6; attempt++) last = await server.login("wrong");
    assert.equal(last?.statusCode, 429);
    assert.equal(last?.json<{ error: { code: string } }>().error.code, "RATE_LIMITED");
  } finally {
    await server.close();
  }
});

test("SSE opens with a snapshot and streams queued/running/done for a new message", async () => {
  const server = await startServer({ withSse: true });
  const controller = new AbortController();
  try {
    const login = await server.login();
    const { token } = login.json<{ token: string }>();
    const response = await fetch(`${server.url}/api/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const events: string[] = [];
    let buffer = "";
    const readEvents = async (until: (events: string[]) => boolean): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!until(events)) {
        if (Date.now() > deadline) throw new Error(`timed out; saw ${events.join(",")}`);
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf("\n\n");
        while (split >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const name = /^event: (.+)$/m.exec(frame)?.[1];
          if (name !== undefined) events.push(name);
          split = buffer.indexOf("\n\n");
        }
      }
    };
    await readEvents((seen) => seen.includes("snapshot"));

    const posted = await server.app.inject({
      method: "POST", url: "/api/v1/messages", headers: server.auth(token),
      payload: { clientMessageId: "sse-client", text: "stream me" },
    });
    assert.equal(posted.statusCode, 202);
    await readEvents((seen) => seen.includes("request.done"));
    for (const expected of ["request.queued", "request.running", "request.done"]) {
      assert.ok(events.includes(expected), `missing ${expected}; saw ${events.join(",")}`);
    }
  } finally {
    controller.abort();
    await server.close();
  }
});

test("hijacked SSE keeps CORS: allowed shell origin echoes ACAO, others do not", async () => {
  const server = await startServer();
  try {
    const { token } = (await server.login()).json<{ token: string }>();
    const open = (origin?: string) => fetch(`${server.url}/api/v1/events`, {
      headers: {
        authorization: `Bearer ${token}`,
        ...(origin === undefined ? {} : { origin }),
      },
    });

    const allowed = await open("tauri://localhost");
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "tauri://localhost");
    assert.match(allowed.headers.get("vary") ?? "", /\bOrigin\b/i);
    await allowed.body?.cancel();

    const denied = await open("https://not-allowed.example");
    assert.equal(denied.status, 200);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    assert.match(denied.headers.get("vary") ?? "", /\bOrigin\b/i);
    await denied.body?.cancel();

    const sameOrigin = await open();
    assert.equal(sameOrigin.headers.get("access-control-allow-origin"), null);
    await sameOrigin.body?.cancel();
  } finally {
    await server.close();
  }
});

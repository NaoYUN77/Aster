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
import { fakeAgent, fixtureSelection, message, steerHandle, waitFor } from "./http-testkit.js";

const PASSWORD = "integration-password";

async function startServer(options: {
  withSse?: boolean;
  connectors?: ConnectorService;
  reply?: (request: { requestId: string; text: string }, signal: AbortSignal) => Promise<string>;
  steer?: (request: { requestId: string; text: string }) => Promise<{
    steerId: string;
    done: Promise<import("../src/http/projection.js").UiMessage | undefined>;
    submission: {
      status(): Promise<"queued" | "placed" | "done" | "unanswered">;
      abort(): Promise<"aborted" | "already_placed" | "settled">;
    };
  }>;
} = {}) {
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
    reply: options.reply ?? (async (request) => `reply:${request.text}`),
    ...(options.steer === undefined ? {} : { steer: options.steer }),
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
  let returnUrlTarget: string | undefined;
  const connectors = {
    get oauthReturnUrl() {
      return returnUrlTarget;
    },
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
    disconnect(slug: string) {
      calls.push(`disconnect:${slug}`);
      if (slug === "missing") throw new ConnectorError("CONNECTOR_NOT_FOUND", "connector was not found");
    },
    async startOAuth(slug: string) {
      calls.push(`start:${slug}`);
      if (slug === "unconfigured") {
        throw new ConnectorError("CONNECTOR_NOT_CONFIGURED", "connector secret is not configured on the broker: google_client_secret");
      }
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

    // A secret the broker says is not configured is a 409 the client can explain, not a 500.
    const unconfigured = await server.app.inject({
      method: "POST", url: "/api/v1/connectors/unconfigured/oauth/start", headers,
    });
    assert.equal(unconfigured.statusCode, 409);
    const unconfiguredBody = unconfigured.json<{ error: { code: string; message: string } }>();
    assert.equal(unconfiguredBody.error.code, "CONNECTOR_NOT_CONFIGURED");
    assert.match(unconfiguredBody.error.message, /google_client_secret/);

    // The provider redirects a browser without our Bearer token; a valid one-time state is enough.
    const callback = await server.app.inject({
      method: "GET", url: "/api/v1/connectors/oauth/callback?state=good-state&code=code-1",
    });
    assert.equal(callback.statusCode, 200);
    assert.match(callback.headers["content-type"] ?? "", /text\/html/);
    assert.match(callback.body, /授权成功/);
    // No CONNECTOR_OAUTH_RETURN_URL: the page stays in the browser.
    assert.equal(callback.body.includes("http-equiv=\"refresh\""), false);

    returnUrlTarget = "aster://oauth/done";
    const redirected = await server.app.inject({
      method: "GET", url: "/api/v1/connectors/oauth/callback?state=good-state&code=code-1",
    });
    assert.equal(redirected.statusCode, 200);
    assert.match(redirected.body, /http-equiv="refresh" content="0;url=aster:\/\/oauth\/done\?slug=work&amp;status=connected"/);
    assert.match(redirected.body, />返回 Aster</);
    // The return URL and the page carry only the slug and status, never a token.
    assert.equal(redirected.body.includes("access_token"), false);
    assert.equal(redirected.body.includes("refresh_token"), false);
    returnUrlTarget = undefined;

    const replay = await server.app.inject({
      method: "GET", url: "/api/v1/connectors/oauth/callback?state=bad-state&code=code-1",
    });
    assert.equal(replay.statusCode, 400);
    assert.match(replay.body, /CONNECTOR_OAUTH_STATE_INVALID/);
    const denied = await server.app.inject({
      method: "GET", url: "/api/v1/connectors/oauth/callback?error=access_denied&state=good-state",
    });
    assert.equal(denied.statusCode, 400);

    const disconnected = await server.app.inject({
      method: "DELETE", url: "/api/v1/connectors/work", headers,
    });
    assert.equal(disconnected.statusCode, 204);
    assert.equal(disconnected.body, "");

    const missing = await server.app.inject({
      method: "DELETE", url: "/api/v1/connectors/missing", headers,
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json<{ error: { code: string } }>().error.code, "CONNECTOR_NOT_FOUND");

    const preflight = await server.app.inject({
      method: "OPTIONS", url: "/api/v1/connectors/work",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "DELETE" },
    });
    assert.equal(preflight.statusCode, 204);
    assert.match(preflight.headers["access-control-allow-methods"] ?? "", /DELETE/);

    assert.deepEqual(calls, [
      "create:github:work:undefined",
      "create:mcp_stdio:local:node",
      "list",
      "start:work",
      "start:unconfigured",
      "complete:good-state:code-1",
      "complete:good-state:code-1",
      "complete:bad-state:code-1",
      "disconnect:work",
      "disconnect:missing",
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

    const disconnect = await server.app.inject({
      method: "DELETE", url: "/api/v1/connectors/work", headers: server.auth(token),
    });
    assert.equal(disconnect.statusCode, 503);
    assert.equal(disconnect.json<{ error: { code: string } }>().error.code, "CONNECTORS_DISABLED");
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

test("steer route: 202 while running, 409 for idle or a stale path, 400 for invalid bodies", async () => {
  const gate = Promise.withResolvers<void>();
  let running = false;
  const server = await startServer({
    reply: async () => {
      running = true;
      await gate.promise;
      running = false;
      return "original answer";
    },
    steer: async (request) => {
      if (!running) throw Object.assign(new Error("idle"), { code: "NO_ACTIVE_REQUEST" });
      return steerHandle(request.requestId, Promise.resolve(message({ id: "77", text: "steer answer" })));
    },
  });
  try {
    const { token } = (await server.login()).json<{ token: string }>();
    const headers = server.auth(token);
    const steer = (requestId: string, payload: object): Promise<import("light-my-request").Response> =>
      server.app.inject({
        method: "POST", url: `/api/v1/requests/${requestId}/steer`, headers, payload,
      }) as Promise<import("light-my-request").Response>;

    const idle = await steer("request-any", { clientMessageId: "steer-1", text: "too early" });
    assert.equal(idle.statusCode, 409);
    assert.equal(idle.json<{ error: { code: string } }>().error.code, "NO_ACTIVE_REQUEST");

    const { row } = server.store.enqueue("client-original", "original question");
    server.worker.notify();
    await waitFor(() => server.store.get(row.request_id)?.status === "running");

    const accepted = await steer(row.request_id, { clientMessageId: "steer-1", text: "look again" });
    assert.equal(accepted.statusCode, 202);
    assert.deepEqual(accepted.json(), {
      steerId: "steer:steer-1",
      requestId: row.request_id,
      status: "accepted",
    });

    const stale = await steer("request-other", { clientMessageId: "steer-2", text: "wrong request" });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json<{ error: { code: string } }>().error.code, "REQUEST_NOT_ACTIVE");

    const tooLong = await steer(row.request_id, { clientMessageId: "steer-3", text: "x".repeat(32_001) });
    assert.equal(tooLong.statusCode, 400);
    assert.equal(tooLong.json<{ error: { code: string } }>().error.code, "TEXT_TOO_LONG");

    const invalid = await steer(row.request_id, { clientMessageId: "", text: "hi" });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json<{ error: { code: string } }>().error.code, "INVALID_REQUEST");

    gate.resolve();
    await waitFor(() => server.store.get(row.request_id)?.status === "done");
    const late = await steer(row.request_id, { clientMessageId: "steer-4", text: "too late" });
    assert.equal(late.statusCode, 409);
    assert.equal(late.json<{ error: { code: string } }>().error.code, "NO_ACTIVE_REQUEST");
  } finally {
    await server.close();
  }
});

test("GET /queue lists only queued rows in claim order and is owner-authenticated", async () => {
  const gate = Promise.withResolvers<void>();
  const server = await startServer({
    reply: async () => {
      await gate.promise;
      return "gated answer";
    },
  });
  try {
    assert.equal((await server.app.inject({ method: "GET", url: "/api/v1/queue" })).statusCode, 401);

    const { token } = (await server.login()).json<{ token: string }>();
    const headers = server.auth(token);
    const submit = async (clientMessageId: string, text: string) => server.app.inject({
      method: "POST", url: "/api/v1/messages", headers, payload: { clientMessageId, text },
    });

    const first = await submit("queue-first", "first");
    assert.equal(first.statusCode, 202);
    const firstId = first.json<{ requestId: string }>().requestId;
    await waitFor(() => server.store.get(firstId)?.status === "running");

    const second = await submit("queue-second", "second");
    const secondId = second.json<{ requestId: string }>().requestId;
    const third = await submit("queue-third", "third");
    const thirdId = third.json<{ requestId: string }>().requestId;

    const queue = await server.app.inject({ method: "GET", url: "/api/v1/queue", headers });
    assert.equal(queue.statusCode, 200);
    assert.deepEqual(queue.json(), {
      items: [
        {
          requestId: secondId,
          clientMessageId: "queue-second",
          text: "second",
          createdAt: server.store.get(secondId)!.created_at,
        },
        {
          requestId: thirdId,
          clientMessageId: "queue-third",
          text: "third",
          createdAt: server.store.get(thirdId)!.created_at,
        },
      ],
    });

    // An idempotent submission replay reports the queued status but adds no second row.
    const replay = await submit("queue-second", "second");
    assert.equal(replay.statusCode, 202);
    assert.deepEqual(replay.json(), { requestId: secondId, status: "queued" });
    assert.equal((await server.app.inject({ method: "GET", url: "/api/v1/queue", headers }))
      .json<{ items: unknown[] }>().items.length, 2);

    gate.resolve();
    await waitFor(() => server.store.get(thirdId)?.status === "done");
  } finally {
    await server.close();
  }
});

test("promote route steers while running, validates the path and rejects rows out of the queue", async () => {
  const gate = Promise.withResolvers<void>();
  let runningId: string | undefined;
  const steerCalls: string[] = [];
  const server = await startServer({
    reply: async (request) => {
      runningId = request.requestId;
      await gate.promise;
      runningId = undefined;
      return "original answer";
    },
    steer: async (request) => {
      steerCalls.push(request.requestId);
      if (runningId === undefined) throw Object.assign(new Error("idle"), { code: "NO_ACTIVE_REQUEST" });
      return steerHandle(request.requestId, new Promise(() => {}));
    },
  });
  try {
    const { token } = (await server.login()).json<{ token: string }>();
    const headers = server.auth(token);
    const promote = (requestId: string): Promise<import("light-my-request").Response> =>
      server.app.inject({
        method: "POST", url: `/api/v1/requests/${requestId}/promote`, headers,
      }) as Promise<import("light-my-request").Response>;

    const malformed = await promote("not-a-request-id");
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json<{ error: { code: string } }>().error.code, "INVALID_REQUEST");

    const original = server.store.enqueue("client-original", "original question");
    server.worker.notify();
    await waitFor(() => server.store.get(original.row.request_id)?.status === "running");

    const queued = server.store.enqueue("client-promote", "promote this");
    assert.equal(server.store.listQueued().length, 1);

    const promoted = await promote(queued.row.request_id);
    assert.equal(promoted.statusCode, 202);
    assert.deepEqual(promoted.json(), {
      requestId: queued.row.request_id,
      mode: "steered",
      steerId: "steer:client-promote",
    });
    assert.equal(server.store.get(queued.row.request_id)?.status, "promoted");
    assert.deepEqual(server.store.listQueued(), []);

    const replay = await promote(queued.row.request_id);
    assert.equal(replay.statusCode, 202);
    assert.deepEqual(replay.json(), {
      requestId: queued.row.request_id,
      mode: "steered",
      steerId: "steer:client-promote",
    });
    assert.equal(steerCalls.length, 1);

    const running = await promote(original.row.request_id);
    assert.equal(running.statusCode, 409);
    assert.deepEqual(running.json(), {
      error: {
        code: "QUEUE_ITEM_NOT_QUEUED",
        message: "消息已不在队列中，请刷新队列",
        requestStatus: "running",
      },
    });

    const missing = await promote("req_AAAAAAAAAAAAAAAA");
    assert.equal(missing.statusCode, 409);
    assert.equal(missing.json<{ error: { code: string } }>().error.code, "QUEUE_ITEM_NOT_QUEUED");
    assert.equal(missing.json<{ error: { requestStatus: string | null } }>().error.requestStatus, null);

    const aborted = server.store.enqueue("client-aborted", "aborted");
    server.store.markAborted(aborted.row.request_id);
    const abortedReply = await promote(aborted.row.request_id);
    assert.equal(abortedReply.statusCode, 409);
    assert.equal(abortedReply.json<{ error: { requestStatus: string | null } }>().error.requestStatus, "aborted");

    gate.resolve();
    await waitFor(() => server.store.get(original.row.request_id)?.status === "done");

    const finished = await promote(original.row.request_id);
    assert.equal(finished.statusCode, 409);
    assert.equal(finished.json<{ error: { requestStatus: string | null } }>().error.requestStatus, "done");
  } finally {
    await server.close();
  }
});

test("promote route starts a queued message immediately when the worker is idle", async () => {
  const server = await startServer();
  try {
    const { token } = (await server.login()).json<{ token: string }>();
    const headers = server.auth(token);
    // Stop the loop so the row stays queued until promote claims it explicitly.
    await server.worker.stop();

    const older = server.store.enqueue("client-older", "older");
    const target = server.store.enqueue("client-target", "start now");
    assert.equal(server.store.listQueued().length, 2);

    const promoted = await server.app.inject({
      method: "POST", url: `/api/v1/requests/${target.row.request_id}/promote`, headers,
    });
    assert.equal(promoted.statusCode, 202);
    assert.deepEqual(promoted.json(), { requestId: target.row.request_id, mode: "started" });
    assert.equal(server.store.get(older.row.request_id)?.status, "queued");
    await waitFor(() => server.store.get(target.row.request_id)?.status === "done");
    assert.deepEqual(
      server.store.listQueued().map((item) => item.clientMessageId),
      ["client-older"],
    );
  } finally {
    await server.close();
  }
});

test("SSE snapshot and queue.changed keep the pending queue in sync across enqueue, claim, promote and abort", async () => {
  const gate = Promise.withResolvers<void>();
  const steerDone = new Promise<import("../src/http/projection.js").UiMessage | undefined>(() => {});
  const server = await startServer({
    reply: async (request) => {
      serverRef.runningId = request.requestId;
      await gate.promise;
      serverRef.runningId = undefined;
      return "answer";
    },
    steer: async (request) => steerHandle(request.requestId, steerDone),
  });
  const serverRef = { runningId: undefined as string | undefined };
  const controller = new AbortController();
  try {
    const { token } = (await server.login()).json<{ token: string }>();
    const headers = server.auth(token);
    const response = await fetch(`${server.url}/api/v1/events`, {
      headers, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const frames: { event: string; data: Record<string, unknown> }[] = [];
    let buffer = "";
    const readUntil = async (predicate: () => boolean): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out; saw ${frames.map((frame) => frame.event).join(",")}`);
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf("\n\n");
        while (split >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (event !== undefined && data !== undefined) {
            frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
          }
          split = buffer.indexOf("\n\n");
        }
      }
    };
    const queueItems = (): { clientMessageId: string }[] => {
      const changed = frames.filter((frame) => frame.event === "queue.changed").at(-1);
      return (changed?.data.items as { clientMessageId: string }[] | undefined) ?? [];
    };

    await readUntil(() => frames.some((frame) => frame.event === "snapshot"));
    assert.deepEqual(frames.find((frame) => frame.event === "snapshot")?.data.queue, []);

    const submit = (clientMessageId: string, text: string) => server.app.inject({
      method: "POST", url: "/api/v1/messages", headers, payload: { clientMessageId, text },
    });

    const first = await submit("sse-first", "first");
    const firstId = first.json<{ requestId: string }>().requestId;
    await readUntil(() => frames.some((frame) => frame.event === "request.running"));
    assert.ok(frames.some((frame) => frame.event === "queue.changed"
      && (frame.data.items as { clientMessageId: string }[]).some((item) => item.clientMessageId === "sse-first")));
    await readUntil(() => queueItems().length === 0);

    const second = await submit("sse-second", "second");
    const secondId = second.json<{ requestId: string }>().requestId;
    await readUntil(() => queueItems().some((item) => item.clientMessageId === "sse-second"));

    const promoted = await server.app.inject({
      method: "POST", url: `/api/v1/requests/${secondId}/promote`, headers,
    });
    assert.equal(promoted.statusCode, 202);
    assert.deepEqual(promoted.json(), { requestId: secondId, mode: "steered", steerId: "steer:sse-second" });
    await readUntil(() => frames.some((frame) => frame.event === "request.steered"));
    await readUntil(() => queueItems().length === 0);
    assert.equal(server.store.get(secondId)?.status, "promoted");

    const third = await submit("sse-third", "third");
    const thirdId = third.json<{ requestId: string }>().requestId;
    await readUntil(() => queueItems().some((item) => item.clientMessageId === "sse-third"));
    const aborted = await server.app.inject({
      method: "POST", url: `/api/v1/requests/${thirdId}/abort`, headers,
    });
    assert.equal(aborted.statusCode, 200);
    await readUntil(() => queueItems().length === 0);
    assert.equal(server.store.get(thirdId)?.status, "aborted");
    assert.equal(firstId, serverRef.runningId);

    gate.resolve();
    await readUntil(() => frames.some((frame) => frame.event === "request.done"));
  } finally {
    controller.abort();
    await server.close();
  }
});

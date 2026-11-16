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
import { fakeAgent, fixtureSelection, message, waitFor } from "./http-testkit.js";

const PASSWORD = "integration-password";

async function startServer(options: { withSse?: boolean } = {}) {
  const fixture = await fixtureSelection();
  const directory = await mkdtemp(join(tmpdir(), "aster-http-server-"));
  const store = new WebRequestStore(join(directory, "web.sqlite"));
  const sessions = new SessionStore(store.database, 60 * 60 * 1000);
  const hub = new EventHub(() => {});
  const config: WebConfig = {
    port: 0,
    host: "127.0.0.1",
    allowedOrigins: ["http://localhost:5173"],
    sessionTtlDays: 30,
    staticDir: join(directory, "web-dist"),
    trustProxy: false,
  };
  const agent = fakeAgent({
    service: fixture.service,
    reply: async (request) => `reply:${request.text}`,
    history: async () => ({
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
    }),
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

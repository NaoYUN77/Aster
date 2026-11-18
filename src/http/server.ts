import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { WebConfig } from "../config.js";
import { ModelSelectionError, type ModelSelectionService } from "../model-control.js";
import { ConnectorError, connectorCode, safeConnectorMessage } from "../connectors/errors.js";
import type { ConnectorService } from "../connectors/service.js";
import { verifyPassword, type PasswordRecord, type SessionStore } from "./auth.js";
import type { EventHub } from "./events.js";
import type { WebRequestStore } from "./store.js";
import type { RequestWorker, WebAgent } from "./worker.js";

/**
 * Fastify composition for the web adapter.
 *
 * The adapter is one owner and one conversation: it exposes auth, message submission/history,
 * abort, the model catalog and an SSE stream. It never reaches into durable storage directly; the
 * agent offers `reply()` and the read-only `history()`.
 */

export type WebServerOptions = {
  readonly config: WebConfig;
  readonly ownerId: string;
  readonly version: string;
  readonly auth: PasswordRecord;
  readonly sessions: SessionStore;
  readonly store: WebRequestStore;
  readonly hub: EventHub;
  readonly worker: RequestWorker;
  readonly agent: WebAgent;
  readonly modelService: ModelSelectionService;
  readonly modelVersion: () => number;
  readonly connectors?: ConnectorService;
  readonly log?: (line: string) => void;
};

export type ErrorBody = { readonly error: { readonly code: string; readonly message: string } };

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

/**
 * CORS headers for a hijacked response. `reply.hijack()` hands the socket to the route, so
 * `@fastify/cors` never sees the response and cannot add `Access-Control-Allow-Origin`. Echo the
 * request origin only when the same `WEB_ALLOWED_ORIGINS` allowlist accepts it.
 */
function hijackCorsHeaders(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): Record<string, string> {
  const headers: Record<string, string> = { Vary: "Origin" };
  if (origin !== undefined && origin !== "" && allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}

function connectorStatus(code: string): number {
  if (code === "CONNECTOR_NOT_FOUND") return 404;
  if (code === "CONNECTOR_INVALID_PROVIDER" || code === "CONNECTOR_INVALID_SLUG"
    || code === "CONNECTOR_INVALID_INPUT" || code === "CONNECTOR_OAUTH_STATE_INVALID") return 400;
  if (code === "CONNECTOR_ALREADY_EXISTS" || code === "CONNECTOR_NOT_CONNECTED"
    || code === "CONNECTOR_OAUTH_DISABLED" || code === "CONNECTOR_NOT_CONFIGURED"
    || code === "CONNECTOR_SECRET_MISSING" || code === "CONNECTOR_SECRET_UNREADABLE"
    || code === "CONNECTOR_MASTER_KEY_INVALID") return 409;
  if (code.startsWith("CONNECTOR_UPSTREAM_") || code === "CONNECTOR_RATE_LIMITED"
    || code === "CONNECTOR_SCOPE_DENIED" || code === "CONNECTOR_AUTH_EXPIRED"
    || code === "CONNECTOR_OAUTH_EXCHANGE_FAILED") return 502;
  return 500;
}

function connectorReply(error: unknown, reply: FastifyReply) {
  const code = connectorCode(error);
  const message = error instanceof ConnectorError ? error.message : safeConnectorMessage(code);
  return reply.code(connectorStatus(code)).send(errorBody(code, message));
}

function htmlPage(title: string, detail: string): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escape(title)}</title><body style="font-family:system-ui,sans-serif;padding:2rem;line-height:1.6">`
    + `<h1>${escape(title)}</h1><p>${escape(detail)}</p></body></html>`;
}

function readLimit(raw: unknown): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) return undefined;
  return value;
}

export async function createWebServer(options: WebServerOptions): Promise<FastifyInstance> {
  const log = options.log ?? ((line: string) => console.error(line));
  const { config, agent, sessions, store, hub, worker, modelService } = options;
  const app = Fastify({
    logger: false,
    // Large enough that an over-limit text still reaches the route and gets TEXT_TOO_LONG
    // instead of a transport-level 413; genuinely huge bodies are still refused.
    bodyLimit: 1024 * 1024,
    trustProxy: config.trustProxy,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });
  await app.register(cors, {
    origin(origin, callback) {
      // Same-origin requests (and non-browser clients) send no Origin header and need no CORS.
      if (origin === undefined || origin === "") return callback(null, true);
      callback(null, config.allowedOrigins.includes(origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Cache-Control"],
    maxAge: 600,
  });
  // The route config enables the limiter; the shared error handler turns its 429 into the API's
  // own `{ error: { code, message } }` envelope.
  await app.register(rateLimit, { global: false });

  app.addHook("preHandler", async (request, reply) => {
    if (request.method === "OPTIONS") return;
    const path = request.url.split("?", 1)[0] ?? "";
    if (!path.startsWith("/api/v1/")) return;
    if (path === "/api/v1/health" || path === "/api/v1/auth/login") return;
    // The OAuth provider redirects the browser here without our Bearer token; the one-time state
    // row is the capability that protects the exchange.
    if (path === "/api/v1/connectors/oauth/callback") return;
    const token = bearerToken(request);
    const session = token === "" ? undefined : sessions.verify(token);
    if (session === undefined) {
      await reply.code(401).send(errorBody("UNAUTHORIZED", "未登录或登录已过期"));
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    const typed = error as { statusCode?: number; code?: unknown; validation?: unknown };
    const status = typed.statusCode ?? 500;
    const code = typed.code;
    if (status === 429 || code === "FST_ERR_RATE_LIMIT") {
      return reply.code(429).send(errorBody("RATE_LIMITED", "尝试过于频繁，请稍后再试"));
    }
    if (status === 413) return reply.code(413).send(errorBody("PAYLOAD_TOO_LARGE", "请求体过大"));
    if (typed.validation !== undefined || status === 400) {
      return reply.code(400).send(errorBody("INVALID_REQUEST", "请求参数不合法"));
    }
    log(`HTTP ${status}: ${code === undefined ? "request failed" : String(code)}`);
    return reply.code(500).send(errorBody("INTERNAL_ERROR", "服务内部错误"));
  });

  // ---------------------------------------------------------------- health
  app.get("/api/v1/health", async () => ({ ok: true, version: options.version }));

  // ------------------------------------------------------------------ auth
  app.post("/api/v1/auth/login", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const body = request.body as { password?: unknown } | undefined;
    const password = body?.password;
    if (typeof password !== "string" || password === "" || password.length > 1_024) {
      return reply.code(400).send(errorBody("INVALID_REQUEST", "请求参数不合法"));
    }
    if (!verifyPassword(password, options.auth)) {
      return reply.code(401).send(errorBody("INVALID_CREDENTIALS", "密码错误"));
    }
    const issued = sessions.issue(typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined);
    return {
      token: issued.token,
      expiresAt: new Date(issued.expiresAt).toISOString(),
      ownerId: options.ownerId,
    };
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const token = bearerToken(request);
    if (token !== "") sessions.revoke(token);
    return reply.code(204).send();
  });

  app.get("/api/v1/auth/me", async (request, reply) => {
    const session = sessions.verify(bearerToken(request));
    if (session === undefined) return reply.code(401).send(errorBody("UNAUTHORIZED", "未登录或登录已过期"));
    return { ownerId: options.ownerId, expiresAt: new Date(session.expiresAt).toISOString() };
  });

  // -------------------------------------------------------------- messages
  app.post("/api/v1/messages", async (request, reply) => {
    const body = request.body as { clientMessageId?: unknown; text?: unknown } | undefined;
    const clientMessageId = body?.clientMessageId;
    const text = body?.text;
    if (typeof clientMessageId !== "string" || clientMessageId.length < 1 || clientMessageId.length > 200) {
      return reply.code(400).send(errorBody("INVALID_REQUEST", "请求参数不合法"));
    }
    if (typeof text !== "string" || text.trim() === "") {
      return reply.code(400).send(errorBody("INVALID_REQUEST", "请求参数不合法"));
    }
    if (text.length > 32_000) {
      return reply.code(400).send(errorBody("TEXT_TOO_LONG", "消息过长，最多 32000 个字符"));
    }
    const { row, created } = store.enqueue(clientMessageId, text);
    if (created) {
      hub.broadcast("request.queued", { requestId: row.request_id, clientMessageId });
      worker.notify();
    }
    return reply.code(202).send({ requestId: row.request_id, status: row.status });
  });

  app.get("/api/v1/messages", async (request, reply) => {
    const query = request.query as { before?: unknown; limit?: unknown };
    const limit = query.limit === undefined ? 30 : readLimit(query.limit);
    if (limit === undefined) return reply.code(400).send(errorBody("INVALID_REQUEST", "请求参数不合法"));
    let before: string | undefined;
    if (query.before !== undefined) {
      if (typeof query.before !== "string" || !/^[1-9]\d*$/.test(query.before)) {
        return reply.code(400).send(errorBody("INVALID_REQUEST", "请求参数不合法"));
      }
      before = query.before;
    }
    try {
      const page = await agent.history({ ...(before === undefined ? {} : { before }), limit });
      return {
        ...page,
        messages: page.messages.map((message) => message.requestId === null
          ? message
          : { ...message, clientMessageId: store.clientMessageId(message.requestId) ?? null }),
      };
    } catch (error) {
      if ((error as { code?: unknown }).code === "INVALID_REQUEST") {
        return reply.code(400).send(errorBody("INVALID_REQUEST", "请求参数不合法"));
      }
      throw error;
    }
  });

  app.post("/api/v1/requests/:requestId/abort", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const result = worker.abort(requestId);
    if (!result.ok) {
      return result.reason === "not_found"
        ? reply.code(404).send(errorBody("REQUEST_NOT_FOUND", "没有找到该请求"))
        : reply.code(409).send(errorBody("REQUEST_NOT_ACTIVE", "请求已结束"));
    }
    return { requestId, status: "aborted" };
  });

  // ---------------------------------------------------------------- models
  app.get("/api/v1/models", async () => modelService.catalog());

  app.post("/api/v1/models/select", async (request, reply) => {
    const body = request.body as { action?: unknown; modelId?: unknown } | undefined;
    const action = body?.action;
    if (action !== "select" && action !== "primary") {
      return reply.code(400).send(errorBody("INVALID_REQUEST", "请求参数不合法"));
    }
    try {
      if (action === "select") {
        if (typeof body?.modelId !== "string" || body.modelId === "") {
          return reply.code(400).send(errorBody("INVALID_REQUEST", "请求参数不合法"));
        }
        modelService.select(body.modelId);
      } else {
        modelService.primary();
      }
    } catch (error) {
      if (error instanceof ModelSelectionError) {
        const mapping: Record<typeof error.code, readonly [number, string]> = {
          MODEL_NOT_FOUND: [404, "没有找到该模型"],
          MODEL_OUT_OF_SCOPE: [422, "该模型不在可切换范围内"],
          MODEL_SWITCH_DISABLED: [409, "当前配置未启用模型切换"],
          SELECTION_WRITE_FAILED: [500, "模型选择保存失败"],
        };
        const [status, message] = mapping[error.code];
        return reply.code(status).send(errorBody(error.code, message));
      }
      throw error;
    }
    const running = store.active() !== undefined;
    return { ...modelService.catalog(), effective: running ? "next_request" : "immediate" };
  });

  // ------------------------------------------------------------- connectors
  const connectorView = (connection: {
    readonly id: string; readonly provider: string; readonly slug: string; readonly status: string;
    readonly accountLabel: string | null; readonly scopes: readonly string[];
    readonly createdAt: string; readonly updatedAt: string; readonly lastErrorCode: string | null;
  }) => ({
    id: connection.id,
    provider: connection.provider,
    slug: connection.slug,
    status: connection.status,
    accountLabel: connection.accountLabel,
    scopes: connection.scopes,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    lastErrorCode: connection.lastErrorCode,
  });

  app.get("/api/v1/connectors", async (_request, reply) => {
    if (options.connectors === undefined) {
      return reply.code(503).send(errorBody("CONNECTORS_DISABLED", "connectors are not enabled"));
    }
    const { definitions, connections } = options.connectors.list();
    return { providers: definitions, connections: connections.map(connectorView) };
  });

  app.post("/api/v1/connectors", async (request, reply) => {
    if (options.connectors === undefined) {
      return reply.code(503).send(errorBody("CONNECTORS_DISABLED", "connectors are not enabled"));
    }
    const body = request.body as { provider?: unknown; slug?: unknown; command?: unknown; args?: unknown } | undefined;
    try {
      const result = options.connectors.create({
        provider: body?.provider,
        slug: body?.slug,
        ...(body?.command === undefined ? {} : { command: body.command }),
        ...(body?.args === undefined ? {} : { args: body.args }),
      });
      return reply.code(result.created ? 201 : 200).send({
        connection: connectorView(result.connection),
        created: result.created,
      });
    } catch (error) {
      return connectorReply(error, reply);
    }
  });

  app.post("/api/v1/connectors/:slug/oauth/start", async (request, reply) => {
    if (options.connectors === undefined) {
      return reply.code(503).send(errorBody("CONNECTORS_DISABLED", "connectors are not enabled"));
    }
    const { slug } = request.params as { slug: string };
    try {
      return await options.connectors.startOAuth(slug);
    } catch (error) {
      return connectorReply(error, reply);
    }
  });

  // Public by necessity: the provider redirects the browser here. The state row is one-time and
  // owner-bound; a replayed or unknown state is refused without revealing which one it was.
  app.get("/api/v1/connectors/oauth/callback", async (request, reply) => {
    reply.type("text/html; charset=utf-8");
    if (options.connectors === undefined) {
      return reply.code(503).send(htmlPage("连接器未启用", "服务器未启用连接器功能。"));
    }
    const query = request.query as { code?: unknown; state?: unknown; error?: unknown };
    if (typeof query.error === "string" && query.error !== "") {
      return reply.code(400).send(htmlPage("授权未完成", "授权被取消或被服务方拒绝，请重新发起授权。"));
    }
    if (typeof query.code !== "string" || typeof query.state !== "string") {
      return reply.code(400).send(htmlPage("授权未完成", "缺少必要的授权参数，请重新发起授权。"));
    }
    try {
      const connection = await options.connectors.completeOAuth(query.state, query.code);
      return reply.send(htmlPage("授权成功", `${connection.provider} 连接已保存，可以关闭此页面并返回 Aster。`));
    } catch (error) {
      const code = connectorCode(error);
      log(`Connector callback failed (${code})`);
      const message = error instanceof ConnectorError ? error.message : safeConnectorMessage(code);
      return reply.code(connectorStatus(code) === 502 ? 502 : 400)
        .send(htmlPage("授权未完成", `${code}: ${message}`));
    }
  });

  // ------------------------------------------------------------------ SSE
  app.get("/api/v1/events", async (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      ...hijackCorsHeaders(request.headers.origin, config.allowedOrigins),
    });
    res.flushHeaders?.();
    const active = store.active();
    hub.add(res, [{
      event: "snapshot",
      data: {
        activeRequest: active === undefined ? null : {
          requestId: active.request_id,
          clientMessageId: active.client_message_id,
          status: "running",
          startedAt: active.started_at ?? active.created_at,
        },
        modelVersion: options.modelVersion(),
      },
    }]);
  });

  // --------------------------------------------------------------- static
  const staticRoot = resolve(config.staticDir);
  const hasStatic = existsSync(resolve(staticRoot, "index.html"));
  if (hasStatic) {
    await app.register(fastifyStatic, { root: staticRoot, prefix: "/" });
    log(`Static frontend: ${staticRoot}`);
  } else {
    log(`Static frontend not found at ${staticRoot}; API only. Run the web build to serve the UI.`);
  }

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?", 1)[0] ?? "";
    if (path.startsWith("/api/")) {
      return reply.code(404).send(errorBody("NOT_FOUND", "没有找到该接口"));
    }
    // SPA fallback: every non-API GET renders the one app.
    if (request.method === "GET" && hasStatic) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send(errorBody("NOT_FOUND", "没有找到该资源"));
  });

  return app;
}

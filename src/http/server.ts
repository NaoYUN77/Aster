import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { WebConfig } from "../config.js";
import { ModelSelectionError, type ModelSelectionService } from "../model-control.js";
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
  readonly log?: (line: string) => void;
};

export type ErrorBody = { readonly error: { readonly code: string; readonly message: string } };

function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}

function bearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
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
      return await agent.history({ ...(before === undefined ? {} : { before }), limit });
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

  // ------------------------------------------------------------------ SSE
  app.get("/api/v1/events", async (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
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

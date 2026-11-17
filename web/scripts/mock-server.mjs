#!/usr/bin/env node
/**
 * 本地 mock API 后端（仅用于桌面 / 手机壳层联调）。
 *
 * 浏览器里用 MSW（src/api/mock）；Tauri / Capacitor 的 WebView 没有
 * Service Worker，无法用 MSW，所以这里用同一份 mock 语义起一个真实 HTTP 端口，
 * 让壳层按正式流程“填服务器地址 → 测试连接 → 登录 → 聊天”。
 *
 * 不是生产后端，不读写业务数据，只监听 127.0.0.1。
 * 密码从 src/api/mock/fixtures.ts 读取，避免再复制一份。
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.MOCK_PORT ?? 8787);
const host = process.env.MOCK_HOST ?? "127.0.0.1";

const fixturesSource = readFileSync(resolve(root, "src/api/mock/fixtures.ts"), "utf8");
const MOCK_PASSWORD = /MOCK_PASSWORD\s*=\s*"([^"]+)"/.exec(fixturesSource)?.[1];
if (!MOCK_PASSWORD) throw new Error("无法从 fixtures.ts 读取 MOCK_PASSWORD");

const MODEL_PRIMARY = { provider: "mock", id: "mock/primary", name: "Mock Primary", label: "Mock Primary" };
const MODEL_FALLBACK = { provider: "mock", id: "mock/fallback", name: "Mock Fallback", label: "Mock Fallback" };
const SELECTABLE = [
  { provider: "mock", id: "mock/opencode-deepseek", name: "DeepSeek Mock", label: "DeepSeek Mock", supplier: "opencode", family: "deepseek", contextWindow: 128000 },
  { provider: "mock", id: "mock/opencode-glm", name: "GLM Mock", label: "GLM Mock", supplier: "opencode", family: "glm", contextWindow: 200000 },
  { provider: "mock", id: "mock/commandcode-deepseek-r1", name: "DeepSeek R1 Mock", label: "DeepSeek R1 Mock", supplier: "commandcode", family: "deepseek", contextWindow: 65536 },
  { provider: "mock", id: "mock/commandcode-glm", name: "GLM 4.5 Mock", label: "GLM 4.5 Mock", supplier: "commandcode", family: "glm", contextWindow: 131072 },
  { provider: "mock", id: "mock/commandcode-gemini-flash", name: "Gemini Flash Mock", label: "Gemini Flash Mock", supplier: "commandcode", family: "gemini-flash", contextWindow: 1000000 },
];
const UNSTABLE_ID = "mock/opencode-glm";

/** @type {{messages: any[], requests: any[], selection: {id: string, kind: "manual"|"auto"} | null, modelVersion: number, sessions: Map<string, {ownerId: string, expiresAt: number}>}} */
const state = { messages: [], requests: [], selection: null, modelVersion: 1, sessions: new Map() };
const timers = new Map();
const listeners = new Set();

let seq = 0;
const makeId = (prefix) => `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

const seed = [
  ["assistant", "晚上好。**本地 mock 服务**已启动，没有连接真实后端。\n\n可以试试：发消息、停止回复、滚动加载更早历史、打开模型选择器。"],
  ["user", "这个客户端支持哪些平台？"],
  ["assistant", "同一份 `web/` 代码打包成三种壳：Web、Tauri 桌面、Capacitor 手机。模型列表只来自 `/api/v1/models`。"],
  ["user", "模型可以切换吗？"],
  ["assistant", "可以，右上角打开模型选择器。切换后会提示“下一次回复生效”。"],
];
let seedTime = Date.now() - seed.length * 60000;
for (const [role, text] of seed) {
  state.messages.push({
    id: makeId("entry"), role, text, createdAt: (seedTime += 60000),
    status: "complete", requestId: null, model: role === "assistant" ? MODEL_PRIMARY : null,
    errorCode: null, tool: null,
  });
}

function emit(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) {
    try { res.write(payload); } catch { listeners.delete(res); }
  }
}

function modelsResponse() {
  const selected = state.selection ? SELECTABLE.find((m) => m.id === state.selection.id) : undefined;
  const current = selected
    ? { ...selected, kind: state.selection.kind }
    : { ...MODEL_PRIMARY, kind: "primary" };
  return {
    canSelect: true,
    current,
    primary: MODEL_PRIMARY,
    chain: [MODEL_PRIMARY, MODEL_FALLBACK],
    selectable: SELECTABLE,
    scope: { suppliers: ["opencode", "commandcode"], families: ["deepseek", "glm", "gemini-flash"], excludesSpeedVariants: true },
  };
}

function activeModelRef() {
  if (state.selection) {
    const selected = SELECTABLE.find((m) => m.id === state.selection.id);
    if (selected) return selected;
  }
  return MODEL_PRIMARY;
}

function activeRequest() {
  const request = [...state.requests].reverse().find((r) => r.status === "running" || r.status === "queued");
  return request
    ? { requestId: request.requestId, status: request.status, clientMessageId: request.clientMessageId }
    : null;
}

function finishRequest(request) {
  clearTimers(request.requestId);
  if (request.status !== "running" && request.status !== "queued") return;

  const requestedRef = activeModelRef();
  const requestedKind = state.selection?.kind ?? "primary";
  const degraded = state.selection?.id === UNSTABLE_ID;
  const actual = degraded ? MODEL_PRIMARY : requestedRef;
  const usage = {
    requested: { ...requestedRef, kind: requestedKind },
    actual,
    kind: requestedKind,
    degraded,
  };
  const reply = `收到（本地 mock）。你刚才说：「${request.text.slice(0, 120)}」。\n\n这条回复用于验证壳层的消息流、Markdown 渲染与模型角标。`;
  const message = {
    id: makeId("entry"), role: "assistant",
    text: degraded ? `（${requestedRef.label} 不可用，本次由 ${actual.label} 回答。）\n\n${reply}` : reply,
    createdAt: Date.now(), status: "complete", requestId: request.requestId,
    clientMessageId: request.clientMessageId,
    model: actual, errorCode: null, tool: null,
  };
  state.messages.push(message);
  request.status = "done";
  request.finishedAt = Date.now();
  emit("request.done", { requestId: request.requestId, message, model: usage });
}

function clearTimers(requestId) {
  timers.get(requestId)?.forEach(clearTimeout);
  timers.delete(requestId);
}

function sendMessage(clientMessageId, text) {
  if (text.length > 32000) return { error: "TEXT_TOO_LONG" };
  const requestId = makeId("req");
  const request = { requestId, clientMessageId, text, status: "queued", createdAt: Date.now() };
  state.requests.push(request);
  // 与服务端一致：`$model` 是命令，不产生 durable user entry。
  if (!text.trim().startsWith("$model")) {
    state.messages.push({
      id: makeId("entry"), role: "user", text, createdAt: Date.now(), status: "complete",
      requestId, clientMessageId, model: null, errorCode: null, tool: null,
    });
  }
  emit("request.queued", { requestId, clientMessageId });

  const started = setTimeout(() => {
    if (request.status !== "queued") return;
    request.status = "running";
    emit("request.running", { requestId });
  }, 650);
  const finished = setTimeout(() => finishRequest(request), 2600);
  timers.set(requestId, [started, finished]);
  return { requestId, status: "queued" };
}

function abortRequest(requestId) {
  const request = state.requests.find((r) => r.requestId === requestId);
  if (!request) return { status: 404, body: { error: { code: "REQUEST_NOT_FOUND", message: "请求不存在" } } };
  if (request.status !== "queued" && request.status !== "running")
    return { status: 409, body: { error: { code: "REQUEST_NOT_ACTIVE", message: "当前状态不能停止" } } };
  clearTimers(requestId);
  request.status = "aborted";
  // 与服务端一致：停止后不再追加空的 assistant 占位消息。
  emit("request.aborted", { requestId });
  return { status: 200, body: { requestId, status: "aborted" } };
}

function messagesPage(before, limit) {
  const sorted = [...state.messages].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  let end = sorted.length;
  if (before) {
    const index = sorted.findIndex((m) => m.id === before);
    end = index === -1 ? sorted.length : index;
  }
  const start = Math.max(0, end - limit);
  const page = sorted.slice(start, end);
  const hasMore = start > 0;
  return { messages: page, nextCursor: hasMore ? page[0]?.id ?? null : null, hasMore };
}

const ALLOWED_ORIGINS = new Set([
  "tauri://localhost", "http://tauri.localhost", "https://localhost",
  "capacitor://localhost", "http://localhost", "http://127.0.0.1:5173",
  "http://localhost:5173",
]);

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, cache-control, accept");
  res.setHeader("Access-Control-Max-Age", "600");
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function authorized(req) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = state.sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) { state.sessions.delete(token); return null; }
  return { token, ...session };
}

/** 与契约一致：错误统一包在 `{ error: { code, message } }` 里。 */
const fail = (res, status, code, message) => json(res, status, { error: { code, message } });
const unauthorized = (res, message = "登录已失效，请重新登录") =>
  fail(res, 401, "UNAUTHORIZED", message);

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

const server = createServer(async (req, res) => {
  if (process.env.MOCK_DEBUG === "1") {
    console.log(`[mock-server] ${req.method} ${req.url} origin=${req.headers.origin ?? "-"}`);
  }
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  const path = url.pathname.replace(/\/+$/, "");

  if (req.method === "GET" && path === "/api/v1/health") {
    json(res, 200, { ok: true, version: "mock-local-0.1.0" });
    return;
  }

  if (req.method === "POST" && path === "/api/v1/auth/login") {
    const body = await readBody(req);
    if (!body || typeof body.password !== "string" || body.password === "") {
      fail(res, 400, "INVALID_REQUEST", "请输入密码");
      return;
    }
    if (body.password !== MOCK_PASSWORD) { fail(res, 401, "INVALID_CREDENTIALS", "密码错误"); return; }
    const token = `mock_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const expiresAt = Date.now() + 7 * 24 * 3600 * 1000;
    state.sessions.set(token, { ownerId: "owner", expiresAt });
    json(res, 200, { token, ownerId: "owner", expiresAt: new Date(expiresAt).toISOString() });
    return;
  }

  if (req.method === "POST" && path === "/api/v1/auth/logout") {
    const auth = authorized(req);
    if (!auth) { unauthorized(res); return; }
    state.sessions.delete(auth.token);
    res.writeHead(204); res.end();
    return;
  }

  if (req.method === "GET" && path === "/api/v1/auth/me") {
    const auth = authorized(req);
    if (!auth) { unauthorized(res); return; }
    json(res, 200, { ownerId: auth.ownerId, expiresAt: new Date(auth.expiresAt).toISOString() });
    return;
  }

  if (req.method === "GET" && path === "/api/v1/messages") {
    if (!authorized(req)) { unauthorized(res); return; }
    const rawLimit = Number(url.searchParams.get("limit") ?? "30");
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 30;
    json(res, 200, messagesPage(url.searchParams.get("before"), limit));
    return;
  }

  if (req.method === "POST" && path === "/api/v1/messages") {
    if (!authorized(req)) { unauthorized(res); return; }
    const body = await readBody(req);
    if (!body || typeof body.clientMessageId !== "string" || body.clientMessageId.trim() === "" || typeof body.text !== "string") {
      fail(res, 400, "INVALID_REQUEST", "请求不合法");
      return;
    }
    const result = sendMessage(body.clientMessageId, body.text);
    if ("error" in result) {
      fail(res, 400, result.error, "消息过长，最多 32000 个字符");
      return;
    }
    json(res, 202, result);
    return;
  }

  const abortMatch = /^\/api\/v1\/requests\/([^/]+)\/abort$/.exec(path);
  if (req.method === "POST" && abortMatch) {
    if (!authorized(req)) { unauthorized(res); return; }
    const result = abortRequest(decodeURIComponent(abortMatch[1]));
    json(res, result.status, result.body);
    return;
  }

  if (req.method === "GET" && path === "/api/v1/models") {
    if (!authorized(req)) { unauthorized(res); return; }
    json(res, 200, modelsResponse());
    return;
  }

  if (req.method === "POST" && path === "/api/v1/models/select") {
    if (!authorized(req)) { unauthorized(res); return; }
    const body = await readBody(req);
    if (body?.action === "select") {
      if (typeof body.modelId !== "string") { fail(res, 400, "INVALID_REQUEST", "action 不合法"); return; }
      const model = SELECTABLE.find((m) => m.id === body.modelId);
      if (!model) { fail(res, 404, "MODEL_NOT_FOUND", "模型不存在或不在允许范围内"); return; }
      state.selection = { id: model.id, kind: "manual" };
    } else if (body?.action === "primary") {
      state.selection = null;
    } else {
      fail(res, 400, "INVALID_REQUEST", "action 不合法");
      return;
    }
    state.modelVersion += 1;
    const models = modelsResponse();
    emit("model.changed", { current: models.current, version: state.modelVersion });
    json(res, 200, { ...models, effective: "next-request" });
    return;
  }

  if (req.method === "GET" && path === "/api/v1/events") {
    if (!authorized(req)) { unauthorized(res); return; }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("snapshot", { activeRequest: activeRequest(), modelVersion: state.modelVersion });
    const request = activeRequest();
    if (request?.status === "running") send("request.running", { requestId: request.requestId });
    listeners.add(res);
    const heartbeat = setInterval(() => { try { res.write(": heartbeat\n\n"); } catch { /* closed */ } }, 15000);
    req.on("close", () => { clearInterval(heartbeat); listeners.delete(res); });
    return;
  }

  fail(res, 404, "NOT_FOUND", "接口不存在");
});

server.listen(port, host, () => {
  console.log(`[mock-server] http://${host}:${port}  (password 取自 fixtures.ts，仅本机)`);
});

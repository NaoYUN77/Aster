import type { ModelRef, ModelUsage, ModelsResponse, SelectableModel, UiMessage } from "../types";
import {
  MOCK_FALLBACK,
  MOCK_OWNER_ID,
  MOCK_PASSWORD,
  MOCK_PRIMARY,
  MOCK_SELECTABLE,
  MOCK_UNSTABLE_MODEL_ID,
  buildModelsResponse,
  seedMessages,
} from "./fixtures";

const STORAGE_KEY = "aster.mock.state.v1";
const SESSION_TTL = 30 * 86_400_000;

export type MockRequestStatus = "queued" | "running" | "done" | "failed" | "aborted";

export type MockRequest = {
  requestId: string;
  clientMessageId: string;
  text: string;
  status: MockRequestStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  errorCode?: string;
};

type Selection = { id: string; kind: "manual" | "auto" } | null;

export type MockConnectorState = {
  status: "disconnected" | "connected" | "error";
  account: { id: string; label: string; detail?: string | null } | null;
  scopes: string[];
  connectedAt: string | null;
  lastError: string | null;
};

export type MockCredentialRequest = {
  requestId: string;
  connectorId: string;
  tool: string;
  scopes: string[];
  expiresAt: number;
  status: "pending" | "submitted" | "cancelled";
  reason?: string;
};

type MockState = {
  messages: UiMessage[];
  sessions: Record<string, number>;
  selection: Selection;
  requests: MockRequest[];
  modelVersion: number;
  seededAt: number;
  connectors: Record<string, MockConnectorState>;
  credentialRequests: Record<string, MockCredentialRequest>;
};

const CONNECTOR_DEFS = [
  {
    id: "github",
    name: "GitHub",
    description:
      "授权后 Aster 可以读取仓库信息，用于代码检索、Issue 与 Pull Request 相关工具。",
    readOnly: false,
    scopes: ["repo", "read:user"],
    account: { id: "aster-dev", label: "aster-dev", detail: "GitHub Mock 账号" },
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "本轮 Gmail 仅提供只读能力：搜索和读取邮件，不会发送或删除。",
    readOnly: true,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    account: { id: "aster.demo@gmail.com", label: "aster.demo@gmail.com", detail: "只读" },
  },
] as const;

function freshConnectors(): Record<string, MockConnectorState> {
  const connectors: Record<string, MockConnectorState> = {};
  for (const def of CONNECTOR_DEFS) {
    connectors[def.id] = {
      status: "disconnected",
      account: null,
      scopes: [],
      connectedAt: null,
      lastError: null,
    };
  }
  return connectors;
}

type MockEvent = { event: string; data: unknown };
type Listener = (event: MockEvent) => void;

const listeners = new Set<Listener>();
const timers = new Map<string, number[]>();

function freshState(): MockState {
  const now = Date.now();
  return {
    messages: seedMessages(now),
    sessions: {},
    selection: null,
    requests: [],
    modelVersion: 1,
    seededAt: now,
    connectors: freshConnectors(),
    credentialRequests: {},
  };
}

function load(): MockState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshState();
    const parsed = JSON.parse(raw) as Partial<MockState>;
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) return freshState();
    const state: MockState = {
      ...freshState(),
      ...parsed,
      messages: parsed.messages,
      sessions: parsed.sessions ?? {},
      requests: parsed.requests ?? [],
      selection: parsed.selection ?? null,
      modelVersion: parsed.modelVersion ?? 1,
      connectors: { ...freshConnectors(), ...(parsed.connectors ?? {}) },
      credentialRequests: parsed.credentialRequests ?? {},
    };
    // 模拟后端重启恢复：未完成的请求置为失败，不自动重放。
    for (const request of state.requests) {
      if (request.status === "queued" || request.status === "running") {
        request.status = "failed";
        request.errorCode = "PROCESS_INTERRUPTED";
        request.finishedAt = Date.now();
      }
    }
    return state;
  } catch {
    return freshState();
  }
}

let state: MockState = load();

function persist(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* mock 持久化失败不影响主流程 */
  }
}

export function mockReset(): void {
  for (const list of timers.values()) list.forEach((timer) => window.clearTimeout(timer));
  timers.clear();
  state = freshState();
  persist();
}

export function subscribeMockEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event: string, data: unknown): void {
  for (const listener of listeners) {
    try {
      listener({ event, data });
    } catch {
      /* ignore listener failure */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 认证                                                                */
/* ------------------------------------------------------------------ */

export function mockLogin(password: string): { token: string; expiresAt: number } | null {
  if (password !== MOCK_PASSWORD) return null;
  const token = `mock_token_${crypto.randomUUID()}`;
  const expiresAt = Date.now() + SESSION_TTL;
  state.sessions[token] = expiresAt;
  persist();
  return { token, expiresAt };
}

export function mockLogout(token: string): void {
  delete state.sessions[token];
  persist();
}

export function mockAuthorized(authorization: string | null): { token: string; ownerId: string; expiresAt: number } | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  const expiresAt = state.sessions[token];
  if (!expiresAt || expiresAt < Date.now()) return null;
  return { token, ownerId: MOCK_OWNER_ID, expiresAt };
}

/* ------------------------------------------------------------------ */
/* 模型                                                                */
/* ------------------------------------------------------------------ */

function selectableById(modelId: string): SelectableModel | undefined {
  return MOCK_SELECTABLE.find((model) => model.id === modelId);
}

function activeModelRef(): ModelRef {
  if (!state.selection) return MOCK_PRIMARY;
  const model = selectableById(state.selection.id);
  if (!model) return MOCK_PRIMARY;
  return { provider: model.provider, id: model.id, label: model.label, name: model.name };
}

export function mockModels(): ModelsResponse {
  return buildModelsResponse(state.selection);
}

export function mockSelectModel(
  input: { action: "select"; modelId: string } | { action: "primary" },
):
  | { ok: true; models: ModelsResponse; effective: "immediate" | "next_request" }
  | { ok: false; status: number; code: string; message: string } {
  if (input.action === "select") {
    const model = selectableById(input.modelId);
    if (!model) {
      return { ok: false, status: 400, code: "MODEL_NOT_FOUND", message: "模型不存在" };
    }
    state.selection = { id: model.id, kind: "manual" };
  } else {
    state.selection = null;
  }

  const active = hasActiveRequest();
  state.modelVersion += 1;
  persist();

  const models = mockModels();
  emit("model.changed", { current: models.current, version: state.modelVersion });
  return { ok: true, models, effective: active ? "next_request" : "immediate" };
}

function hasActiveRequest(): boolean {
  return state.requests.some(
    (request) => request.status === "queued" || request.status === "running",
  );
}

/* ------------------------------------------------------------------ */
/* 历史                                                                */
/* ------------------------------------------------------------------ */

export function mockMessages(
  before: string | null,
  limit: number,
): { messages: UiMessage[]; nextCursor: string | null; hasMore: boolean } {
  const sorted = [...state.messages].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
  let end = sorted.length;
  if (before) {
    const index = sorted.findIndex((message) => message.id === before);
    end = index === -1 ? sorted.length : index;
  }
  const start = Math.max(0, end - limit);
  const page = sorted.slice(start, end);
  const hasMore = start > 0;
  return {
    messages: page,
    nextCursor: hasMore ? page[0]?.id ?? null : null,
    hasMore,
  };
}

/* ------------------------------------------------------------------ */
/* 请求                                                                */
/* ------------------------------------------------------------------ */

const REPLY_POOL = [
  "收到。这是 **MSW mock** 的回复，用于在真实后端就绪前验证 UI。\n\n- 消息列表与状态更新正常\n- 停止按钮可用\n- 历史分页按 entry cursor 工作",
  "已处理完成。\n\n```ts\n// 选择模型不产生聊天消息，也不调用模型\nexport async function selectModel(modelId: string) {\n  return api.POST(\"/models/select\", {\n    body: { action: \"select\", modelId },\n  });\n}\n```",
  "明白。补充两点：\n\n1. 三端共用同一份 `web/dist`\n2. 模型列表只信 `/api/v1/models`，不硬编码 id\n\n> 当前回复来自 mock，未调用真实模型。",
  "这是一个 mock 回复。你可以试试右上角的 **模型** 按钮，切换到「GLM Mock」再发一条消息，会看到一次手动模型降级的提示。",
];

let replyIndex = 0;

function nextReply(text: string): { text: string; tool?: { name: string; status: "done" | "failed" } } {
  const command = text.trim();
  if (command.startsWith("$model")) {
    if (command === "$model list") {
      return {
        text: `可切模型（实时目录，共 ${MOCK_SELECTABLE.length} 个）：\n\n${MOCK_SELECTABLE.map(
          (model) => `- \`[${model.supplier}]\` ${model.id}（${model.name}）`,
        ).join("\n")}`,
      };
    }
    if (command === "$model primary") {
      state.selection = null;
      state.modelVersion += 1;
      const models = mockModels();
      emit("model.changed", { current: models.current, version: state.modelVersion });
      return { text: "已切回主模型。下一次回复生效。" };
    }
    if (command === "$model") {
      const models = mockModels();
      return {
        text: `当前模型：${models.current.label}（${models.current.kind === "primary" ? "主模型" : "手动指定"}）\n默认链：${models.chain.map((model) => model.label).join(" → ")}`,
      };
    }
    const target = command.slice("$model".length).trim();
    const model = selectableById(target);
    if (model) {
      state.selection = { id: model.id, kind: "manual" };
      state.modelVersion += 1;
      const models = mockModels();
      emit("model.changed", { current: models.current, version: state.modelVersion });
      return { text: `已切换到 ${model.label}。下一次回复生效。` };
    }
    return { text: `没有找到模型 ${target}。发 $model list 查看可切模型。` };
  }

  const reply = REPLY_POOL[replyIndex % REPLY_POOL.length]!;
  replyIndex += 1;
  const withTool = replyIndex % 4 === 0;
  return {
    text: reply,
    ...(withTool ? { tool: { name: "web_search", status: "done" as const } } : {}),
  };
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

export function mockSendMessage(
  clientMessageId: string,
  text: string,
): { requestId: string; status: "queued" } | { error: string } {
  if (text.trim() === "") return { error: "INVALID_REQUEST" };
  if (text.length > 32_000) return { error: "TEXT_TOO_LONG" };

  const existing = state.requests.find((request) => request.clientMessageId === clientMessageId);
  if (existing) return { requestId: existing.requestId, status: "queued" };

  const requestId = makeId("req");
  const now = Date.now();
  const request: MockRequest = {
    requestId,
    clientMessageId,
    text,
    status: "queued",
    createdAt: now,
  };
  state.requests.push(request);

  // 与服务端一致：`$model` 是命令，不产生 durable user entry。
  // 本地用户气泡只能靠客户端自己保留，历史里不会再出现。
  if (!text.trim().startsWith("$model")) {
    state.messages.push({
      id: makeId("entry"),
      role: "user",
      text,
      createdAt: now,
      status: "complete",
      requestId,
      clientMessageId,
      model: null,
      errorCode: null,
      tool: null,
    });
  }

  persist();
  emit("request.queued", { requestId, clientMessageId });
  scheduleRequest(request);
  return { requestId, status: "queued" };
}

function scheduleRequest(request: MockRequest): void {
  const started = window.setTimeout(() => {
    if (request.status !== "queued") return;
    request.status = "running";
    request.startedAt = Date.now();
    persist();
    emit("request.running", { requestId: request.requestId });
  }, 650);

  const finished = window.setTimeout(() => finishRequest(request), 2600);
  timers.set(request.requestId, [started, finished]);
}

function clearTimers(requestId: string): void {
  const list = timers.get(requestId);
  if (list) {
    list.forEach((timer) => window.clearTimeout(timer));
    timers.delete(requestId);
  }
}

function finishRequest(request: MockRequest): void {
  clearTimers(request.requestId);
  if (request.status !== "running" && request.status !== "queued") return;

  const requestedRef = activeModelRef();
  const requestedKind = state.selection?.kind ?? "primary";

  // 演示：手动选择的“GLM Mock”模拟不可用，由主模型回答，degraded=true。
  const degraded = state.selection?.id === MOCK_UNSTABLE_MODEL_ID;
  const actual: ModelRef = degraded ? MOCK_PRIMARY : requestedRef;
  const kind = requestedKind;

  const usage: ModelUsage = {
    requested: { ...requestedRef, kind: requestedKind },
    actual,
    kind,
    degraded,
  };

  const reply = nextReply(request.text);
  const message: UiMessage = {
    id: makeId("entry"),
    role: "assistant",
    text: degraded
      ? `（${requestedRef.label} 不可用，本次由 ${actual.label} 回答。）\n\n${reply.text}`
      : reply.text,
    createdAt: Date.now(),
    status: "complete",
    requestId: request.requestId,
    clientMessageId: request.clientMessageId,
    model: actual,
    errorCode: null,
    tool: null,
  };

  state.messages.push(message);
  if (reply.tool) {
    state.messages.push({
      id: makeId("entry"),
      role: "system",
      text: "",
      createdAt: Date.now(),
      status: "complete",
      requestId: request.requestId,
      model: null,
      errorCode: null,
      tool: reply.tool,
    });
  }

  request.status = "done";
  request.finishedAt = Date.now();
  persist();
  emit("request.done", { requestId: request.requestId, message, model: usage });
}

export function mockAbort(requestId: string): { ok: boolean; status: number; code?: string } {
  const request = state.requests.find((item) => item.requestId === requestId);
  if (!request) return { ok: false, status: 404, code: "NOT_FOUND" };
  if (request.status !== "queued" && request.status !== "running") {
    return { ok: false, status: 409, code: "CONFLICT" };
  }

  clearTimers(requestId);
  request.status = "aborted";
  request.finishedAt = Date.now();

  // 与服务端修复对齐：停止后不再追加空的 assistant 占位消息，
  // 界面上只在用户消息下显示“已停止”。

  persist();
  emit("request.aborted", { requestId });
  return { ok: true, status: 200 };
}

export function mockActiveRequest(): { requestId: string; status: string; clientMessageId: string } | null {
  const active = [...state.requests]
    .reverse()
    .find((request) => request.status === "running" || request.status === "queued");
  if (!active) return null;
  return {
    requestId: active.requestId,
    status: active.status,
    clientMessageId: active.clientMessageId,
  };
}

export function mockSnapshot(): { activeRequest: unknown; modelVersion: number } {
  return { activeRequest: mockActiveRequest(), modelVersion: state.modelVersion };
}

/* ------------------------------------------------------------------ */
/* Connectors（仅 mock：状态保存在 mock 服务端，不写客户端存储）        */
/* ------------------------------------------------------------------ */

function connectorView(id: string) {
  const def = CONNECTOR_DEFS.find((item) => item.id === id);
  const current = state.connectors[id];
  if (!def || !current) return null;
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    status: current.status,
    account: current.account,
    scopes: current.scopes,
    readOnly: def.readOnly,
    connectedAt: current.connectedAt,
    lastError: current.lastError,
  };
}

export function mockConnectors() {
  return {
    connectors: CONNECTOR_DEFS.map((def) => connectorView(def.id)),
    mock: true,
  };
}

export function mockConnect(
  id: string,
):
  | { ok: true; connector: NonNullable<ReturnType<typeof connectorView>> }
  | { ok: false; status: number; code: string; message: string } {
  const def = CONNECTOR_DEFS.find((item) => item.id === id);
  const current = state.connectors[id];
  if (!def || !current) {
    return { ok: false, status: 404, code: "CONNECTOR_NOT_FOUND", message: "连接器不存在" };
  }

  current.status = "connected";
  current.account = { ...def.account };
  current.scopes = [...def.scopes];
  current.connectedAt = new Date().toISOString();
  current.lastError = null;
  persist();
  emit("connector.changed", { connectorId: id, status: current.status });

  const connector = connectorView(id);
  if (!connector) {
    return { ok: false, status: 500, code: "INTERNAL_ERROR", message: "连接失败" };
  }
  return { ok: true, connector };
}

export function mockDisconnect(
  id: string,
): { ok: true } | { ok: false; status: number; code: string; message: string } {
  const current = state.connectors[id];
  if (!current) {
    return { ok: false, status: 404, code: "CONNECTOR_NOT_FOUND", message: "连接器不存在" };
  }
  current.status = "disconnected";
  current.account = null;
  current.scopes = [];
  current.connectedAt = null;
  current.lastError = null;
  persist();
  emit("connector.changed", { connectorId: id, status: current.status });
  return { ok: true };
}

/** 模拟服务端发起一次安全注入请求，通过 SSE 推给所有端。 */
export function mockRequestCredential(
  connectorId = "github",
): { requestId: string } | { error: "CONNECTOR_NOT_FOUND" } {
  const def = CONNECTOR_DEFS.find((item) => item.id === connectorId);
  if (!def) return { error: "CONNECTOR_NOT_FOUND" };

  const gmail = connectorId === "gmail";
  const requestId = makeId("cred");
  const request: MockCredentialRequest = {
    requestId,
    connectorId,
    tool: gmail ? "gmail.search" : "github.create_issue_comment",
    scopes: [...def.scopes],
    expiresAt: Date.now() + 120_000,
    status: "pending",
  };
  state.credentialRequests[requestId] = request;
  persist();
  emit("credential.request", {
    requestId,
    connector: { id: def.id, name: def.name },
    tool: request.tool,
    scopes: request.scopes,
    expiresAt: request.expiresAt,
    reason: gmail
      ? "读取邮件需要你的 Gmail 只读令牌。"
      : "这个工具需要你的 GitHub 令牌才能继续。",
    accountHint: state.connectors[connectorId]?.account?.label ?? def.account.label,
  });
  return { requestId };
}

export function mockSubmitCredential(
  requestId: string,
  token: string,
): { ok: true } | { ok: false; status: number; code: string; message: string } {
  const request = state.credentialRequests[requestId];
  if (!request) {
    return { ok: false, status: 404, code: "CREDENTIAL_NOT_FOUND", message: "凭据请求不存在" };
  }
  if (request.status === "submitted") return { ok: true };
  if (request.status !== "pending") {
    return { ok: false, status: 409, code: "CREDENTIAL_NOT_PENDING", message: "凭据请求已结束" };
  }
  if (request.expiresAt < Date.now()) {
    request.status = "cancelled";
    request.reason = "timeout";
    persist();
    return { ok: false, status: 409, code: "CREDENTIAL_EXPIRED", message: "凭据请求已超时" };
  }
  if (token.trim() === "") {
    return { ok: false, status: 400, code: "INVALID_REQUEST", message: "令牌不能为空" };
  }
  // 只记录状态，不保存 token 明文（mock 同样遵守）。
  request.status = "submitted";
  persist();
  return { ok: true };
}

export function mockCancelCredential(
  requestId: string,
  reason: string,
): { ok: true } | { ok: false; status: number; code: string; message: string } {
  const request = state.credentialRequests[requestId];
  if (!request) {
    // 已结束/服务端已清理时按幂等处理，避免弹窗卡住。
    return { ok: true };
  }
  if (request.status === "pending") {
    request.status = "cancelled";
    request.reason = reason;
    persist();
  }
  return { ok: true };
}

export { MOCK_FALLBACK, MOCK_PRIMARY };

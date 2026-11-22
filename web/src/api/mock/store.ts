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

export type MockConnectorStatus = "pending" | "connected" | "error" | "revoked";

/** 与后端 `ConnectorConnection` 同形；mock 也只暴露这些安全字段。 */
export type MockConnectorConnection = {
  id: string;
  provider:
    | "github"
    | "gmail"
    | "outlook"
    | "linear"
    | "notion"
    | "google_calendar"
    | "google_drive";
  slug: string;
  status: MockConnectorStatus;
  accountLabel: string | null;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
  lastErrorCode: string | null;
};

type MockState = {
  messages: UiMessage[];
  sessions: Record<string, number>;
  selection: Selection;
  requests: MockRequest[];
  modelVersion: number;
  seededAt: number;
  /** 按 slug 保存；没有记录 = 尚未创建连接。 */
  connectors: Record<string, MockConnectorConnection>;
};

const CONNECTOR_DEFS = [
  {
    provider: "github",
    displayName: "GitHub",
    transport: "oauth",
    defaultScopes: ["repo", "read:user"],
    tools: ["github.search_repositories", "github.create_issue_comment"],
    description: "可读取仓库、Issue 与 Pull Request，也可创建 Issue 与评论。",
    accountLabel: "aster-dev",
  },
  {
    provider: "gmail",
    displayName: "Gmail",
    transport: "oauth",
    defaultScopes: ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"],
    tools: ["gmail.search", "gmail.read"],
    description: "支持邮件检索与发送，不会删除邮件。",
    accountLabel: "aster.demo@gmail.com",
  },
  {
    provider: "outlook",
    displayName: "Outlook",
    transport: "oauth",
    defaultScopes: ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"],
    tools: [
      "connector_outlook_list_messages",
      "connector_outlook_search_messages",
      "connector_outlook_get_message",
    ],
    description: "支持邮件检索、发送与回复，不会删除邮件。",
    accountLabel: "aster.demo@outlook.com",
  },
  {
    provider: "linear",
    displayName: "Linear",
    transport: "oauth",
    defaultScopes: ["read", "write"],
    tools: [
      "connector_linear_list_issues",
      "connector_linear_search_issues",
      "connector_linear_get_issue",
    ],
    description: "支持 Issue 读取、创建与更新，不会删除 Issue。",
    accountLabel: "aster.demo@linear.app",
  },
  {
    provider: "notion",
    displayName: "Notion",
    transport: "oauth",
    defaultScopes: [],
    tools: ["connector_notion_search", "connector_notion_get_page"],
    description: "支持页面与数据库的读取与写入，不会删除内容。",
    accountLabel: "Aster Workspace",
  },
  {
    provider: "google_calendar",
    displayName: "Google Calendar",
    transport: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "https://www.googleapis.com/auth/calendar",
    ],
    tools: [
      "connector_google_calendar_list_events",
      "connector_google_calendar_get_event",
    ],
    description: "支持日程读取与创建，不会删除日程。",
    accountLabel: "aster.demo@gmail.com",
  },
  {
    provider: "google_drive",
    displayName: "Google Drive",
    transport: "oauth",
    defaultScopes: [
      "openid",
      "email",
      "https://www.googleapis.com/auth/drive.file",
    ],
    tools: [
      "connector_google_drive_search_files",
      "connector_google_drive_get_file",
    ],
    description: "支持文件检索与读写（仅限 Aster 创建或打开的文件），不会删除文件。",
    accountLabel: "aster.demo@gmail.com",
  },
] as const;

function connectorDef(provider: string) {
  return CONNECTOR_DEFS.find((item) => item.provider === provider) ?? null;
}

function freshConnectors(): Record<string, MockConnectorConnection> {
  return {};
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
      connectors: Object.fromEntries(
        Object.entries(parsed.connectors ?? {}).filter(([slug, value]) => {
          const item = value as Partial<MockConnectorConnection> | null;
          return (
            item !== null &&
            typeof item === "object" &&
            item.slug === slug &&
            (item.provider === "github" ||
              item.provider === "gmail" ||
              item.provider === "outlook" ||
              item.provider === "linear" ||
              item.provider === "notion" ||
              item.provider === "google_calendar" ||
              item.provider === "google_drive") &&
            typeof item.status === "string"
          );
        }),
      ) as Record<string, MockConnectorConnection>,
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

  if (command === "$demo subagent") {
    mockTriggerSubagentDemo();
    return { text: "已启动 2 个演示子任务：一个正在读取工作区，一个正在等待审批。可以点击输入框上方的胶囊条展开或中止。" };
  }
  if (command === "$demo approval") {
    mockTriggerApprovalDemo();
    return { text: "已触发一次敏感操作审批演示弹窗。" };
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

function providerView(def: (typeof CONNECTOR_DEFS)[number]) {
  return {
    provider: def.provider,
    displayName: def.displayName,
    transport: def.transport,
    defaultScopes: [...def.defaultScopes],
    tools: [...def.tools],
  };
}

export function mockConnectors() {
  return {
    providers: CONNECTOR_DEFS.map(providerView),
    connections: Object.values(state.connectors),
    mock: true,
  };
}

export function mockCreateConnector(
  provider: string,
  slug: string,
):
  | { ok: true; connection: MockConnectorConnection; created: boolean }
  | { ok: false; status: number; code: string; message: string } {
  const def = connectorDef(provider);
  if (!def) {
    return { ok: false, status: 404, code: "CONNECTOR_NOT_FOUND", message: "连接器不存在" };
  }

  const existing = state.connectors[slug];
  if (existing) {
    if (existing.provider !== provider) {
      return {
        ok: false,
        status: 409,
        code: "CONNECTOR_NOT_CONFIGURED",
        message: "该 slug 已被其他连接器占用",
      };
    }
    return { ok: true, connection: existing, created: false };
  }

  const now = new Date().toISOString();
  const connection: MockConnectorConnection = {
    id: makeId("conn"),
    provider: def.provider,
    slug,
    status: "pending",
    accountLabel: null,
    scopes: [...def.defaultScopes],
    createdAt: now,
    updatedAt: now,
    lastErrorCode: null,
  };
  state.connectors[slug] = connection;
  persist();
  emit("connector.changed", { connection });
  return { ok: true, connection, created: true };
}

export function mockStartConnectorOAuth(
  slug: string,
):
  | { ok: true; url: string }
  | { ok: false; status: number; code: string; message: string } {
  const connection = state.connectors[slug];
  const def = connection ? connectorDef(connection.provider) : null;
  if (!connection || !def) {
    return { ok: false, status: 404, code: "CONNECTOR_NOT_FOUND", message: "连接器不存在" };
  }

  connection.status = "pending";
  connection.updatedAt = new Date().toISOString();
  persist();
  emit("connector.changed", { connection });

  // Mock 浏览器回调：不依赖真实 OAuth，延时后模拟授权完成。
  const timerKey = `oauth:${slug}`;
  const previous = timers.get(timerKey);
  previous?.forEach((timer) => window.clearTimeout(timer));
  const timer = window.setTimeout(() => {
    const latest = state.connectors[slug];
    if (!latest) return;
    latest.status = "connected";
    latest.accountLabel = def.accountLabel;
    latest.scopes = [...def.defaultScopes];
    latest.updatedAt = new Date().toISOString();
    latest.lastErrorCode = null;
    persist();
    emit("connector.changed", { connection: latest });
    timers.delete(timerKey);
  }, 1_200);
  timers.set(timerKey, [timer]);

  return {
    ok: true,
    url: `https://example.com/mock-oauth?provider=${encodeURIComponent(
      connection.provider,
    )}&slug=${encodeURIComponent(slug)}`,
  };
}

export function mockDeleteConnector(
  slug: string,
): { ok: true } {
  const connection = state.connectors[slug];
  if (connection) {
    // 取消可能仍在等待的 mock 授权回调，避免断开后又被定时器连回去。
    const timerKey = `oauth:${slug}`;
    timers.get(timerKey)?.forEach((timer) => window.clearTimeout(timer));
    timers.delete(timerKey);
    // 与服务端一致：行保留为 revoked，供同一 slug 重新授权。
    connection.status = "revoked";
    connection.accountLabel = null;
    connection.scopes = [];
    connection.updatedAt = new Date().toISOString();
    persist();
    emit("connector.changed", { connection });
  }
  return { ok: true };
}

/** 模拟服务端发起一次安全注入请求，通过 SSE 推给所有端（仅 mock）。 */
export function mockRequestCredential(
  connectorId = "github",
): { requestId: string } | { error: "CONNECTOR_NOT_FOUND" } {
  const def = connectorDef(connectorId);
  if (!def) return { error: "CONNECTOR_NOT_FOUND" };

  const connection = state.connectors[def.provider];
  const requestId = makeId("cred");
  const tool =
    def.provider === "github"
      ? "github.create_issue_comment"
      : def.provider === "linear"
        ? "linear.search_issues"
        : `${def.provider}.search`;
  emit("credential.request", {
    connectionId: connection?.id ?? `mock_${def.provider}`,
    provider: def.provider,
    slug: def.provider,
    tool,
    requestId,
  });
  return { requestId };
}

const mockSubagents = new Map<
  string,
  {
    id: string;
    task: string;
    status: "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
    currentTool: string | null;
    startedAt: number;
    finishedAt: number | null;
  }
>();

const mockApprovals = new Map<string, Record<string, unknown>>();

export function mockTriggerSubagentDemo(): void {
  const now = Date.now();
  const sub1 = {
    id: "sub_demo_read",
    task: "巡检 workspace 文件结构并汇总关键改动",
    status: "running" as const,
    currentTool: "read",
    startedAt: now - 8_000,
    finishedAt: null,
  };
  const sub2 = {
    id: "sub_demo_write",
    task: "修复测试断言并生成 sub-test.txt",
    status: "waiting_approval" as const,
    currentTool: "write",
    startedAt: now - 14_000,
    finishedAt: null,
  };
  mockSubagents.set(sub1.id, sub1);
  mockSubagents.set(sub2.id, sub2);
  emit("subagent.updated", sub1);
  emit("subagent.updated", sub2);
}

export function mockTriggerApprovalDemo(): void {
  const now = Date.now();
  const id = `apr_demo_${now.toString(36)}`;
  const approval = {
    id,
    status: "pending",
    caller: { kind: "subagent", subagentId: "sub_demo_write", task: "修复测试断言并生成 sub-test.txt" },
    toolName: "bash",
    args: { command: "echo hello > /tmp/aster-e2e-escape.txt" },
    rule: "workspace_escape",
    reason: "Shell 命令试图写入工作区 (/data/workspace) 之外的路径：/tmp/aster-e2e-escape.txt",
    categoryKey: "bash:workspace_escape",
    summary: "bash -> /tmp/aster-e2e-escape.txt",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30 * 60_000).toISOString(),
    resolvedAt: null,
    decisionReason: null,
  };
  mockApprovals.set(id, approval);
  emit("approval.requested", approval);
}

export function mockCancelSubagent(id: string): { ok: boolean; status: string } {
  const item = mockSubagents.get(id);
  if (!item) return { ok: false, status: "not_found" };
  if (item.status !== "running" && item.status !== "waiting_approval") {
    return { ok: false, status: item.status };
  }
  const updated = {
    ...item,
    status: "cancelled" as const,
    currentTool: null,
    finishedAt: Date.now(),
  };
  mockSubagents.set(id, updated);
  emit("subagent.updated", updated);
  return { ok: true, status: "cancelled" };
}

export function mockResolveApproval(
  id: string,
  decision: "approve_once" | "approve_similar" | "deny",
  reason?: string,
): { ok: true; approval: Record<string, unknown> } | { ok: false } {
  const item = mockApprovals.get(id);
  if (!item) return { ok: false };
  const status =
    decision === "approve_once"
      ? "approved_once"
      : decision === "approve_similar"
        ? "approved_similar"
        : "denied";
  const updated = {
    ...item,
    status,
    resolvedAt: new Date().toISOString(),
    decisionReason: reason ?? null,
  };
  mockApprovals.delete(id);
  emit("approval.resolved", updated);
  return { ok: true, approval: updated };
}

export { MOCK_FALLBACK, MOCK_PRIMARY };

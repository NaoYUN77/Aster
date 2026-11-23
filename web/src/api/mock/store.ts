import type { ModelRef, ModelUsage, ModelsResponse, SelectableModel, UiMessage } from "../types";
import type {
  AutomationsResponse,
  ReminderItem,
  RoutineItem,
  RoutineRunItem,
  WatchDigestItem,
  WatcherItem,
} from "../automations";
import type {
  UsageBudgetState,
  UsageCallItem,
  UsageRange,
  UsageSource,
  UsageSummaryResponse,
} from "../usage";
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
  const subAprId = `apr_sub_demo_${now.toString(36)}`;
  const subApproval = {
    id: subAprId,
    status: "pending",
    caller: { kind: "subagent", subagentId: sub2.id, task: sub2.task },
    toolName: "write",
    args: { path: "sub-test.txt", content: "hello from sub-agent" },
    rule: "subagent_write_escalation",
    reason: "Sub-agent (sub_demo_write) 未获得工作区写权限或写锁，尝试执行 write",
    categoryKey: "subagent:write:write_escalation",
    summary: "write (subagent sub_demo_write)",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 30 * 60_000).toISOString(),
    resolvedAt: null,
    decisionReason: null,
  };
  mockSubagents.set(sub1.id, sub1);
  mockSubagents.set(sub2.id, sub2);
  mockApprovals.set(subAprId, subApproval);
  emit("subagent.updated", sub1);
  emit("subagent.updated", sub2);
  emit("approval.requested", subApproval);
}

export function mockTriggerApprovalDemo(): void {
  const now = Date.now();
  const id = `apr_main_demo_${now.toString(36)}`;
  const approval = {
    id,
    status: "pending",
    caller: { kind: "main", conversationId: "1" },
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
  const caller = item.caller as { kind?: string; subagentId?: string } | undefined;
  if (caller?.kind === "subagent" && caller.subagentId) {
    const sub = mockSubagents.get(caller.subagentId);
    if (sub && sub.status === "waiting_approval") {
      const nextSub = { ...sub, status: "running" as const };
      mockSubagents.set(sub.id, nextSub);
      emit("subagent.updated", nextSub);
    }
  }
  return { ok: true, approval: updated };
}

let mockDailyTokenBudget: number | null = 500_000;

export function mockUsageSummary(
  range: UsageRange,
  filters: { model?: string; source?: UsageSource } = {},
): UsageSummaryResponse {
  const model = activeModelRef();
  const now = Date.now();
  const availableModels = [
    { provider: model.provider, modelId: model.id },
    { provider: "anthropic", modelId: "claude-sonnet-4-6" },
    { provider: "openai", modelId: "gpt-5.4-mini" },
  ];

  const allRecentCalls: UsageCallItem[] = [
    {
      id: 108,
      timestamp: now - 45_000,
      source: "main",
      subagentId: null,
      provider: model.provider,
      modelId: model.id,
      inputTokens: 12_400,
      outputTokens: 4_800,
      cacheReadTokens: 28_600,
      cacheWriteTokens: 2_200,
      reasoningTokens: 0,
      totalTokens: 48_000,
      costUsd: 0.14,
      durationMs: 2_840,
      contextWindow: 128_000,
    },
    {
      id: 107,
      timestamp: now - 14 * 60_000,
      source: "subagent",
      subagentId: "sub_audit_01",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      inputTokens: 16_200,
      outputTokens: 6_100,
      cacheReadTokens: 41_500,
      cacheWriteTokens: 3_400,
      reasoningTokens: 0,
      totalTokens: 67_200,
      costUsd: 0.24,
      durationMs: 4_120,
      contextWindow: 200_000,
    },
    {
      id: 106,
      timestamp: now - 42 * 60_000,
      source: "dreaming",
      subagentId: null,
      provider: model.provider,
      modelId: model.id,
      inputTokens: 9_800,
      outputTokens: 3_200,
      cacheReadTokens: 22_000,
      cacheWriteTokens: 1_000,
      reasoningTokens: 0,
      totalTokens: 36_000,
      costUsd: 0.08,
      durationMs: 3_250,
      contextWindow: 128_000,
    },
    {
      id: 105,
      timestamp: now - 2 * 3_600_000,
      source: "main",
      subagentId: null,
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      inputTokens: 14_500,
      outputTokens: 5_200,
      cacheReadTokens: 31_000,
      cacheWriteTokens: 1_800,
      reasoningTokens: 0,
      totalTokens: 52_500,
      costUsd: 0.19,
      durationMs: 3_640,
      contextWindow: 200_000,
    },
    {
      id: 104,
      timestamp: now - 5 * 3_600_000,
      source: "routine",
      subagentId: null,
      provider: "openai",
      modelId: "gpt-5.4-mini",
      inputTokens: 6_400,
      outputTokens: 1_900,
      cacheReadTokens: 12_200,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 20_500,
      costUsd: 0.03,
      durationMs: 1_420,
      contextWindow: 128_000,
    },
    {
      id: 103,
      timestamp: now - 9 * 3_600_000,
      source: "compaction",
      subagentId: null,
      provider: model.provider,
      modelId: model.id,
      inputTokens: 11_200,
      outputTokens: 2_600,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 13_800,
      costUsd: 0.02,
      durationMs: 1_950,
      contextWindow: 128_000,
    },
  ];

  const budget: UsageBudgetState = {
    dailyTokenBudget: mockDailyTokenBudget,
    todayTokens: 194_200,
    lastAlertDate:
      mockDailyTokenBudget !== null && 194_200 >= mockDailyTokenBudget
        ? new Date(now).toISOString().slice(0, 10)
        : null,
  };

  const contextOccupancy = {
    usedTokens: 48_000,
    contextWindow: 128_000,
    ratio: 0.375,
    provider: model.provider,
    modelId: model.id,
    updatedAt: now - 45_000,
    inputTokens: 12_400,
    outputTokens: 4_800,
    cacheReadTokens: 28_600,
    cacheWriteTokens: 2_200,
    reasoningTokens: 0,
  };

  const base1d: UsageSummaryResponse = {
    range: "1d",
    timezone: "Asia/Shanghai",
    contextOccupancy,
    totals: {
      calls: 27,
      inputTokens: 45_200,
      outputTokens: 32_000,
      cacheReadTokens: 117_000,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 194_200,
      cacheHitRate: 0.721,
      costUsd: 0.24,
    },
    trend: [
      { key: "00h", label: "00h", calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: null },
      { key: "03h", label: "03h", calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costUsd: null },
      { key: "06h", label: "06h", calls: 2, inputTokens: 4_800, outputTokens: 2_200, cacheReadTokens: 11_000, cacheWriteTokens: 0, totalTokens: 18_000, costUsd: 0.02 },
      { key: "09h", label: "09h", calls: 5, inputTokens: 8_400, outputTokens: 5_600, cacheReadTokens: 20_000, cacheWriteTokens: 0, totalTokens: 34_000, costUsd: 0.04 },
      { key: "12h", label: "12h", calls: 4, inputTokens: 6_200, outputTokens: 4_800, cacheReadTokens: 17_000, cacheWriteTokens: 0, totalTokens: 28_000, costUsd: 0.03 },
      { key: "15h", label: "15h", calls: 9, inputTokens: 14_800, outputTokens: 11_200, cacheReadTokens: 38_000, cacheWriteTokens: 0, totalTokens: 64_000, costUsd: 0.09 },
      { key: "18h", label: "18h", calls: 5, inputTokens: 7_400, outputTokens: 5_800, cacheReadTokens: 23_000, cacheWriteTokens: 0, totalTokens: 36_200, costUsd: 0.04 },
      { key: "21h", label: "21h", calls: 2, inputTokens: 3_600, outputTokens: 2_400, cacheReadTokens: 8_000, cacheWriteTokens: 0, totalTokens: 14_000, costUsd: 0.02 },
    ],
    bySource: [
      { source: "main", calls: 15, inputTokens: 26_200, outputTokens: 18_000, cacheReadTokens: 68_000, cacheWriteTokens: 0, totalTokens: 112_200, share: 0.578, costUsd: 0.14 },
      { source: "subagent", calls: 7, inputTokens: 11_000, outputTokens: 9_000, cacheReadTokens: 34_000, cacheWriteTokens: 0, totalTokens: 54_000, share: 0.278, costUsd: 0.07 },
      { source: "dreaming", calls: 3, inputTokens: 4_800, outputTokens: 3_200, cacheReadTokens: 10_000, cacheWriteTokens: 0, totalTokens: 18_000, share: 0.093, costUsd: 0.02 },
      { source: "routine", calls: 2, inputTokens: 3_200, outputTokens: 1_800, cacheReadTokens: 5_000, cacheWriteTokens: 0, totalTokens: 10_000, share: 0.051, costUsd: 0.01 },
    ],
    byModel: [
      { provider: model.provider, modelId: model.id, calls: 19, inputTokens: 31_000, outputTokens: 22_200, cacheReadTokens: 83_000, cacheHitRate: 0.728, totalTokens: 136_200, share: 0.701, costUsd: 0.16 },
      { provider: "anthropic", modelId: "claude-sonnet-4-6", calls: 6, inputTokens: 10_200, outputTokens: 7_800, cacheReadTokens: 26_000, cacheHitRate: 0.718, totalTokens: 44_000, share: 0.227, costUsd: 0.06 },
      { provider: "openai", modelId: "gpt-5.4-mini", calls: 2, inputTokens: 4_000, outputTokens: 2_000, cacheReadTokens: 8_000, cacheHitRate: 0.667, totalTokens: 14_000, share: 0.072, costUsd: 0.02 },
    ],
    availableModels,
    recentCalls: allRecentCalls,
    budget,
  };

  const base30d: UsageSummaryResponse = {
    range: "30d",
    timezone: "Asia/Shanghai",
    contextOccupancy,
    totals: {
      calls: 742,
      inputTokens: 1_660_000,
      outputTokens: 950_000,
      cacheReadTokens: 3_250_000,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 5_860_000,
      cacheHitRate: 0.662,
      costUsd: 7.42,
    },
    trend: [
      { key: "b1", label: "10/28", calls: 98, inputTokens: 210_000, outputTokens: 120_000, cacheReadTokens: 410_000, cacheWriteTokens: 0, totalTokens: 740_000, costUsd: 0.94 },
      { key: "b2", label: "11/02", calls: 126, inputTokens: 280_000, outputTokens: 160_000, cacheReadTokens: 550_000, cacheWriteTokens: 0, totalTokens: 990_000, costUsd: 1.26 },
      { key: "b3", label: "11/07", calls: 152, inputTokens: 340_000, outputTokens: 195_000, cacheReadTokens: 675_000, cacheWriteTokens: 0, totalTokens: 1_210_000, costUsd: 1.54 },
      { key: "b4", label: "11/12", calls: 118, inputTokens: 265_000, outputTokens: 155_000, cacheReadTokens: 510_000, cacheWriteTokens: 0, totalTokens: 930_000, costUsd: 1.18 },
      { key: "b5", label: "11/17", calls: 134, inputTokens: 305_000, outputTokens: 175_000, cacheReadTokens: 610_000, cacheWriteTokens: 0, totalTokens: 1_090_000, costUsd: 1.38 },
      { key: "b6", label: "近5日", calls: 114, inputTokens: 260_000, outputTokens: 145_000, cacheReadTokens: 495_000, cacheWriteTokens: 0, totalTokens: 900_000, costUsd: 1.12 },
    ],
    bySource: [
      { source: "main", calls: 398, inputTokens: 890_000, outputTokens: 510_000, cacheReadTokens: 1_760_000, cacheWriteTokens: 0, totalTokens: 3_160_000, share: 0.539, costUsd: 4.02 },
      { source: "subagent", calls: 196, inputTokens: 450_000, outputTokens: 260_000, cacheReadTokens: 870_000, cacheWriteTokens: 0, totalTokens: 1_580_000, share: 0.27, costUsd: 2.01 },
      { source: "dreaming", calls: 84, inputTokens: 200_000, outputTokens: 110_000, cacheReadTokens: 393_000, cacheWriteTokens: 0, totalTokens: 703_000, share: 0.12, costUsd: 0.88 },
      { source: "routine", calls: 44, inputTokens: 82_000, outputTokens: 48_000, cacheReadTokens: 162_000, cacheWriteTokens: 0, totalTokens: 292_000, share: 0.05, costUsd: 0.36 },
      { source: "compaction", calls: 20, inputTokens: 38_000, outputTokens: 22_000, cacheReadTokens: 65_000, cacheWriteTokens: 0, totalTokens: 125_000, share: 0.021, costUsd: 0.15 },
    ],
    byModel: [
      { provider: model.provider, modelId: model.id, calls: 486, inputTokens: 1_080_000, outputTokens: 610_000, cacheReadTokens: 2_120_000, cacheHitRate: 0.663, totalTokens: 3_810_000, share: 0.65, costUsd: 4.62 },
      { provider: "anthropic", modelId: "claude-sonnet-4-6", calls: 184, inputTokens: 410_000, outputTokens: 245_000, cacheReadTokens: 805_000, cacheHitRate: 0.663, totalTokens: 1_460_000, share: 0.249, costUsd: 2.15 },
      { provider: "openai", modelId: "gpt-5.4-mini", calls: 72, inputTokens: 170_000, outputTokens: 95_000, cacheReadTokens: 325_000, cacheHitRate: 0.657, totalTokens: 590_000, share: 0.101, costUsd: 0.65 },
    ],
    availableModels,
    recentCalls: allRecentCalls,
    budget,
  };

  const base7d: UsageSummaryResponse = {
    range: "7d",
    timezone: "Asia/Shanghai",
    contextOccupancy,
    totals: {
      calls: 186,
      inputTokens: 373_000,
      outputTokens: 241_000,
      cacheReadTokens: 807_000,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 1_421_000,
      cacheHitRate: 0.684,
      costUsd: 1.84,
    },
    trend: [
      { key: "d1", label: "11/16", calls: 22, inputTokens: 44_000, outputTokens: 28_000, cacheReadTokens: 93_000, cacheWriteTokens: 0, totalTokens: 165_000, costUsd: 0.21 },
      { key: "d2", label: "11/17", calls: 31, inputTokens: 63_000, outputTokens: 41_000, cacheReadTokens: 134_000, cacheWriteTokens: 0, totalTokens: 238_000, costUsd: 0.31 },
      { key: "d3", label: "11/18", calls: 24, inputTokens: 48_000, outputTokens: 31_000, cacheReadTokens: 103_000, cacheWriteTokens: 0, totalTokens: 182_000, costUsd: 0.24 },
      { key: "d4", label: "11/19", calls: 40, inputTokens: 82_000, outputTokens: 53_000, cacheReadTokens: 177_000, cacheWriteTokens: 0, totalTokens: 312_000, costUsd: 0.41 },
      { key: "d5", label: "11/20", calls: 26, inputTokens: 54_000, outputTokens: 34_000, cacheReadTokens: 116_000, cacheWriteTokens: 0, totalTokens: 204_000, costUsd: 0.26 },
      { key: "d6", label: "11/21", calls: 16, inputTokens: 36_800, outputTokens: 22_000, cacheReadTokens: 67_000, cacheWriteTokens: 0, totalTokens: 125_800, costUsd: 0.17 },
      { key: "d7", label: "今日", calls: 27, inputTokens: 45_200, outputTokens: 32_000, cacheReadTokens: 117_000, cacheWriteTokens: 0, totalTokens: 194_200, costUsd: 0.24 },
    ],
    bySource: [
      { source: "main", calls: 102, inputTokens: 210_000, outputTokens: 135_000, cacheReadTokens: 450_000, cacheWriteTokens: 0, totalTokens: 795_000, share: 0.559, costUsd: 1.03 },
      { source: "subagent", calls: 48, inputTokens: 96_000, outputTokens: 63_000, cacheReadTokens: 210_000, cacheWriteTokens: 0, totalTokens: 369_000, share: 0.26, costUsd: 0.48 },
      { source: "dreaming", calls: 21, inputTokens: 40_000, outputTokens: 26_000, cacheReadTokens: 90_000, cacheWriteTokens: 0, totalTokens: 156_000, share: 0.11, costUsd: 0.2 },
      { source: "routine", calls: 10, inputTokens: 17_000, outputTokens: 11_000, cacheReadTokens: 37_000, cacheWriteTokens: 0, totalTokens: 65_000, share: 0.046, costUsd: 0.08 },
      { source: "compaction", calls: 5, inputTokens: 10_000, outputTokens: 6_000, cacheReadTokens: 20_000, cacheWriteTokens: 0, totalTokens: 36_000, share: 0.025, costUsd: 0.05 },
    ],
    byModel: [
      { provider: model.provider, modelId: model.id, calls: 124, inputTokens: 242_000, outputTokens: 158_000, cacheReadTokens: 542_000, cacheHitRate: 0.691, totalTokens: 942_000, share: 0.663, costUsd: 1.18 },
      { provider: "anthropic", modelId: "claude-sonnet-4-6", calls: 44, inputTokens: 94_000, outputTokens: 61_000, cacheReadTokens: 193_000, cacheHitRate: 0.672, totalTokens: 348_000, share: 0.245, costUsd: 0.49 },
      { provider: "openai", modelId: "gpt-5.4-mini", calls: 18, inputTokens: 37_000, outputTokens: 22_000, cacheReadTokens: 72_000, cacheHitRate: 0.661, totalTokens: 131_000, share: 0.092, costUsd: 0.17 },
    ],
    availableModels,
    recentCalls: allRecentCalls,
    budget,
  };

  const selected = range === "1d" ? base1d : range === "30d" ? base30d : base7d;
  if (!filters.model && !filters.source) return selected;

  let factor = 1;
  if (filters.model) {
    const match = selected.byModel.find((item) => item.modelId === filters.model);
    factor *= match ? match.share : 0;
  }
  if (filters.source) {
    const match = selected.bySource.find((item) => item.source === filters.source);
    factor *= match ? match.share : 0;
  }

  const scale = (n: number) => Math.round(n * factor);
  const filteredCalls = selected.recentCalls.filter((call) => {
    if (filters.model && call.modelId !== filters.model) return false;
    if (filters.source && call.source !== filters.source) return false;
    return true;
  });
  const filteredBySource = (filters.source
    ? selected.bySource.filter((s) => s.source === filters.source)
    : selected.bySource
  ).map((s) => ({
    ...s,
    calls: Math.max(filters.model ? 1 : 0, Math.round(s.calls * (filters.model ? factor : 1))),
    inputTokens: Math.round(s.inputTokens * (filters.model ? factor : 1)),
    outputTokens: Math.round(s.outputTokens * (filters.model ? factor : 1)),
    cacheReadTokens: Math.round(s.cacheReadTokens * (filters.model ? factor : 1)),
    totalTokens: Math.round(s.totalTokens * (filters.model ? factor : 1)),
    share: filters.source ? 1 : s.share,
  }));

  return {
    ...selected,
    totals: {
      ...selected.totals,
      calls: Math.max(factor > 0 ? 1 : 0, scale(selected.totals.calls)),
      inputTokens: scale(selected.totals.inputTokens),
      outputTokens: scale(selected.totals.outputTokens),
      cacheReadTokens: scale(selected.totals.cacheReadTokens),
      cacheWriteTokens: scale(selected.totals.cacheWriteTokens),
      totalTokens: scale(selected.totals.totalTokens),
      costUsd:
        selected.totals.costUsd !== null && factor > 0
          ? Math.round(selected.totals.costUsd * factor * 100) / 100
          : null,
    },
    trend: selected.trend.map((pt) => ({
      ...pt,
      calls: scale(pt.calls),
      inputTokens: scale(pt.inputTokens),
      outputTokens: scale(pt.outputTokens),
      cacheReadTokens: scale(pt.cacheReadTokens),
      cacheWriteTokens: scale(pt.cacheWriteTokens),
      totalTokens: scale(pt.totalTokens),
      costUsd: pt.costUsd !== null && factor > 0 ? Math.round(pt.costUsd * factor * 100) / 100 : null,
    })),
    bySource: filteredBySource,
    recentCalls: filteredCalls,
  };
}

export function mockUpdateDailyTokenBudget(
  dailyTokenBudget: number | null,
): { budget: UsageBudgetState } {
  mockDailyTokenBudget = dailyTokenBudget && dailyTokenBudget > 0 ? Math.trunc(dailyTokenBudget) : null;
  const now = Date.now();
  return {
    budget: {
      dailyTokenBudget: mockDailyTokenBudget,
      todayTokens: 194_200,
      lastAlertDate:
        mockDailyTokenBudget !== null && 194_200 >= mockDailyTokenBudget
          ? new Date(now).toISOString().slice(0, 10)
          : null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 后台任务（Routines / Watchers / Watch digest / Reminders）           */
/* ------------------------------------------------------------------ */

type MockAutomationsState = {
  routines: RoutineItem[];
  watchers: WatcherItem[];
  digestItems: WatchDigestItem[];
  reminders: ReminderItem[];
  nextRunId: number;
};

function createInitialMockAutomations(): MockAutomationsState {
  const now = Date.now();
  const hour = 3_600_000;
  const day = 24 * hour;
  const iso = (ms: number) => new Date(ms).toISOString();

  return {
    nextRunId: 200,
    routines: [
      {
        id: 101,
        chatId: MOCK_OWNER_ID,
        title: "每日 AI 与开源简报",
        timezone: "Asia/Shanghai",
        mode: "agent",
        brief: "汇总过去 24 小时 AI 模型发布、GitHub 趋势与重要架构博文，过滤营销软文，仅在有实质进展时汇报。",
        text: null,
        delivery: "report",
        status: "active",
        conversationId: 12,
        consecutiveFailures: 0,
        lastError: null,
        createdAt: iso(now - 14 * day),
        updatedAt: iso(now - 6 * hour),
        schedule: {
          routineId: 101,
          kind: "daily",
          spec: { kind: "daily", at: "09:00" },
          nextDueAt: iso(now + 10 * hour),
          lastRunAt: iso(now - 14 * hour),
        },
        recentRuns: [
          {
            id: 195,
            routineId: 101,
            runKey: "sched:today",
            trigger: "schedule",
            status: "succeeded",
            scheduledFor: iso(now - 14 * hour),
            notBefore: null,
            startedAt: iso(now - 14 * hour),
            finishedAt: iso(now - 14 * hour + 18_000),
            reply: "今日重点：1) TypeScript 5.9 RC 发布，显著优化增量构建；2) SQLite 3.50 改善 WAL 并发读性能。",
            errorCode: null,
            attempts: 1,
            leaseUntil: null,
            createdAt: iso(now - 14 * hour),
          },
          {
            id: 191,
            routineId: 101,
            runKey: "sched:yesterday",
            trigger: "schedule",
            status: "suppressed",
            scheduledFor: iso(now - 38 * hour),
            notBefore: null,
            startedAt: iso(now - 38 * hour),
            finishedAt: iso(now - 38 * hour + 11_000),
            reply: "NO_REPORT",
            errorCode: null,
            attempts: 1,
            leaseUntil: null,
            createdAt: iso(now - 38 * hour),
          },
          {
            id: 186,
            routineId: 101,
            runKey: "sched:2days-ago",
            trigger: "schedule",
            status: "failed",
            scheduledFor: iso(now - 62 * hour),
            notBefore: null,
            startedAt: iso(now - 62 * hour),
            finishedAt: iso(now - 62 * hour + 45_000),
            reply: null,
            errorCode: "UPSTREAM_TIMEOUT",
            attempts: 2,
            leaseUntil: null,
            createdAt: iso(now - 62 * hour),
          },
        ],
      },
      {
        id: 102,
        chatId: MOCK_OWNER_ID,
        title: "周五晚间工作复盘提醒",
        timezone: "Asia/Shanghai",
        mode: "notify",
        brief: null,
        text: "本周收尾啦，记得整理下周优先级并同步项目进度。",
        delivery: "always",
        status: "paused",
        conversationId: null,
        consecutiveFailures: 0,
        lastError: null,
        createdAt: iso(now - 30 * day),
        updatedAt: iso(now - 2 * day),
        schedule: {
          routineId: 102,
          kind: "weekly",
          spec: { kind: "weekly", days: [5], at: "18:00" },
          nextDueAt: iso(now + 3 * day),
          lastRunAt: iso(now - 4 * day),
        },
        recentRuns: [
          {
            id: 180,
            routineId: 102,
            runKey: "sched:last-fri",
            trigger: "schedule",
            status: "succeeded",
            scheduledFor: iso(now - 4 * day),
            notBefore: null,
            startedAt: iso(now - 4 * day),
            finishedAt: iso(now - 4 * day + 400),
            reply: "本周收尾啦，记得整理下周优先级并同步项目进度。",
            errorCode: null,
            attempts: 1,
            leaseUntil: null,
            createdAt: iso(now - 4 * day),
          },
        ],
      },
    ],
    watchers: [
      {
        id: 201,
        chatId: MOCK_OWNER_ID,
        threadTs: null,
        kind: "feed",
        target: "https://openai.com/news/rss.xml",
        label: "OpenAI & Anthropic 官方博客",
        status: "active",
        maxEventsPerHour: 10,
        deliveryMode: "triage",
        triagePrompt: "仅关注新模型发布、API 价格变化与重要工程博客，跳过市场活动公告。",
        createdAt: iso(now - 10 * day),
        stoppedAt: null,
        source: {
          id: 301,
          watcherId: 201,
          kind: "feed",
          location: "https://openai.com/news/rss.xml",
          mode: "poll",
          status: "active",
          intervalSec: 900,
          nextCheckAt: iso(now + 8 * 60_000),
          reconcileAt: null,
          failures: 0,
          lastError: null,
          lastCheckAt: iso(now - 7 * 60_000),
        },
      },
      {
        id: 202,
        chatId: MOCK_OWNER_ID,
        threadTs: null,
        kind: "github_run",
        target: "NaoYUN77/Aster",
        label: "Aster 主分支 CI 构建",
        status: "active",
        maxEventsPerHour: 20,
        deliveryMode: "direct",
        triagePrompt: null,
        createdAt: iso(now - 5 * day),
        stoppedAt: null,
        source: {
          id: 302,
          watcherId: 202,
          kind: "github_run",
          location: "NaoYUN77/Aster",
          mode: "push",
          status: "active",
          intervalSec: 900,
          nextCheckAt: null,
          reconcileAt: iso(now + 12 * 60_000),
          failures: 0,
          lastError: null,
          lastCheckAt: iso(now - 3 * 60_000),
        },
      },
      {
        id: 203,
        chatId: MOCK_OWNER_ID,
        threadTs: null,
        kind: "x",
        target: "@karpathy",
        label: "X · @karpathy",
        status: "active",
        maxEventsPerHour: 10,
        deliveryMode: "triage",
        triagePrompt: "关注开源项目、训练方法论和长文笔记。",
        createdAt: iso(now - 8 * day),
        stoppedAt: null,
        source: {
          id: 303,
          watcherId: 203,
          kind: "x",
          location: "https://x.com/karpathy",
          mode: "poll",
          status: "backoff",
          intervalSec: 600,
          nextCheckAt: iso(now + 24 * 60_000),
          reconcileAt: null,
          failures: 2,
          lastError: "WATCH_RATE_LIMITED",
          lastCheckAt: iso(now - 18 * 60_000),
        },
      },
    ],
    digestItems: [
      {
        id: 401,
        watcherId: 201,
        eventId: 901,
        chatId: MOCK_OWNER_ID,
        threadTs: null,
        text: "OpenAI & Anthropic 官方博客：发布 Agent Tool Use 评测基准更新（新增多步工具编排指标）",
        status: "queued_digest",
        attempts: 1,
        createdAt: iso(now - 2 * hour),
        triageAction: "digest",
        triageReason: "属于工程评测更新，非紧急突发事件，已纳入每日简报队列",
        triageUrgent: false,
      },
      {
        id: 402,
        watcherId: 203,
        eventId: 902,
        chatId: MOCK_OWNER_ID,
        threadTs: null,
        text: "X · @karpathy：分享本地 LLM 推理上下文压缩的实测笔记与内存占用对比",
        status: "queued_digest",
        attempts: 1,
        createdAt: iso(now - 50 * 60_000),
        triageAction: "digest",
        triageReason: "高质量技术随笔，静默时段暂存等待明日早报汇总",
        triageUrgent: false,
      },
    ],
    reminders: [
      {
        id: 501,
        chatId: MOCK_OWNER_ID,
        ownerId: MOCK_OWNER_ID,
        content: "准备明天上午的开源一键部署架构方案评审",
        dueAt: iso(now + 11 * hour),
        timezone: "Asia/Shanghai",
        createdAt: iso(now - 3 * hour),
        status: "pending",
        attempts: 0,
        messageId: null,
        sentAt: null,
        failureCode: null,
      },
      {
        id: 502,
        chatId: MOCK_OWNER_ID,
        ownerId: MOCK_OWNER_ID,
        content: "确认 Exa API Key 的月度用量账单与额度上限",
        dueAt: iso(now + 2 * day),
        timezone: "Asia/Shanghai",
        createdAt: iso(now - day),
        status: "pending",
        attempts: 0,
        messageId: null,
        sentAt: null,
        failureCode: null,
      },
    ],
  };
}

let mockAutomations: MockAutomationsState = createInitialMockAutomations();

export function mockGetAutomations(): AutomationsResponse {
  return {
    routines: {
      enabled: true,
      paused: false,
      items: mockAutomations.routines.map((r) => ({
        ...r,
        schedule: { ...r.schedule },
        recentRuns: r.recentRuns.map((run) => ({ ...run })),
      })),
    },
    watchers: {
      enabled: true,
      quietHours: "23:00-08:00",
      digestTime: "08:30",
      timezone: "Asia/Shanghai",
      items: mockAutomations.watchers.map((w) => ({
        ...w,
        source: { ...w.source },
      })),
      digest: {
        items: mockAutomations.digestItems.map((d) => ({ ...d })),
      },
    },
    reminders: {
      enabled: true,
      items: mockAutomations.reminders.map((r) => ({ ...r })),
    },
  };
}

export function mockSetRoutineStatus(
  id: number,
  status: "active" | "paused",
): { ok: true; routine: RoutineItem } | { ok: false; code: string; message: string; status: number } {
  const item = mockAutomations.routines.find((r) => r.id === id);
  if (!item) {
    return { ok: false, code: "ROUTINE_NOT_FOUND", message: "没有找到该定时任务", status: 404 };
  }
  item.status = status;
  item.updatedAt = new Date().toISOString();
  return { ok: true, routine: { ...item, recentRuns: [...item.recentRuns] } };
}

export function mockRunRoutineNow(
  id: number,
): { ok: true; run: RoutineRunItem } | { ok: false; code: string; message: string; status: number } {
  const item = mockAutomations.routines.find((r) => r.id === id);
  if (!item) {
    return { ok: false, code: "ROUTINE_NOT_FOUND", message: "没有找到该定时任务", status: 404 };
  }
  if (item.status !== "active") {
    return { ok: false, code: "ROUTINE_PAUSED", message: "该定时任务已暂停，请先恢复后再运行", status: 409 };
  }
  const nowIso = new Date().toISOString();
  const run: RoutineRunItem = {
    id: ++mockAutomations.nextRunId,
    routineId: item.id,
    runKey: `manual:${Date.now()}`,
    trigger: "manual",
    status: "queued",
    scheduledFor: null,
    notBefore: null,
    startedAt: null,
    finishedAt: null,
    reply: null,
    errorCode: null,
    attempts: 0,
    leaseUntil: null,
    createdAt: nowIso,
  };
  item.recentRuns = [run, ...item.recentRuns].slice(0, 5);
  return { ok: true, run };
}

export function mockDeleteRoutine(
  id: number,
): { ok: true; id: number } | { ok: false; code: string; message: string; status: number } {
  const idx = mockAutomations.routines.findIndex((r) => r.id === id);
  if (idx === -1) {
    return { ok: false, code: "ROUTINE_NOT_FOUND", message: "没有找到该定时任务", status: 404 };
  }
  mockAutomations.routines.splice(idx, 1);
  return { ok: true, id };
}

export function mockStopWatcher(
  id: number,
): { ok: true; id: number } | { ok: false; code: string; message: string; status: number } {
  const idx = mockAutomations.watchers.findIndex((w) => w.id === id);
  if (idx === -1) {
    return { ok: false, code: "WATCHER_NOT_FOUND", message: "没有找到运行中的监控任务", status: 404 };
  }
  mockAutomations.watchers.splice(idx, 1);
  return { ok: true, id };
}

export function mockFlushWatchDigest(): { count: number; text: string } {
  const items = mockAutomations.digestItems;
  if (items.length === 0) {
    return { count: 0, text: "" };
  }
  const count = items.length;
  const lines = items.map((item, i) => `${i + 1}. ${item.text}`);
  const text = `【监控简报汇总 · 共 ${count} 条】\n${lines.join("\n")}`;
  mockAutomations.digestItems = [];
  const msg: UiMessage = {
    id: `host_digest_${Date.now()}`,
    role: "assistant",
    text,
    createdAt: Date.now(),
    status: "complete",
    requestId: null,
    clientMessageId: null,
    model: null,
    errorCode: null,
    tool: null,
  };
  state.messages.push(msg);
  persist();
  emit("host.message", { message: msg, source: "watch" });
  return { count, text };
}

export function mockCancelReminder(
  id: number,
): { ok: true; reminder: ReminderItem } | { ok: false; code: string; message: string; status: number } {
  const idx = mockAutomations.reminders.findIndex((r) => r.id === id);
  if (idx === -1) {
    return { ok: false, code: "REMINDER_NOT_FOUND", message: "没有找到该提醒", status: 404 };
  }
  const [removed] = mockAutomations.reminders.splice(idx, 1);
  return { ok: true, reminder: { ...removed!, status: "cancelled" } };
}

export { MOCK_FALLBACK, MOCK_PRIMARY };

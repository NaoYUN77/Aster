# Aster 三端联通 v1 架构方案

- 状态：Draft，供 Dev 1 / Dev 2 开工使用
- 日期：2026-11-16（Asia/Shanghai）
- 基线分支：`feat/三端联通`（从 `origin/main` 的 `8eb542a` 拉出）
- 本轮范围：架构文档 + 分支。**本分支不写产品实现代码。**
- 验收时间：2026-11-17，Jay 验收

---

## 0. 硬约束（所有 Dev 必须先读）

### 0.1 生产 bot 绝对不能被影响

当前正在跑、已经好用的生产 Aster bot **不停机、不重启、不替换、不重新部署**。

本轮及后续开发必须遵守：

1. 所有新工作只在 `feat/三端联通` 及其派生分支上进行。
2. 不部署到生产；不执行生产环境的 `docker compose up/down/restart`、`systemctl restart`、进程 kill 等操作。
3. 不动生产机上的 `.env`、数据目录、SQLite 文件、`model-selection.json`、workspace、memory、反向代理配置。
4. 本地开发和联调使用**独立数据目录、独立端口、独立 Compose project name / volume**。禁止把开发进程指到生产 `DATA_DIR`。
5. 验证和联调不能以停掉现网 bot 为代价。需要真实模型调用时，使用开发用 key 和开发数据目录；不要复用生产会话或生产凭据。
6. 需要远程机器验证时，使用单独的用户/端口/目录，并先获得 Jay 明确同意；今晚默认只在本机验证。
7. Dev 分支不要改生产部署文件；如必须调整 Compose/Caddy，只新增 `deploy/web/` 下的独立文件，并在文档里标明“不得用于生产现网”。

### 0.2 不编造模型 id

模型列表、可选范围、故障转移、`$model` 行为全部复用现有实现和运行时目录：

- 只展示运行时 `models` 目录里真实存在的模型。
- 只允许 `selectableModels()` 认可的 OpenCode / Command Code 条目。
- 不硬编码任何模型 id；测试用 fixture，不用真实目录猜 id。
- 选择模型的 HTTP 接口与 `$model` 文本命令必须共用同一套策略，不得各写一份。

### 0.3 已锁定前提（不要改回去）

- 单 owner、自托管；不做多用户、多租户、注册、邀请、权限组。
- 第一版不做 Live2D / 虚拟形象 / 贴纸包 / TTS。
- 继续复用现有 Node/Aster 核心；新增 Fastify + REST/SSE 接入层；**不用 Rust 重写 agent/后端**。
- 三端：Web（Vite + React + TypeScript + Tailwind + shadcn/ui + assistant-ui）、桌面（Tauri 包同一套 Web）、手机（Capacitor 包同一套 Web）。
- 去掉多人 Hub / member / fork 路径；Web 模式不创建 `HubStore`。
- 第一版只做文本对话；不做语音、图片、文件、贴纸。

---

## 1. 第一版目标与非目标

### 1.1 目标

一个 Jay 自己用的、可自托管的三端聊天客户端：

1. 单 owner 登录。
2. 发文本消息，看到“排队 / 正在回复 / 完成 / 失败 / 已停止”状态。
3. 查看历史消息；刷新、断线重连后不丢。
4. 可以停止当前回复。
5. 三端都能通过按钮/下拉框查看并切换模型，行为与 `$model` 一致。
6. 桌面端、手机端可以配置服务器地址。
7. 一条 Docker Compose 命令部署到自己的 VPS；生产现网 bot 不受影响。

### 1.2 非目标（v1 明确不做）

- 多用户、注册、邀请、团队、角色权限。
- Live2D、虚拟形象、贴纸、表情包、语音。
- 图片/文件上传、多模态输入。
- 多会话列表、会话重命名、会话删除。v1 只有 owner 的主会话。
- 记忆系统重设计；继续使用 Aster 现有记忆骨架。
- 工具调用的完整可视化；v1 只做紧凑状态，不展示原始参数。
- Rust 重写、Rust 网关、Rust sidecar。
- 应用商店上架、推送通知、离线模型。
- 自动更新、灰度发布、生产监控大盘。
- 把 Telegram/Slack 渠道删掉或重构；v1 只新增 web 模式，旧渠道代码保持可用但不在 web 部署中启用。

---

## 2. 总体架构

```text
┌──────────────────────────────┐
│ Web (Vite/React/TS/Tailwind) │
│  shared UI + API client      │
└──────────────┬───────────────┘
               │ 同一套 web/dist
     ┌─────────┴─────────┐
     │                   │
┌────▼─────┐       ┌─────▼──────┐
│ Tauri    │       │ Capacitor  │
│ desktop  │       │ iOS/Android│
└────┬─────┘       └─────┬──────┘
     │  HTTPS + Bearer    │
     └─────────┬──────────┘
               │
        ┌──────▼──────────────────────────┐
        │ Caddy (TLS, 反代, SSE 不缓冲)    │
        └──────┬──────────────────────────┘
               │
        ┌──────▼──────────────────────────┐
        │ Fastify 5 Web Adapter            │
        │  auth / messages / models / SSE   │
        │  single-owner worker              │
        └──────┬──────────────────────────┘
               │ 复用现有 Node/Aster 核心
        ┌──────▼──────────────────────────┐
        │ openAgent()                      │
        │  pi-durable / tools / memory     │
        │  model catalog / failover / $model│
        └──────┬──────────────────────────┘
               │
        ┌──────▼──────────────────────────┐
        │ data-web/                        │
        │  agent.sqlite / web.sqlite       │
        │  model-selection.json / memory   │
        └─────────────────────────────────┘
```

核心原则：

- **一个 React 应用**，三端共用；Tauri/Capacitor 只做壳，不复制 UI。
- **一个 Fastify 接入层**，不碰 agent 内部；通过 `openAgent()` 的公开方法调用。
- **一个模型策略**：HTTP 模型接口与 `$model` 共用 `model-policy` + `model-failover` + `model-selection.json`。
- **单 owner 串行**：同一时刻只处理一个 agent 请求；多端发来的请求排队，避免并发写同一会话。
- **生产隔离**：web 部署使用独立 `DATA_DIR`、端口、Compose 项目名、volume。

---

## 3. 仓库结构与分支策略

### 3.1 目录结构

```text
Aster/
├─ src/                         # 现有 Node 后端
│  ├─ http/                     # 新增：Web 接入层（Dev 1）
│  │  ├─ server.ts              # Fastify 实例、插件、静态资源、优雅关闭
│  │  ├─ config.ts              # WEB_* 环境变量解析（或并入 src/config.ts）
│  │  ├─ auth.ts                # 登录、token、scrypt、会话
│  │  ├─ requests.ts            # web_requests 表 + 单 worker
│  │  ├─ routes/
│  │  │  ├─ auth.ts
│  │  │  ├─ messages.ts
│  │  │  ├─ models.ts
│  │  │  ├─ events.ts           # SSE
│  │  │  └─ health.ts
│  │  ├─ projection.ts          # durable transcript -> UI message
│  │  ├─ model-service.ts       # 与 $model 共用的模型选择服务
│  │  └─ openapi.ts             # 生成 OpenAPI 文档 / 契约
│  ├─ model-command.ts          # 现有；抽出共享选择逻辑
│  ├─ model-failover.ts         # 现有；增加 onModelUsed 回调
│  ├─ model-policy.ts           # 现有；不改选择范围
│  ├─ config.ts                 # 增加 CHANNEL=web 与 WEB_*
│  ├─ main.ts                   # web 模式启动 HTTP，不启动 Telegram/Slack
│  └─ agent.ts                  # 增加历史读取 / 模型元数据钩子；web 模式不建 Hub
├─ web/                         # 新增：三端共享前端（Dev 2）
│  ├─ package.json
│  ├─ vite.config.ts
│  ├─ index.html
│  ├─ src/
│  │  ├─ api/                   # 生成的 API client + SSE client
│  │  ├─ app/                   # 路由、布局、登录态
│  │  ├─ components/            # 通用 UI（shadcn/ui）
│  │  ├─ features/chat/         # 消息列表、输入框、状态、停止
│  │  ├─ features/models/       # ModelPicker、降级提示
│  │  ├─ features/settings/     # 服务器地址、退出登录
│  │  └─ lib/                   # token store、平台适配、格式化
│  ├─ src-tauri/                # Tauri 2 桌面壳
│  ├─ capacitor.config.ts       # Capacitor 壳
│  ├─ android/                  # 生成后提交或按团队约定
│  └─ ios/                      # 生成后提交或按团队约定
├─ deploy/
│  └─ web/
│     ├─ docker-compose.yml     # 独立 project：aster-web
│     ├─ Caddyfile
│     └─ .env.example
├─ docs/
│  ├─ architecture/three-client-v1.md
│  └─ api/three-client-v1.openapi.yaml   # Dev 1 先交付契约
└─ test/                        # 现有测试；新增 http 测试
```

约定：

- `web/` 是**独立的 npm 项目**，有自己的 `package-lock.json`。v1 不引入 npm workspaces / pnpm / turborepo，避免动根 `package-lock.json` 和现有 CI。
- 根 `package.json` 只增加便捷脚本，例如 `web:dev`、`web:build`，不把前端依赖装进后端。
- Tauri/Capacitor 工程放在 `web/` 内，构建输入固定为 `web/dist`。
- 不在 `src/http/` 里直接操作 `agent.sqlite`；历史读取走 agent 的只读接口，请求状态走 `web.sqlite`。

### 3.2 分支策略

```text
main
 └─ feat/三端联通                    # 本文档 + API 契约，不写产品代码
     ├─ feat/三端联通-server         # Dev 1：Fastify + Aster 接入
     └─ feat/三端联通-client         # Dev 2：web/ + Tauri + Capacitor
```

规则：

1. `feat/三端联通` 只提交架构文档和 API 契约；不合并到 `main`，不部署。
2. Dev 1、Dev 2 从 `feat/三端联通` 拉自己的分支；PR 目标为 `feat/三端联通`，不是 `main`。
3. 契约优先：Dev 1 先提交 `docs/api/three-client-v1.openapi.yaml` 和错误码表，Dev 2 据此生成 client；后端未完成前 Dev 2 用 mock。
4. 两边不交叉改文件：Dev 1 只改 `src/**`、`deploy/web/**`、`test/**`；Dev 2 只改 `web/**`、`docs/**` 中前端说明。共享契约由 Dev 1 维护，Dev 2 提 issue/评论，不直接改后端。
5. 合并到 `main`、生产部署、打 tag 都必须等 Jay 明天验收后另行决定。
6. 本地检查：`npm run check`、`npm test`、`web` 的 `npm run build`。不要触发任何部署 workflow。

---

## 4. 后端接入层（Dev 1）

### 4.1 运行模式：新增 `CHANNEL=web`

现有配置只接受 Telegram/Slack。Web 产品不需要这两个渠道，因此新增第三种运行模式：

```text
CHANNEL=web
WEB_OWNER_ID=owner            # 默认 owner，仅作为内部 senderId
DATA_DIR=/data                # 必须是独立目录
WEB_PORT=8787
WEB_HOST=0.0.0.0
WEB_ALLOWED_ORIGINS=...       # 桌面/手机 WebView 的 origin 白名单
WEB_SESSION_TTL_DAYS=30
```

行为：

- `CHANNEL=web` 时不需要 Telegram/Slack token；`main.ts` 不启动 Telegram/Slack 轮询，不创建 `HubStore`。
- `config.channel` 增加 `{ kind: "web", ownerId }`；`agent.reply()` 的 `senderId` 使用 `WEB_OWNER_ID`。
- Telegram/Slack 代码保持原样，不在本轮重构；web 模式只是不实例化它们。
- 旧的 `CHANNEL=telegram|slack` 行为不变，避免影响生产分支。
- 一个 `DATA_DIR` 只能有一个进程（现有 flock 语义不变）；开发/测试必须用独立目录。

### 4.2 Fastify 组成

新增依赖（根 `package.json`）：

- `fastify@5`
- `@fastify/static`：托管 `web/dist`
- `@fastify/cors`：桌面/手机跨 origin
- `@fastify/rate-limit`：登录限流
- `@fastify/helmet`：安全头（CSP 由 Caddy/静态层配合）
- 生成 OpenAPI 可用 `@fastify/swagger`（仅开发/文档，不作为运行时必需）

不引入：

- 不加 ORM；继续用 `node:sqlite`。
- 不加 Redis/消息队列；单 owner 用进程内串行 worker + SQLite 足够。
- 不加 WebSocket；v1 用 SSE。
- 不加 Better Auth；单 owner 用 scrypt + 不透明 token 更简单。

### 4.3 认证

单 owner，不做注册。

**凭据初始化：**

- 新增 CLI：`npm run web:set-password`。
- 交互式读取密码（隐藏输入），用 `node:crypto` 的 `scrypt` 生成 hash，写入 `DATA_DIR/web-auth.json`（权限 0600）。
- 不把明文密码写入环境变量、shell history、日志或仓库。
- 不在 HTTP 上暴露“首次设置密码”接口。

**登录：**

- `POST /api/v1/auth/login`，body `{ "password": "..." }`。
- 校验 scrypt；成功后生成 32 字节随机 token（base64url），只把 `sha256(token)` 存入 `web_sessions`。
- 返回 `{ token, expiresAt }`；服务端不存明文 token。
- 登录限流：每 IP 每分钟 5 次；失败不区分“用户不存在/密码错误”。
- `POST /api/v1/auth/logout` 撤销当前 token。
- `GET /api/v1/auth/me` 返回 `{ ownerId, expiresAt }`。

**鉴权：**

- 所有 `/api/v1/*`（除 `/health`、`/auth/login`）要求 `Authorization: Bearer <token>`。
- token 过期或撤销返回 401；client 清 token 回登录页。
- 不做 cookie/session；三端统一 Bearer，避免 cookie/CORS/SameSite 在 Tauri/Capacitor 里的差异。
- Web 的 token 存储见 5.3；XSS 风险用 CSP、Markdown 白名单、无第三方脚本控制。

**会话表（`web.sqlite`）：**

```sql
web_sessions(
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  label TEXT
)
```

多设备登录允许；v1 不做设备管理页。

### 4.4 请求生命周期

单 owner，单会话，串行处理。

**提交消息：**

`POST /api/v1/messages`

```json
{
  "clientMessageId": "uuid-from-client",
  "text": "你好"
}
```

返回 `202`：

```json
{
  "requestId": "req_...",
  "status": "queued"
}
```

规则：

- `clientMessageId` 幂等：同一 client 重复提交返回同一 `requestId`，不重复入队。
- `text` 长度限制（例如 32k 字符）；空文本拒绝。
- 入队写 `web_requests`，状态 `queued`。
- 单 worker FIFO 取 `queued`，置 `running`，调用 `agent.reply({ requestId, conversationId: "owner", senderId: ownerId, text }, signal)`。
- 同一时刻只允许一个 `running`；多端同时发消息会排队。
- 成功后写 `done` + 最终文本 + 实际模型元数据；失败写 `failed` + 错误码。
- 不把最终文本当历史唯一来源；历史仍来自 durable transcript。`web_requests` 只做请求状态、幂等和短期重试。

**停止：**

`POST /api/v1/requests/:requestId/abort`

- 仅允许停止 `queued` 或 `running` 的当前请求。
- 调用 `agent.abort()`；将请求置 `aborted`。
- 由于是单会话，abort 影响当前对话的正在执行任务；queued 的后续请求保留，worker 继续下一个。
- 若 agent 已经产出一部分 durable 内容，历史以 transcript 为准；UI 显示“已停止”。

**重启恢复：**

- 启动时把 `running` 置为 `failed`，错误码 `PROCESS_INTERRUPTED`，不自动重放。
- `queued` 保留，worker 继续处理。
- 原因：durable 执行可能已经完成一半，自动重放可能产生重复轮次；v1 让用户手动重试更安全。
- UI 对 `PROCESS_INTERRUPTED` 显示“服务重启，请重试”。

**请求表（`web.sqlite`）：**

```sql
web_requests(
  request_id TEXT PRIMARY KEY,
  client_message_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL,          -- queued|running|done|failed|aborted
  reply TEXT,
  error_code TEXT,
  error_message TEXT,
  requested_model TEXT,          -- 请求开始时的选择（JSON 或 label）
  actual_model TEXT,             -- 实际回答模型
  model_kind TEXT,               -- primary|manual|auto
  degraded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
)
```

- `client_message_id` 建唯一索引（或与 owner 组合唯一）。
- 定期清理 30 天前的终态记录；历史不依赖该表。
- 不在此表存 provider key、工具参数、原始异常堆栈。

### 4.5 历史消息

**原则：durable transcript 是唯一历史源，不复制一份消息表。**

- 使用 pi-durable 的 `Conversation.entries()` / `ConversationTranscript` 读取。
- 在 `agent.ts` 增加只读方法，例如 `history({ before, limit })`，返回投影后的 UI 消息；不要暴露内部 Entry 结构给 HTTP 层。
- `src/http/projection.ts` 负责映射：
  - 用户文本、助手文本：完整展示。
  - 工具调用/结果：v1 只给紧凑摘要（工具名 + 成功/失败），不展示原始参数；可作为折叠行或直接隐藏。
  - 系统/压缩/内部条目：不展示。
  - 失败轮次：如果 transcript 有对应错误，标记 `status: "failed"`。
- 分页：`GET /api/v1/messages?before=<cursor>&limit=30`，返回 `{ messages, nextCursor, hasMore }`。
- `before` 使用稳定的 entry cursor（entry id 或时间+id），不要用数组下标。
- 如果现有公开 API 不足以读取，Dev 1 可以在 `agent.ts` 加薄封装；**不要**新建第二套消息表。

**UI 消息结构（契约）：**

```json
{
  "id": "entry_...",
  "role": "user | assistant | system",
  "text": "...",
  "createdAt": 1730000000000,
  "status": "complete | failed | aborted",
  "requestId": "req_...",
  "model": { "id": "...", "label": "..." },
  "errorCode": null,
  "tool": { "name": "...", "status": "done | failed" }
}
```

- `model` 仅助手消息有；历史里如果拿不到实际模型，可省略。
- `tool` 仅用于紧凑展示，不返回参数。

### 4.6 SSE

**端点：** `GET /api/v1/events`

- `Authorization: Bearer`；EventSource 不能带 header，所以前端用 `fetch` + `ReadableStream` 解析 SSE。
- `Content-Type: text/event-stream`；`Cache-Control: no-cache`；`X-Accel-Buffering: no`。
- 每 15 秒发 `: heartbeat` 注释，防代理断流。
- 连接建立后先发 `snapshot` 事件：当前 `running` 请求、最近事件游标、模型选择版本。
- 断线重连：客户端重新拉历史 + `snapshot`；v1 不做完整事件回放。
- 多端同时连接：每个连接独立；事件广播给所有连接。

**事件类型：**

| event | data | 说明 |
|---|---|---|
| `snapshot` | `{ activeRequest, modelVersion }` | 建连时 |
| `request.queued` | `{ requestId, clientMessageId }` | 已入队 |
| `request.running` | `{ requestId }` | 开始调用 agent |
| `request.done` | `{ requestId, message, model }` | 完成；`message` 为投影后的助手消息 |
| `request.failed` | `{ requestId, code, message }` | 失败；`code` 如 `MODEL_UNAVAILABLE` |
| `request.aborted` | `{ requestId }` | 已停止 |
| `model.changed` | `{ current, version }` | 任一端切换模型后广播 |
| `heartbeat` | `{ ts }` | 可选，或直接用 SSE 注释 |

`request.done.model`：

```json
{
  "requested": { "id": "...", "label": "...", "kind": "manual" },
  "actual": { "id": "...", "label": "..." },
  "kind": "primary | manual | auto",
  "degraded": true
}
```

- `degraded` 仅在“请求开始时是手动选择，实际用了别的模型”时为 true。
- 自动降级（没有手动选择）`degraded=false`，UI 不弹打扰性提示；可只在消息角标显示实际模型。
- 整条链失败：`request.failed` + `MODEL_UNAVAILABLE`，不清除已选模型。

v1 **不做 token 级流式输出**：`request.running` 后前端显示“正在回复”，完成时一次性拿最终文本。后续可在不改协议的情况下增加 `request.delta`。

### 4.7 模型接口（核心）

目标：三端用按钮/下拉框选模型，行为与 `$model` 完全一致。

#### 4.7.1 与 `$model` 共用策略

现有代码：

- `src/model-policy.ts`：`selectableModels()`、`isSelectableModel()`、供应商前缀、家族、排除 speed variant。
- `src/model-failover.ts`：`createModelSwitchStore()`、`model-selection.json`、sticky、降级、`MODEL_UNAVAILABLE_MESSAGE`。
- `src/model-command.ts`：`parseModelCommand()`、`createModelCommandHandler()`。

要求：

- Dev 1 把 `model-command.ts` 里的“状态 / 列表 / 选择 / 切回主模型”抽成共享的 `ModelSelectionService`（`src/http/model-service.ts` 或 `src/model-control.ts`），文本命令和 HTTP 都调用它。
- 不允许 HTTP 层自己过滤模型或自己写 `model-selection.json`。
- 不允许硬编码模型 id 或家族列表；范围由 `model-policy.ts` 决定。
- `$model` 文本命令继续可用；Web 输入框发 `$model ...` 仍由 agent 现有 host 命令路径处理。
- 选择模型是 host 侧操作：不调用模型、不产生 durable 对话轮次。

#### 4.7.2 `GET /api/v1/models`

返回：

```json
{
  "canSelect": true,
  "current": {
    "provider": "opencode",
    "id": "opencode-go/...",
    "name": "...",
    "label": "...",
    "kind": "primary | manual | auto"
  },
  "primary": { "provider": "...", "id": "...", "name": "...", "label": "..." },
  "chain": [
    { "provider": "...", "id": "...", "label": "..." }
  ],
  "selectable": [
    {
      "provider": "opencode",
      "id": "opencode-go/...",
      "name": "...",
      "label": "...",
      "supplier": "opencode | commandcode",
      "family": "deepseek | glm | gemini-flash",
      "contextWindow": 1000000
    }
  ],
  "scope": {
    "suppliers": ["opencode", "commandcode"],
    "families": ["deepseek", "glm", "gemini-flash"],
    "excludesSpeedVariants": true
  }
}
```

规则：

- `selectable` 来自启动时真实 `models` 目录 + `selectableModels(models, provider)`；没有就返回空数组。
- `canSelect` 仅当配置了 `MODEL_FALLBACKS` 且 `switchStore` 存在；否则 false，UI 显示只读。
- `current.kind`：
  - 没有 `model-selection.json` 记录 → `primary`。
  - 手动选择 → `manual`。
  - 自动降级后 sticky → `auto`。
- `current` 必须是真实存在的目录条目；如果记录缺失/已下架，启动时按现有逻辑清除，并回退 primary。
- 不返回 API key、base URL、provider 内部配置。

#### 4.7.3 `POST /api/v1/models/select`

Body 二选一：

```json
{ "action": "select", "modelId": "opencode-go/..." }
```

```json
{ "action": "primary" }
```

行为：

- `select`：校验 `modelId` 在当前 `selectable` 中；通过后写 `model-selection.json`，`kind: "manual"`，返回新的 `GET /models` 结构。
- `primary`：清除选择（`state.clear()`），返回 primary。
- 不调用模型；不产生对话消息；不需要等待 agent。
- 如果请求正在进行：选择仍然写入，但当前请求继续用开始时捕获的模型；返回结果里带 `effective: "next_request"`，UI 提示“下一次回复生效”。
- 错误：
  - `MODEL_NOT_FOUND`：id 不在目录。
  - `MODEL_OUT_OF_SCOPE`：在目录但不在可选范围（供应商/家族/速度变体）。
  - `MODEL_SWITCH_DISABLED`：未配置 failover。
  - `INVALID_REQUEST`：action 不合法。
- 写文件失败返回 `SELECTION_WRITE_FAILED`，不改变内存状态。
- 成功后广播 `model.changed`。

#### 4.7.4 实际使用模型与降级

现有 `agent.reply()` 只返回最终文本，Web 层拿不到“实际用了哪个模型”。需要补一个最小钩子：

- 在 `createModelFailover` 的 options 增加可选 `onModelUsed(event)`；每次成功返回时回调：
  ```ts
  { requested, actual, kind: "primary" | "manual" | "auto", degraded: boolean }
  ```
- 或在 `agent.reply()` 返回值增加可选 `model` 元数据；优先选不改现有渠道返回类型的方案（回调）。
- Web worker 在请求开始时捕获 `requested`（`state.active()` 或 primary），完成后用回调/状态推导 `actual`。
- 不要通过解析回复文本里的“（X 不可用，本次由 Y 回答）”来还原模型；文本是给用户看的，不是协议。
- 现有 `MODEL_UNAVAILABLE_MESSAGE` / `MODEL_INCOMPATIBLE_MESSAGE` 保持原文；HTTP 映射为稳定错误码：
  - `MODEL_UNAVAILABLE` → “模型暂时不可用”
  - `MODEL_INCOMPATIBLE` → “所选模型不支持本次请求（例如包含图片），请先切换模型”（v1 无图片，保留映射）

### 4.8 Web 服务启动与关闭

- `main.ts` 在 `CHANNEL=web` 时：
  1. 读配置、初始化 trace、打开 agent。
  2. 初始化 `web.sqlite`（建表、WAL）。
  3. 启动 Fastify，注册路由、静态资源、CORS、限流。
  4. 启动单 worker。
  5. 注册 SIGINT/SIGTERM：停止接收新请求 → 等待当前请求最多 N 秒 → 关闭 SSE → 关闭 SQLite/agent。不要 kill 正在写 SQLite 的进程。
- 启动时检查 `DATA_DIR` 是否被其他进程占用（现有 flock 语义）；被占用则明确报错退出，不要抢占生产目录。
- `/api/v1/health` 无需鉴权，返回 `{ ok: true, version }`；不返回模型 key、路径、内部状态。

---

## 5. 三端共享前端（Dev 2）

### 5.1 一套代码

- `web/` 是唯一 UI 代码库；Tauri 和 Capacitor 只加载 `web/dist`。
- 不复制组件、不写两套登录页、不写两套模型选择器。
- 目录按 feature 分：`chat`、`models`、`settings`、`auth`。
- 组件库：shadcn/ui；样式：Tailwind；聊天原语：assistant-ui；数据请求：TanStack Query；轻量 UI 状态：Zustand（只放 token、连接状态、当前模型缓存；服务端数据用 Query）。

### 5.2 API client

- Dev 1 先交 OpenAPI；Dev 2 用 `openapi-typescript` + `openapi-fetch` 生成类型安全 client。
- 统一 `createApiClient({ baseUrl, token })`；所有端共用。
- SSE 不用 `EventSource`（不能带 Authorization），用 `fetch` + `ReadableStream` 手写解析；封装成 `subscribeEvents({ baseUrl, token, onEvent, signal })`。
- 错误统一映射为 `{ code, message }`；UI 只显示安全文案，不显示堆栈。
- 请求超时、断网、401、409、429 分别处理。

### 5.3 登录与 token 存储

- 登录页：密码输入 → `POST /auth/login` → 存 token → 进入聊天。
- `TokenStore` 抽象：
  - Web：`localStorage`（单 owner + 严格 CSP + 无第三方脚本；接受 XSS 残余风险）。
  - Tauri：`tauri-plugin-store` 或系统 keychain（优先 keychain；至少不要明文写普通文件）。
  - Capacitor：`@capacitor/preferences`；如接 secure storage 插件更好，v1 允许 Preferences 并在文档标注。
- 401 时清 token、回登录页；不清历史缓存（历史在服务端）。
- 退出登录调用 `/auth/logout` 并清本地 token。

### 5.4 服务器地址

- Web：默认同源（`window.location.origin`），不显示服务器地址输入；部署在 Caddy 后。
- Tauri：首次启动/设置页输入 `https://your-domain`；存 Tauri store；支持“测试连接”（`GET /health`）。
- Capacitor：首次启动/设置页输入地址；存 Preferences；支持测试连接。
- 地址规范化：去尾部 `/`，必须 `https://`（本地开发允许 `http://localhost`）；不把地址写死进构建产物。
- 连接失败显示可重试错误，不白屏。

### 5.5 聊天界面

- 顶部：标题、连接状态、模型按钮、设置/退出。
- 消息区：用户/助手气泡；assistant-ui 的 thread 组件；Markdown 白名单渲染；代码块可复制；不渲染原始 HTML。
- 工具调用：紧凑行“工具：xxx · 完成/失败”，可折叠；不显示参数。
- 输入区：多行文本、发送按钮、停止按钮（`running` 时显示）、字数限制。
- 状态：
  - `queued`：消息旁“排队中”。
  - `running`：打字指示器 + 停止。
  - `done`：正常显示。
  - `failed`：错误条 + 重试按钮（重试生成新 `clientMessageId`，避免与失败请求混淆）。
  - `aborted`：灰色“已停止”。
- 历史：进入页面拉最近 30 条；上滚加载更早；SSE `request.done` 后追加或替换本地临时消息。
- 多端：同一账号多端同时在线，任一端发消息，其他端通过 SSE 收到并追加；以服务端消息 id 去重。
- 刷新/重连：重新拉历史 + snapshot；不依赖内存事件回放。

### 5.6 模型选择 UI（三端同一组件）

**入口：**

- 聊天页顶部一个按钮，显示当前模型短标签 + 状态徽章。
- 点击打开 Popover（桌面）/ Bottom Sheet（手机）；三端共用 `ModelPicker`，响应式切换展示方式。

**展示：**

- 标题“模型”。
- 当前模型：名称 + id（等宽小字）+ 徽章：
  - `主模型`（primary）
  - `手动指定`（manual）
  - `自动降级`（auto）
- 当前默认链：按顺序列出 primary → fallbacks，标出当前实际使用的位置。
- 可选模型：按供应商分组（OpenCode / Command Code），组内按家族（DeepSeek / GLM / Gemini Flash）；每项显示名称 + id + 上下文窗口（有则显示）。
- 没有可选模型 / `canSelect=false`：显示“当前配置未启用模型切换”，只展示当前模型，不显示假列表。
- 列表只来自 `GET /models`；前端不硬编码、不猜测、不合并本地常量。

**操作：**

- 点选某个模型 → `POST /models/select {action:"select", modelId}`。
- “切回主模型” → `POST /models/select {action:"primary"}`。
- 成功后用响应更新当前模型，关闭选择器，Toast“已切换到 X（下一次回复生效）”或“已切换，下一次回复生效”。
- 失败：保留选择器，显示服务端错误码对应文案；不乐观更新当前模型。
- 请求进行中选择：允许，但提示“当前回复继续使用原模型，下一次生效”。
- `$model` 文本命令仍可用；如果用户在输入框发 `$model`，按普通消息走 agent host 命令，回复作为助手消息显示；模型变化后前端收到 `model.changed` 或在下一次 `GET /models` 刷新。

**降级/失败行为：**

- `request.done.model.degraded=true`：在该条助手消息上方显示一条非阻塞提示：
  “手动选择的 X 不可用，本次由 Y 回答。选择仍保持为 X。”
  不自动把 UI 改成 Y；下次请求仍先试 X（现有 sticky 语义）。
- 自动降级（`kind=auto` / 非手动）：只在消息角标显示实际模型，不弹 banner，不打扰。
- 整条链失败：`request.failed` + `MODEL_UNAVAILABLE`；消息区显示“模型暂时不可用”+ 重试；模型选择不清除，选择器仍显示原选择。
- `MODEL_INCOMPATIBLE`：显示服务端文案；v1 无图片入口，保留处理。
- 如果启动时选中的模型已下架：服务端清除并回退 primary；前端下次 `GET /models` 看到 primary，可显示一次“之前选择的模型已不可用，已回到主模型”（可选，不阻塞验收）。

**验收点：**

- 三端都能打开模型选择器。
- 列表项与 `$model list` 的实时可选范围一致。
- 切换到某模型后，下一次回复使用它；重启服务后仍保持（manual sticky）。
- “切回主模型”后恢复默认链。
- 手动模型失败时能看到降级提示；整条链失败时看到“模型暂时不可用”。
- 选择模型不产生一条聊天消息、不调用模型。

---

## 6. 部署（Docker Compose + Caddy + SQLite）

### 6.1 拓扑

```text
Internet
  │ 443
┌─▼──────────────┐
│ Caddy          │  自动 TLS / 反代 / SSE 不缓冲
└─┬──────────────┘
  │ 8787 (internal)
┌─▼──────────────┐
│ aster-web      │  Node 24 + Fastify + agent
│  /data volume  │  agent.sqlite / web.sqlite / memory
└────────────────┘
```

### 6.2 Compose 约定

- 文件：`deploy/web/docker-compose.yml`，`name: aster-web`（独立 project）。
- 服务：
  - `app`：构建根目录 Dockerfile（或 `deploy/web/Dockerfile`），`DATA_DIR=/data`，只暴露内部 8787。
  - `caddy`：暴露 80/443，挂载 Caddyfile 和证书卷。
- volume：`aster-web-data`，**不要**复用生产 volume。
- 环境变量：`deploy/web/.env`（不入库），示例 `.env.example` 只放占位。
- 端口：默认 8787 仅内部；宿主只开 80/443。若本机 80/443 已被生产 Caddy 占用，开发环境改用 8788/8443 或只监听 localhost，绝不改生产 Caddy。
- 健康检查：`GET /api/v1/health`。
- 重启策略：`unless-stopped`；但本轮不部署。

### 6.3 Caddy

- `reverse_proxy app:8787`。
- SSE 必须关闭缓冲：`flush_interval -1`；必要时 `header_up X-Accel-Buffering no`。
- 超时：读超时大于 agent 最长等待（现有 5 分钟），建议 `read_timeout 10m`；不要因 SSE 空闲被断。
- 静态：由 Fastify 托管 `web/dist`；Caddy 只反代，减少两处 SPA fallback 逻辑。
- 安全头：HSTS、`X-Content-Type-Options`、`Referrer-Policy`、CSP（`script-src 'self'`；`connect-src 'self'` + API 域；不引入第三方脚本）。
- 不在 Caddy 层做 Basic Auth 替代应用登录；应用登录是唯一入口。

### 6.4 SQLite 与备份

- `DATA_DIR/agent.sqlite`：Aster 现有数据。
- `DATA_DIR/web.sqlite`：sessions、web_requests。
- `DATA_DIR/model-selection.json`：模型选择（现有）。
- WAL 模式；单进程写。
- 备份：停写窗口内 `sqlite3 .backup` 或 volume snapshot；至少备份 `agent.sqlite`、`web.sqlite`、`model-selection.json`、memory/workspace。
- 不使用生产数据目录做开发备份/恢复。

### 6.5 生产隔离清单

Dev 1 部署前必须逐项确认：

- [ ] Compose project name 是 `aster-web`，不是生产 project。
- [ ] volume 是 `aster-web-data`，不是生产 volume。
- [ ] `DATA_DIR` 是独立目录；没有指向生产目录。
- [ ] 宿主端口不与生产 Caddy/应用冲突。
- [ ] 没有执行任何 `docker compose down/restart` 到生产 project。
- [ ] 没有修改生产 `.env`、Caddyfile、systemd。
- [ ] 没有把开发 key 写进生产 env。
- [ ] 验证只打开发地址，不打生产域名。

---

## 7. Dev 1 / Dev 2 分工

### 7.1 Dev 1：后端与平台

**目标：** 提供稳定、可被三端调用的 Fastify REST/SSE 接入层，复用 Aster 核心。

任务顺序：

1. **契约（先做）**
   - `docs/api/three-client-v1.openapi.yaml`：auth、messages、models、events、health、错误码。
   - 与 Dev 2 对齐字段；后续变更走契约 PR。
2. **配置与启动**
   - `config.ts` 支持 `CHANNEL=web`、`WEB_*`；不破坏 telegram/slack。
   - `main.ts` web 分支启动 HTTP；不创建 `HubStore`；优雅关闭。
   - `web.sqlite` 初始化（WAL、sessions、web_requests）。
3. **认证**
   - `web:set-password` CLI；scrypt；session token；限流；Bearer middleware。
4. **请求 worker**
   - `POST /messages` 幂等入队；FIFO；单 running；`agent.reply()`；错误映射；abort；重启恢复。
5. **历史**
   - `agent.ts` 只读 history；`projection.ts`；分页。
6. **模型接口**
   - 抽出共享 `ModelSelectionService`；`GET /models`；`POST /models/select`；`model.changed`。
   - `model-failover` 增加 `onModelUsed` 回调；记录 requested/actual/kind/degraded。
   - 确保 `$model` 行为不回归。
7. **SSE**
   - `/events`；snapshot；事件广播；心跳；断线处理；Caddy 不缓冲。
8. **静态与部署**
   - `@fastify/static` 托管 `web/dist`；SPA fallback 排除 `/api`。
   - `deploy/web/docker-compose.yml`、`Caddyfile`、`.env.example`；独立 project/volume/port。
9. **测试**
   - 单测：auth、幂等、队列、模型选择校验、错误映射、投影。
   - 集成：临时 `DATA_DIR` + mock agent 或测试模型；不碰生产。
   - `npm run check`、`npm test`。

**今晚完成标准：**

- 本机 `CHANNEL=web DATA_DIR=./data-web npm run dev` 可启动。
- `curl` 完成：登录 → 发消息 → SSE 收到 running/done → 拉历史 → 模型列表 → 切换 → 切回主模型 → abort。
- 模型接口与 `$model list` 结果一致；不出现硬编码 id。
- 现有测试通过；没有修改生产文件；没有部署。

### 7.2 Dev 2：三端客户端

**目标：** 一套 React UI，Web 可用，Tauri/Capacitor 能跑起来并连接同一后端。

任务顺序：

1. **脚手架**
   - `web/`：Vite + React + TS + Tailwind + shadcn/ui + assistant-ui。
   - TanStack Query、Zustand、React Router、Zod、openapi-typescript/openapi-fetch。
   - 独立 `package-lock.json`；根脚本可选。
2. **API client 与 mock**
   - 根据契约生成 client；SSE fetch 封装。
   - 后端未就绪时用 MSW/mock 实现登录、历史、模型列表、发送、SSE 事件。
3. **登录与设置**
   - 登录页；TokenStore；401 处理；退出。
   - 服务器地址（桌面/手机）；测试连接；Web 同源。
4. **聊天**
   - thread、消息气泡、Markdown 白名单、工具紧凑行、输入框、发送、停止、状态、历史分页、重连。
5. **模型选择器**
   - `ModelPicker`：当前模型、徽章、分组列表、切回主模型、错误、降级 banner、下一次生效提示。
   - 三端复用同一组件；响应式 Popover/Bottom Sheet。
6. **Tauri**
   - `src-tauri`；`frontendDist: ../dist`；服务器地址配置；构建可运行；CORS origin 与 Dev 1 对齐。
7. **Capacitor**
   - `capacitor.config.ts`；`webDir: dist`；Android/iOS 至少一个平台能构建并在模拟器运行；服务器地址配置；CORS 对齐。
8. **测试/验收**
   - Web 跑通真实后端；Tauri 跑通；Capacitor 至少一个平台跑通。
   - `npm run build` 通过；无 Live2D/贴纸/头像代码。

**今晚完成标准：**

- Web：登录、发消息、看状态、停止、历史、模型选择全部可用。
- 桌面：Tauri 打开，配置服务器地址后与 Web 同等功能。
- 手机：Capacitor 至少 Android 或 iOS 模拟器打开，配置地址后同等功能。
- 三端模型选择器都能列出真实目录、切换、切回主模型、显示降级。
- 没有多用户 UI、没有 Hub、没有头像/贴纸入口。

### 7.3 依赖与协作

```text
Dev 1 契约 ──► Dev 2 生成 client / mock
Dev 1 后端 ──► Dev 2 联调
Dev 1 部署文件 ──► 仅本地验证，不部署
```

- 第一天先对齐契约字段（`current.kind`、`request.done.model`、错误码、分页 cursor）。
- Dev 2 不直接改 `src/**`；发现契约问题在 PR 评论里提，Dev 1 改。
- Dev 1 不改 `web/**`；静态资源路径由 Dev 2 的 build 输出决定。
- 合并顺序：先 Dev 1 契约/后端 → Dev 2 联调 → 集成分支验收。
- 不合并到 `main`，不部署，不碰生产。

---

## 8. 第一版验收标准

Jay 明天按以下清单验收：

### 8.1 功能

- [ ] 单 owner 密码登录；错误密码被拒绝；退出后 token 失效。
- [ ] Web 能发文本、收到回复、看到 queued/running/done/failed/aborted。
- [ ] 能停止正在生成的回复。
- [ ] 刷新页面后历史仍在；断线重连后能继续收消息。
- [ ] 桌面端能配置服务器地址并完成同样流程。
- [ ] 手机端能配置服务器地址并完成同样流程（至少一个平台）。
- [ ] 三端都有模型按钮/下拉框。
- [ ] 模型列表来自真实目录，与 `$model list` 一致；没有编造 id。
- [ ] 能选择模型；下一次回复使用它；重启后仍保持。
- [ ] 能“切回主模型”，恢复默认链。
- [ ] 手动模型失败降级时看到提示；整条链失败看到“模型暂时不可用”。
- [ ] 选择模型不产生聊天消息、不调用模型。
- [ ] 没有 Hub / member / fork 入口；没有 Live2D / 头像 / 贴纸入口。

### 8.2 工程

- [ ] `npm run check`、`npm test` 通过。
- [ ] `web` 的 `npm run build` 通过。
- [ ] `CHANNEL=web` 本地启动；`CHANNEL=telegram|slack` 现有路径未被破坏。
- [ ] `web.sqlite` 表结构、WAL、清理策略可用。
- [ ] SSE 经 Caddy 不缓冲；心跳正常。
- [ ] Compose/Caddy 使用独立 project/volume/端口。
- [ ] 没有生产变更、没有生产部署、没有停/重启现网 bot。
- [ ] 文档包含 `$model` 与 UI 的关系、错误码、部署隔离清单。

### 8.3 明确不验收

- Live2D、虚拟形象、贴纸、语音、图片、文件。
- 多用户、多租户、注册、邀请。
- 多会话、会话管理。
- Rust 重写、Rust 网关。
- 应用商店上架、推送、自动更新。
- 生产部署。

---

## 9. 风险与取舍

| 风险 | 影响 | 缓解 |
|---|---|---|
| 误碰生产数据/服务 | 现网 bot 中断 | 独立 `DATA_DIR`/端口/Compose project；部署前清单；今晚不部署 |
| SSE 被 Caddy/代理缓冲 | 前端收不到状态 | `flush_interval -1`、`X-Accel-Buffering: no`、心跳；联调时用 curl 验证 |
| Tauri/Capacitor origin 与 CORS 不匹配 | 桌面/手机登录失败 | `WEB_ALLOWED_ORIGINS` 覆盖 `tauri://localhost`、`http://tauri.localhost`、`capacitor://localhost`、`http://localhost`；Dev 1/2 对齐 |
| Bearer token 在 Web 的 XSS 风险 | token 泄露 | 严格 CSP、Markdown 白名单、无第三方脚本；单 owner 风险可接受 |
| `reply()` 不返回实际模型 | UI 无法显示降级 | 增加 `onModelUsed` 回调；不改现有渠道返回类型 |
| 历史投影与 durable transcript 不一致 | 消息重复/缺失 | transcript 为唯一源；投影只读；按 entry cursor 分页；SSE 消息按 id 去重 |
| 模型选择与 `$model` 双实现漂移 | 行为不一致 | 抽共享 `ModelSelectionService`；HTTP 不自己过滤；测试对齐 `$model list` |
| 重启时 running 请求不确定 | 重复轮次 | 启动置 failed `PROCESS_INTERRUPTED`，不自动重放；用户重试 |
| 时间紧，三端做不完 | 验收缺口 | 优先级 Web → Tauri → Capacitor；先保证 Web + 模型选择，再壳；不做额外功能 |
| 中文分支名在工具链/URL 中编码 | 混淆 | 本地已验证合法；URL 用百分号编码展示；不改分支名 |

---

## 10. 今晚交付物清单

- [x] 分支 `feat/三端联通` 从 `origin/main` `8eb542a` 拉出。
- [x] 本文档提交到该分支。
- [ ] 分支 push 到 origin（提交后执行）。
- [ ] 不开产品实现 PR、不合并、不部署。
- [ ] Dev 1 / Dev 2 按本文档开工；今晚只在本机验证，不碰生产。

---

## 11. 一句话给 Dev

**Dev 1：** 把 Aster 包成一个单 owner 的 Fastify REST/SSE 服务，模型选择必须和 `$model` 共用同一套实时目录/failover/sticky 逻辑；独立数据目录，不碰生产。

**Dev 2：** 只写一套 `web/` React UI，Tauri 和 Capacitor 都包它；三端都要有模型按钮/下拉框，列表只信 `/api/v1/models`，不硬编码模型 id，不做 Live2D/贴纸。

**共同：** 生产 Aster bot 不停、不重启、不替换；今晚不部署。

# 三端共享 Web 客户端（Dev 2）

- 分支：`feat/三端联通-client`（从 `feat/三端联通` 拉出）
- 范围：`web/**` 与本文档；不改 `src/**`、后端契约、部署文件
- 架构依据：`docs/architecture/three-client-v1.md`（第 0、3.2、5、7.2、7.3、8、10、11 节）

## 1. 一套代码，三种壳

```
web/                     Vite + React + TS 应用（唯一 UI 代码）
├─ src/                  页面、组件、API client、mock
├─ src-tauri/            Tauri 2 桌面壳，frontendDist: ../dist
├─ android/              Capacitor 8 Android 壳，webDir: dist
└─ dist/                 npm run build 产物（不入库）
```

- Tauri 与 Capacitor 只加载同一份 `web/dist`，没有复制组件。
- 三个平台共用同一个 `ModelPicker`、登录页、聊天页与 TokenStore 抽象。
- 没有 Live2D / 虚拟形象 / 贴纸 / 头像 / Hub / member / fork 入口。

## 2. 技术栈

| 能力 | 选择 |
| --- | --- |
| 构建 | Vite 8 + TypeScript |
| UI | React 19 + Tailwind CSS 4 + shadcn/ui 风格组件（Radix 原语） |
| 聊天原语 | assistant-ui（外部 store runtime + Thread 原语） |
| 服务端数据 | TanStack Query |
| 本地 UI 状态 | Zustand（token / 连接状态 / 未完成请求 / SSE 状态） |
| 路由 | React Router（Web 用 BrowserRouter，原生壳用 HashRouter） |
| 校验 | Zod（SSE 事件、URL 校验） |
| API client | openapi-typescript + openapi-fetch |
| Mock | MSW 3（仅开发/演示） |

## 3. API 契约

- 正式契约由 Dev 1 维护：`docs/api/three-client-v1.openapi.yaml`。
- 当前契约已同步 Dev 1 Connectors DELETE 契约 `4cb638c`（队列 `86e70f1` / steer 基线 `300a463` / 远程 `3b084c9`）：
  - `POST /api/v1/requests/{requestId}/steer`（`SteerRequest` / `SteerResponse`）
  - `GET /api/v1/queue`（仅 queued，FIFO）
  - `POST /api/v1/requests/{requestId}/promote`（有 running 时 `mode=steered`，
    否则 `mode=started`；行状态可变为 `promoted`）
  - `GET/POST /api/v1/connectors`、`POST /{slug}/oauth/start`、
    `DELETE /api/v1/connectors/{slug}`
  - `409 QUEUE_ITEM_NOT_QUEUED` 的 `error.requestStatus` 为
    `running/done/failed/aborted/null`
  - SSE `request.steered` / `steer.done` / `queue.changed`，`snapshot` 增加 `queue`
  - `UiMessage` 保留可选 `clientMessageId`
- 契约变更后从 Dev 1 的分支同步同路径文件，再重新生成：

```bash
cd web
npm run gen:api
```

- `web/openapi/three-client-v1.official.yaml` 是更早的契约快照（`4f4e99b`），
  仅作离线回退；`three-client-v1.draft.yaml` 是临时草案。

生成结果在 `web/src/api/schema.d.ts`，业务代码通过 `web/src/api/client.ts` 的类型化封装访问。
契约路径自带 `/api/v1` 前缀，客户端 baseUrl 只保存服务器根地址。

错误响应统一为 `{"error":{"code","message"}}`；`POST /api/v1/messages` 的 400
既可能是 `INVALID_REQUEST`，也可能是 `TEXT_TOO_LONG`，客户端按 `error.code` 分支处理。

### 3.1 SSE

`EventSource` 不能带 `Authorization`，客户端使用 `fetch` + `ReadableStream` 手写解析：
`web/src/api/sse.ts`。支持：

- `snapshot`（含 `queue`）/ `request.queued` / `request.running` / `request.done` /
  `request.failed` / `request.aborted` / `request.steered` / `steer.done` /
  `queue.changed` / `model.changed`
- `connector.changed`：失效 Connectors 查询，跨端同步连接状态
- `credential.request`（仅 mock）：打开全局凭据弹窗（见第 7 节）
- `: heartbeat` 注释与 `heartbeat` 事件
- 断线指数退避重连（1s → 15s），重连后重新拉历史、模型与连接器状态，不做事件回放
- 401 立即清 token 回登录页

### 3.2 错误码文案

前端统一映射 `web/src/api/errors.ts`，只展示安全文案：

- `MODEL_UNAVAILABLE` → 模型暂时不可用
- `MODEL_INCOMPATIBLE` → 所选模型不支持本次请求，请先切换模型
- `PROCESS_INTERRUPTED` → 服务重启，请重试
- `MODEL_NOT_FOUND` / `MODEL_OUT_OF_SCOPE` / `MODEL_SWITCH_DISABLED` /
  `SELECTION_WRITE_FAILED`
- `UNAUTHORIZED` / `RATE_LIMITED` / 网络与超时
- `TEXT_TOO_LONG`：直接展示服务端 `message`（如“消息过长，最多 32000 个字符”），
  不用固定文案覆盖

## 4. 认证、TokenStore 与服务器地址

| 平台 | Token / 服务器地址存储 |
| --- | --- |
| Web | `localStorage`（`aster.token`），单 owner + 严格 CSP + 无第三方脚本 |
| Tauri | `tauri-plugin-store`（`settings.json`），不写普通明文配置 |
| Capacitor | `@capacitor/preferences` |

- 401：清 token、清聊天内存状态、回登录页；历史仍在服务端。
- 退出：调用 `/auth/logout`（失败也清本地）并回登录页。
- Web 默认同源（`window.location.origin`），设置页只读展示，不允许改地址。
- 桌面/手机首次启动进入服务器设置页：输入地址 → 测试连接（`GET /api/v1/health`）→ 保存。
- 地址规范化：去尾部 `/`，缺省补 `https://`；远程必须 HTTPS，仅
  `localhost` / `127.0.0.1` / `[::1]` 允许 `http://`。地址不入构建产物。

### 4.1 与 Dev 1 对齐的 CORS origin

桌面/手机 WebView 的 origin 需要在 `WEB_ALLOWED_ORIGINS` 中放行：

- `tauri://localhost`（Linux/macOS Tauri）
- `http://tauri.localhost`（Windows Tauri）
- `https://localhost`（本 Capacitor 配置 `androidScheme: "https"`）
- `capacitor://localhost`（若改用 iOS/自定义 scheme）
- `http://localhost`（本地开发）

SSE 使用 `fetch` 且带 `Cache-Control: no-cache` 请求头，属于非简单请求，
后端 CORS 的 `Access-Control-Allow-Headers` 必须包含
`authorization, cache-control, content-type`，否则桌面/手机壳的 `/events` 会一直重连。

## 5. 聊天行为

- 初始拉最近 30 条；上滚用 `before=<entry cursor>` 加载更早，保持滚动位置。
- 发送使用 `clientMessageId`（UUID）；202 后进入输入框上方的队列面板，
  SSE 推进到“正在回复/完成”后进入会话。
- SSE `request.queued/running` 可能先于 POST `/api/v1/messages` 的响应到达；
  响应落地时按本地已到达的状态回填，不能把 running/done 覆盖回 queued。
- 去重：历史与 SSE live 同 id 合并时保留 `requestId` / `clientMessageId`（历史文本优先）；
  本地乐观 user 消息只与服务器 **user** 消息按 `clientMessageId` 或 `requestId` 去重，
  不按文本、也不用 assistant 的 `requestId` 猜。`$model` 命令没有 durable user entry，
  本地气泡保留。旧服务端缺少这两个字段时宁可不合并，也不误删合法消息。
  契约新增的 `clientMessageId` 为可选字段，客户端兼容返回与不返回两种服务端。
- 停止：`POST /api/v1/requests/:requestId/abort`，只在用户消息下显示“已停止”；
  不渲染空 assistant 气泡（服务端也不再追加停止占位消息）。
- 失败：错误条 + 重试；重试生成新的 `clientMessageId`。
- `TEXT_TOO_LONG`：输入超过 32,000 字符时输入框内直接提示“消息太长”，发送被服务端
  拒绝时错误条与 toast 都显示“消息太长，请缩短后重试”，且不提供无效的重试按钮。
- 多端：`request.done` 按服务端消息 id 去重；完成/失败/停止后重新拉历史。
- Markdown 白名单渲染：不渲染原始 HTML、不渲染图片、链接只允许 http(s)/mailto，
  代码块有复制按钮。
- 工具调用只显示“工具：xxx · 完成/失败”紧凑行，不展示参数。

### 5.1 运行中插话（steer）

- 仅当 `activeStatus === "running"` 且存在 `activeRequestId` 时，发送走
  `POST /api/v1/requests/{requestId}/steer`，body 为 `{ clientMessageId, text }`；
  202 返回 `steerId = "steer:<clientMessageId>"`。
- 插话加入当前 run，不产生独立的 `request.done`。成功只把本地乐观消息的
  `requestId` 改为 `steerId` 并标记完成，**不修改** `activeRequestId`；
  原请求的 `request.done` / `request.failed` / `request.aborted` 负责收尾。
- 409 `NO_ACTIVE_REQUEST` / `REQUEST_NOT_ACTIVE` 表示检查与提交之间请求已结束，
  服务端没有写入；客户端用**同一个** `clientMessageId` 回退到普通
  `POST /api/v1/messages`。其他错误不回退，按普通失败提示并保留重试。
- `queued` 或空闲状态保持原来的发送/排队语义，不产生插话。
- Composer：运行中保留停止按钮；输入框有内容时额外显示发送按钮，其
  `aria-label` / `title` 为「插话」，底部提示为
  「正在回复，Enter 插话，Shift+Enter 换行」。排队中仍然只显示停止。
- 乐观消息：本地 outgoing 增加 `steer` 标记，用户气泡显示小字「插话 · 本轮」。
  历史消息没有额外字段，按 `requestId?.startsWith("steer:")` 识别。
- SSE：
  - `request.steered`：若本地有同 `clientMessageId` 的 outgoing，只补
    `requestId = steerId` 与 `steer` 标记，不重复插入；其他端发起的插话插入一条
    临时 live user 行（合成 id `steer:<steerId>`），同一 `steerId` 重放不重复。
  - `steer.done`：按 `message.id` 合并进 live（同 id 覆盖，不产生第二条），
    并重新拉历史；不清理 `activeRequestId`。
  - 历史刷新后，live 临时 user 行若其 `requestId` 已出现在服务器 history 的
    user 行里，则让位给 durable 行，避免刷新后出现两条插话气泡。

### 5.2 队列面板与「排队 / 立即插入」

- 队列来源：`GET /api/v1/queue` 与 SSE `snapshot.queue` / `queue.changed`；
  连接和重连时额外 `GET /api/v1/queue` 兜底，但 snapshot/queue.changed 优先，
  兜底结果不能覆盖更新的事件。
- `queue.changed` 整体替换本地队列；`request.running` / `request.aborted` 按
  `requestId` 移除对应行。
- 队列面板位于输入框上方，`queue.length > 0` 时才渲染：
  - 每行显示单行截断文本（`title` 全文）、时间、「排队中」；
  - 「立即插入」仅 `activeStatus === "running"` 可点，否则禁用并提示
    「当前没有运行中的回复」；
  - 「取消」复用 `POST /api/v1/requests/{id}/abort`，成功后从队列和本地气泡移除。
- 点击「立即插入」调用 `POST /api/v1/requests/{id}/promote`：
  - 202 `mode=steered`：移除队列行，本端 outgoing 标记 `steer/requestId=steerId/done`，
    toast「已插入本轮」；
  - 202 `mode=started`：按普通发送成功处理——移除队列行，outgoing 置为
    `running/requestId=该行 requestId` 并成为 active，不显示插话标记，
    toast「已开始执行」；
  - 409 `QUEUE_ITEM_NOT_QUEUED`：重拉队列与历史，按 `error.requestStatus` 提示：
    `running`「该消息已开始执行」、`done/failed`「该消息已结束」、
    `aborted`「该消息已取消」、缺失/`null`「队列已更新」；
  - 其他错误：保留队列行并 toast。
- promote loading 存在 store 的 `promoting` 集合；`snapshot.queue` /
  `queue.changed` / 兜底 `GET /queue` 到达即清空，队列行状态以服务端快照为准。
- 回退对账：若 `queue.changed` 重新出现同一 `clientMessageId`，而本端该
  outgoing 已被标记为 `steer=true` 或 `requestId=steer:*`，则改回
  `steer=false`、`status=queued`、`requestId=该行 requestId`，重新显示在队列面板，
  不再显示「插话 · 本轮」。
- queued 的普通消息不再显示为会话气泡，只显示在队列面板；轮到执行后进入会话。
- Composer：
  - 运行中且有输入：停止 +「排队」+「立即插入」；
  - Enter = 排队，Ctrl/⌘+Enter = 立即插入，Shift+Enter = 换行；
  - 提示「正在回复，Enter 排队，Ctrl/⌘+Enter 立即插入」；
  - 排队中/空闲：单个「发送」；排队中仍可继续入队，队列面板里的「立即插入」禁用。
- 本端发送成功后乐观加入队列，随后被 `queue.changed` 整体替换，按
  `requestId/clientMessageId` 去重，不会出现两行。

## 6. 模型选择器（三端同一组件）

入口在聊天页顶部，桌面 Popover / 手机 Bottom Sheet 响应式切换。

- 当前模型：名称、等宽 id、徽章（主模型 / 手动指定 / 自动降级）
- 默认链：primary → fallbacks，标出当前所在位置
- 可选模型：只来自 `GET /api/v1/models`，按 supplier（OpenCode / Command Code）
  → family（DeepSeek / GLM / Gemini Flash）分组，显示 id 与上下文窗口
- 操作：点选 → `POST /models/select {action:"select",modelId}`；
  “切回主模型” → `{action:"primary"}`
- 请求进行中切换：允许，提示“当前回复继续使用原模型，下一次回复生效”
- `degraded=true`：在对应助手消息上方显示非阻塞提示，不把 UI 改成实际模型
- 自动降级：只在消息角标显示实际模型
- 整条链失败：显示“模型暂时不可用”+ 重试，选择器仍保留原选择
- 列表为空或 `canSelect=false`：只显示当前模型，不显示假列表
- **前端不硬编码任何模型 id、家族或供应商**；mock fixture 的 `mock/...` 只存在于 mock 模式

## 7. Connectors 与安全注入（MVP）

入口：聊天页右上角账号菜单 →「连接器」，以及设置页 →「连接器 → 管理连接」。
页面只展示 **GitHub / Gmail** 两张卡片；图标来自 `web/src/assets/connectors/`
的本地 SVG，不热链。

### 7.1 连接状态与授权（真实契约）

- 状态由服务端保存（一次授权、三端复用）。Web / Tauri / Capacitor 都从
  `GET /api/v1/connectors` 读取 `{providers, connections}`，本机不保存 Connector
  token，也不做每端单独登录；Aster 自身登录与 Connector 授权是两件事。
- 列表映射：`connection.status` 为 `connected` 显示 `accountLabel`；
  `pending` 显示「等待授权」；`error` 显示 `lastErrorCode` 的安全中文文案；
  无 connection（或 `revoked`）显示「未连接」。`GET` 返回 `503
  CONNECTORS_DISABLED` 时页面显示「服务器未启用连接器」，不渲染成两张未连接卡片。
- 连接流程：
  1. `POST /api/v1/connectors`，body `{provider:id, slug:id}`；已存在时服务端返回
     200 `created:false`，按幂等成功继续；
  2. `POST /api/v1/connectors/{slug}/oauth/start` 取 `{url}`；
  3. 统一走 `openAuthUrl(url)`，用各平台自己的默认浏览器：
     - Tauri：`@tauri-apps/plugin-opener`（动态 import，浏览器构建不加载）；
     - Capacitor：`@capacitor/browser` 的 Custom Tabs，Android 跟随默认浏览器；
     - Web：`window.open(url, "_blank", "noopener,noreferrer")` 开新标签页，
       绝不当前页跳转。带 `noopener` 时返回值为 null，无法判断是否被拦截，
       因此等待授权的卡片始终同时提供「打开授权页」手动链接；
  4. 本端只进入「等待授权」，不假装已连接；授权回调由服务端处理，客户端以
     SSE `connector.changed` 或重新拉列表为准。授权页留在浏览器里，
     客户端不关闭、不跳转、不接管浏览器。
  5. `POST /connectors` 成功但 `POST /oauth/start` 失败时，客户端 best-effort
     `DELETE /connectors/{slug}` 清掉本次建出的 pending 行并刷新列表；
     清理失败不覆盖原始错误。界面不会再显示「已发起授权」，卡片回到「未连接」。
     已连接的旧连接不会被误删。
- 从浏览器切回 App 时，Capacitor 端监听 `App` 的 `appStateChange`
  （`isActive: true`）重新拉取列表；Web / Tauri 由 Connectors 页面的
  `visibilitychange` / `focus` 刷新，三端都另有 SSE `connector.changed` 兜底。
  **不会程序化关闭系统浏览器**，也不使用深链 / 自定义 scheme 强制把用户拉回 App：
  授权页是否关闭由用户决定。
- 卡片四态：`disconnected` 灰色「连接」、`pending` 黄色「等待授权…」+「取消」、
  `connected` 绿色显示 `accountLabel` +「断开」、`error` 红色错误文案 +「重试」。
- 重新授权复用同一流程；断开调用 `DELETE /api/v1/connectors/{slug}`，成功后以服务端
  列表为准。
- 刷新/重启后状态来自服务端，不来自客户端缓存。若服务端暂时不可达，
  页面显示错误与“重试”，不会把未知状态显示成已连接。
- Gmail 本轮只读：UI 标注“只读”，只展示搜索/读取邮件的能力，不出现发送、
  删除或修改入口。

### 7.2 凭据弹窗（仅 Mock）

`credential.request` 生产上不由 OAuth 连接器产生；该弹窗只由
`POST /api/v1/mock/credential-request` 触发，用于三端验收。客户端已删除对
不存在的 `/api/v1/credential-requests/*` 的调用。真实事件 payload 为：

```json
{
  "connectionId": "conn_...",
  "provider": "github",
  "slug": "github",
  "tool": "github.create_issue_comment",
  "requestId": "cred_..."
}
```

- 弹窗显示 connector、tool 与 120 秒 mock 倒计时；输入框不回显。
- 输入内容不提交到服务器、**不写 localStorage/sessionStorage、不写日志**；
  关闭/拒绝/超时只清理内存状态。
- 连接器状态变化（`connector.changed`）只用来失效列表查询，不信任事件里的 payload。

### 7.3 提示音

`web/src/lib/sound.ts` 用 Web Audio 本地合成，不加载外部音频：

- `attention`：凭证请求到达（水滴感滑音）
- `success`：授权/提交完成（两声上行短音）
- `error`：连接或提交失败（低音下行）
- 首次 pointerdown / keydown / touchstart 时创建并 resume AudioContext；
  未解锁前保持安静，不报错。
- 开关在设置页与连接器页，状态存 `aster.soundMuted`；开启时播放一次成功音试听。

### 7.4 验收

1. GitHub/Gmail 授权后刷新、重启壳层仍显示已连接（服务端状态）。
2. 断开后卡片变为未连接，相关工具不可用。
3. 点「连接」会打开系统浏览器；用户切回 App 时状态自动刷新，浏览器不会被 App 关闭。
4. 服务端未启用连接器时显示「服务器未启用连接器」，不是「未连接」。
5. Mock 入口仍能弹出凭据组件；组件不再向服务端提交任何内容，
   localStorage/sessionStorage 中搜不到输入过的 token。
6. 首次点击后能听到提示音；静音开关生效并在刷新后保持。
7. 桌面居中 Dialog、手机底部 Sheet；拒绝/超时后弹窗关闭且没有自动重试。

## 8. Mock 模式（MSW）

开发环境默认启用（`VITE_USE_MOCK=0` 可关闭），登录页会显示 mock 密码提示。

- 覆盖：登录/登出/me、历史分页、发送、停止、模型列表、模型切换、SSE 事件流、
  Connectors 列表/create/oauth-start/delete、mock 凭据请求
- 支持演示场景：
  - 手动选择 `GLM Mock` 时模拟失败，由主模型回答并带 `degraded=true`
  - 停止正在生成的回复得到 `aborted`
  - 刷新页面后 mock 状态保留在 `localStorage`（Connectors 的 mock 连接状态同样保留）
  - 连接器详情里的「模拟凭据请求（Mock）」会通过 SSE 推送一条真实契约形状的
    `credential.request`（`connectionId/provider/slug/tool/requestId`）
- mock 的 Connector 状态存于 mock 服务端（浏览器 MSW 用 localStorage 模拟服务端持久化），
  不属于客户端 token 存储；真实后端接入后以服务端数据库为准。
- 生产构建默认不包含 MSW：Vite 在 production 下把 mock 模块替换为
  `browser.stub.ts`；仅显式 `VITE_USE_MOCK=1` 的演示构建会打包 mock（用于壳层离线验收）。

```bash
cd web
npm run dev          # mock 默认开启
VITE_USE_MOCK=0 npm run dev   # 连真实后端（Vite 代理 /api → VITE_DEV_BACKEND）
```

### 8.1 壳层联调用的本地 HTTP mock

Tauri / Capacitor 的 WebView 没有可用的 Service Worker，MSW 无法拦截请求。
为在没有真实后端时验证“填服务器地址 → 测试连接 → 登录 → 聊天”，
`web/scripts/mock-server.mjs` 用同一套 mock 语义起一个只监听 127.0.0.1 的 HTTP 服务
（不发真实模型请求，不读写业务数据）：

```bash
cd web
npm run mock:server          # http://127.0.0.1:8787，MOCK_PORT 可改
```

- 桌面：服务器地址填 `http://127.0.0.1:8787`
- Android 模拟器：`adb reverse tcp:8787 tcp:8787` 后同样填 `http://127.0.0.1:8787`
- 密码从 `src/api/mock/fixtures.ts` 读取，不在脚本里另存

该服务只用于开发验收；正式环境仍由 Dev 1 的后端提供同一份契约。

## 9. 桌面壳（Tauri 2）

- `src-tauri/tauri.conf.json`：`frontendDist: "../dist"`、`devUrl: http://localhost:5173`
- 窗口 1100×760，最小 380×560
- CSP：`script-src 'self'`；`connect-src` 允许 https 与 localhost 开发地址；
  `worker-src 'self'`
- 插件：`tauri-plugin-store` 用于 token / 服务器地址
- Linux 构建依赖：`libwebkit2gtk-4.1-dev`、`libgtk-3-dev`、
  `libayatana-appindicator3-dev`、`librsvg2-dev`、`build-essential`、Rust ≥ 1.90

```bash
cd web
npm run tauri dev
npm run tauri build -- --no-bundle
```

## 10. 手机壳（Capacitor 8）

- `capacitor.config.ts`：`appId: com.aster.mobile`、`webDir: "dist"`、
  `androidScheme: "https"`
- `android/` 由 `npx cap add android` 生成；Web 资产通过 `npx cap sync android` 复制
- 服务器地址存 `@capacitor/preferences`

```bash
cd web
npm run build
npx cap sync android
cd android && ./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

- 本机验证环境：JDK 21、Android SDK 36（`ANDROID_HOME`）、Gradle 8.14.3
- 模拟器没有 KVM 时只能用 `-accel off`（TCG），启动很慢；有硬件加速时正常
- 壳内页面 origin 为 `https://localhost`（`androidScheme: https`）；用本地 mock 联调时：
  `adb reverse tcp:8787 tcp:8787`，应用内服务器地址填 `http://127.0.0.1:8787`
  （loopback 视为可信来源；生产仍应填 HTTPS 地址）
- 启动图与 launcher 图标已换成 Aster 自己的资源（`android/app/src/main/res`），
  不再使用 Capacitor 默认图标；自适应图标背景色 `#5858EB`，前景为白色 Asterisk。

### 10.1 旧 Android WebView 启动兼容

真机曾出现 APK 永远停在「正在启动…」。原因是 Vite 8 默认 `build.target`
（baseline-widely-available，约 Chrome 107）会把 class static block / 私有字段
原样输出，低版本 WebView 解析 bundle 时直接 `SyntaxError`，React 不会挂载。
现在有三层兜底：

- `web/vite.config.ts` 设置
  `build.target: ["chrome61", "safari12", "firefox60", "edge79"]`；
  产物中不再有 class static block / 私有字段。受动态 `import()` 限制，
  实际最低约为 Chrome 63。
- `useBootstrap` 给连接与登录引导加 4 秒超时与异常捕获：超时也会
  `setReady(true)`；原生壳进入 `/setup` 重新配置服务器，Web 同源则回登录页。
  同时 `lib/storage.ts` 的 Capacitor Preferences 调用有 1.5 秒超时，
  超时后本次会话回退 `localStorage`，避免原生桥不回调时卡死。
- `web/index.html` 内联 ES5 看门狗：8 秒内 `#root` 仍未挂载就显示
  「启动失败：<错误>，点这里重新配置服务器」；按钮会清掉本地服务器地址和
  token（localStorage 与 Preferences）后回到 `#/setup`。这段脚本不依赖打包产物，
  即使主 bundle 语法失败也能执行。

## 11. 验证命令

```bash
cd web
npm run typecheck
npm test             # vitest：消息去重、队列/promote、steer 发送路径、SSE 事件解析
npm run build        # 生产构建（不含 mock）
```

完整验收（Web / 桌面 / 手机）的三端结果记录在 PR 描述与本次任务报告中。

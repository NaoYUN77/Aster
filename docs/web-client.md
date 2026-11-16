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
- 契约未到位前，`web/openapi/three-client-v1.draft.yaml` 是前端按架构文档第 4.3–4.7 节写的临时契约，仅用于生成类型与 mock。
- 重新生成类型：

```bash
cd web
npm run gen:api
```

脚本会优先读取正式契约；存在正式契约时不再使用 draft。生成结果在
`web/src/api/schema.d.ts`，业务代码通过 `web/src/api/client.ts` 的类型化封装访问。

### 3.1 SSE

`EventSource` 不能带 `Authorization`，客户端使用 `fetch` + `ReadableStream` 手写解析：
`web/src/api/sse.ts`。支持：

- `snapshot` / `request.queued` / `request.running` / `request.done` /
  `request.failed` / `request.aborted` / `model.changed`
- `: heartbeat` 注释与 `heartbeat` 事件
- 断线指数退避重连（1s → 15s），重连后重新拉历史与模型，不做事件回放
- 401 立即清 token 回登录页

### 3.2 错误码文案

前端统一映射 `web/src/api/errors.ts`，只展示安全文案：

- `MODEL_UNAVAILABLE` → 模型暂时不可用
- `MODEL_INCOMPATIBLE` → 所选模型不支持本次请求，请先切换模型
- `PROCESS_INTERRUPTED` → 服务重启，请重试
- `MODEL_NOT_FOUND` / `MODEL_OUT_OF_SCOPE` / `MODEL_SWITCH_DISABLED` /
  `SELECTION_WRITE_FAILED`
- `UNAUTHORIZED` / `RATE_LIMITED` / `TEXT_TOO_LONG` / 网络与超时

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
- 发送使用 `clientMessageId`（UUID）；202 后显示“排队中”，SSE 推进到“正在回复/完成”。
- 停止：`POST /api/v1/requests/:requestId/abort`，UI 显示“已停止”。
- 失败：错误条 + 重试；重试生成新的 `clientMessageId`。
- 多端：`request.done` 按服务端消息 id 去重；完成/失败/停止后重新拉历史。
- Markdown 白名单渲染：不渲染原始 HTML、不渲染图片、链接只允许 http(s)/mailto，
  代码块有复制按钮。
- 工具调用只显示“工具：xxx · 完成/失败”紧凑行，不展示参数。

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

## 7. Mock 模式（MSW）

开发环境默认启用（`VITE_USE_MOCK=0` 可关闭），登录页会显示 mock 密码提示。

- 覆盖：登录/登出/me、历史分页、发送、停止、模型列表、模型切换、SSE 事件流
- 支持演示场景：
  - 手动选择 `GLM Mock` 时模拟失败，由主模型回答并带 `degraded=true`
  - 停止正在生成的回复得到 `aborted`
  - 刷新页面后 mock 状态保留在 `localStorage`
- 生产构建默认不包含 MSW：Vite 在 production 下把 mock 模块替换为
  `browser.stub.ts`；仅显式 `VITE_USE_MOCK=1` 的演示构建会打包 mock（用于壳层离线验收）。

```bash
cd web
npm run dev          # mock 默认开启
VITE_USE_MOCK=0 npm run dev   # 连真实后端（Vite 代理 /api → VITE_DEV_BACKEND）
```

### 7.1 壳层联调用的本地 HTTP mock

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

## 8. 桌面壳（Tauri 2）

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

## 9. 手机壳（Capacitor 8）

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

## 10. 验证命令

```bash
cd web
npm run typecheck
npm run build        # 生产构建（不含 mock）
```

完整验收（Web / 桌面 / 手机）的三端结果记录在 PR 描述与本次任务报告中。

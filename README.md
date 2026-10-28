# Aster

单 owner 的个人 AI agent：从 Telegram 私聊接收消息，在可恢复的 durable 执行环境里运行 agent 与工具，再把回复分段送回。它有长期记忆、能接入 MCP 工具，面向一台小规格云服务器长期运行。

基于 `@earendil-works/pi-durable`（1.3.0）构建。**已于 2026-10 在腾讯云完成首次真实部署并持续运行**（单容器，模型 DeepSeek，记忆系统开启）；此前的 Docker 部署链在此之前从未在真实云服务器完整上线过，部署细节见 [部署指南](docs/deployment-test-guide.md)。

## 特性

- **Durable 执行**：会话、工具调用与执行进度全部持久化；进程被杀或重启后按 checkpoint 恢复，未完成的请求不会丢。
- **长期记忆**：工作状态（working）、每日事件归档（daily）与周期上下文快照三层结构，配套检索工具与压缩预算，见下文「记忆系统」。
- **工具系统**：内置文件/命令工具常驻；MCP 工具按需经 `tool_search` 检索加载，不占常驻上下文。
- **多提供商**：注册表内置 12 个显式 API key 的模型提供商，配置只认一个 key，启动前校验模型 id。
- **投递可靠性**：回复先落盘再发送，分段确认；结果未知的发送不自动重发，提供人工核查与补发命令。
- **单 owner 安全边界**：只接受指定 Telegram 用户的私聊文本；群聊与他人消息不触发模型。

## 快速开始

需要 Node.js 24.19.0+，以及可访问 Telegram 与所选模型服务的网络。

```sh
npm ci
cp .env.example .env
# 填写 .env（见下）
npm run check
npm test
npm run build
npm start
```

开发运行用 `npm run dev`。测试全部离线（faux 模型 + 本地 SQLite），不调用收费模型或 Telegram。

`.env` 必填项：

- `TELEGRAM_BOT_TOKEN`：BotFather 创建的 bot token。
- `TELEGRAM_OWNER_ID`：允许使用 bot 的个人 Telegram 数字用户 ID。
- `MODEL_PROVIDER` / `MODEL_ID`：注册表内的提供商 id 与该提供商在 pi-ai 1.3.0 模型目录中的 id；写错时启动前报错并列出示例，不自动替换。
- 所选提供商对应的 API key（见下表；只要求当前所选的那个，其余留空不算缺项）。

| `MODEL_PROVIDER` | API key 变量 |
| --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `google` | `GEMINI_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `moonshotai`、`moonshotai-cn` | `MOONSHOT_API_KEY` |
| `minimax` | `MINIMAX_API_KEY` |
| `zai` | `ZAI_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |

注册表定义在 `src/providers.ts`，是支持范围的唯一来源。本应用只支持显式 API key 的提供商：不含 OAuth/订阅登录、云厂商环境凭据（Bedrock、Vertex），暂不支持自定义 base URL 的 OpenAI 兼容端点。

常用可选项（均有默认值，完整清单见 `.env.example`）：

- `DATA_DIR`：持久化数据目录，默认 `./data`（Docker 部署固定为 `/data`）。
- `TELEGRAM_API_ROOT`：Telegram Bot API 的根地址覆盖。服务器无法直连 `api.telegram.org` 时，可指向自建反向代理（须为 https）；现网部署即经 Cloudflare Worker 反代使用此项。
- `MEMORY_ENABLED`：记忆系统总开关，默认开；设 `0` 整体关闭，行为与接入前一致（回滚开关）。其余 `MEMORY_*` 为预算与时区配置。
- `MCP_CONFIG`：MCP 配置文件路径，默认 `DATA_DIR/mcp.json`。

私聊 bot 后直接发送文字即可。bot 若已配置 webhook，应用会拒绝启动，需先在原部署中停用 webhook。

## 架构

一条消息的路径：Telegram 长轮询 → 渠道层收件箱落盘 → 运行时恢复/推进会话 → 记忆层组装上下文 → 模型层调用提供商 → 工具层执行 → 回复落盘后分段发送。

| 层 | 职责 | 主要文件 |
| --- | --- | --- |
| 入口与部署 | 组合接线、部署渲染、环境预检、发布清单 | `src/main.ts`、`src/deployment-*.ts`、`src/release-*.ts` |
| 渠道 | Telegram 长轮询与所有者过滤；持久化收件箱（offset 检查点、分段投递与对账） | `src/telegram.ts`、`src/inbox.ts` |
| 运行时 | 基于 pi-durable 的 Session：durable 执行、checkpoint、replay 恢复 | `src/agent.ts` |
| 记忆 | 归档、工作状态、压缩、上下文规划与快照、生命周期接入与记忆工具 | `src/memory/` |
| 工具 | 工具注册表（常驻 + deferred）、MCP 接入与 OAuth 凭据保管 | `src/tools.ts`、`src/mcp*.ts` |
| 模型 | 提供商注册表与模型解析、启动前目录校验 | `src/providers.ts` |
| 配置 | `.env` 解析与严格校验（缺项/错项启动前失败） | `src/config.ts` |
| 存储 | 会话/checkpoint/记忆与投递状态，位于数据目录 | `agent.sqlite`、`inbox.sqlite` |

数据目录内容：

| 路径 | 内容 |
| --- | --- |
| `agent.sqlite`（及 WAL） | 底座会话与执行恢复状态；记忆系统的 working 状态、周期快照投影、归档进度与轮数计数 |
| `inbox.sqlite`（及 WAL） | 请求消费位置、身份绑定与投递状态 |
| `workspace/` | agent 的任务文件；含 `workspace/MEMORY.md`（用户明确要求保存的长期事实，由模型经文件工具按需读写） |
| `memory/daily/YYYY-MM-DD.md` | 每日事件记忆：归档任务从已确认的会话范围增量提取 |
| `mcp.json`（可选） | MCP server 配置 |
| `mcp-oauth/<server>.json`（可选） | 远程 MCP server 的 OAuth token，仅属主可读 |

约束：同一数据目录只允许一个应用进程（镜像入口以 `flock` 互斥）；数据目录绑定 bot 与 owner，不能换身份续用；当前为单会话、串行请求、顺序工具执行，单个请求等待上限 5 分钟，超时向底座请求取消（外部副作用不保证可撤销）。接入每次最多取 10 条 update，处理完本地待办再轮询，不构造无限内存队列。

## 记忆系统

在既有会话之上分三区组装每次请求的上下文：A 区为稳定规则（系统提示与工具声明，保持不变以利用提供商前缀缓存）；B 区为周期快照（连续性摘要与 working 基线，只在压缩或重置正式生效时切换）；C 区为实时尾巴（近期原文、工具结果与本轮检索结果）。

模型可用的记忆工具：

| 工具 | 用途 |
| --- | --- |
| `working_read` / `working_update` | 读取 / 按预期版本更新当前任务状态（目标、约束、进度、待办等结构化状态） |
| `memory_search` | 按关键词与日期范围检索每日事件记忆，带来源、分页游标与未扫描范围 |
| `memory_read` | 按日期 + 段落 id 精确读取一条每日事件 |

运行机制：已确认的会话范围由后台归档任务增量提取为 `memory/daily/*.md`，归档失败只记录状态、不影响聊天；上下文达到预算阈值时触发压缩并发布新快照。检索有双层预算（单次结果与单请求累计，默认约 4 Ki / 8 Ki tokens），超限返回明确错误而不是静默截断。

状态：MEM-01～MEM-08 已全部完成并合并。MEM-08 真实模型验收（DeepSeek pro 与 flash）结论：多轮对话的目标/约束/进度保留良好，云端前缀缓存命中约 87%；验收中发现并已修复「working 状态因 entry id 不可见而无法落盘」与「摘要日期捏造」两处问题。设计见 [Memory 与 Context 实施方案](docs/memory-and-context-design.md)，验收记录见 [记忆系统验收](docs/memory-verification.md)。

## 工具与 MCP

常驻工具：`bash`、`read`、`write`、`edit`（pi-durable 提供）、`current_time`，以及记忆开启时的 `memory_search`、`memory_read`、`working_read`、`working_update`。工具不是文件系统沙箱，生产环境应使用独立低权限用户运行。在 `src/tools.ts` 用底座 `defineTool` 定义新工具并注册，名称冲突在注册时直接拒绝。工具契约、错误语义与重放规则见 [契约与生命周期](docs/contracts-and-lifecycle.md)。

MCP server 通过 `DATA_DIR/mcp.json`（或 `MCP_CONFIG`）接入，无需改代码。文件不存在表示不启用；默认路径上的文件级错误只禁用 MCP 并记录原因，显式指定路径的错误使启动失败。

```json
{
  "servers": [
    {
      "name": "github",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "cwd": "/data/workspace",
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },
      "timeoutMs": 60000,
      "connectTimeoutMs": 10000
    },
    {
      "name": "notion",
      "transport": "http",
      "url": "https://mcp.notion.com/mcp",
      "auth": { "type": "oauth" }
    }
  ]
}
```

配置要点：

- `name` 唯一，匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$`；最多 8 个 server（stdio 最多 4 个），超出的条目忽略并告警。
- stdio：`command` 必填；`cwd` 必须是存在的绝对路径；默认 `inheritEnv: false`，子进程只得到运行所需变量加 `env` 条目，bot 的凭据不会传入。
- http：必须是 `https`（仅回环允许 `http`）；`auth.type` 目前只支持 `oauth`。
- `args`、env 值、header 值中的 `${NAME}` 从应用环境解析；缺失变量只禁用该条目并只报告变量名。单条无效、重名只跳过该条，不影响其他 server。
- 配置文件含凭据引用，部署时设为 `600`，不要提交仓库。

工具以 `mcp__<server>__<tool>` 命名，默认不直接提供给模型：系统提示只列出已连接的 server 与工具数量，模型先调 `tool_search` 检索并加载需要的工具，之后才能调用，已加载集合随会话保存。MCP 调用一律按不可重放处理（`replay: "unsafe"`），进程中断后不自动重跑，避免重复外部副作用。启动时连不上的 server 只记录错误码并跳过；运行中掉线不自动重连，调用返回 `MCP_CLOSED`，重启后重连。

离线检查配置用 `npm run build && node dist/src/check-config.js`；连接冒烟测试用 `npm run build && npm run mcp:check`（逐个连接、列出工具名后关闭，不启动 Telegram 与模型）。

OAuth 首次授权或重新授权时先停 bot，再执行 `npm run build && DATA_DIR=./data npm run mcp:auth -- <server>`，打开打印的 URL 在浏览器登录并同意，回到终端等待回调；headless 服务器需先建 SSH 端口转发（如 `ssh -L 8765:127.0.0.1:8765 user@host`）。支持 RFC 7591 动态注册的授权服务器（如 Notion）会自动完成客户端注册，`client_id` 与 token 一起保存在 `mcp-oauth/<server>.json`——不要删除该文件，重新注册会让已有授权失效。refresh token 失效后工具调用会报 `MCP_AUTH_REQUIRED`，这是预期行为，重新执行 `mcp:auth` 即可，不要反复重启。

部署注意：容器内路径是卷内路径（`cwd` 等写 `/data/...`）；stdio server 依赖宜在派生镜像中预装，运行时从 npm registry 临时安装会把可用性绑到外部网络；每个 stdio server 都增加常驻进程与内存，4 GB 主机上优先少而稳。

## 投递核查与补发

网络超时可能发生在 Telegram 已收到消息之后，因此结果未知的发送不会自动重发。先停应用，查看待核查分段：

```sh
npm run deliveries -- list
```

核对 Telegram 实际收到的内容后二选一（命令只改本地投递状态，重启应用后才继续发送，不会重新执行 agent）：

```sh
npm run deliveries -- retry telegram:123:456 1   # 确认需要重发该分段（可能与已送达的重复）
npm run deliveries -- sent telegram:123:456 1    # 已确认该分段送达，继续后面的分段
```

## Docker 部署

生产交付统一使用 Docker 镜像（仓库名 `aster`），服务器只需 Docker Engine 24+ 与 Compose 2.24.4+，不需要主机 Node.js 或 Go。当前拓扑为单服务 `personal-agent`：

```sh
docker build -t aster:local .
cp .env.example .env   # 填写 bot、owner、模型与 key，chmod 600
docker compose run --rm --no-deps personal-agent node dist/src/check-config.js
docker compose up -d
docker compose logs --tail 50 personal-agent
```

也可使用构建覆盖 `docker compose -f docker-compose.yml -f docker-compose.build.yml build`。生产 Compose 本身只引用镜像、不含 `build`；通过镜像仓库或 `docker save` / `docker load` 交付产物，不在生产主机上强制构建。更新时在 `.env` 指定不可变镜像引用（`ASTER_IMAGE=仓库/aster@sha256:<digest>`），`docker compose pull` 后停旧起新；数据卷 `personal-agent-data` 保持不变，禁止用 `down -v` 代替普通停服。容器内固定 `/data`（uid 1000），应用默认内存上限 1 GB、128 进程/线程、45 秒停止宽限。`running` 只表示进程存在，仍需核对启动日志与真实 Telegram 往返才算验收。

服务器无法直连 Telegram 时（例如中国区云主机），用 `TELEGRAM_API_ROOT` 指向自建反向代理即可，现网即以 Cloudflare Worker 反代运行；注意同一个 bot token 只能有一个实例在轮询，迁移或演练时不要让新旧实例同时在线。

同一主机的 `test` 与 `production` 环境由版本化环境描述区分（项目名、卷名、所消费的 bot），`npm run deployment:environment` 做渲染与冲突检查，见 [部署环境描述](docs/deployment-environments.md)。整卷备份、还原、维护命令与上线验收清单见 [部署指南](docs/deployment-test-guide.md)。

凭据只经部署环境提供：bot token、提供商 key 与 owner ID 放在权限受限的 env 文件中，MCP 配置以 `${ENV}` 引用进程环境；应用只做存在性与形状校验，不把秘密写入工具参数或 durable 状态。

## 开发与验证边界

```sh
npm run check   # 类型检查
npm run build   # 构建
npm test        # 全量离线测试
```

已验证：类型、构建与全量离线测试通过；记忆系统经真实模型验收（见上）；Docker 单服务部署已在腾讯云真实上线并通过端到端验收（对话往返、记忆落盘、容器重启恢复）。

未验证 / 已知限制：

- 其余提供商（DeepSeek 以外）的真实模型摘要与归档质量未逐个实测。
- 已知缺陷：回复已持久化但请求收尾未执行时进程被杀，该轮的轮数计数会永久滞后一轮（回复与状态一致，仅压缩评估触发点后移），已用测试钉住当前行为，修复方案待定。
- 单会话串行处理，不是高吞吐或长期离线收件箱；长期繁忙时消息滞留在 Telegram 侧。

## 文档索引

- [部署指南](docs/deployment-test-guide.md)：镜像交付、备份恢复、维护命令、上线验收
- [部署环境描述](docs/deployment-environments.md)：test / production 环境描述字段
- [契约与生命周期](docs/contracts-and-lifecycle.md)：工具契约、错误语义、重放与升级兼容性
- [Memory 与 Context 实施方案](docs/memory-and-context-design.md) / [记忆系统验收](docs/memory-verification.md)
- [CI/CD 实施计划](docs/ci-cd-implementation-plan.md)：安全关卡、实施顺序与当前进度
- [MVP 范围](docs/mvp.md) / [Docker 验证记录](docs/docker-verification.md)
- 仓库级约束见 [CLAUDE.md](CLAUDE.md)

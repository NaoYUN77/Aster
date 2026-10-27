# Aster

基于官方 `@earendil-works/pi-durable` 的个人任务助手：从 Telegram 私聊接收文本，运行 agent 和工具，然后回复。远端模型负责推理；应用面向 4 核 CPU、4 GB 内存云服务器部署。

## 开始运行

需要 Node.js 24.19.0，以及可访问 Telegram 和所选模型服务的网络。

```sh
npm ci
cp .env.example .env
```

在 `.env` 中填写：

- `TELEGRAM_BOT_TOKEN`：BotFather 创建的 bot token。
- `TELEGRAM_OWNER_ID`：允许使用 bot 的个人 Telegram 数字用户 ID；也可用 `TELEGRAM_OWNER_ID_FILE` 指向只读文件，二者只能设置一个。
- `MODEL_PROVIDER`：注册表内的提供商 id，见下表。
- `MODEL_ID`：该提供商在 pi-ai 1.3.0 模型目录中的 id；不自动替换，写错时启动前报错并列出示例。
- 所选提供商对应的 API key 环境变量，见下表。
- `DATA_DIR`：持久化数据目录，默认 `./data`。

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

只要求**当前所选提供商**的 key；其他 key 留空不算缺项。注册表定义在 `src/providers.ts`，是支持范围的唯一来源。

本应用只支持显式 API key 的提供商，不包含 OAuth／订阅登录、云厂商环境凭据（如 Bedrock、Vertex）以及需要额外端点参数的提供商。提供商连接由 pi-ai 负责，不承诺支持任意 OpenAI 兼容地址或自定义 base URL。

```sh
npm run check
npm test
npm run build
npm start
```

开发运行使用 `npm run dev`；单独执行一组测试：`npx tsx --test test/boundaries.test.ts`。测试使用离线模型替身和本地 SQLite，不调用收费模型或 Telegram。

私聊 bot 后直接发送文字即可。只接受指定用户的私聊文本；群聊和其他用户不触发模型。bot 如果已经配置 webhook，应用会拒绝启动，需先在原有部署中停用 webhook。

## 架构与持久化

Telegram 适配层将 update 转换为内部请求；应用使用稳定请求 ID 将其提交给 pi durable。底座负责完整 agent loop 和工具执行。最终结果保存后再发送，分段回复记录每段确认。

数据目录包括：

| 路径 | 内容 |
| --- | --- |
| `workspace/MEMORY.md` | 用户明确要求保存的长期事实（语义不变，仍由模型经文件工具按需读写） |
| `workspace/` | agent 的任务文件 |
| `memory/daily/YYYY-MM-DD.md` | 每日事件记忆：归档任务从已确认的会话范围提取，经检索工具按需读取 |
| `agent.sqlite` 及其 WAL 文件 | 底座会话与执行恢复状态，以及记忆系统的 working 状态、周期快照投影、归档进度与轮数计数 |
| `inbox.sqlite` 及其 WAL 文件 | 请求消费位置、身份绑定和投递状态 |
| `mcp.json`（可选） | MCP server 配置；默认路径，可用 `MCP_CONFIG` 覆盖 |
| `mcp-oauth/<server>.json`（可选） | 远程 MCP server 的 OAuth token，仅属主可读 |

同一个数据目录只允许一个应用进程使用。数据目录绑定 bot 和 owner，不能直接更换身份后继续使用原会话。部署更新保留整个目录；备份时先停止服务，再复制数据目录，包含 SQLite 相关文件。

当前使用一个会话、串行用户请求及顺序工具执行。单个请求等待上限为 5 分钟；执行超时后向底座请求取消。此上限不代表任意外部副作用可被撤销。正常进程关闭保留未完成请求，重启后恢复。

接入每次最多取得 10 条 update，处理完本地待办后再轮询，不构造无限内存队列。长期繁忙时，消息仍滞留 Telegram；这不是高吞吐或长期离线收件箱。

## 自定义工具

在 `src/tools.ts` 使用底座 `defineTool` 定义工具，并加入 `personalTools.tools`。现有 `current_time` 是最小示例。参数由 TypeBox schema 定义，底座负责执行前校验；名称冲突在注册时拒绝。

内置工具为 `read/write/edit/bash`，由 pi durable 提供。工具并非文件系统沙箱，生产环境使用独立的低权限系统用户；部署示例约束写入持久化目录。

工具契约、错误语义、重放与升级兼容性见 [设计文档](docs/contracts-and-lifecycle.md)。仓库级约束见 [CLAUDE.md](CLAUDE.md)，MVP 范围见 [docs/mvp.md](docs/mvp.md)。

## 记忆系统（MEM-01～MEM-07，已接入）

在既有会话之上增加三层结构：稳定规则（系统提示）＋周期快照 B（连续性摘要与 working 基线，只在压缩或重置正式生效时切换）＋追加流水 C（近期原文、工具结果与检索结果）。模型可用的记忆工具：

| 工具 | 用途 |
| --- | --- |
| `working_get` / `working_update` | 读取／按预期版本更新当前任务状态（目标、进度、待办、偏好等结构化 JSON） |
| `memory_search` | 按关键词与日期范围检索每日事件记忆，带来源、分页游标与未扫描范围 |
| `memory_read` | 按日期＋段落 id 精确读取一条每日事件 |

已确认的会话范围会被后台归档任务增量提取为 `memory/daily/*.md`；归档失败只记录状态，不影响聊天与回复。检索有预算：单次结果与单请求累计都有 token 上限（默认约 4 Ki／8 Ki），超限返回明确错误而不是静默截断。`workspace/MEMORY.md` 的语义不变。设计与实现结论见 [Memory 与 Context 实施方案](docs/memory-and-context-design.md)。

可选配置（`.env`，均有默认值与范围校验，见 `.env.example`）：`MEMORY_ENABLED`（默认开）、`MEMORY_BACKGROUND_TARGET_TOKENS`、`MEMORY_RECENT_VERBATIM_TOKENS`、`MEMORY_SNAPSHOT_TOKENS`、`MEMORY_NARRATIVE_TOKENS`、`MEMORY_INSTRUCTIONS_TOKENS`、`MEMORY_SEARCH_RESULT_TOKENS`、`MEMORY_REQUEST_SEARCH_TOKENS`、`MEMORY_EVALUATE_AFTER_USER_TURNS`（默认 20）、`MEMORY_RESERVE_TOKENS`、`MEMORY_TIMEZONE`、`MEMORY_ARCHIVE_TIMEOUT_MS`。设 `MEMORY_ENABLED=0` 可整体关闭记忆系统，应用行为与接入前一致（回滚开关）。

状态：接入、恢复、预算、错误映射与升级路径已由本地自动化测试覆盖（`test/memory-integration.test.ts` 等，离线 faux 模型）；**真实模型的摘要与事件提取质量、真实窗口下的阈值标定、提供商缓存命中尚未验证**，属于 MEM-08 的验收范围，不要据此宣称线上效果。

## 工具凭证与 Agent Vault

工具的 API token、API key、用户名和密码可由开源 Agent Vault 从 Infisical Secret Management 同步，再在 HTTP(S) 出口注入；应用只持有占位值。启用方式、`${vault:KEY}` 引用、Basic/Bearer 配置及独立隔离部署见 [Agent Vault 运行说明](docs/agent-vault.md)。模型提供商的 API key、Telegram Bot token 和 owner ID 的存放方式也在该文档中说明；`MODEL_PROVIDER`、`MODEL_ID` 等非秘密配置仍留在应用环境。MCP 外部 OAuth 保留现有授权流程和本地 token 状态，不要求迁入 Vault。

使用独立 `docker-compose.agent-vault.yml` 启动这一模式，不与默认 Compose 合并。Aster 与防火墙容器共享网络命名空间，broker 独立运行；真实 Infisical 联调与容器出口验收尚需在目标机完成。

不同基础设施的密钥按 Infisical 文件夹拆分时，每个文件夹对应一个 vault。叠加 `docker-compose.router.yml`，使用独立 `aster-router` 镜像按目标 `host:port` 选择 vault。配置和运行方法见 [router/README.md](router/README.md)。

同一台主机上的 `test` 与 `production` 由各自的版本化环境描述区分项目名、卷、网络、broker 地址、管理端口和私有目录；`npm run deployment:environment` 提供渲染核对、router 核对、宿主资源冲突检查与跨环境重叠检查。字段与用法见 [部署环境描述](docs/deployment-environments.md)。

CI/CD 的安全关卡、实施顺序与当前进度见 [CI/CD 实施计划](docs/ci-cd-implementation-plan.md)。Agent Vault 受审构建及虚构凭据回归用于验证已确认的取密重定向与日志问题，基础 CI 成功不等于已获得生产部署准入。`npm run release:preflight` 提供版本化清单、两份本地 Compose／显式策略文件摘要及预期四镜像 digest 引用的离线绑定检查；[契约与用法](scripts/ci/README.md#离线发布清单绑定预检ci-07-基础)说明其边界，通过不代表已验签、策略安全或生产预检完成。主机基线、停止写入后的卷元数据预检与整卷备份入口见 [CI-07 主机准备与离线备份](scripts/deploy/README.md)。

## MCP 服务器（可选）

通过 `DATA_DIR/mcp.json`（或 `MCP_CONFIG` 指定的路径）接入 MCP server，无需改代码。默认文件不存在表示不启用；显式指定的文件缺失、不是合法 JSON 或顶层结构错误时启动失败，默认路径上的文件级错误只禁用 MCP 并记录原因。离线校验该文件、不连接 server 的命令是 `npm run build && node dist/src/check-config.js`（`npm run check` 只做类型检查）。

配置好之后用 `npm run build && npm run mcp:check` 做一次连接冒烟测试：它按 bot 相同的方式读取配置和环境变量，逐个连接 server、列出工具名后关闭，不启动 Telegram 和模型。输出示例：

```text
github (stdio): 12 tools
  create_issue
  search_repositories
calendar: unavailable (MCP_AUTH_REQUIRED)
```

任一 server 失败时退出码为 1；单个 server 失败不影响其他 server 的输出。它打印的是 server 自报的工具，包含 agent 之后会因 schema 或重名跳过的工具；它不打印 URL、header、env 或 token。

```json
{
  "servers": [
    {
      "name": "github",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "cwd": "/var/lib/personal-agent/workspace",
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },
      "timeoutMs": 60000,
      "connectTimeoutMs": 10000
    },
    {
      "name": "calendar",
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "X-Client": "personal-agent" },
      "auth": { "type": "oauth", "scope": "calendar.read", "redirectPort": 8765 }
    }
  ]
}
```

- `name` 唯一，匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$`；最多 8 个 server，其中 stdio 最多 4 个。超出数量的条目被忽略并记录告警，其余条目照常生效。
- stdio：`command` 必填；`args`、`env` 为字符串数组／映射；`cwd` 必须是存在的绝对路径。默认 `inheritEnv: false`，子进程只得到 `PATH` 等运行所需变量加 `env` 中的条目，bot 的模型与 Telegram 凭据不会传入 server。
- http：必须是 `https`，仅回环地址允许 `http`；`headers` 键不得含控制字符，值在 `${NAME}` 解析后必须只含制表符、可见 ASCII 或 Latin-1 字符（Fetch 不接受其他字符，如换行或中文）；`auth.type` 目前只支持 `oauth`。
- `args`、env 值、header 值和 `clientSecret` 中的 `${NAME}` 从应用环境解析，缺失变量只禁用该条目并只报告变量名。
- 单条无效、重名、超出数量或缺失变量只跳过该条目并记录告警，不影响其他 server。顶层结构错误、未知顶层键、不是合法 JSON 属于文件级错误。文件可带 UTF-8 BOM。
- 配置文件含凭据引用，部署时设为 `600`，不要提交仓库。

工具以 `mcp__<server>__<tool>` 命名，默认**不直接提供给模型**。系统提示只列出已连接的 server 和工具数量；模型先调用 `tool_search` 加载需要的工具，之后才能调用，已加载的工具随该会话保存。server 返回的参数 schema 必须能表示为 object 且有界（16 KiB、深度 12、属性 256 个、无 `$ref`），否则跳过该工具；名称冲突时用固定哈希后缀避免与内置工具重名，同一 server 的工具按原始名称排序后分配，重启不会改变归属。每个 server 最多登记 100 个工具、10 页，且整次工具发现限时 30 秒；发生截断时日志会记录。图片结果超过 4 MiB 时替换为文字说明，不进入会话记录。

MCP 调用一律按不可重放处理（`replay: "unsafe"`）：进程中断后不会自动重跑，避免重复外部副作用。启动时某个 server 不可用只记录安全错误码（如 `MCP_TIMEOUT`、`MCP_HTTP_401`）并跳过；运行中掉线的工具保留，调用返回 `MCP_CLOSED`，重启进程后重连，不做自动重连。

`auth.authorizationServerMetadataUrl` 可指定授权服务器的 metadata 文档，用于 MCP server 公布的授权服务器有误或不可达时；`mcp:auth` 与 bot 的刷新路径使用同一配置。

OAuth：bot 只使用和刷新 `DATA_DIR/mcp-oauth/<server>.json` 中的 token，不在 bot 进程内开回调端口。首次授权或需要重新授权时，先停止 bot（避免两个进程竞争 token 文件），再执行：

```sh
npm run build
DATA_DIR=./data npm run mcp:auth -- calendar
```

`mcp:auth` 与 bot 读取同一组 `DATA_DIR`、`MCP_CONFIG` 环境变量；用 `MCP_CONFIG` 指定过路径时，授权命令也要带上同样的值。生产容器的维护命令与 OAuth 回调转发见 [部署指南](docs/deployment-test-guide.md)。

打开命令打印的 URL 完成授权，回到终端等待回调。服务器没有入站端口时，先建立到配置端口的 SSH 端口转发，例如 `ssh -L 8765:127.0.0.1:8765 user@host`。命令只打印 server 名和工具数量，不打印 token。运行中需要重新授权时，该工具调用返回 `MCP_AUTH_REQUIRED`，按上述步骤处理后重启。

### 需要浏览器登录账号的 server（如 Notion）

这类 server 的 OAuth 就是普通网页登录：授权 URL 打开后，用户在浏览器里登录自己的账号并点击同意，回调带回授权码。客户端侧无需预注册，配置里只写 URL 和 `auth`：

```json
{
  "name": "notion",
  "transport": "http",
  "url": "https://mcp.notion.com/mcp",
  "auth": { "type": "oauth" }
}
```

流程与上一节相同：`npm run mcp:auth -- notion` 打印授权 URL，浏览器打开、登录并同意，回到终端等待回调，最后打印工具数量。具体行为：

- **客户端注册**：授权服务器支持 RFC 7591 动态注册时自动完成（Notion 支持），回调地址固定为 `http://127.0.0.1:<redirectPort>/callback`。注册得到的 `client_id` 与 token 一起保存在 `DATA_DIR/mcp-oauth/<server>.json`，再次授权会复用；**不要删除该文件**，重新注册会让已有授权失效。
- **登录范围**：授权以点击同意的那个账号为界，能访问的内容就是该账号在 Notion 里的权限。换账号或换 workspace 需要重新授权。
- **token 生命周期**：访问令牌约 8 小时，401 后自动用 refresh token 刷新；refresh token 每次刷新都会轮换，同一授权文件不能被两个进程同时刷新（所以授权和排查前先停 bot）。refresh token 在首次授权后 180 天、或连续 30 天未使用时失效，下一次刷新返回 `invalid_grant`，应用清除旧 token 并把工具调用报为 `MCP_AUTH_REQUIRED`。**这是预期行为**，重新执行 `mcp:auth` 即可，不要反复重启。
- **headless 服务器**：授权 URL 在操作者的电脑上打开，回调需要到达服务器，因此先 `ssh -L <redirectPort>:127.0.0.1:<redirectPort> user@host`。授权服务器只接受 loopback 回调，不能用公网地址替代。
- **企业策略**：若 workspace 强制由管理员预配（Notion 的 enterprise-managed authorization），动态注册会被拒绝；此时需要管理员提供 `clientId`／`clientSecret` 并在其后台登记上面的回调地址。

MCP server 与应用使用同一系统用户，不构成安全边界；stdio server 的代码和配置应视为受信任组件。不要把无关凭据放进 `env` 或 `headers`。远程 HTTP + OAuth 的隔离更强，优先选用。

部署注意：

- Aster 镜像自带 Bash 和 npm，`HOME=/data`、`NPM_CONFIG_CACHE=/data/.npm`，缓存与 OAuth 状态均可持久化。MCP 配置使用容器内路径，例如 `/data/workspace`。
- stdio server 的依赖宜在派生镜像中预装；隔离 Vault 模式不会自动放行 npm registry。把 MCP 配置放在数据卷内，不要把含 secret 的配置写进镜像。
- 每个 stdio server 都会增加常驻进程和内存占用；4 GB 主机上优先少而稳的 server。

## 投递核查与补发

网络超时可能发生在 Telegram 已收到消息之后，因此应用不会自动重发结果未知的消息。明确拒绝的发送与未知发送分别保存；程序不丢弃已生成回复。

构建后可查看请求 ID、从 0 开始的分段编号和错误码：

```sh
npm run deliveries -- list
```

先停止应用，核对 Telegram 实际收到的内容，再处理相应分段：

```sh
# 确认需要重新发送：可能重复已送达但未获确认的该分段
npm run deliveries -- retry telegram:123:456 1

# 已确认该分段送达：继续后面的分段
npm run deliveries -- sent telegram:123:456 1
```

这些命令只修改本地投递状态，重新启动应用才会发送待投递内容。不会重新执行 agent 或工具。命令在列出或修改前会先执行恢复：进程在发送中被强杀的分段会转为 `uncertain` 并出现在列表中；`sending` 不会直接出现在输出里。本地记录只清理已送达请求，保留最新 100 条；未完成或待核查请求不会被清理。底座会话的历史管理仍由底座负责。

## Linux 云服务器

生产交付统一使用 Docker 镜像 **Aster**（镜像仓库名 `aster`）。服务器只需 Docker Engine 24+ 与 Compose 2.24.4+，不需要主机 Node.js 或 Go。开发运行仍可使用上文的 npm 命令。

先在构建机生成本地镜像：

```sh
docker build -t aster:local .
cp .env.example .env
# 填写 .env 中的 bot、owner、模型和 API key
docker compose run --rm --no-deps personal-agent node dist/src/check-config.js
docker compose up -d
docker compose logs --tail 50 personal-agent
```

也可使用显式构建覆盖：`docker compose -f docker-compose.yml -f docker-compose.build.yml build`。生产 Compose 本身只引用镜像；仓库尚未发布公共镜像。通过镜像仓库或 `docker save` / `docker load` 把产物交付到服务器，不在生产主机上强制构建。

生产发布在 `.env` 中指定实际镜像摘要，例如 `ASTER_IMAGE=registry.example.com/team/aster@sha256:<digest>`，然后拉取、停止旧实例并更新：

```sh
docker compose pull
docker compose stop personal-agent
docker compose up -d --no-build personal-agent
docker compose logs --tail 50 personal-agent
```

`running` 只表示进程存在，仍需核对初始化日志、重启次数及真实 Telegram 验收；当前没有应用就绪探针。不要对同一 bot 或数据卷启动多个实例。

持久化卷继续使用 `personal-agent-data`，不随 Aster 改名；容器内固定 `/data`，由 uid 1000 读写。应用默认内存上限 1 GB、128 个进程/线程、45 秒停止宽限；这些是配置上限，4 核／4 GB 目标机峰值仍待验收。更新不删除数据卷，禁止用 `down -v` 代替普通停服。

维护命令在停服后通过同一 Compose 配置执行：

```sh
docker compose stop personal-agent
docker compose run --rm --no-deps personal-agent node dist/src/deliveries.js list
docker compose up -d personal-agent
```

完整的镜像交付、备份恢复、MCP/OAuth、systemd 旧数据迁移及上线验收见 [部署指南](docs/deployment-test-guide.md)。Vault 隔离及多 vault router 使用各自 Compose 组合，见 [Agent Vault](docs/agent-vault.md)；不要与普通 Compose 混合。

## 验证边界

本地自动化验证覆盖类型、构建、消息边界、分段投递、工具重放、取消及底座离线恢复；真实 Telegram/模型联调需要有效配置。测试通过不代表已部署，仓库不包含真实凭据。历史 MVP 用例记录见 [docs/mvp-verification.md](docs/mvp-verification.md)，本次镜像迁移的实测结果与阻塞见 [Docker 验证记录](docs/docker-verification.md)。

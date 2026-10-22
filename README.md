# Personal Agent

基于官方 `@earendil-works/pi-durable` 的个人任务助手：从 Telegram 私聊接收文本，运行 agent 和工具，然后回复。远端模型负责推理；应用面向 4 核 CPU、4 GB 内存云服务器部署。

## 开始运行

需要 Node.js 24.19.0，以及可访问 Telegram 和所选模型服务的网络。

```sh
npm ci
cp .env.example .env
```

在 `.env` 中填写：

- `TELEGRAM_BOT_TOKEN`：BotFather 创建的 bot token。
- `TELEGRAM_OWNER_ID`：允许使用 bot 的个人 Telegram 数字用户 ID。
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
| `workspace/MEMORY.md` | 用户明确要求保存的长期事实 |
| `workspace/` | agent 的任务文件 |
| `agent.sqlite` 及其 WAL 文件 | 底座会话与执行恢复状态 |
| `inbox.sqlite` 及其 WAL 文件 | 请求消费位置、身份绑定和投递状态 |
| `mcp.json`（可选） | MCP server 配置；默认路径，可用 `MCP_CONFIG` 覆盖 |
| `mcp-oauth/<server>.json`（可选） | 远程 MCP server 的 OAuth token，仅属主可读 |

同一个数据目录只允许一个应用进程使用。数据目录绑定 bot 和 owner，不能直接更换身份后继续使用原会话。部署更新保留整个目录；备份时先停止服务，再复制数据目录，包含 SQLite 相关文件。

当前使用一个会话、串行用户请求及顺序工具执行。单个请求等待上限为 5 分钟；执行超时后向底座请求取消。此上限不代表任意外部副作用可被撤销。正常进程关闭保留未完成请求，重启后恢复。

接入每次最多取得 10 条 update，处理完本地待办后再轮询，不构造无限内存队列。长期繁忙时，消息仍滞留 Telegram；这不是高吞吐或长期离线收件箱。

## 自定义工具

在 `src/tools.ts` 使用底座 `defineTool` 定义工具，并加入 `personalTools.tools`。现有 `current_time` 是最小示例。参数由 TypeBox schema 定义，底座负责执行前校验；名称冲突在注册时拒绝。

内置工具为 `read/write/edit/bash`，由 pi durable 提供。文件记忆通过这些工具维护，不另建记忆数据库。工具并非文件系统沙箱，生产环境使用独立的低权限系统用户；部署示例约束写入持久化目录。

工具契约、错误语义、重放与升级兼容性见 [设计文档](docs/contracts-and-lifecycle.md)。仓库级约束见 [CLAUDE.md](CLAUDE.md)，MVP 范围见 [docs/mvp.md](docs/mvp.md)。

## MCP 服务器（可选）

通过 `DATA_DIR/mcp.json`（或 `MCP_CONFIG` 指定的路径）接入 MCP server，无需改代码。默认文件不存在表示不启用；显式指定的文件缺失、不是合法 JSON 或顶层结构错误时启动失败，默认路径上的文件级错误只禁用 MCP 并记录原因。离线校验该文件、不连接 server 的命令是 `npm run build && node dist/src/check-config.js`（`npm run check` 只做类型检查）。

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

`mcp:auth` 与 bot 读取同一组 `DATA_DIR`、`MCP_CONFIG` 环境变量；用 `MCP_CONFIG` 指定过路径时，授权命令也要带上同样的值（systemd 部署见 [deploy/README-systemd.md](deploy/README-systemd.md)）。

打开命令打印的 URL 完成授权，回到终端等待回调。服务器没有入站端口时，先建立到配置端口的 SSH 端口转发，例如 `ssh -L 8765:127.0.0.1:8765 user@host`。命令只打印 server 名和工具数量，不打印 token。运行中需要重新授权时，该工具调用返回 `MCP_AUTH_REQUIRED`，按上述步骤处理后重启。

MCP server 与应用使用同一系统用户，不构成安全边界；stdio server 的代码和配置应视为受信任组件。不要把无关凭据放进 `env` 或 `headers`。远程 HTTP + OAuth 的隔离更强，优先选用。

部署注意：

- systemd 的 `ProtectHome`/`ProtectSystem` 使默认 npm 缓存不可写。用 `npx` 启动 stdio server 时，在 `/etc/personal-agent.env` 设置 `NPM_CONFIG_CACHE=/var/lib/personal-agent/.npm`（位于 `ReadWritePaths` 内），或构建时预装 server 并改用绝对路径。`TasksMax=64` 需同时容纳 stdio server 进程。
- Docker 镜像自带 npm；把 MCP 配置放在数据卷内，不要把含 secret 的配置写进镜像。
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

提供两种部署方式：Docker Compose（无需在主机安装 Node）和 systemd 直接托管。主机只有这一个服务时 Docker 更省运维；主机已有其他 Docker 服务（如 QQ bot）时用 systemd，资源账更好算。两种方式都没有取代另一种，选择依据见 [部署指南](docs/deployment-test-guide.md) 第 1.5 节。

### Docker

需要 Docker 24 及 Compose v2，主机安装 `bash`（工具执行依赖它）。

```sh
# 在项目目录创建 .env，至少填写 TELEGRAM_BOT_TOKEN、TELEGRAM_OWNER_ID、MODEL_PROVIDER、MODEL_ID 和对应 API key
cp .env.example .env
vi .env

docker compose build
docker compose up -d
docker compose logs -f
```

- 持久化数据保存在命名卷 `personal-agent-data`（容器内 `/data`），`docker compose down` 不会删除；只有 `docker compose down -v` 会删除。卷名由 `docker-compose.yml` 顶层 `volumes` 的 `name: personal-agent-data` 显式指定，不随项目目录名变化。设置显式卷名之前创建的卷带项目前缀（如 `<目录名>_personal-agent-data`），升级时需先把其中的数据复制到新卷，否则应用会看到空数据目录。
- `DATA_DIR` 在 compose 中固定为 `/data`，`.env` 里的 `DATA_DIR` 会被覆盖。
- 容器以非 root 的 `node` 用户运行，内存上限 3 GB，`init: true` 回收工具子进程，停止宽限期 45 秒。systemd 示例默认更紧（`MemoryMax=1G`），用于与 QQ bot 等容器共存；Docker 方式适合独占主机。
- 同一数据卷只允许一个容器使用；不要对同一卷启动多个副本。
- 备份：先停止服务，再归档整个卷。归档后列出内容，确认三个持久化位置都在，不能只看命令退出码。

  ```sh
  docker compose stop
  docker run --rm -v personal-agent-data:/data -v "$PWD":/backup alpine \
    tar czf /backup/personal-agent-data.tgz -C /data .
  tar tzf personal-agent-data.tgz | grep -E '(^|/)(inbox|agent)\.sqlite(-wal|-shm)?$|workspace/MEMORY\.md$'
  ```

  输出应包含 `inbox.sqlite`、`agent.sqlite` 和 `workspace/MEMORY.md`；SQLite 的 `-wal`、`-shm` 文件可能同时存在。用 `ls -l personal-agent-data.tgz` 确认归档非空。备份完成后 `docker compose start`。

- 还原：停服务后把归档解回同一卷。归档保留 `node` 用户（uid 1000）的文件所有权。

  ```sh
  docker compose down
  docker run --rm -v personal-agent-data:/data -v "$PWD":/backup alpine \
    sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/personal-agent-data.tgz -C /data'
  docker compose up -d
  docker compose logs --tail 20
  ```

  还原会覆盖卷内现有数据，只用于恢复演练或确实需要回到旧状态时。启动日志出现配置或身份错误时，先核对 `.env` 与归档是否来自同一个 bot。

- 投递核查命令需在容器内执行（先停服务）：

  ```sh
  docker compose stop
  docker compose run --rm personal-agent node dist/src/deliveries.js list
  docker compose start
  ```

- 更新：拉取新代码后重新 `docker compose build && docker compose up -d`；数据卷保持不变。

### systemd

提供 [systemd 服务示例](deploy/personal-agent.service) 和安装脚本，默认代码位于 `/opt/personal-agent`，数据位于 `/var/lib/personal-agent`，配置位于 `/etc/personal-agent.env`。

```sh
sudo ./deploy/install-systemd.sh
```

脚本会创建系统用户和目录、安装依赖并构建、生成 unit、启用服务；必需配置缺失或为空时只启用不启动。重复执行会清空并重建代码目录、更新 unit，保留数据与配置。详细行为、路径约定和日常操作见 [deploy/README-systemd.md](deploy/README-systemd.md)。

手动安装：

1. 在服务器安装 Node.js 24.19.0、npm、bash，以及提供 `flock` 的 util-linux；创建 `personal-agent` 系统用户。
2. 将项目部署到 `/opt/personal-agent`，执行 `npm ci && npm run build && npm prune --omit=dev`。
3. 将 `.env.example` 的配置写入 `/etc/personal-agent.env`，设为 root 所有、权限 `600`，并使用 `DATA_DIR=/var/lib/personal-agent`。
4. 将服务文件安装到 `/etc/systemd/system/personal-agent.service`，执行 `systemctl daemon-reload` 和 `systemctl enable --now personal-agent`。
5. 使用 `journalctl -u personal-agent -f` 查看运行情况。

服务采用 `flock` 避免重复实例，应用与工具共享 1 GB 内存硬上限（`MemoryHigh` 768 MB、`TasksMax` 64），适合与其他服务共存于 4 GB 主机。单独使用时可通过 `systemctl edit personal-agent` 调高。该上限是保护措施，不是性能保证。实际云端内存、取消和重启行为仍需上线环境验收。工具子进程继承宿主环境，部署账户和所配置凭据均属于受信任执行环境，不用于执行敌对代码。

生产环境使用投递管理命令时，要以同一服务用户和同一个 `DATA_DIR` 运行，例如：

```sh
sudo -u personal-agent env DATA_DIR=/var/lib/personal-agent node /opt/personal-agent/dist/src/deliveries.js list
```

先停服务再修改投递记录。服务停止后尚处于 sending 的分段，会在下一次应用启动恢复为 uncertain。

## 验证边界

本地自动化验证覆盖类型、构建、消息边界、分段投递、工具重放、取消及底座离线恢复；真实 Telegram/模型联调需要有效配置。测试通过不代表已部署，仓库不包含真实凭据。当前环境、用例与资源边界记录见 [docs/mvp-verification.md](docs/mvp-verification.md)。

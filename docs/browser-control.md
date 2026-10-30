# 浏览器部署与运行

## 独立浏览器容器

浏览器是可选部署能力。`docker-compose.browser.yml` 为基础 Compose 的叠加文件，增加 `aster-browser`，Aster 主镜像不安装 Chromium。浏览器使用已发布的官方 Playwright `v1.64.1-noble` 镜像，固定多架构 manifest digest `sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea`，支持 Linux amd64 和 arm64。镜像内含 Node 和浏览器二进制，但不提供可供应用导入的 Playwright npm 包，因此仅在 sidecar 内安装精确版本 `playwright-core@1.64.1` 来定位对应 Chromium。

浏览器 headless 运行，Chromium 的 CDP 监听 `127.0.0.1:9223`；无额外依赖的 Node 代理在容器 `9222` 提供 CDP HTTP、WebSocket 和资源指标。发现响应中的 loopback WebSocket 地址会改写成调用方使用的容器地址。Aster 通过 `http://aster-browser:9222` 连接。Compose 没有 `ports` 映射，也没有 Docker socket 挂载。默认 bridge 网络允许浏览器访问互联网；不能将唯一网络改成 `internal: true`，否则普通导航和代理连接会失败。

浏览器资源上限为内存 `2g`、共享内存 `1g`、进程／线程 `512`；`restart: unless-stopped` 在浏览器进程退出时恢复 sidecar。主进程使用 init 回收子进程，收到停止信号时关闭代理并终止 Chromium。浏览器崩溃不会终止 Aster，Aster 的 CDP 客户端需要在下次任务重连。浏览器代理不添加 Aster 启动依赖，避免浏览器故障阻止主服务启动。

浏览器与 Aster 均以 UID/GID 1000 访问 `/data/browser`。启动前在 Linux 宿主机创建目录并赋予权限；默认位置为 `~/Aster/data/browser`：

```sh
browser_data="${BROWSER_DATA_DIR:-$HOME/Aster/data/browser}"
sudo install -d -o 1000 -g 1000 -m 0750 "$browser_data" \
  "$browser_data/shots" "$browser_data/pages" "$browser_data/traces"
```

如果需要更换位置，在 `.env` 配置绝对路径 `BROWSER_DATA_DIR=/srv/aster/browser`，并让上述命令的 `browser_data` 指向同一目录。Compose 不自动创建缺失的宿主目录，以免产生 root 所有、应用不可写的目录。Windows Docker Desktop 应显式设置 `BROWSER_DATA_DIR` 到允许共享的绝对路径；默认 `${HOME}` 面向 Linux 部署。两个容器共享该目录，分别存放截图 `shots/`、页面产物 `pages/` 和 trace `traces/`，更新镜像保留产物。浏览器 profile 位于 sidecar 临时目录，不承诺持久化登录状态。

在已有 `.env` 与基础 Aster 镜像准备完成后运行：

```sh
docker compose -f docker-compose.yml -f docker-compose.browser.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.browser.yml up -d --build
```

所有后续 Compose 操作都要保留这两个 `-f` 参数。该命令只构建 sidecar；基础服务使用原有 `ASTER_IMAGE` 镜像配置。可先使用 `docker compose ... build aster-browser` 单独构建镜像。

可选 `.env` 配置 `BROWSER_PROXY=http://proxy.example:8080` 或 `socks5://proxy.example:1080`，只传给 sidecar 的 Chromium `--proxy-server` 参数。叠加文件显式将 Aster 容器的同名变量置空，以覆盖基础 `env_file`；不改变主服务或模型请求的代理。该配置只接受代理服务器地址，不接受用户名、密码、路径、查询参数或 fragment；需要认证时由同网络可信代理处理。sidecar 不加载 Aster 的 `.env` 文件，不记录启动参数、原始浏览器 stderr、代理 URL 或环境内容。容器检查仍能看到其配置，不能把凭据写入该变量。

浏览器显式以 UID/GID `1000:1000`、`cap_drop: ALL`、`no-new-privileges` 运行，避免上游 Ubuntu／`pwuser` 的 UID 分配变化影响共享目录。Chromium 使用 `--no-sandbox`，这里依赖独立容器边界，并非完整的恶意站点隔离。CDP 无认证且具有完整浏览器控制权限，只应让受信任的 Compose 服务加入该网络，不要发布 `9222`、使用 host 网络或将该端口接入公共反向代理。产物目录可能含页面敏感内容，需由部署方限制访问并清理历史产物。

## 内部资源指标契约

`GET http://aster-browser:9222/aster/metrics` 返回 sidecar 所属 cgroup 的指标，不使用 Docker API：

```json
{
  "memoryBytes": 1234,
  "memoryLimitBytes": 2147483648,
  "pids": 12,
  "pidsLimit": 512
}
```

计量单位为字节和 cgroup 任务数（含线程），不是宿主总内存或 Chromium 主进程数。支持标准容器 cgroup v2 根目录，以及 cgroup v1 的 `memory/`、`pids/` 布局；限制值为无限时返回 `null`，读取失败、非法数值或超时返回 HTTP 503 和固定错误 `{"error":"Browser metrics unavailable"}`，不以零伪造指标。每个文件最多读取 128 字节，指标等待最多 1.5 秒，读取保持单个进行中的请求，避免超时探测堆积。HTTP 并发最多 16，连接最多 64，WebSocket 最多 32，超限拒绝连接或返回错误。CDP HTTP 发现响应最多 1 MiB，超限返回 502；WebSocket 通过背压流式转发，10 分钟无流量关闭。代理只开放 GET 发现接口 `/json/version`、`/json/list`、`/json`、`/json/protocol`、指标接口及 `/devtools/browser/*`、`/devtools/page/*` WebSocket。

在 Aster 容器内检查服务和资源：

```sh
docker compose -f docker-compose.yml -f docker-compose.browser.yml exec personal-agent \
  node -e "Promise.all(['/json/version','/aster/metrics'].map(async p => { const r = await fetch('http://aster-browser:9222' + p, {signal: AbortSignal.timeout(5000)}); console.log(p, r.status, await r.text()); if (!r.ok) process.exitCode = 1; })).catch(() => process.exit(1))"
```

测试重启时使用 `docker compose -f docker-compose.yml -f docker-compose.browser.yml restart aster-browser`，随后再次运行上述探测并验证 `/browser_health`。配置渲染及本地 Node 代理测试不能替代容器和真实 Telegram 验收。

## 应用生命周期与工具

设置 `BROWSER_CDP_URL=http://aster-browser:9222` 启用浏览器；仅接受无凭据、查询或路径的 HTTP(S) origin。工具发现只启动本地 MCP，不要求 CDP 已可用。每条 Telegram 请求使用一个 MCP stdio 会话和独立的 `--isolated` context，任务结束后调用 `browser_close` 并关闭连接；常驻 Chromium 继续运行。

原生工具名为 `pw.browser_navigate`、`pw.browser_navigate_back`、`pw.browser_snapshot`、`pw.browser_click`、`pw.browser_type`、`pw.browser_press_key`、`pw.browser_select_option`、`pw.browser_take_screenshot`。均通过 pi-durable schema 验证与宿主权限审查，外部操作不可自动重放；本版本不暴露执行任意 JavaScript、安装浏览器、上传文件或设置存储状态的 MCP 工具。截图路径、格式和视口截图范围由宿主生成，模型不能覆盖目录。导航仅接受 HTTP(S) 与 about:blank，单次 URL 最多 4096 字符，字符串参数最多 16000 字符，每请求最多 40 次浏览器调用。

动作超时 5 秒、导航 20 秒、MCP 调用 30 秒。首个操作前最多等待 CDP 就绪 15 秒；只读就绪探测可以重试，网页操作不自动重试。断连、超时或 MCP 操作错误后本轮停止，后续请求建立新连接。检测到安全验证页或 Google 429 时只允许截图，阻止继续交互。该检测是保守的文本启发式，仍要求模型遇验证截图停止，不承诺识别所有验证形式。

请求标识经过 SHA-256 后成为目录名，不记录 Telegram 身份。截图保存在 `shots/<hash>/*.png`，对应 manifest 保留截图关联；pages 保存 MCP 页面产物，traces 保存请求状态与工具调用计数。trace 是生命周期记录，不是 Playwright trace zip。恢复同一已开始请求时页面状态视为丢失，避免把新 context 冒充旧状态；已完成的 durable 回复仍可使用保存的截图。强杀应用可能留下浏览器 context，需重启 sidecar 清理。产物不自动删除；运维清理前须核对未完成与待补发投递，不能删除其引用文件。

`/browser_health` 绕过模型，打开 about:blank、保存并返回 PNG，同时显示 cgroup 内存与任务数；未配置时返回启用提示。每请求最多 3 张、每张最多 8 MiB，只允许 browser/shots 内真实 PNG 常规文件。回复与全部图片分段在 inbox 同一事务保存后发送；每段单独确认。上传结果未知进入 uncertain，按现有 `npm run deliveries` 流程核对补发；重投使用已有文件，不重新运行网页任务。图片文件丢失或无效明确 failed。

## 模型与费用验收

沿用 `MODEL_PROVIDER=deepseek` 和 `MODEL_ID=deepseek-v4-pro` / `deepseek-flash`；它们是安装的 pi-ai 1.3.0 目录中的实际 id。Playwright MCP 0.0.83 自带 alpha 版 Playwright，与 stable 1.64.1 sidecar 的 CDP 连接、截图、context 清理及重启重连已在下述容器验证。`pw.` 点号名称已通过底座原生 faux 模型执行验证，尚未用真实 DeepSeek API 验证其工具名接受情况。

具备模型 key、CDP 与可写数据目录时，在仓库执行：

```sh
npm run build
# 在环境文件中分别设置上述两个 MODEL_ID 后，各执行一次；真实请求会产生模型费用。
node --env-file=.env scripts/browser-model-check.mjs
```

脚本使用同一 pi-durable agent loop，要求从搜索首页操作，为百度、谷歌、超星逐任务保存回复、耗时、浏览器调用次数、截图及底座模型 usage 前后快照，供人工判断摘要质量；不会把成功返回等同于验收通过。每次使用独立测试目录，不复用生产对话。费用采用模型 usage 的 cost 差值；代理流量和费用由实际代理账单补充，未知记 null；另行运行 `docker stats --no-stream aster-browser-v1-check` 记录 CPU/内存，不计服务器费用。当前脚本不测真实 Telegram，须另外验证 bot 中收到图片。

## 专用容器验证入口

以下命令只用于空闲测试机；先确认不存在同名网络、卷或容器。它们不使用生产数据，也不映射 CDP 宿主端口：

```sh
docker build -t aster:browser-v1 .
docker build -t aster-browser:playwright-1.64.1 deploy/browser
docker network create aster-browser-v1-check
docker volume create aster-browser-v1-check
docker run -d --name aster-browser-v1-check --network aster-browser-v1-check \
  --network-alias aster-browser --init --shm-size 1g --memory 2g --pids-limit 512 \
  --restart unless-stopped --cap-drop ALL --security-opt no-new-privileges:true \
  --mount type=volume,source=aster-browser-v1-check,target=/data/browser \
  aster-browser:playwright-1.64.1
docker run --rm --network aster-browser-v1-check \
  --env BROWSER_CDP_URL=http://aster-browser:9222 \
  --mount type=volume,source=aster-browser-v1-check,target=/data/browser \
  --mount "type=bind,source=$PWD/scripts,target=/app/scripts,readonly" \
  --entrypoint node aster:browser-v1 scripts/browser-smoke.mjs
node scripts/browser-restart-check.mjs
```

重启检查脚本创建应用测试进程后暂停，等待操作者在另一个终端手动重启上述专用浏览器容器，再按 Enter 继续断连与重连断言；脚本不执行容器重启。smoke 报告和截图保留在专用卷内，输出可能包含网站临时验证 URL，不应直接发布原始报告。检查并导出所需证据后，再由操作者删除这三个测试对象。

## 2026-10-30 实际验证

- Docker Desktop Linux engine 29.7.2，Aster Node 24.19.0；两个镜像构建成功，Aster 镜像无 `/ms-playwright` 或 Chromium/Chrome 可执行程序。
- 真实 MCP stdio → CDP → Chromium：about:blank 截图成功；通过 `Target.getBrowserContexts` 检查任务中增加一个 context，结束回到原计数；浏览器保持运行。
- 容器重启时原操作返回错误，同一 Aster 浏览器运行时进程继续存活；下一请求等待就绪后成功重连并截图。`scripts/browser-restart-check.mjs` 与 worker 为该检查入口，针对专用 `aster-browser-v1-check` 网络、卷和容器，不能用于生产对象。最终追加清理错误日志后申请再次复测，自动审批因当前上下文缺少该容器创建记录而拒绝；该次复测未执行，以上结果来自此前通过的真实重启检查。随后将检查入口改为等待操作者手动重启，该交互入口仅完成语法检查，未重跑容器断言。
- 最后一轮 `scripts/browser-smoke.mjs` 在 Aster 镜像内执行，无模型、无 Telegram：百度搜索遇安全验证，约 17.2 秒、2 次工具调用、截图停止；谷歌约 8.3 秒返回 `/sorry/`、HTTP 429，2 次调用、截图停止，没有可用搜索结果；超星公开首页约 19.0 秒、3 次调用，读取快照并截图。快照包含个人作者授权、出版社授权、院士题词、超星名师讲坛、超星期刊及学习通下载入口；未登录、未逐个打开入口。搜索 smoke 直接打开结果 URL，不等同于从首页搜索的模型验收。测试网络未设置 BROWSER_PROXY；宿主环境自身出口不代表部署服务器出口。
- 最后一轮健康探测读取内存 404520960 / 2147483648 bytes、cgroup 任务 199 / 512；随后空闲 Docker stats 为 253.9 MiB / 2 GiB、CPU 0.00%、146 tasks。均为样本而非峰值或生产容量承诺；未计服务器费用。
- 最终全量离线测试为 276 项、268 通过、0 失败、8 项环境条件跳过；浏览器专项 23/23 通过，包含验证页与清理失败回归。类型检查、构建、脚本语法及 `git diff --check` 通过。
- 首次容器检查发现 `/json/version/` 尾斜杠未被代理接受，修复并加入回归；首次重启检查发现就绪竞态，增加操作前有界只读探测后通过。
- 开发环境无 `.env`、DeepSeek key、Telegram token；两模型摘要/成本、真实 Telegram 图片、代理流量/费用仍未验收。保留临时 spec 与 Proposed ADR；本记录不宣称 issue 全部完成。

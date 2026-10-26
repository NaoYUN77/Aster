# Aster Docker 部署运行手册

生产交付统一使用 Docker 镜像 **Aster**（镜像仓库名 `aster`）。服务器只需要 Docker Engine 24+ 和 Compose 2.24.4+，不需要主机 Node.js 或 Go。开发运行仍可使用 README 中的 npm 命令。

状态：本手册依据本地镜像构建、Compose 配置渲染和主机测试编写，尚未在真实云服务器执行完整上线。文中的“预期”是验收标准，不是已完成的部署记录。原 systemd 部署已停止支持，只保留[迁移路径](#9-从-systemd-迁移)。

## 1. 交付物与镜像

| 文件 | 用途 |
| --- | --- |
| `docker-compose.yml` | 基础部署：只运行应用，镜像为 `${ASTER_IMAGE:-aster:local}`，不含 `build` |
| `docker-compose.build.yml` | 本地构建覆盖：为应用添加 `build: .` |
| `docker-compose.agent-vault.yml` | Agent Vault 隔离部署：broker、防火墙命名空间和应用；应用镜像 `${ASTER_IMAGE:-aster:local}`，网络镜像 `${ASTER_NETWORK_IMAGE:-aster-network:local}` |
| `docker-compose.agent-vault.build.yml` | Vault 模式的本地构建覆盖：应用和网络容器 |
| `docker-compose.router.yml` | 多 vault 覆盖：只能叠加在 Vault 基础文件上；新增 `${ASTER_ROUTER_IMAGE:-aster-router:local}` |
| `docker-compose.router.build.yml` | 路由器构建覆盖：`build: ./router` |
| `docker-compose.agent-vault.broker-build.yml` | 受审 broker 本地构建覆盖；来源与补丁见 [broker 说明](../deploy/agent-vault/broker/README.md) |

镜像仓库目前没有发布 Aster 的公共镜像。示例中的 `aster:local` 是本地标签，生产应替换为你自己的镜像仓库引用。`docker-compose.router.yml` 使用 Compose 的 `!override` 标签，因此 Compose 最低版本为 **2.24.4**；更早版本会直接报解析错误。

资源上限（配置值，不是实测峰值）：

| 服务 | 内存 | 进程/线程 |
| --- | --- | --- |
| `personal-agent` | 1 GB | 128 |
| `agent-vault` | 512 MB | 64 |
| `tool-network` | 32 MB | 16 |
| `egress-router` | 128 MB | 32 |

基础部署的应用容器以 uid 1000 运行，可写卷 `/data`；它的根文件系统并非只读。Vault 模式的 `personal-agent` 服务额外设置 `read_only: true` 和 128 MB `/tmp` tmpfs，此时唯一可写持久化位置是 `/data`（以及 tmpfs）。镜像内置 Bash、`flock`、npm 和 Node 24.19.0，并设置 `HOME=/data`、`NPM_CONFIG_CACHE=/data/.npm`。

### 同一数据卷的单实例保护

镜像入口为 `flock --no-fork --nonblock /data/app.lock node dist/src/main.js`。同一个数据卷上的第二个应用容器会因拿不到锁而立即退出，这是有意的保护。它只覆盖“同卷多容器”：

- 不同数据卷、同一个 bot token 或同一个 owner 的两个实例不会被镜像检测。Telegram 长轮询会互相争抢，可能产生重复回复。
- 迁移、回滚或演练期间不要让旧实例和新实例同时消费同一个 bot。
- 同一数据卷只允许一个容器使用；不要用 `docker compose up --scale` 扩容。

## 2. 配置

基础部署使用项目目录下的 `.env`：

```sh
cp .env.example .env
vi .env
chmod 600 .env
```

必填项：

- `TELEGRAM_BOT_TOKEN`：BotFather 创建的 bot token。
- `TELEGRAM_OWNER_ID`：纯数字 Telegram 用户 ID；不要写用户名。
- `MODEL_PROVIDER`：`src/providers.ts` 注册表内的 id。
- `MODEL_ID`：该提供商在 pi-ai 1.3.0 模型目录中的 id。
- 当前提供商对应的 API key 变量（如 `ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY`）；其他提供商的 key 留空。

只检查键是否存在，不要在终端或日志中回显值：

```sh
grep -cE '^(TELEGRAM_BOT_TOKEN|TELEGRAM_OWNER_ID|MODEL_PROVIDER|MODEL_ID)=.+' .env   # 预期 4
grep -cE '^[A-Z0-9_]*_API_KEY=.+' .env                                            # 至少 1
```

`DATA_DIR` 由 Compose 固定为 `/data`，`.env` 中的值不生效。数据卷的显式名称是 `personal-agent-data`，不随项目目录名变化；升级 Aster 改名时也不改卷名。

离线配置检查不联网、不回显凭据：

```sh
docker compose run --rm --no-deps personal-agent node dist/src/check-config.js
```

预期输出 `Configuration OK: MODEL_PROVIDER=... MODEL_ID=... MCP_SERVERS=...`。缺失项会打印 `Missing configuration: <KEY>`，提供商或模型 id 错误会打印候选列表；先修配置，不要反复重启。bot 已有 webhook 时应用拒绝启动，需先在原部署中停用。

MCP 配置默认读取 `DATA_DIR/mcp.json`，即卷内 `/data/mcp.json`；文件不存在表示关闭。默认路径上的文件级错误只禁用 MCP，`MCP_CONFIG` 显式指定的文件错误会使检查失败。配置格式见 README 的 MCP 章节。

容器内的绝对路径是卷内路径，不是旧主机路径：`cwd`、stdio `command`/`args` 必须指向 `/data/...` 或镜像内已有程序。迁移 systemd 配置时，把 `/var/lib/personal-agent/...` 改为 `/data/...`，并把 `command` 改为镜像内可用的绝对路径（如 `/usr/local/bin/node`）。镜像不会自动安装 stdio server 的依赖；需要在派生镜像中预装，或显式允许并审计运行时下载。

## 3. 构建与分发镜像

生产 Compose 文件本身不构建。构建在构建机执行：

```sh
# 应用镜像
docker compose -f docker-compose.yml -f docker-compose.build.yml build personal-agent

# Vault 模式：应用与网络命名空间镜像
docker compose -f docker-compose.agent-vault.yml -f docker-compose.agent-vault.build.yml build

# Vault + 多 vault 路由器：再叠加两个覆盖文件
docker compose -f docker-compose.agent-vault.yml -f docker-compose.router.yml \
  -f docker-compose.agent-vault.build.yml -f docker-compose.router.build.yml build
```

等价的单镜像命令是 `docker build -t aster:local .` 和 `docker build -t aster-router:local ./router`；网络镜像使用 `deploy/agent-vault/network.Dockerfile`。构建机需要能访问 npm registry 和 Docker 基础镜像仓库。本地验证中应用镜像已成功构建；路由器与网络镜像构建曾因 Docker Hub 认证超时未完成，不能据此声称已产出这两个镜像。

通过镜像仓库分发时，推送后记录不可变 digest。通过文件分发时：

```sh
# 构建机
docker save aster:local | gzip > aster-image.tar.gz

# 服务器
docker load < aster-image.tar.gz
```

生产不在服务器上临时构建。选择一种交付方式并在部署记录中写明镜像 digest 或归档校验和。

## 4. 基础部署

```sh
docker compose config --quiet
docker compose run --rm --no-deps personal-agent node dist/src/check-config.js
docker compose up -d --no-build
docker compose logs --tail 50 personal-agent
```

预期日志出现 `Personal agent starting; single-owner private Telegram messages enabled.`，随后进入长轮询且无持续报错。`docker compose ps` 显示 `running` 只表示进程存在，不代表已通过 Telegram 验收。

用 owner 账号私聊 bot 发送“现在几点？”。预期收到与服务器 UTC 时间一致的回复，日志中没有 `Agent request failed`。数据卷中应出现：

```sh
docker compose exec personal-agent ls -la /data /data/workspace
```

`inbox.sqlite`、`agent.sqlite`、`workspace/` 应存在；`workspace/MEMORY.md` 在第一次明确要求记忆后出现。

### 生产更新（不可变引用）

在 `.env` 中设置实际镜像引用，例如：

```env
ASTER_IMAGE=registry.example.com/team/aster@sha256:<digest>
```

然后：

```sh
docker compose pull personal-agent
docker compose stop personal-agent
docker compose up -d --no-build personal-agent
docker compose logs --tail 50 personal-agent
```

数据卷保持不变。更新前先按第 8 节备份。不要用 `docker compose down -v` 代替普通停服。

### 回滚

把 `ASTER_IMAGE` 改回上一个可用 digest，执行 `docker compose up -d --no-build personal-agent`。镜像回滚不会自动回滚数据；应用没有数据库降级机制，旧镜像也不保证能读取新版本写入的状态。

- 若新版本只运行过、未产生不可逆数据，直接用旧镜像启动即可。
- 若出现 schema 或数据不兼容，这是一个显式的恢复决策：按第 8 节还原备份会丢失备份之后产生的会话、记忆和投递状态，可能造成重复回复。先停服、备份当前卷，再决定是否还原；不要把它当作回滚的默认步骤。
- 回滚前始终先备份当前卷，保留现场以便排查。

## 5. Agent Vault 隔离部署

Vault 模式使用独立文件，不能与基础 `docker-compose.yml` 合并。完整配置、Infisical 规则、CA、owner ID 和验收见 [Agent Vault 运行说明](agent-vault.md)；本节只给运行顺序。

Broker 镜像由 `ASTER_VAULT_IMAGE` 指定，默认 `aster-vault:local`，需先按 [受审构建说明](../deploy/agent-vault/broker/README.md) 构建或分发。原始 `infisical/agent-vault:0.40.0` 存在已复现的取密重定向与日志风险，不作为自动上线的默认产物。生产发布须使用通过相应准入的 digest；当前自动检查范围与尚未完成的发布／部署关卡见 [CI/CD 实施计划](ci-cd-implementation-plan.md)。

```sh
mkdir -p deploy/agent-vault/private
chmod 700 deploy/agent-vault/private
cp deploy/agent-vault/vault.env.example deploy/agent-vault/private/vault.env
cp deploy/agent-vault/app.env.example deploy/agent-vault/private/app.env
chmod 600 deploy/agent-vault/private/*.env
```

按 `agent-vault.md` 填写 `vault.env`、`app.env`，导出 `private/telegram-owner-id`，并获取 `private/ca.pem`。`private/` 已在 gitignore 和 dockerignore 中，不会进入构建上下文。

首次启动按顺序执行：先起 broker 与网络命名空间，再做离线配置检查，最后起应用。

```sh
docker compose -f docker-compose.agent-vault.yml config --quiet
docker compose -f docker-compose.agent-vault.yml up -d tool-network agent-vault
docker compose -f docker-compose.agent-vault.yml run --rm --no-deps personal-agent node dist/src/check-config.js
docker compose -f docker-compose.agent-vault.yml up -d --no-build personal-agent
docker compose -f docker-compose.agent-vault.yml logs --tail 50
```

使用路由器时，把 `-f docker-compose.router.yml` 加到每条命令，并在启动应用前多一步 `up -d egress-router`；完整顺序见第 6 节。

应用与 `tool-network` 共享网络命名空间，broker 固定 IP `172.30.82.2`。单 vault 模式下，uid 1000 的应用只允许访问 broker 的 `172.30.82.2:14322` 和精确 loopback，其他出网（包括公网直连、UDP、Docker DNS `127.0.0.11`）被丢弃；这不是“完全不能访问 broker”，而是不能绕过 broker 的代理端口。管理端口 `14321` 只绑定宿主回环，通过 SSH 转发访问。叠加路由器后规则改为应用只能访问 loopback、路由器（uid 1001）才能访问 broker，见第 6 节。

## 6. 多 vault 路由器

只有在不同基础设施的密钥分属多个 Infisical 文件夹、需要多个 vault 时才使用。路由器按 CONNECT 的 `host:port` 选择 vault，应用只持有一个路由器密码。

```sh
cp deploy/agent-vault/app.router.env.example deploy/agent-vault/private/app.router.env
chmod 600 deploy/agent-vault/private/app.router.env

mkdir -p deploy/agent-vault/private/router
cp deploy/agent-vault/egress-router.example.json deploy/agent-vault/private/router/config.json
# 写入 client-password 和每个 vault 的 agent token 文件
chown -R 1001:1001 deploy/agent-vault/private/router
chmod 700 deploy/agent-vault/private/router
chmod 600 deploy/agent-vault/private/router/*
```

路由器容器以 uid 1001 运行，整个 `private/router` 目录只读挂载到 `/etc/aster-router`。配置中的路径因此是 `/etc/aster-router/config.json`、`/etc/aster-router/client-password` 等；文件必须是 uid 1001 可读的 `600`，目录不能让其他用户写入。

启动前用现有 `check` 命令验证路由、超时、限制和凭据文件权限：

```sh
docker run --rm -u 1001:1001 \
  -v "$PWD/deploy/agent-vault/private/router:/etc/aster-router:ro" \
  aster-router:local check -config /etc/aster-router/config.json
```

预期输出 `configuration OK: N routes, listen 127.0.0.1:14323, upstream 172.30.82.2:14322`。路由器没有单独的探测子命令；运行时只有 `serve`、`check`、`version`、`redact`。健康端点 `127.0.0.1:14324`（`/healthz`、`/readyz`）只在共享命名空间内可达，不发布宿主端口。

组合启动：

```sh
docker compose -f docker-compose.agent-vault.yml -f docker-compose.router.yml config --quiet
docker compose -f docker-compose.agent-vault.yml -f docker-compose.router.yml up -d --no-build
docker compose -f docker-compose.agent-vault.yml -f docker-compose.router.yml logs --tail 50 egress-router
```

路由器覆盖会把应用的 `env_file` 替换为 `private/app.router.env`，应用代理改为 `http://app:<router-password>@127.0.0.1:14323`。`tool-network` 设置 `ROUTER_ENABLED=1` 后：

- uid 1000 的应用只能访问精确 loopback，不能直连 broker；
- uid 1001 的路由器只能访问 broker `172.30.82.2:14322` 和 loopback；
- 未列入路由表的 host 返回 `403`，错误的客户端密码返回 `407`。

修改路由或凭据文件后重载：

```sh
docker compose -f docker-compose.agent-vault.yml -f docker-compose.router.yml kill -s SIGHUP egress-router
```

已有 tunnel 不受影响；配置语法错误会在日志中记录并保留旧配置。

## 7. 维护命令

所有一次性命令使用同一组 Compose 文件和同一镜像，先停应用，避免与运行中的进程争用 SQLite 或 OAuth token 文件。

```sh
# 投递核查
docker compose stop personal-agent
docker compose run --rm --no-deps personal-agent node dist/src/deliveries.js list
docker compose start personal-agent

# MCP 连接检查
docker compose stop personal-agent
docker compose run --rm --no-deps personal-agent node dist/src/mcp-check.js
docker compose start personal-agent
```

Vault 模式把 `-f docker-compose.agent-vault.yml` 加到每条命令；使用多 vault 路由器时还必须同时加 `-f docker-compose.router.yml`。Compose 的 `run`、`stop`、`down` 都按项目计算服务集合，只用基础文件停止会留下路由器容器继续共享旧网络命名空间，因此停服和重建都要用同一组文件：

```sh
COMPOSE_VAULT="-f docker-compose.agent-vault.yml"
COMPOSE_ROUTER="$COMPOSE_VAULT -f docker-compose.router.yml"

docker compose $COMPOSE_ROUTER stop personal-agent egress-router
docker compose $COMPOSE_ROUTER run --rm --no-deps personal-agent node dist/src/deliveries.js list
docker compose $COMPOSE_ROUTER up -d --no-build personal-agent egress-router
```

`--no-deps` 依赖 `tool-network`、broker 和（路由器模式下）路由器已经在运行。`deliveries.js list` 输出 `blocked` 与 `failures` 两个数组；该命令会先执行恢复，强杀时处于 `sending` 的分段会以 `uncertain` 出现。先核对 Telegram 实际收到的内容，再决定 `retry` 或 `sent`。销毁环境时同样使用完整的 `-f` 组合执行 `down`，不要只对基础文件执行 `down`。

### MCP OAuth

`mcp-auth.js` 在进程内监听 `127.0.0.1:<redirectPort>`。普通 `docker compose run` 的容器有自己的网络命名空间；`-p 127.0.0.1:8765:8765` 把宿主端口转发到容器网络接口，而进程只监听容器回环，回调因此不会到达进程。Vault 模式的命名空间也不发布入站端口。两种模式因此都使用同一个离线流程：停止生产，在可信运维环境完成授权，再把授权文件放回数据卷。

在 Linux 运维主机上，可以直接用宿主网络运行同一个镜像，让授权进程和操作者的 SSH 转发共享回环。显式指定镜像，先停应用：

```sh
docker compose stop personal-agent
docker run --rm --network host --env-file .env \
  -e DATA_DIR=/data -v personal-agent-data:/data \
  aster:local node dist/src/mcp-auth.js calendar
docker compose start personal-agent
```

使用 `ASTER_IMAGE` 引用时把最后一条命令中的 `aster:local` 换成该值；`--network host` 只在 Linux 上可用。授权进程会读写卷内 `mcp-oauth/`，因此必须先停应用。操作者本机先建立 `ssh -L 8765:127.0.0.1:8765 user@host`（端口与 `auth.redirectPort` 一致），再打开命令打印的 URL。

Vault 模式不能直接套用上述命令：应用配置依赖共享命名空间和代理，宿主网络不具备相同的出网策略与 broker 可达性，不能视为等价的隔离环境。Vault 模式保持纯离线流程：在可信环境（可以是另一台机器上的开发运行）按 README 的 `mcp:auth` 流程完成授权，再把 `mcp-oauth/<server>.json` 放入数据卷：

```sh
docker run --rm -v personal-agent-data:/data -v "$PWD/oauth-export":/oauth:ro alpine \
  sh -c 'mkdir -p /data/mcp-oauth && cp /oauth/* /data/mcp-oauth/ \
    && chown -R 1000:1000 /data/mcp-oauth && chmod 600 /data/mcp-oauth/*'
```

不要删除已有的 client 注册信息；重新注册会让旧授权失效。授权文件必须保持 uid 1000、`600`。Vault 服务规则必须放行授权服务器实际使用的 discovery、registration 和 token endpoint；应用不会回退直连。

### 日志与资源

```sh
docker compose ps
docker compose logs --tail 100 personal-agent
docker stats --no-stream $(docker compose ps -q personal-agent)
docker inspect --format '{{.State.OOMKilled}}' $(docker compose ps -q personal-agent)
```

关注初始化日志、`Agent request failed`、`delivery`、`polling retry`、重启次数和 `OOMKilled`。1 GB 是保护线，不是性能保证；真实峰值仍需在目标机测量。

## 8. 备份与还原（整个卷）

备份前停止应用，保证 SQLite 连接已关闭。备份和还原都针对整个数据卷，不做单文件挑选。

### 8.1 基础部署

```sh
docker compose stop personal-agent

docker run --rm -v personal-agent-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/aster-data.tgz -C /data .

tar tzf aster-data.tgz | grep -E '(^|/)(agent|inbox)\.sqlite(-wal|-shm)?$|(^|/)workspace/|(^|/)mcp-oauth/'
ls -l aster-data.tgz

docker compose start personal-agent
```

通过标准：

- 归档非空，列表包含 `agent.sqlite`、`inbox.sqlite`、`workspace/`；SQLite 的 `-wal`、`-shm` 文件可能同时存在。
- 配置了 MCP 时包含 `mcp.json`，使用过 OAuth 时包含 `mcp-oauth/<server>.json`。
- 只有空列表或找不到文件，说明卷名错误或目录为空，不能当作备份成功。

还原会覆盖现有数据：

```sh
docker compose down
docker run --rm -v personal-agent-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/aster-data.tgz -C /data; \
    chown -R 1000:1000 /data'
docker compose up -d --no-build
docker compose logs --tail 20 personal-agent
```

`chown` 保证应用以 uid 1000 读写；不要跳过。还原后确认记忆和会话回到备份时状态。

### 8.2 Vault 部署

Vault 模式有两个卷和一份私有配置。使用路由器时，停止和启动都要带上 `-f docker-compose.router.yml`，否则路由器容器会继续运行并占用旧命名空间：

```sh
# 有路由器时使用：COMPOSE="-f docker-compose.agent-vault.yml -f docker-compose.router.yml"
COMPOSE="-f docker-compose.agent-vault.yml"
docker compose $COMPOSE down

docker run --rm -v personal-agent-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/aster-data.tgz -C /data .
docker run --rm -v personal-agent-vault-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/aster-vault-data.tgz -C /data .
# 私有配置归档写到当前目录，不依赖可能不存在的 /backup
umask 077
tar czf aster-private.tgz -C deploy/agent-vault private

docker compose $COMPOSE up -d --no-build
```

`private/` 包含 Vault 主密码、CA 和 agent token，属于敏感材料，按凭据管理。Vault 数据卷保存加密快照和 CA 私钥；丢失主密码后无法解密。还原时同时恢复两个卷和 `private/`，应用数据卷再执行 `chown -R 1000:1000 /data`；Vault 卷不要改成 uid 1000，保持归档中的属主。不要用 `down -v`。归档文件名以当前目录为准；还原前确认三个归档都存在且非空。

## 9. 从 systemd 迁移

旧部署的 systemd unit、安装脚本和 broker overlay 已从仓库删除；这些命令只用于停止和迁移旧实例，不是受支持的安装方式。迁移期间保持旧数据目录完整，先备份再导入。

```sh
# 1. 停止旧应用；如果旧主机上仍有 unit
sudo systemctl stop personal-agent
sudo systemctl disable personal-agent

# 2. 备份整个旧数据目录
sudo tar czf /root/aster-legacy-data.tgz -C /var/lib/personal-agent .
sudo tar tzf /root/aster-legacy-data.tgz | \
  grep -E '(^|/)(agent|inbox)\.sqlite(-wal|-shm)?$|(^|/)workspace/|(^|/)mcp-oauth/'

# 3. 目标卷必须为空。先确认没有旧实例写入；已有内容时先单独备份，不要直接覆盖。
docker volume create personal-agent-data
docker run --rm -v personal-agent-data:/data alpine \
  sh -c 'set -e; [ -z "$(ls -A /data)" ] || { echo "target volume is not empty; back it up and import into a new volume" >&2; exit 1; }'

# 4. 导入命名卷，保留所有文件并改为 uid 1000
docker run --rm -v personal-agent-data:/data -v /root:/backup alpine \
  sh -ec '[ -z "$(ls -A /data)" ] || { echo "target volume is not empty" >&2; exit 1; }; \
    tar xzf /backup/aster-legacy-data.tgz -C /data; chown -R 1000:1000 /data'

# 5. 检查并启动
docker compose run --rm --no-deps personal-agent node dist/src/check-config.js
docker compose up -d --no-build
docker compose logs --tail 50 personal-agent
```

第 3 步故意在目标卷非空时失败，避免把已有卷内容删除后才发现归档错误。已有目标卷（例如之前演练过）先按第 8 节整卷备份；需要保留时改为导入一个新卷，再通过 `docker-compose.yml` 的卷名或复制数据切换，不要用 `rm -rf /data/*` 清空正在使用的卷。

迁移时必须保留：

| 内容 | 说明 |
| --- | --- |
| `agent.sqlite` 及其 WAL/SHM | 底座会话与执行恢复状态 |
| `inbox.sqlite` 及其 WAL/SHM | 请求消费位置、身份绑定和投递状态 |
| `workspace/` | 记忆和任务文件 |
| `mcp.json` | 可选，MCP 配置 |
| `mcp-oauth/` | 可选，MCP OAuth token 与动态注册信息 |
| `.npm/` | 可选，stdio MCP 的缓存；保留可减少重新下载 |

配置迁移应在上述第 5 步启动前完成：

- MCP 的 `cwd` 改为容器内路径，例如 `/data/workspace`；宿主 `/opt` 或用户目录下的命令不可直接复用，应在派生镜像中安装依赖并更新绝对路径。
- 从 `/etc/personal-agent.env` 摘取 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_OWNER_ID`、`MODEL_PROVIDER`、`MODEL_ID` 和对应 API key 到 `.env`。
- 不要复制 `DATA_DIR=/var/lib/personal-agent`；容器内固定 `/data`。
- 基础部署使用 `.env` 中的内联 `TELEGRAM_OWNER_ID`；Vault 模式使用 `private/app.env` 和挂载的 owner 文件，二者不能同时设置。
- 旧 systemd 专用的 `ProtectHome`、`MemoryMax`、`ReadWritePaths` 等设置不再适用；资源限制由 Compose 提供。
- 旧 Vault 混合部署：在旧 checkout 中停止 broker 容器，保留卷名 `personal-agent-vault-data`，按 `agent-vault.md` 重新创建 `private/vault.env`（主密码必须与旧卷一致）、CA 和 owner 文件，再启动 Vault Compose。旧 `/etc/personal-agent/egress-router*` 配置迁移到 `private/router/`，文件属主改为 1001、`600`。

已有卷名必须保留：应用卷 `personal-agent-data`，Vault 卷 `personal-agent-vault-data`。如果旧 Compose 创建的是带项目前缀的卷（如 `<目录名>_personal-agent-data`），把内容复制到显式命名的卷后再启动，不要改名或新建空卷。迁移验收通过并保留一段回滚窗口后，再删除旧 unit 和旧数据目录；在此之前不要删除 `/var/lib/personal-agent`。

旧 systemd 路径的详细说明见 [历史 systemd 混合部署（仅迁移）](agent-vault-systemd.md)。

## 10. 常见故障

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| `pull access denied` / 找不到镜像 | 镜像未构建、未 `load` 或引用写错 | 核对 `ASTER_IMAGE`；构建机分发或从仓库拉取 |
| Compose 报 `!override` 解析错误 | Compose 低于 2.24.4 | 升级 Compose |
| 启动即退出，`Missing configuration` | `.env` 或 `private/app.env` 缺项 | 补齐对应键 |
| 启动即退出，webhook 错误 | bot 已有 webhook | 先停用原 webhook |
| 启动即退出，`belongs to another Telegram bot or owner` | 数据卷来自别的 bot／用户 | 换独立数据卷，或确认身份后迁移 |
| 启动即退出，`flock` 无法加锁 | 同一数据卷已有实例 | 停掉旧容器；不要并行运行 |
| `EACCES` / `Unable to open the database file` | 卷内文件属主不是 uid 1000 | `chown -R 1000:1000 /data` |
| 容器 `running` 但无回复 | 模型、代理或 Telegram 网络失败 | 看日志错误码；核对 `NO_PROXY` 与代理地址 |
| Vault 请求 `407`/`403` | agent token、vault 名或服务规则不匹配 | 核对代理 URL、vault 与 `services.yaml` |
| 路由器 `check` 报权限错误 | 文件不是 uid 1001 的 `600`，或目录可被其他用户写 | 修正属主和权限 |
| 路由器未匹配 host 返回 `403` | 路由表缺少精确 `host:port` | 增加路由；不支持通配符 |
| 直接出网被拒绝 | `tool-network` 的预期行为 | 通过 broker／路由器访问 |
| 备份归档为空 | 卷名错误 | `docker volume ls` 核对 `personal-agent-data` |
| 收到截断提示 | 模型输出达到长度上限 | 让用户拆分问题；不会自动续写 |
| 回复重复 | 发送结果曾未知后人工 `retry` | 核对 Telegram 实际消息，重复属预期风险 |

## 11. 上线判定与验证边界

全部满足才算部署验收完成：

- [ ] 配置检查输出 `Configuration OK`。
- [ ] owner 私聊、会话连续、工具调用、记忆跨重启、非授权隔离均通过。
- [ ] 正常重启、执行中断、强杀三种场景通过。
- [ ] `deliveries.js list` 可用且输出可读。
- [ ] 未触发 OOM，重启次数稳定。
- [ ] 备份归档包含 SQLite、WAL、`workspace/` 和 `mcp-oauth/`，整卷还原演练成功。
- [ ] 日志中没有凭据或完整消息内容。
- [ ] 记录了镜像 digest、Compose 版本、真实模型和当日费用。

本仓库当前已验证：应用镜像可构建；六种 Compose 组合可渲染；主机测试 137/137 通过；Go 测试与 `go vet` 通过；`network.sh` 通过 `sh -n`。未验证：真实云服务器上线、真实 Telegram／模型联调、Agent Vault 与 Infisical 联调、路由器与网络镜像的 Docker 构建（曾遇 Docker Hub 认证超时）、Go race detector（当前 Windows 环境 CGO 关闭）。这些项目不能写成“已上线”或“已验证”。

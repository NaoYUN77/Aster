# 上线测试指南

面向第一次把本应用部署到云服务器的人。按顺序执行，每步给出命令、预期结果和失败时的排查入口。范围是本仓库当前的单用户 Telegram 文本 MVP。

工程约束见 [CLAUDE.md](../CLAUDE.md)，部署参数细节见 [README.md](../README.md)，已有本地验证记录见 [mvp-verification.md](mvp-verification.md)。

## 0. 测试前准备

| 项目 | 要求 | 确认方式 |
| --- | --- | --- |
| 服务器 | Linux，4 核 / 4 GB 或以上 | `nproc`、`free -h` |
| 磁盘 | 建议 ≥ 10 GB 可用 | `df -h` |
| 软件 | Docker 24+ 与 Compose v2；或 Node.js 24.19.0 | `docker --version`、`docker compose version` |
| 账号 | BotFather 创建的 bot token；自己的 Telegram 数字用户 ID | — |
| 模型 | 账户可用的 `MODEL_PROVIDER`／`MODEL_ID` 及对应 API key | 见步骤 1 |

准备一个**测试专用**的 bot 和隔离数据目录。正式使用前不要直接拿日常 bot 试。

## 1. 配置检查（不上线也要先过）

```sh
cp .env.example .env
vi .env
```

必填项：

- `TELEGRAM_BOT_TOKEN`：bot token。
- `TELEGRAM_OWNER_ID`：纯数字，不接受用户名。
- `MODEL_PROVIDER`：只能是 `anthropic` 或 `openai`。
- `MODEL_ID`：该账户实际可用的模型 ID，写错不会自动替换。
- 对应提供商的 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`。
- Docker 部署时 `DATA_DIR` 会被 compose 固定为 `/data`，`.env` 里的值不生效。
- systemd 部署时配置放在 `/etc/personal-agent.env`，其中必须设置 `DATA_DIR=/var/lib/personal-agent`。

```sh
# 不要在日志或终端里回显 token；只检查键是否存在
# Docker 用项目目录下的 .env；systemd 用 /etc/personal-agent.env
grep -cE '^(TELEGRAM_BOT_TOKEN|TELEGRAM_OWNER_ID|MODEL_PROVIDER|MODEL_ID|(ANTHROPIC|OPENAI)_API_KEY)=.+' .env
chmod 600 .env
```

预期：输出 `5`。少于 5 说明有项为空。systemd 部署时对 `/etc/personal-agent.env` 执行同样的检查（文件应已由 `install -m 600` 创建为 root 所有）。

缺失或非法配置时应用会直接退出并打印 `Missing configuration: <KEY>` 或 `MODEL_PROVIDER must be anthropic or openai`。看到这类错误先修配置，不要反复重启。

**bot 已配置 webhook 会拒绝启动**，错误为 `Telegram webhook is active; remove it before starting long polling`。先在原部署里停用 webhook。

## 1.5 选择部署方式

同一台服务器还要运行其他常驻服务（例如 QQ bot）时，先决定用 Docker 还是 systemd，再执行后续对应步骤。

| 维度 | Docker | systemd 直跑 |
| --- | --- | --- |
| 磁盘 | 基础镜像 + 应用约 470 MB | Node 运行时 + 生产依赖约 260 MB |
| 常驻内存 | Node 进程 + 约 10–20 MB 容器运行时 | 仅 Node 进程 |
| 启动速度 | 慢 1–3 秒 | 快 |
| 升级 | `docker compose build && up -d` | `git pull && sudo ./deploy/install-systemd.sh` |
| 与其他容器共存 | 多一层 Docker 资源限制，排查面更大 | 与主机统一调度 |
| 进程回收 | `init: true` | systemd 作为 PID 1 |

**推荐：主机已有 Docker 服务（如 QQ bot）时用 systemd。** 原因不是省那 200 MB，而是：

- 内存账更好算。QQ bot 容器有各自的 `mem_limit`，再叠一个容器后，三套限制互相独立，容易出现“谁都没超限、合起来却 OOM”。原生进程与 QQ bot 共享剩余内存，由内核统一回收。
- 避免 Docker 层争抢。容器内存上限包含工具子进程，主机紧张时容器更容易被 OOM killer 选中。
- 少一层故障面。本应用只需要出网访问 Telegram 和模型 API，不需要容器网络。

主机只有这一个服务时，Docker 更省运维。

### 与 QQ bot 共存的资源分配

以下按 4 核 / 4 GB 估算，实测值需在部署后按第 6 节记录。

| 组件 | 预估常驻 | 上限设置 |
| --- | --- | --- |
| QQ bot（AstrBot + NapCat 两个容器） | 约 600 MB | 各自容器限制 |
| 本应用（systemd） | 100–300 MB | `MemoryMax=1G`、`MemoryHigh=768M` |
| 系统与其他 | 约 500 MB | — |
| 剩余缓冲 | 2 GB 以上 | — |

本应用的服务文件已按与 QQ bot 共存收紧为 `MemoryHigh=768M`、`MemoryMax=1G`、`TasksMax=64`。单用户文本 agent 实际占用远低于 1 GB；这个上限是保护线，触发时会先回收本服务而不是拖垮整机。

单独使用这台服务器、需要更多余量时：

```sh
sudo systemctl edit personal-agent
```

```ini
[Service]
MemoryHigh=2G
MemoryMax=3G
TasksMax=128
```

## 2. 构建镜像（Docker 部署）

```sh
docker compose build
```

预期：构建成功，最后输出镜像 `personal-agent:local`。

```sh
docker compose config | grep -A2 '^volumes:'
```

预期：卷名为 `personal-agent-data`（不是带项目目录前缀的名字）。卷名不对时不要继续，先核对 `docker-compose.yml`。

失败排查：

- `npm ci` 失败：检查服务器能否访问 npm registry。
- 拉取基础镜像失败：检查 Docker 镜像源配置。
- 类型错误：本地先跑 `npm run check` 定位，不要靠容器内报错。

## 2b. 安装与构建（systemd 部署）

### 方式一：安装脚本（推荐）

先把代码放到服务器（`git clone` 或上传），在仓库根目录执行：

```sh
# 安装 Node.js 24.19.0 与 util-linux 后
node --version   # 必须是 v24.19.x
sudo ./deploy/install-systemd.sh
```

脚本会创建用户和目录、复制代码、安装依赖并构建、生成 unit、启用服务。配置仍为空时只启用不启动，避免重启循环。

首次运行后编辑配置：

```sh
sudo vi /etc/personal-agent.env   # 至少填 TELEGRAM_BOT_TOKEN、TELEGRAM_OWNER_ID、MODEL_ID 和对应 API key
sudo systemctl start personal-agent
```

### 方式二：手动安装

脚本做的事都可以手工执行；注意 unit 模板里的 `/usr/bin/node`、`/usr/bin/flock` 要替换为 `command -v` 的实际路径。

```sh
sudo useradd --system --home /opt/personal-agent --shell /usr/sbin/nologin personal-agent
sudo apt install -y bash util-linux
node --version   # 必须是 v24.19.x
command -v node flock
```

```sh
sudo mkdir -p /opt/personal-agent /var/lib/personal-agent
sudo chown personal-agent:personal-agent /opt/personal-agent /var/lib/personal-agent
sudo chmod 700 /var/lib/personal-agent

# 复制应用文件后以服务用户安装依赖并构建
sudo runuser -u personal-agent -- env HOME=/opt/personal-agent \
  bash -c 'cd /opt/personal-agent && npm ci && npm run build && npm prune --omit=dev'
```

配置放到 systemd 环境文件，不要放在项目目录：

```sh
sudo install -o root -g root -m 600 /dev/null /etc/personal-agent.env
sudo vi /etc/personal-agent.env
```

内容与 `.env.example` 相同，但必须设置：

```ini
DATA_DIR=/var/lib/personal-agent
```

安装服务并启动：

```sh
sudo sed -e "s#/usr/bin/node#$(command -v node)#" -e "s#/usr/bin/flock#$(command -v flock)#" \
  deploy/personal-agent.service | sudo tee /etc/systemd/system/personal-agent.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now personal-agent
sudo systemctl status personal-agent --no-pager
journalctl -u personal-agent -f
```

预期：`active (running)`，日志出现 `Personal agent starting; single-owner private Telegram messages enabled.`

失败排查：

- `status=203/EXEC`：`ExecStart` 里的 Node 或 `flock` 路径不对，用 `command -v node`、`command -v flock` 确认并替换；脚本会自动替换为实际路径。Node 装在 `/home` 下时会被 `ProtectHome=true` 挡住，必须用系统级安装。
- `status=200/CHDIR`：`WorkingDirectory` 不存在或权限不足。
- `status=226/NAMESPACE`：`ReadWritePaths` 指向的目录不存在；先创建 `/var/lib/personal-agent`。
- 启动即退出且日志有 `Missing configuration`：检查 `/etc/personal-agent.env` 权限与内容。
- 启动即退出且日志有 `Unable to open the database file` 或 `EACCES`：`DATA_DIR` 不在 `ReadWritePaths` 内，或目录属主不对。
- `flock` 报错：说明已有实例在跑，`ps aux | grep main.js` 确认。
- 脚本报 `run from the repository root`：在包含 `package.json` 的目录执行。
- 脚本报 `must set DATA_DIR=/var/lib/personal-agent`：配置文件里的 `DATA_DIR` 与 unit 的 `ReadWritePaths` 不一致。

数据目录权限必须允许服务用户读写；`ProtectSystem=strict` 下只有 `ReadWritePaths` 指定的路径可写。服务文件默认限制为 `MemoryHigh=768M`、`MemoryMax=1G`、`TasksMax=64`，与 QQ bot 共存；单独使用时可 `sudo systemctl edit personal-agent` 调高。

## 3. 首次启动与冒烟测试

启动（按部署方式选一条）：

```sh
# Docker
docker compose up -d && docker compose logs -f

# systemd
sudo systemctl start personal-agent && journalctl -u personal-agent -f
```

预期日志依次出现：

1. `Personal agent starting; single-owner private Telegram messages enabled.`
2. 轮询期间无报错。若启动即退出，看上一节配置错误。

然后用**owner 账号**私聊 bot 发一条：`现在几点？`

预期：

- 收到回复，内容与当前时间一致（验证模型调用与 `current_time` 工具）。
- 日志中该请求无 `Agent request failed`。
- 数据目录出现文件：

```sh
# Docker
docker compose exec personal-agent ls -la /data /data/workspace

# systemd
sudo ls -la /var/lib/personal-agent /var/lib/personal-agent/workspace
```

应看到 `inbox.sqlite`、`agent.sqlite`、`workspace/MEMORY.md`。

## 4. 功能验收（对应 MVP 七条）

逐条执行并记录结果。表格里的“通过标准”就是判定依据，不要用“看起来正常”代替。

| # | 测试 | 操作 | 通过标准 |
| --- | --- | --- | --- |
| 1 | 基本对话 | owner 私聊发一条普通问题 | 收到有效回复，日志无错误 |
| 2 | 上下文连续 | 接着发“我刚才问了什么？” | 回复能引用上一条内容 |
| 3 | 工具调用 | 发“现在几点？” | 时间与服务器 UTC 时间一致 |
| 4 | 非法参数 | 不需要手工构造；确认现有测试通过即可 | `npm test` 中参数校验用例通过 |
| 5 | 记忆持久 | 发“请记住：我的代号是 blue”，再问“我的代号是什么？” | 回复 `blue`；数据目录下 `workspace/MEMORY.md` 含该事实 |
| 6 | 记忆跨重启 | 重启服务后问“我的代号是什么？” | 仍回复 `blue`，不需要重新告知 |
| 7 | 非授权隔离 | 用另一个账号（或群聊）给 bot 发消息 | bot 不回复；日志无该请求的 agent 执行 |
| 8 | 失败可区分 | 临时把 `MODEL_ID` 改成一个不存在的值，重启后发消息，然后改回 | 用户收到“本次处理未能完成”类提示，日志错误码为模型相关；改回后恢复正常 |
| 9 | 长回复分段 | 发“请分点详细说明……”，让回复超过 4000 字符 | 收到多条连续消息，内容完整、无乱码、顺序正确 |

第 5 条同时验证了“普通聊天不会自动写入记忆”：发几句闲聊后再看 `MEMORY.md`，不应出现未明确要求保存的内容。

第 8 条修改配置后需要重启服务：Docker 用 `docker compose up -d`（会重建容器），systemd 用 `sudo systemctl restart personal-agent`。

## 5. 重启与恢复测试

以下命令按部署方式二选一。Docker 用 `docker compose`，systemd 用 `systemctl`／`journalctl`。

### 5.1 正常重启

```sh
# Docker
docker compose restart && docker compose logs --tail 20

# systemd
sudo systemctl restart personal-agent && journalctl -u personal-agent -n 20 --no-pager
```

预期：重新启动后能继续对话；之前已完成的记忆仍在。

### 5.2 执行中断

在 agent 正在执行一个长任务时（例如让它跑一条耗时命令）执行：

```sh
# Docker
docker compose stop && docker compose start && docker compose logs --tail 30

# systemd
sudo systemctl stop personal-agent && sudo systemctl start personal-agent
journalctl -u personal-agent -n 30 --no-pager
```

预期：

- 停止在 45 秒宽限期内完成，不报超时错误。
- 重启后该请求能继续完成，或明确报告失败；不会重复执行已完成的部分。
- 不会给同一请求重复发两条完整回复。

### 5.3 强杀

```sh
# Docker
docker compose kill && docker compose start && docker compose logs --tail 30

# systemd（模拟进程被强杀，systemd 会按 Restart=on-failure 拉起）
sudo systemctl kill -s SIGKILL personal-agent
sleep 15
journalctl -u personal-agent -n 30 --no-pager
```

预期：应用能重新打开数据目录并继续服务；未完成的请求不会静默消失。

### 5.4 投递核查入口

```sh
# Docker
docker compose stop
docker compose run --rm personal-agent node dist/src/deliveries.js list
docker compose start

# systemd
sudo systemctl stop personal-agent
sudo -u personal-agent env DATA_DIR=/var/lib/personal-agent \
  node /opt/personal-agent/dist/src/deliveries.js list
sudo systemctl start personal-agent
```

预期：输出 JSON（`blocked` 与 `failures` 两个数组）。没有异常时两个数组都为空。若之前制造过发送失败，应能看到请求 ID、分段号和错误码。

注意：该命令会先执行恢复，被强杀时处于 `sending` 的分段会以 `uncertain` 出现。按 README 先核对 Telegram 实际收到的内容，再决定 `retry` 或 `sent`。

## 6. 资源与稳定性

挂一段时间（至少跑通一轮日常使用）后检查：

```sh
# Docker
docker stats --no-stream personal-agent
docker inspect personal-agent --format '{{.State.OOMKilled}}'
docker compose logs --tail 100 | grep -E 'Agent request failed|delivery|polling retry'

# systemd
systemctl show personal-agent -p MemoryCurrent,MemoryMax,TasksCurrent,NRestarts
journalctl -u personal-agent -n 100 --no-pager | grep -E 'Agent request failed|delivery|polling retry'
ps -o pid,rss,cmd -C node

# 通用
free -h
df -h
```

与 QQ bot 共存时，额外确认主机整体余量：

```sh
free -h
docker stats --no-stream
```

记录：

| 指标 | 关注点 |
| --- | --- |
| 内存 | Docker 部署：峰值明显低于 3 GB，`OOMKilled` 为 `false`；systemd 部署：`MemoryCurrent` 稳定低于 `MemoryMax`，主机仍有 1 GB 以上可用 |
| CPU | 空闲时接近 0，不应持续满载 |
| 磁盘 | 数据卷缓慢增长属正常；短期暴涨说明会话或投递记录异常 |
| 日志 | 不应出现凭据、完整消息内容或 SDK 请求对象 |
| 重启 | Docker 看 `docker compose ps`，systemd 看 `NRestarts`；重启次数不应持续增加 |

## 7. 备份与还原演练

**必须实际做一次**，不能只看命令退出码。两种部署方式的数据位置不同：Docker 是命名卷 `personal-agent-data`，systemd 是 `/var/lib/personal-agent`。

### 7.1 备份

```sh
# Docker
docker compose stop
docker run --rm -v personal-agent-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/personal-agent-data.tgz -C /data .
tar tzf personal-agent-data.tgz | grep -E '(^|/)(inbox|agent)\.sqlite(-wal|-shm)?$|workspace/MEMORY\.md$'
ls -l personal-agent-data.tgz

# systemd（先停服务，保证 SQLite 连接已关闭）
sudo systemctl stop personal-agent
sudo tar czf /root/personal-agent-data.tgz -C /var/lib/personal-agent .
sudo tar tzf /root/personal-agent-data.tgz | grep -E '(^|/)(inbox|agent)\.sqlite(-wal|-shm)?$|workspace/MEMORY\.md$'
```

通过标准：

- 列表包含 `inbox.sqlite`、`agent.sqlite`、`workspace/MEMORY.md`。
- 归档文件大小不为 0。
- 只出现空列表或找不到文件，说明备份的是错误卷或空目录，**不要当作备份成功**。

### 7.2 还原

先记下当前一条记忆内容，然后：

```sh
# Docker
docker compose down
docker run --rm -v personal-agent-data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; tar xzf /backup/personal-agent-data.tgz -C /data'
docker compose up -d
docker compose logs --tail 20

# systemd
sudo systemctl stop personal-agent
sudo sh -c 'rm -rf /var/lib/personal-agent/* /var/lib/personal-agent/.[!.]* 2>/dev/null; tar xzf /root/personal-agent-data.tgz -C /var/lib/personal-agent'
sudo chown -R personal-agent:personal-agent /var/lib/personal-agent
sudo systemctl start personal-agent
journalctl -u personal-agent -n 20 --no-pager
```

通过标准：

- 应用正常启动，无身份或配置错误。
- 记忆内容和会话历史恢复到备份时状态。

还原会覆盖现有数据，演练时不要拿正式数据做第一次尝试。systemd 还原后必须恢复文件所有者，否则服务用户无法写入。

## 8. 常见故障对照

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 启动即退出，`Missing configuration` | `.env` 或 `/etc/personal-agent.env` 缺项 | 补齐对应键 |
| 启动即退出，webhook 错误 | bot 已有 webhook | 先停用原 webhook |
| 启动即退出，`belongs to another Telegram bot or owner` | 数据目录来自别的 bot／用户 | 换独立数据目录，或确认身份后迁移 |
| `status=203/EXEC` | systemd 的 Node 或 `flock` 路径不对 | `command -v node`、`command -v flock` 后修正 `ExecStart` |
| `status=226/NAMESPACE` | `ReadWritePaths` 指向的目录不存在 | 先创建 `/var/lib/personal-agent` 再启动 |
| 日志提示 `EACCES`／`Unable to open the database file` | 数据目录属主、权限或 `DATA_DIR` 与 `ReadWritePaths` 不一致 | `chown -R personal-agent:personal-agent /var/lib/personal-agent`；核对 `/etc/personal-agent.env` 的 `DATA_DIR` |
| 收到“本次处理未能完成” | 模型错误、超时或工具失败 | 看日志错误码；`AGENT_TIMEOUT` 表示已请求取消执行 |
| 收到截断提示 | 模型输出达到长度上限 | 让用户拆分问题；不会自动续写 |
| 回复重复 | 发送结果曾未知后人工 `retry` | 核对 Telegram 实际消息，重复属预期风险 |
| 日志反复 `polling retry` | 网络或 Telegram 限流 | 应用有退避；持续失败检查出网与 token |
| 进程反复重启 | 底座 Session 失效（`AGENT_SESSION_FAILED`） | 属设计行为，重启恢复；若持续出现，检查磁盘与 SQLite 文件权限 |
| 备份归档为空 | 挂载了错误卷名 | 用 `docker volume ls` 确认真实卷名 |

## 9. 上线判定

全部满足才算部署验收完成：

- [ ] 第 4 节九项功能验收通过，并有记录。
- [ ] 正常重启、执行中断、强杀三种场景通过。
- [ ] 投递核查命令可用，`list` 输出可读。
- [ ] 内存未触发 OOM，重启次数稳定。
- [ ] 与 QQ bot 共存时主机仍有 1 GB 以上可用内存。
- [ ] 备份归档包含三个持久化位置，还原演练成功。
- [ ] 日志中无凭据与完整消息内容。
- [ ] 已记录真实模型的名称、版本与当日费用消耗。

把结果追加到 [mvp-verification.md](mvp-verification.md) 的阶段 E／F 部分，写明日期、命令、观察结果和未覆盖项。测试通过但未实际部署的情况不能写成“已上线”。

## 10. 回滚

```sh
# Docker
git checkout <上一个可用提交>
docker compose build && docker compose up -d

# systemd
git checkout <上一个可用提交>
sudo ./deploy/install-systemd.sh
```

数据不随代码回滚。若新版本写入过不兼容数据，用第 7 节还原备份。回滚前先备份当前数据。

## 11. 与 QQ bot 共存的日常检查

两边都在跑时，定期看整体而不是只看单个服务：

```sh
free -h
docker stats --no-stream
systemctl show personal-agent -p MemoryCurrent,NRestarts
```

关注点：

- 主机 `available` 内存持续低于 300 MB 时，先看是不是 QQ bot 侧镜像更新或本应用会话历史异常增长。
- 本应用 `NRestarts` 增加且日志有 `AGENT_SESSION_FAILED`，说明底座遇到过存储错误；检查磁盘空间与 `/var/lib/personal-agent` 权限。
- 两个服务都正常时不要为了“省内存”频繁重启；重启本身会重新加载会话上下文。

## 附：本地回归（服务器上也可执行）

```sh
npm run check
npm test
npm run build
```

三项都通过才继续部署。当前基线为 38 项测试通过；服务器上运行测试需要 Node.js 24.19.0 与完整开发依赖。

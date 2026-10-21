# systemd 部署说明

本应用作为 systemd 服务运行，适合与 Docker 部署的其他服务（如 QQ bot）共存于一台 4 核 / 4 GB 服务器。

快速安装见 [deployment-test-guide.md](../docs/deployment-test-guide.md) 第 2b 节；本文说明脚本行为、路径约定和资源限制。

## 一键安装

```sh
sudo ./deploy/install-systemd.sh
```

脚本执行顺序：

1. 检查 root、Node 24.x、`npm`、`flock`、`runuser`、`bash` 和仓库根目录；Node 装在 `/home`、`/root` 或 `/run/user` 下会因 `ProtectHome=true` 不可见而拒绝继续。
2. 创建系统用户 `personal-agent`（无登录 shell）。
3. 创建 `/opt/personal-agent`（代码）与 `/var/lib/personal-agent`（数据），数据目录权限 `700`；代码目录重置为 `755`，避免从宽松权限的检出复制后留下可写目录。
4. 复制应用文件，排除 `.git`、`node_modules`、`dist`、`data`、`.env`。
5. 首次运行时从 `.env.example` 创建 `/etc/personal-agent.env`（root 所有，`600`），并写入 `DATA_DIR=/var/lib/personal-agent`。
6. 在构建前校验配置：`DATA_DIR` 必须与 unit 的 `ReadWritePaths` 一致，`MODEL_PROVIDER` 必须是 `anthropic` 或 `openai`。
7. 以服务用户执行 `npm ci && npm run build && npm prune --omit=dev`，`HOME` 与 npm 缓存指向 `/opt/personal-agent`，构建后删除缓存。
8. 按实际路径（含 Node 与 `flock`）生成 unit 文件，再次校验配置后启用服务。
9. 只检查**当前所选提供商**的 API key：使用 `openai` 时留空的 `ANTHROPIC_API_KEY` 不算缺项。任一必填值为空时只启用不启动，避免带着占位凭据进入重启循环；校验在触碰 systemd 之前完成。

可重复执行：代码和 unit 会被替换，数据目录与已有配置不会被覆盖。

## 路径约定

| 路径 | 用途 | 属主 |
| --- | --- | --- |
| `/opt/personal-agent` | 代码与生产依赖 | `personal-agent` |
| `/var/lib/personal-agent` | `agent.sqlite`、`inbox.sqlite`、`workspace/` | `personal-agent`，权限 `700` |
| `/etc/personal-agent.env` | 配置与凭据 | `root`，权限 `600` |

要换路径时，修改脚本顶部变量并同步调整 unit 文件。数据目录必须与 `DATA_DIR` 一致。

## 资源限制

与 QQ bot 共存时，unit 默认限制已按共享主机收紧：

| 项 | 值 | 说明 |
| --- | --- | --- |
| `MemoryHigh` | 768M | 超过后内核优先回收本服务 |
| `MemoryMax` | 1G | 硬上限，包含工具子进程 |
| `TasksMax` | 64 | 进程与线程上限 |
| `TimeoutStopSec` | 45s | 与 Docker 部署一致 |

单用户文本 agent 实际占用通常为 100–300 MB，上限是保护线而非预期占用。单独使用这台服务器时，可通过 `systemctl edit personal-agent` 调高。

## 日常操作

```sh
systemctl status personal-agent
journalctl -u personal-agent -f
sudo systemctl restart personal-agent
```

投递核查（先停服务）：

```sh
sudo systemctl stop personal-agent
sudo -u personal-agent env DATA_DIR=/var/lib/personal-agent \
  node /opt/personal-agent/dist/src/deliveries.js list
sudo systemctl start personal-agent
```

更新：

```sh
sudo ./deploy/install-systemd.sh
```

或手动：

```sh
sudo runuser -u personal-agent -- env HOME=/opt/personal-agent \
  bash -c 'cd /opt/personal-agent && npm ci && npm run build && npm prune --omit=dev'
sudo systemctl restart personal-agent
```

备份与还原见 [deployment-test-guide.md](../docs/deployment-test-guide.md) 第 7 节。

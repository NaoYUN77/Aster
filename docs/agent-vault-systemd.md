# Agent Vault：systemd 应用 + 容器 broker

状态：部署方案。应用继续由 systemd 托管，只把 Agent Vault 放入容器；真实 Infisical 联调和目标主机验收尚未执行。Docker 全隔离模式见 [Agent Vault 运行说明](agent-vault.md)。

## 适用场景

主机已经用 systemd 跑本应用，且希望避免再叠一个应用容器的资源开销；同时仍要由 Infisical 提供工具和入口凭据。适合 4 核 / 4 GB、已有其他容器（如 QQ bot）的服务器。

与完整 Compose 模式的差别：

| 项目 | systemd + broker 容器 | 完整 Compose |
| --- | --- | --- |
| 应用进程 | systemd 直接运行 Node | 容器 |
| 资源开销 | 较低 | 多一层容器运行时 |
| 强制出网限制 | 无；应用可绕过代理直连 | `tool-network` 只允许访问 broker |
| 凭据注入 | 相同，均由 broker 在 HTTP(S) 出口完成 | 相同 |
| 适用 | 资源优先、工具受信任 | 隔离优先 |

应用和 broker 仍然共用同一个代理身份；这不等同于按工具或进程隔离权限。

## 架构

```text
systemd: node /opt/personal-agent/dist/src/main.js
  HTTP_PROXY/HTTPS_PROXY → 127.0.0.1:14322
    → agent-vault 容器
        ← Infisical（只读同步）
    → 目标 API（注入真实凭据）
```

管理端口 `14321` 只绑定回环，用于配置和取 CA；代理端口 `14322` 只绑定回环，供 systemd 应用使用。

如果不同基础设施的密钥放在不同 Infisical 文件夹，需要为每个文件夹建一个 vault。应用只有一组全局代理变量，此时在应用和 broker 之间加一个 `agent-egress-router`，按目标 host 选择 vault；仍然只运行一个 broker。见本文第 2.1 节和 [router/README.md](../router/README.md)。

## 前置条件

- 应用已按 [systemd 部署说明](../deploy/README-systemd.md) 安装，代码在 `/opt/personal-agent`，数据在 `/var/lib/personal-agent`。
- Docker 24+ 与 Compose v2，用于运行 broker。
- Infisical 项目和环境/路径；一个只读 Universal Auth Machine Identity。
- Bot token、Telegram 数字 owner ID、当前模型提供商的 API key。

## 1. 启动 broker

复制配置：

```sh
mkdir -p deploy/agent-vault/private
chmod 700 deploy/agent-vault/private
cp deploy/agent-vault/vault.env.example deploy/agent-vault/private/vault.env
chmod 600 deploy/agent-vault/private/vault.env
```

填写 `private/vault.env`：

```env
AGENT_VAULT_MASTER_PASSWORD=<强密码>
INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=<只读 Machine Identity client id>
INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=<只读 Machine Identity client secret>
AGENT_VAULT_ADDR=http://localhost:14321
```

`AGENT_VAULT_MASTER_PASSWORD` 用于包装 broker 的本地数据密钥（DEK），保护数据卷中的凭据和 CA 私钥；它不是 Infisical 密码，也不传给应用。丢失后原数据卷无法解密。首次启动前设置；已有实例改用 CLI `agent-vault master-password set|change`，不要只改环境变量。

自建 Infisical 时修改 `docker-compose.agent-vault.yml` 的 `INFISICAL_URL`（Compose 的 `environment` 优先于 `env_file`）。

只启动 broker，并叠加回环代理端口：

```sh
docker compose -f docker-compose.agent-vault.yml \
  -f deploy/agent-vault/compose.systemd.yml up -d agent-vault

docker compose -f docker-compose.agent-vault.yml \
  -f deploy/agent-vault/compose.systemd.yml ps

docker compose -f docker-compose.agent-vault.yml \
  -f deploy/agent-vault/compose.systemd.yml logs -f agent-vault
```

不要启动同一文件里的 `personal-agent` 服务；它会和 systemd 实例争用数据目录和 bot 身份。

## 2. 配置 Infisical 和 vault

在 Infisical 项目环境中放入：

| Key | 内容 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | bot token |
| `TELEGRAM_OWNER_ID` | 数字 user ID |
| 当前提供商的 key，如 `OPENAI_API_KEY` | 模型 key |
| 工具 key，如 `GITHUB_TOKEN` | 按需 |

Machine Identity 只授予该项目、环境、路径的读取权限。然后建立 SSH 隧道打开管理界面：

```sh
ssh -L 14321:127.0.0.1:14321 <user>@<server>
```

在 `http://127.0.0.1:14321`：

1. 创建名为 `personal-agent` 的 vault，credential store 选择 Infisical，绑定 project / environment / path。
2. 轮询周期初始 60 秒，确认首次同步成功。
3. 设置 `unmatched_host_policy=deny`。
4. 配置服务规则，至少包含 Telegram 和当前模型提供商。示例见 [services.example.yaml](../deploy/agent-vault/services.example.yaml)；应用规则会替换整个集合，不要丢掉已有规则。

最小规则：

```yaml
services:
  - name: telegram
    host: api.telegram.org:443/bot__vault_TELEGRAM_BOT_TOKEN__/*
    auth:
      type: passthrough
    substitutions:
      - key: TELEGRAM_BOT_TOKEN
        placeholder: __vault_TELEGRAM_BOT_TOKEN__
        in: [path]

  - name: openai
    host: api.openai.com:443/v1/*
    auth:
      type: bearer
      token: OPENAI_API_KEY
```

工具 token 的占位值写在 `mcp.json`，不要写进 `/etc/personal-agent.env`。stdio MCP 使用：

```json
{
  "servers": [
    {
      "name": "github",
      "transport": "stdio",
      "command": "node",
      "args": ["/opt/mcp/github-server.js"],
      "env": { "GITHUB_TOKEN": "${vault:GITHUB_TOKEN}" }
    }
  ]
}
```

HTTP MCP 使用 `headers: { "Authorization": "Bearer ${vault:API_TOKEN}" }`；Basic auth 不需要占位值，由 Vault 规则生成 Authorization。MCP OAuth 继续使用 `DATA_DIR/mcp-oauth`，对应 endpoint 配置为 `passthrough`。

### 2.1 多个 Infisical 文件夹：每文件夹一个 vault

一个 vault 只绑定一个 project / environment / secret path，并且只同步该路径下的直接 key，不递归子文件夹。不要为了“只建一个 vault”把不同基础设施的密钥合并到同一文件夹。推荐的拆分：

| vault | Infisical path | 示例 key | Agent Vault 服务规则 |
| --- | --- | --- | --- |
| `telegram` | `/personal-agent/telegram` | `TELEGRAM_BOT_TOKEN` | `api.telegram.org:443/bot__vault_TELEGRAM_BOT_TOKEN__/*` |
| `deepseek` | `/personal-agent/deepseek` | `DEEPSEEK_API_KEY` | `api.deepseek.com:443/*` |
| `tools` | `/personal-agent/tools` | `GITHUB_TOKEN` 等 | `api.github.com:443/*` 等 |

每个 vault 使用同一个只读 Machine Identity，但分别创建**只授予该 vault `proxy` 角色**的 agent token。每个 vault 单独设置 `unmatched_host_policy=deny` 和该 vault 需要的服务规则；导入 service 文件只影响当前 vault。

然后部署路由器：

1. 按 [router/README.md](../router/README.md) 构建并安装 `agent-egress-router`：
   ```sh
   go build -trimpath -o agent-egress-router ./cmd/agent-egress-router
   sudo install -m 0755 agent-egress-router /usr/local/bin/agent-egress-router
   sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin agent-router
   ```
2. 以 [egress-router.example.json](../deploy/agent-vault/egress-router.example.json) 为基础，建立 `/etc/personal-agent/egress-router.json`，每条路由写一个 host、vault 和 token 文件。
3. 创建 `/etc/personal-agent/egress-router/`，写入 `client-password` 和每个 vault 的 agent token 文件；目录 `0750 root:agent-router`，文件 `0640 root:agent-router`。客户端密码使用十六进制可避免 URL 编码：
   ```sh
   openssl rand -hex 32 > client-password
   sudo install -d -m 0750 -o root -g agent-router /etc/personal-agent/egress-router
   sudo install -m 0640 -o root -g agent-router egress-router.json /etc/personal-agent/egress-router.json
   sudo install -m 0640 -o root -g agent-router client-password /etc/personal-agent/egress-router/client-password
   sudo install -m 0640 -o root -g agent-router agent-token-telegram /etc/personal-agent/egress-router/agent-token-telegram
   sudo install -m 0640 -o root -g agent-router agent-token-deepseek /etc/personal-agent/egress-router/agent-token-deepseek
   ```
4. 安装 [agent-egress-router.service](../deploy/agent-vault/agent-egress-router.service) 到 `/etc/systemd/system/`，执行 `sudo -u agent-router agent-egress-router check -config /etc/personal-agent/egress-router.json`，再 `sudo systemctl enable --now agent-egress-router`。
5. 应用代理改为 `http://app:<router-password>@127.0.0.1:14323`；应用不再持有 agent token。

路由器只绑定回环，未知 host 返回 `403`；Agent Vault 的 `407`/`403` 会原样返回。路由器日志只记录 host、vault、状态和字节数，不记录请求头或正文。

## 3. 取 CA 并导出 owner ID

```sh
curl --fail http://127.0.0.1:14321/v1/mitm/ca.pem \
  -o deploy/agent-vault/private/ca.pem
chmod 644 deploy/agent-vault/private/ca.pem
```

从 Infisical 导出 owner ID：

```sh
infisical login --method universal-auth

infisical secrets get TELEGRAM_OWNER_ID --plain \
  --projectId <PROJECT_ID> --env prod --path /personal-agent/tools \
  > deploy/agent-vault/private/telegram-owner-id
chmod 644 deploy/agent-vault/private/telegram-owner-id
```

CLI 参数按安装版本调整。owner ID 不经过 HTTP，Vault 无法注入；应用只读文件。

安装到 systemd 服务可读的位置：

```sh
sudo install -d -m 755 /etc/personal-agent
sudo install -m 644 deploy/agent-vault/private/ca.pem \
  /etc/personal-agent/ca.pem
sudo install -m 644 deploy/agent-vault/private/telegram-owner-id \
  /etc/personal-agent/telegram-owner-id
```

`ProtectSystem=strict` 只禁止写入，不阻止读取 `/etc`；服务用户需要能读这两个文件。

## 4. 配置 systemd 环境

编辑 `/etc/personal-agent.env`：

```env
DATA_DIR=/var/lib/personal-agent

AGENT_VAULT_ENABLED=1
HTTP_PROXY=http://REPLACE_WITH_URLENCODED_PROXY_TOKEN:personal-agent@127.0.0.1:14322
HTTPS_PROXY=http://REPLACE_WITH_URLENCODED_PROXY_TOKEN:personal-agent@127.0.0.1:14322
NO_PROXY=localhost,127.0.0.1,::1
NODE_USE_ENV_PROXY=1
NODE_EXTRA_CA_CERTS=/etc/personal-agent/ca.pem

TELEGRAM_BOT_TOKEN=__vault_TELEGRAM_BOT_TOKEN__
TELEGRAM_OWNER_ID_FILE=/etc/personal-agent/telegram-owner-id

MODEL_PROVIDER=openai
MODEL_ID=gpt-5.5
OPENAI_API_KEY=sk-__vault_OPENAI_API_KEY__
```

说明：

- proxy 地址是 `127.0.0.1:14322`，不是 Docker 网络里的 `172.30.82.2`。
- `REPLACE_WITH_URLENCODED_PROXY_TOKEN` 是 Vault 中 proxy 身份的真实 token，不是占位符；按 URL 规则编码。
- `gpt-5.5` 是当前 pi-ai 目录中的示例，换成你账户可用的模型 id。
- 未使用的 provider key 留空；如果设置了真实值，`AGENT_VAULT_ENABLED=1` 会在启动时拒绝。
- 不要同时设置 `TELEGRAM_OWNER_ID` 和 `TELEGRAM_OWNER_ID_FILE`。
- `NODE_EXTRA_CA_CERTS` 必须在 Node 启动前生效；`EnvironmentFile` 满足这一点。

使用多 vault 路由器时，只替换代理两行，其余不变：

```env
HTTP_PROXY=http://app:<URL编码的router密码>@127.0.0.1:14323
HTTPS_PROXY=http://app:<URL编码的router密码>@127.0.0.1:14323
```

`app` 是路由器配置中的 `client_auth.username`；密码来自 `/etc/personal-agent/egress-router/client-password`，不是 Agent Vault agent token。`NO_PROXY` 仍只允许 loopback。

## 5. 检查并启动

以服务用户验证配置、CA 和 owner ID 文件：

```sh
sudo bash -c 'set -a; . /etc/personal-agent.env; set +a; \
  exec runuser -u personal-agent -- env HOME=/var/lib/personal-agent \
  node /opt/personal-agent/dist/src/check-config.js'
```

预期：

```text
Configuration OK: MODEL_PROVIDER=openai MODEL_ID=gpt-5.5 ...
```

然后：

```sh
sudo systemctl restart personal-agent
journalctl -u personal-agent -f
```

预期日志：

```text
Personal agent starting; single-owner private Telegram messages enabled.
```

## 6. 验收

### 6.1 入口和模型

用 owner 账号私聊 bot 发“现在几点？”。应收到正确时间；这验证 Telegram 代理、模型 key 注入和 `current_time`。

### 6.2 确认应用环境只有占位值

```sh
sudo systemctl show personal-agent -p Environment | tr ' ' '\n' \
  | grep -E '^(TELEGRAM_BOT_TOKEN|OPENAI_API_KEY)='
```

预期：

```text
TELEGRAM_BOT_TOKEN=__vault_TELEGRAM_BOT_TOKEN__
OPENAI_API_KEY=sk-__vault_OPENAI_API_KEY__
```

不要打印完整环境，里面还有 proxy token。

### 6.3 出网行为

systemd 模式没有 `tool-network`。下面这条命令预期会直连成功，这是该模式的已知取舍：

```sh
sudo runuser -u personal-agent -- \
  env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
  node -e 'fetch("https://api.telegram.org",{signal:AbortSignal.timeout(5000)})
    .then(()=>console.log("direct egress allowed"))
    .catch(()=>console.log("direct egress blocked"))'
```

如果要求阻断直连，可加 systemd drop-in：

```sh
sudo systemctl edit personal-agent
```

```ini
[Service]
IPAddressDeny=any
IPAddressAllow=127.0.0.1 ::1
```

它会让应用只能访问本机（包括 `127.0.0.1:14322`），但依赖 cgroup v2/BPF，并会阻断本机 DNS。应用设计上通过 broker 解析上游域名；该限制未在本仓库的 systemd 测试中覆盖，启用后必须实际验证 Telegram、模型和 MCP。broker 不在本机时，把它的 IP 加入 `IPAddressAllow`。

### 6.4 工具凭证

让 agent 调用一个使用工具 key 的工具，确认日志没有认证错误，工具结果和日志没有真实 token。

### 6.5 MCP

```sh
sudo systemctl stop personal-agent
sudo bash -c 'set -a; . /etc/personal-agent.env; set +a; \
  exec runuser -u personal-agent -- env HOME=/var/lib/personal-agent \
  node /opt/personal-agent/dist/src/mcp-check.js'
sudo systemctl start personal-agent
```

每个 server 打印工具数量和工具名；失败时打印安全错误码。该命令在 unit 外运行，不验证 `IPAddressDeny` 等沙箱设置。

### 6.6 轮换

- 模型 key：在 Infisical 修改，等待轮询周期后直接发消息；不需要重启。
- Telegram bot token：在 BotFather revoke 后旧值立即失效，而 Vault 要等一个轮询周期才拿到新值。先确认 Vault 已同步（用占位路径请求 `getMe` 得到 200），再 `systemctl restart personal-agent`；否则重启后的 `getMe` 会拿到已吊销的 token 而返回 401。unit 的 `RestartSec=30` 让 5 次重试覆盖 150 秒，超过默认 60 秒轮询周期，避免重试预算在同步完成前耗尽。
- owner ID：重新导出到 `/etc/personal-agent/telegram-owner-id`，`systemctl restart personal-agent`。该文件不走代理，改 Infisical 后必须重新导出；应用启动时会把 owner ID 与数据目录中记录的绑定比对，不一致时以 `StateError` 退出（日志打印完整 message），需按 `docs/agent-vault.md` 决定迁移还是换用新的数据目录。
- proxy token：修改 `/etc/personal-agent.env`，重启应用。
- 路由器 agent token：替换 `/etc/personal-agent/egress-router/agent-token-*`，`systemctl reload agent-egress-router`（`SIGHUP` 重新读取路由和 token）；旧 tunnel 不受影响。
- 路由器客户端密码：在配置的 `client_auth.password_files` 中同时列出 `client-password` 和 `client-password.next`，写入新密码到 `.next`，`systemctl reload agent-egress-router`；更新应用并重启后，从配置和磁盘删除旧文件，再 reload。
- CA：重新获取并安装，重启应用。

### 6.7 多 vault 路由器验收

在服务器上以应用用户或 root 执行，密码和 token 不要出现在 shell history 中：

```sh
ROUTER_PASSWORD=$(sudo cat /etc/personal-agent/egress-router/client-password)
PROXY="http://app:${ROUTER_PASSWORD}@127.0.0.1:14323"

# Telegram：路径中的占位值由 vault telegram 替换
curl --proxy "$PROXY" --cacert /etc/personal-agent/ca.pem \
  "https://api.telegram.org/bot__vault_TELEGRAM_BOT_TOKEN__/getMe"

# 模型：Bearer 占位值由 vault deepseek 替换
curl --proxy "$PROXY" --cacert /etc/personal-agent/ca.pem \
  -H "Authorization: Bearer __vault_DEEPSEEK_API_KEY__" \
  "https://api.deepseek.com/models"

# 未配置的 host：路由器返回 403
curl --proxy "$PROXY" --cacert /etc/personal-agent/ca.pem \
  -o /dev/null -w '%{http_code}\n' "https://example.com"

# 错误的 router 密码：路由器返回 407
curl --proxy "http://app:wrong@127.0.0.1:14323" --cacert /etc/personal-agent/ca.pem \
  -o /dev/null -w '%{http_code}\n' "https://api.deepseek.com/models"

sudo journalctl -u agent-egress-router -n 50 -o cat
```

通过标准：Telegram 和模型请求返回 `200`；未配置 host 返回 `403`；错误密码返回 `407`；路由器日志包含 `route`、`vault`、`status`、`bytes_in`/`bytes_out`，但不包含 agent token、router 密码、真实 API key 或请求正文。Agent Vault 自身返回 `407`/`403` 时，路由器应透传相同状态码和 `Proxy-Authenticate`。

## 7. 备份、更新、回滚

备份前停止应用和 broker：

```sh
sudo systemctl stop personal-agent
docker compose -f docker-compose.agent-vault.yml \
  -f deploy/agent-vault/compose.systemd.yml stop agent-vault

sudo tar czf /root/personal-agent-data.tgz -C /var/lib/personal-agent .
sudo tar czf /root/personal-agent-config.tgz -C /etc personal-agent.env personal-agent

docker run --rm -v personal-agent-vault-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/personal-agent-vault-data.tgz -C /data .

docker compose -f docker-compose.agent-vault.yml \
  -f deploy/agent-vault/compose.systemd.yml start agent-vault
sudo systemctl start personal-agent
```

`/root/personal-agent-config.tgz` 和 vault 数据卷都包含敏感材料，按凭据管理。不要删除数据目录或执行 `docker compose down -v`。

更新应用：

```sh
git pull
sudo ./deploy/install-systemd.sh
sudo systemctl restart personal-agent
```

回滚：

```sh
git checkout <上一个可用提交>
sudo ./deploy/install-systemd.sh
```

broker 镜像在 Compose 中固定为 `0.40.0`；升级前核对上游 release 和镜像 digest，重新执行验收。

## 已知边界

- 没有 `tool-network` 的强制出网限制；需要该边界时使用完整 Compose 模式，或自行加 systemd `IPAddressDeny` 并验收。
- MCP OAuth token 仍保存在 `DATA_DIR/mcp-oauth`，没有迁入 Infisical。
- 应用、stdio MCP 和 bash 工具同 uid，不构成安全边界。
- Infisical 同步失败时继续使用最后一次缓存，本版没有最大缓存年龄关断。
- Agent Vault 仍以容器运行；本仓库没有 systemd 直接运行 broker 的受支持方案。
- 真实 Infisical 同步、注入/轮换、目标主机防火墙和各家模型 SDK 的流式请求仍需部署验收。

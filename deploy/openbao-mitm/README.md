# OpenBao + MITM 出站密钥占位

Aster 应用的模型、Web 工具与 Telegram 请求经 MITM 代理出站；代理把请求头和 URL 路径里的 `__vault_<NAME>__` 占位符换成 OpenBao 中 `secret/aster/<NAME>` 的值。应用进程与模型只看到占位符，明文密钥不写入 `.env`、镜像、仓库、日志或聊天。

代理与 OpenBao 都不共享通用网络：应用只能经专用内网访问代理，OpenBao 只对代理可达，两个端口都不发布到宿主机。详见下文“网络可达性”。

> **历史背景**：[ADR-0005](../../docs/adr/0005-remove-agent-vault-single-service.md) 删除的是依赖 Infisical 云的旧 Agent Vault 子系统；本方案使用同机自建的 `aster-openbao` + `aster-mitm` 内网服务完成出站占位替换。

## 目录结构

| 文件 | 作用 |
| --- | --- |
| `compose.yml` | `aster-openbao` 与 `aster-mitm` 两个服务，项目名 `aster`；三个专用网络（`aster_vault`、`aster_mitm_clients`、`aster_egress`），不发布端口 |
| `openbao/config.hcl` | 单节点 OpenBao 配置（仅 `aster_vault` 内网监听，只有 mitm 可达） |
| `addon/aster_vault_addon.py` | mitmproxy 插件：按主机白名单将请求头和 URL 路径中的 `__vault_<NAME>__` 替换为 OpenBao KV 值，越权或未知占位符返回 403；客户端源地址不在白名单时同样返回 403 |
| `addon/vault_placeholders.py` | 占位符替换纯函数策略（无 mitmproxy 依赖，可独立单测） |
| `addon/allowlist.json` | 占位符名 → 允许的目标主机列表（精确匹配） |
| `addon/client_allowlist.py` | 代理客户端源地址白名单（默认只允许 Aster 应用容器 `10.89.143.3/32`） |
| `addon/test_vault_placeholders.py` | 占位符策略单测 |
| `addon/test_client_allowlist.py` | 客户端源地址白名单单测 |
| `bootstrap.sh` | 运维引导：启用 KV v2、写只读策略、签发只读 token、录入密钥（隐藏输入）、导出不含私钥的公共 CA 证书 |
| `../../docker-compose.mitm.yml` | 应用侧 Compose overlay：注入代理变量、挂载 MITM CA 证书、只加入内部网络 `aster_mitm_clients`（固定地址 `10.89.143.3`，不接默认网络） |

## 替换规则与安全边界

- **替换位置**：仅替换 HTTP 请求头与 URL 路径（`?` 之前）。**绝不替换请求体**：内置 `web_fetch` 会把模型提供的目标 URL 放在请求体里发给 `api.deepseek.com`，不替换请求体可防止提示词注入借抓取接口外带真实密钥。
- **主机白名单**：仅当请求目标主机精确匹配 `allowlist.json` 中该 `<NAME>` 允许的主机时才替换（例如 `api.deepseek.com.evil.example` 会被拒绝）。
- **失败关闭**：未知占位符名、不允许的目标主机或 OpenBao 读取失败时，整条请求直接返回 `403`，日志只记占位符名与目标主机，不打印任何密钥值。

| 变量名（`.env`） | 是否占位 | 占位符值 | OpenBao KV 路径 | 允许出站主机 |
| --- | --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 是 | `__vault_TELEGRAM_BOT_TOKEN__` | `secret/aster/TELEGRAM_BOT_TOKEN` | `api.telegram.org` |
| `DEEPSEEK_API_KEY` | 是 | `__vault_DEEPSEEK_API_KEY__` | `secret/aster/DEEPSEEK_API_KEY` | `api.deepseek.com` |
| `DEEPSEEK_WEB_API_KEY` | 是（可选） | `__vault_DEEPSEEK_WEB_API_KEY__` | `secret/aster/DEEPSEEK_WEB_API_KEY` | `api.deepseek.com` |
| 其他提供商 `*_API_KEY` | 是（按需） | `__vault_<NAME>__` | `secret/aster/<NAME>` | 见 `addon/allowlist.json` |
| `TELEGRAM_OWNER_ID` | 否 | 数值用户 ID（进程内比对，不出站） | — | — |
| `MODEL_PROVIDER` / `MODEL_ID` / `DATA_DIR` / `MEMORY_*` | 否 | 普通配置值 | — | — |

## 网络可达性与端口暴露

两个监听端口都不发布到宿主机，并且各自只在专用网络中可监听：

| 端口 | 监听位置 | 谁能连 | 谁不能连 |
| --- | --- | --- | --- |
| `14322`（MITM 代理） | 仅绑定 `aster_mitm_clients` 上的 `10.89.143.2`，不是 `0.0.0.0` | 只有 Aster 应用容器 `10.89.143.3`；addon 还会用 `ASTER_PROXY_CLIENT_ALLOW` 做第二次源地址校验 | 宿主机（未 publish；即使能路由到该子网，源地址也不在白名单）；`aster_vault`／`aster_egress` 上的容器；其它任何网络的容器 |
| `8200`（OpenBao） | `aster_vault` 内网 `10.89.82.2:8200` | `aster-mitm`（`10.89.82.3`）；运维路径为 `docker exec`／临时接入 `aster_vault` 的容器，宿主机也可经 bridge 地址 `10.89.82.2:8200` 本机访问（未 publish，宿主机以外不可达） | Aster 应用容器（不在 `aster_vault`）；`aster_egress` 及其它网络的容器；宿主机以外的任何主机 |

- `aster_vault` 与 `aster_mitm_clients` 都是 Docker `internal: true`：没有默认路由，应用不能绕过代理直连外网，OpenBao 流量也不会离开宿主机内网。
- 只有 `aster-mitm` 接入 `aster_egress` 负责公网出口，该网络上没有其它业务容器。
- 代理额外做了连接治理：`connection_timeout=30` 关闭空闲连接，避免半开隧道长期占用。
- 运维访问 OpenBao 不要发布端口，使用容器内 CLI、一次性网络容器或 SSH 隧道：
  ```bash
  docker exec -it aster-openbao bao status
  docker run --rm --network aster_vault -e BAO_ADDR=http://aster-openbao:8200 <OpenBao 镜像> bao status
  ssh -L 8200:10.89.82.2:8200 <user>@<server>   # 本机浏览器/CLI 访问 http://127.0.0.1:8200
  ```
- 宿主机对 `10.89.143.2:14322` 即使 TCP 可达，也会因源地址不在 `ASTER_PROXY_CLIENT_ALLOW` 而收到 `403`，不能作为代理使用。
- 子网固定为 `10.89.82.0/24`（vault）与 `10.89.143.0/24`（clients）。若与宿主机现有网段冲突，同时修改 `compose.yml` 中的 subnet、`ipv4_address`、`--listen-host`、`ASTER_PROXY_CLIENT_ALLOW` 以及 `docker-compose.mitm.yml` 中的 `ipv4_address`，保持三处一致。

## 宿主机证书与凭据目录（不进仓库）

```text
~/Aster/secrets/openbao/                    chmod 700
  openbao-mitm-token                        chmod 600，只读策略 token（bootstrap.sh 生成，仅挂入 aster-mitm）
  mitmproxy-ca.pem                          chmod 644，仅含公共 CA 证书（由 mitmproxy-ca-cert.pem 导出，只读挂入 personal-agent）
  mitmproxy/                                aster-mitm 的 confdir（容器内 uid 1000 可写）
    mitmproxy-ca.pem                        含 CA 私钥 + 证书，仅 aster-mitm 使用，严禁挂入应用容器
    mitmproxy-ca-cert.pem                   mitmproxy 生成的纯公钥证书，bootstrap.sh 会将它复制为上层 ../mitmproxy-ca.pem
```

> **生产 CA 信任正式做法**：
> - 严禁在生产环境使用 `ssl_insecure` 或 `NODE_TLS_REJECT_UNAUTHORIZED=0`（应用配置校验 `readConfig` 与 `configureEnvProxy` 也会直接拒绝 `NODE_TLS_REJECT_UNAUTHORIZED=0`）。
> - 将 `aster-mitm` 生成的纯公钥证书导出到 `~/Aster/secrets/openbao/mitmproxy-ca.pem`（仅包含 `-----BEGIN CERTIFICATE-----`，不含 `PRIVATE KEY`），通过 `docker-compose.mitm.yml` 只读挂载到容器内 `/run/aster/mitmproxy-ca.pem`，并设置 `NODE_EXTRA_CA_CERTS=/run/aster/mitmproxy-ca.pem`。
> - 若生产机器上证书放在其他路径，可通过环境变量 `ASTER_MITM_CA_CERT=/actual/path/to/ca-cert.pem` 覆盖挂载源路径。

## 1. 启动或核对 OpenBao 与 MITM（若尚未运行）

```bash
cd ~/Aster/deploy/openbao-mitm
export OPENBAO_IMAGE=<生产固定版本 OpenBao 镜像>
export MITMPROXY_IMAGE=<生产固定版本 mitmproxy 镜像>
export ASTER_OPENBAO_SECRETS=$HOME/Aster/secrets/openbao
mkdir -p "$ASTER_OPENBAO_SECRETS/mitmproxy" && sudo chown 1000:1000 "$ASTER_OPENBAO_SECRETS/mitmproxy"
docker compose up -d openbao
```

OpenBao 首次启动需完成 `bao operator init` 与 `unseal`，随后执行引导脚本生成只读 token 并录入密钥，再启动 `mitm`：

```bash
ASTER_OPENBAO_SECRETS=$HOME/Aster/secrets/openbao ./bootstrap.sh DEEPSEEK_API_KEY DEEPSEEK_WEB_API_KEY TELEGRAM_BOT_TOKEN
docker compose up -d mitm
# mitm 首次启动生成证书后，再跑一次（不传密钥名）将纯公钥证书导出到 ~/Aster/secrets/openbao/mitmproxy-ca.pem
ASTER_OPENBAO_SECRETS=$HOME/Aster/secrets/openbao ./bootstrap.sh
```

## 2. 应用加入 `aster_mitm_clients` 并切换为占位符（迁移步骤）

1. **备份原 `.env`（保存在仓库外）**：
   ```bash
   cp ~/Aster/.env ~/Aster/secrets/env.plaintext.bak
   chmod 600 ~/Aster/secrets/env.plaintext.bak
   ```
2. **确认公共 CA 证书存在且不含私钥**：
   ```bash
   grep -c "BEGIN CERTIFICATE" ~/Aster/secrets/openbao/mitmproxy-ca.pem   # 应 >= 1
   grep -c "PRIVATE KEY" ~/Aster/secrets/openbao/mitmproxy-ca.pem || true # 必须为 0
   ```
3. **将 `.env` 中的密钥改为 `__vault_<NAME>__` 占位符**（非密钥配置保持不变）：
   ```dotenv
   TELEGRAM_BOT_TOKEN=__vault_TELEGRAM_BOT_TOKEN__
   DEEPSEEK_API_KEY=__vault_DEEPSEEK_API_KEY__
   DEEPSEEK_WEB_API_KEY=__vault_DEEPSEEK_WEB_API_KEY__
   ```
4. **叠加 `docker-compose.mitm.yml` 启动应用**（项目名保持 `aster-production`，不要用 `aster`，以免与 OpenBao/MITM 栈争夺网络名）：
   ```bash
   cd ~/Aster
   docker compose -p aster-production --env-file .env \
     -f docker-compose.yml -f docker-compose.mitm.yml up -d
   ```
   应用此时只接入 `aster_mitm_clients`（固定地址 `10.89.143.3`），不再接入默认网络或 `aster_default`。

`docker-compose.mitm.yml` 为 `personal-agent` 注入的环境变量与挂载：
- `HTTPS_PROXY=http://aster-mitm:14322`、`HTTP_PROXY=http://aster-mitm:14322`
- `NO_PROXY=localhost,127.0.0.1,::1,aster-mitm`（只保留回环与代理自身；OpenBao 不在应用的任何可达网络上）
- `NODE_USE_ENV_PROXY=1`（配合应用启动时的 `configureEnvProxy()` 与 `TelegramClient` 的 `HttpsAgent({ keepAlive: true, proxyEnv })`，使 LLM、`web_search`/`web_fetch`、MCP 与 grammY Telegram Bot API 全部走代理）
- `NODE_EXTRA_CA_CERTS=/run/aster/mitmproxy-ca.pem`（只读挂载 `${ASTER_MITM_CA_CERT:-~/Aster/secrets/openbao/mitmproxy-ca.pem}`）
- 只加入内部网络 `aster_mitm_clients`（固定地址 `10.89.143.3`）；没有默认网络，也没有直连公网的路由

## 3. 验证与验收步骤

### 本地自动化测试（无需真实 OpenBao 或真实密钥）

```bash
npm run check
npx tsx --test test/mitm-proxy.test.ts
python -m unittest discover -s deploy/openbao-mitm/addon -p "test_*.py" -v
```

### 生产／Compose 验收步骤

```bash
# 1. 核对应用只接入 aster_mitm_clients（固定地址 10.89.143.3），不在任何共享网络上
docker inspect aster-production-personal-agent-1 \
  --format '{{json .NetworkSettings.Networks}}'
# 期望输出中只有 aster_mitm_clients，且 IPAddress 为 10.89.143.3

# 2. 经 MITM 请求允许的主机（DeepSeek 模型 API）：占位符被替换，返回 200（或业务状态码，非 403）
docker exec aster-production-personal-agent-1 node -e '
  fetch("https://api.deepseek.com/v1/models", {
    headers: { Authorization: "Bearer __vault_DEEPSEEK_API_KEY__" },
  }).then((r) => console.log("deepseek status:", r.status));
'

# 3. 经 MITM 调用内置 web_search / web_fetch（DeepSeek Web 工具端点）
docker exec aster-production-personal-agent-1 node -e '
  fetch("https://api.deepseek.com/v1/tools/search", {
    method: "POST",
    headers: {
      Authorization: "Bearer __vault_DEEPSEEK_WEB_API_KEY__",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: "example", max_results: 1 }),
  }).then((r) => console.log("web_search status:", r.status));
'

# 4. 越权主机拦截验证：把占位符发往非白名单主机必须返回 403
docker exec aster-production-personal-agent-1 node -e '
  fetch("https://example.com/", {
    headers: { Authorization: "Bearer __vault_DEEPSEEK_API_KEY__" },
  }).then((r) => console.log("disallowed host status (expected 403):", r.status));
'

# 5. 检查 aster-mitm 日志不泄露路径中的 bot token 或任何密钥值（mitmdump -q）
docker logs aster-mitm 2>&1 | grep -c '/bot' || true   # 期望为 0

# 6. 网络边界核对：应用不能直连 OpenBao（不在 aster_vault 上，主机名不可解析）
docker exec aster-production-personal-agent-1 node -e '
  fetch("http://aster-openbao:8200/v1/sys/health", { signal: AbortSignal.timeout(3000) })
    .then((r) => console.log("UNEXPECTED openbao status:", r.status))
    .catch((e) => console.log("expected openbao unreachable:", e.cause?.code ?? e.name));
'

# 7. 其它网络（例如 aster_egress）上的容器不能把 MITM 当代理：14322 只绑定在 aster_mitm_clients 上
docker run --rm --network aster_egress --entrypoint node "$ASTER_IMAGE" -e '
  fetch("http://10.89.143.2:14322", { signal: AbortSignal.timeout(3000) })
    .then((r) => console.log("UNEXPECTED proxy status:", r.status))
    .catch((e) => console.log("expected proxy unreachable:", e.cause?.code ?? e.name));
'

# 8. 宿主机没有 8200／14322 的监听或发布端口
docker port aster-openbao; docker port aster-mitm        # 均为空
ss -ltn | grep -E ':(8200|14322)\b' || echo "no host listeners on 8200/14322"
```

## 4. 回滚步骤（去掉 proxy/CA、恢复明文 env）

若需回退到无代理直连模式：

1. **恢复仓库外备份的明文 `.env`**：
   ```bash
   cp ~/Aster/secrets/env.plaintext.bak ~/Aster/.env
   chmod 600 ~/Aster/.env
   ```
2. **仅使用基础 `docker-compose.yml` 重建应用容器**（去掉 `-f docker-compose.mitm.yml`）：
   ```bash
   cd ~/Aster
   docker compose -p aster-production --env-file .env -f docker-compose.yml up -d
   ```
   此时 `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY`、`NODE_EXTRA_CA_CERTS`、CA 挂载以及 `aster_mitm_clients` 网络连接均从 `personal-agent` 容器移除，应用恢复直连默认网络。
3. **网络与 OpenBao/MITM 栈**：回滚应用不需要删除专用网络；若整个 OpenBao + MITM 栈下线，在 `deploy/openbao-mitm` 执行 `docker compose down`（会一并移除 `aster_vault`、`aster_mitm_clients`、`aster_egress`）。

## 5. 已知问题说明

- **Telegram 主机出口网络超时**：若宿主机所在网络无法直连 `api.telegram.org`（即使经同机 `aster-mitm` 出站仍受限于宿主机出口网络），Telegram `getMe` / `getUpdates` 超时属于**已知主机出口网络问题**，不是本 PR 的回归；在宿主机出口不可达 `api.telegram.org` 的机器上可配合 `TELEGRAM_API_ROOT`（并在 `addon/allowlist.json` 的 `TELEGRAM_BOT_TOKEN` 中加入对应反代域名）使用。

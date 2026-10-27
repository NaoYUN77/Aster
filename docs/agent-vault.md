# 工具凭证：Agent Vault + Infisical

## 已实现的范围

工具使用的 API token、API key、用户名和密码存放在 Infisical Secret Management，由开源 Agent Vault 在出站 HTTP(S) 请求中注入。应用不读取这些凭证的真实值。应用侧支持 Node 原生 fetch/http/https、grammY 的专用代理 agent，以及 stdio MCP 的代理与 CA 环境传递。

MCP 的网页登录 OAuth 保留现有 `mcp:auth`、动态注册、token 文件和刷新流程。OAuth endpoint 与 MCP endpoint 在 Vault 配置为 `passthrough`，避免代理覆盖 OAuth Authorization header。**OAuth token 仍保存在 `DATA_DIR/mcp-oauth`，没有迁入 Infisical；不要将此版本称为所有凭证均不落应用主机。** 同 uid 的文件/bash 工具仍能访问该文件，这是此次范围保留的边界。

部署使用独立的 `docker-compose.agent-vault.yml`，包含 Vault、拥有网络命名空间的防火墙容器和应用。不要与原 Compose 文件合并；后者的默认网络允许直连。生产只支持 Docker 部署；应用镜像由 `${ASTER_IMAGE:-aster:local}` 提供，网络命名空间镜像由 `${ASTER_NETWORK_IMAGE:-aster-network:local}` 提供。旧的 systemd 混合部署已停止支持，只保留[迁移说明](agent-vault-systemd.md)。

原生数据库、SSH、私钥签名、mTLS 以及不支持代理的 SDK 不在本版支持范围。需要这些协议的工具不得靠明文 env/password 降级，应先增加相应可信适配。

## 入口基础设施配置放在哪里

Bot token、Telegram owner ID 和 LLM API key 都存放在 Infisical。前两者中，Bot token 是请求路径的一部分，可由 Vault 注入；owner ID 只在本地比较 Telegram 消息来源，不经过 HTTP，因此需要部署时从 Infisical 导出到文件。模型提供商和 `MODEL_ID` 是公开的选择配置，不需要进入秘密管理。

| 项目 | 权威存放位置 | 应用侧内容 |
| --- | --- | --- |
| Telegram Bot token | Infisical，key 为 `TELEGRAM_BOT_TOKEN` | `private/app.env` 放 `__vault_TELEGRAM_BOT_TOKEN__`；Vault 在请求路径中替换 |
| Telegram owner user ID | Infisical，key 为 `TELEGRAM_OWNER_ID` | 部署时导出到 `private/telegram-owner-id`，挂载为 Compose secret；`private/app.env` 的 `TELEGRAM_OWNER_ID_FILE` 只放路径 |
| LLM API key | Infisical，key 名按使用中的提供商规则 | `private/app.env` 的 provider API-key 变量放占位值；Vault 规则注入认证 |
| `MODEL_PROVIDER`、`MODEL_ID` | 不进入秘密管理 | `private/app.env` 的真实值；启动时用于离线模型目录校验 |
| Vault proxy 身份 | `private/app.env` 的 proxy URL | 启动信任凭证，仅 proxy 权限，不具备读取真实秘密的权限 |
| Infisical Machine Identity / Vault 主密码 | `private/vault.env`，仅传给 Vault 容器 | 不传给应用或工具 |

owner ID 不是请求凭证，所以不能用占位值让代理替换。应用只读取导出文件，不持有 Infisical 身份；在 Infisical 中修改后，重新导出该文件并重启应用。该文件属于访问控制配置，不是可公开的运行参数，放在 git/docker 构建上下文之外。Compose 的 file secret 以 bind mount 方式挂载，`uid`/`gid`/`mode` 不生效，容器内看到的仍是源文件权限；应用以 uid 1000 运行，因此该文件需设为 `644`（只含数字 ID，且所在 `private/` 目录为 `700`）。未启用 Vault 时仍可直接在 `.env` 设置 `TELEGRAM_OWNER_ID`；两种来源不能同时设置。

入口 token/key 与工具凭证目前共用一个工作负载的代理身份；这不代表按工具或进程隔离了各自权限。拆成独立权限域需要进一步拆分执行环境和代理身份。

## 模型提供商如何接入

模型请求同样走 Agent Vault，应用不保存真实 API key。`src/providers.ts` 的注册表只声明每个提供商读取哪个环境变量；pi-ai 在请求时读取该变量，把它放进 SDK 原本使用的认证 header，再由 Vault 服务规则按 host/path 替换为 Infisical 中的真实值：

```text
openAgent
  createProviderModels(MODEL_PROVIDER)
    pi-ai 读取 PROVIDERS[provider].apiKeyEnv  ← app.env 中的占位值
      SDK 发出正常认证 header               ← 占位值
        HTTPS_PROXY → Agent Vault
          匹配 host/path，注入真实 key      ← Infisical
            目标模型 API
```

| 提供商类别 | 注册表中的 id | 应用侧变量 | SDK 发出的位置 | Vault 规则 |
| --- | --- | --- | --- | --- |
| OpenAI 兼容 | `openai`、`deepseek`、`groq`、`xai`、`mistral`、`moonshotai`、`moonshotai-cn`、`zai`、`openrouter` | 各自的 `*_API_KEY` | `Authorization: Bearer <占位值>` | `auth.type: bearer`，`token` 指向同名或对应 key |
| Anthropic 风格 | `anthropic`、`minimax` | `ANTHROPIC_API_KEY`、`MINIMAX_API_KEY` | `x-api-key: <占位值>` | `auth.type: api-key`，`header: x-api-key` |
| Gemini | `google` | `GEMINI_API_KEY` | `x-goog-api-key: <占位值>` | `auth.type: api-key`，`header: x-goog-api-key` |

完整 host 与规则见 `deploy/agent-vault/services.example.yaml`，只保留当前 `MODEL_PROVIDER` 对应的规则。OpenAI 的占位值需要以 `sk-` 开头：已安装的 pi-ai 1.3.0 会把发往 `api.openai.com` 且不以 `sk-` 开头的 key 当作 ChatGPT 登录 token，从而省略部分请求参数。示例使用 `sk-__vault_OPENAI_API_KEY__`，真实 key 仍只存在于 Infisical。

本地测试覆盖 Node 全局 fetch 与 grammY 的代理路径；各提供商 SDK 的完整流式请求仍需在部署验收中逐个确认，不能仅凭配置规则推断已联调。

`MODEL_PROVIDER` 和 `MODEL_ID` 保留在应用配置中，因为启动时的模型目录校验是离线完成的，二者也不是秘密。切换提供商时同时修改 `MODEL_PROVIDER`、`MODEL_ID`、对应 API-key 占位值和 Vault 服务规则；只改其中一处会导致认证失败或启动校验失败。

## 配置契约

| 配置 | 含义 |
| --- | --- |
| `AGENT_VAULT_ENABLED=1` | 启用应用侧代理检查与 MCP 凭证配置约束；缺省/`0` 保留原运行方式。启用后要求 Bot token 与所有已设置的注册表提供商 key 为占位值，owner ID 从文件读取 |
| `HTTP_PROXY` / `HTTPS_PROXY` | 必须完全相同。单 vault 时格式 `http://<proxy-token>:<vault>@172.30.82.2:14322`；多 vault 时指向共享命名空间内的路由器，如 `http://app:<router-password>@127.0.0.1:14323`。也接受 HTTPS 代理 URL |
| `NODE_USE_ENV_PROXY=1` | 在启动 Node 前设置；应用还调用 Node 24 的 `setGlobalProxyFromEnv` 覆盖默认网络客户端 |
| `NODE_EXTRA_CA_CERTS` | 启动 Node 前指定绝对路径；证书必须可读，在线入口会验证 Node 已加载它 |
| `NO_PROXY` | 仅允许为空或精确 loopback 主机列表，不允许 `*`、域名后缀或外部主机 |
| `TELEGRAM_OWNER_ID_FILE` | 可选的绝对路径；启用 Vault 时必填，从 Infisical 导出的 owner ID。与 `TELEGRAM_OWNER_ID` 互斥，文件必须可读且内容为正整数 |

只采用大写 proxy 配置，拒绝有值的小写版本及 `ALL_PROXY`，避免库选择不同出口。禁止关闭 TLS 验证。子进程会获得对应的 `SSL_CERT_FILE`、`REQUESTS_CA_BUNDLE`、`CURL_CA_BUNDLE`、`GIT_SSL_CAINFO`，而不继承 Infisical 身份或宿主其他环境。

### 多 vault 与 host 路由

一个 Agent Vault vault 绑定一个 Infisical project / environment / secret path，并且只同步该路径下的直接 key，不递归子文件夹。因此“不同基建放不同文件夹”对应多个 vault，而不是一个 vault 的多个路径。

应用进程只有一组全局 `HTTP_PROXY` / `HTTPS_PROXY`，无法按目标 host 选择不同 vault。多 vault 部署在应用与 broker 之间增加 `agent-egress-router`：应用把代理指向路由器的回环端口，路由器按 CONNECT 的 `host:port` 从精确路由表选择 vault 与对应的 agent token，再转发到 broker。

```text
app ── HTTP_PROXY → 127.0.0.1:14323 (router, app password)
                         ├─ api.telegram.org:443 → vault telegram + token A
                         ├─ api.deepseek.com:443 → vault deepseek + token B
                         └─ api.github.com:443   → vault tools    + token C
                         ▼
                    172.30.82.2:14322 (one broker, many vaults)
```

- 每个 vault 配一个只授予该 vault `proxy` 角色的 agent token；token 是数据库记录，不增加常驻进程。
- 仍然只运行一个 broker；只有需要独立故障域或独立信任边界时才拆多个 broker。
- 路由器只监听回环，不解析 DNS，不持有 Infisical 凭据或真实 API key。为适配 Docker bridge，上游只接受回环或私有 IP 字面量，例如 `172.30.82.2:14322`；不接受公网 IP 或主机名。
- 应用只持有路由器客户端密码，不持有 agent token。
- 未列入路由表的 host 默认拒绝（`403`）；Agent Vault 的 `407`/`403` 原样透传。

路由器在 Docker 中与 `tool-network` 共享网络命名空间，因此回环地址就是应用看到的地址。运行方式、目录权限和验收命令见 [router/README.md](../router/README.md) 与 [部署运行手册](deployment-test-guide.md#6-多-vault-路由器)，示例配置见 [egress-router.example.json](../deploy/agent-vault/egress-router.example.json)。设计文档见 [host 路由方案](agent-vault-router-plan.md)。

MCP 中 `${vault:KEY}` 转换为字符串 `__vault_KEY__`，**不是取密接口**。KEY 必须使用 UPPER_SNAKE_CASE；未启用 Vault 时使用引用会禁用对应 server。比如：

```json
{
  "servers": [
    {
      "name": "github",
      "transport": "stdio",
      "command": "node",
      "args": ["/opt/mcp/github-server.js"],
      "env": { "GITHUB_TOKEN": "${vault:GITHUB_TOKEN}" }
    },
    {
      "name": "account",
      "transport": "http",
      "url": "https://account.example.com/api/mcp"
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

`account` 的用户名/密码由 Vault 的 Basic 规则直接生成 Authorization，不需要在 MCP JSON 中填写，也不应自行将占位用户名/密码 base64 编码。SDK 必须有非空 key 时使用占位值，Vault 的 bearer/api-key/basic 规则覆盖对应 header。只有服务要求 path/query/body 等认证位置时，才配置精确 placeholder 和 `in` 范围的 substitutions。

Vault 模式下禁止 stdio `inheritEnv: true`、覆盖代理/CA/Node TLS 配置；常见凭证变量名要求占位值。HTTP MCP 除 `Accept`、`Content-Type`、`X-Client` 外的显式 header 必须使用占位值（支持 `Bearer ${vault:KEY}`），URL 不接受 query。OAuth provider 自动生成的认证不受显式 header 限制。`${NAME}` 仍用于一般环境配置；不能依靠变量名规则识别所有任意字符串里的秘密。禁止绕过凭证策略主要依靠真实秘密不部署到工具环境、Vault 规则与强制网络出口，配置校验只负责可识别的错误。

自定义工具继续复用 pi-durable 的原生 `defineTool`、取消信号及重放规则。启动入口初始化代理后，可直接请求已授权 HTTPS URL；宿主负责固定 URL/服务身份，模型参数不能包含 secret 或选择任意认证目标。不要增加返回明文凭证的工具。SDK 使用自建 agent/dispatcher 时，必须显式接入并验证；不支持代理的工具在隔离部署中失败，不自动直连。

## 准备部署

Broker 由 `${ASTER_VAULT_IMAGE:-aster-vault:local}` 提供，使用本仓库基于固定上游版本的受审构建，见 [构建与补丁](../deploy/agent-vault/broker/README.md)。原始 `infisical/agent-vault:0.40.0` 已复现取密重定向和错误日志泄露，不能直接作为自动生产部署的默认值，证据见 [安全调查](agent-vault-security-investigation.md)。受审构建仅支持 Universal Auth；升级前验证来源、签名及 digest，并重新运行回归。应用和网络命名空间镜像分别通过 `ASTER_IMAGE`／`ASTER_NETWORK_IMAGE` 指定；生产 Compose 只消费镜像。CI 与剩余准入条件见 [实施计划](ci-cd-implementation-plan.md)，此前 Docker 迁移证据见 [镜像迁移验证](docker-verification.md)。

在独立 Linux Docker 主机或现有受控部署目录执行：

```sh
mkdir -p deploy/agent-vault/private
chmod 700 deploy/agent-vault/private
cp deploy/agent-vault/vault.env.example deploy/agent-vault/private/vault.env
cp deploy/agent-vault/app.env.example deploy/agent-vault/private/app.env
chmod 600 deploy/agent-vault/private/*.env
```

`private/` 已同时加入 gitignore 和 dockerignore，不会进入构建上下文。不要在聊天、命令行参数、工具结果或日志中粘贴真实凭证。配置中的代理 token 本身具有访问权限，也需要保密。

多 vault 模式额外准备 `private/app.router.env` 和 `private/router/`：

```sh
cp deploy/agent-vault/app.router.env.example deploy/agent-vault/private/app.router.env
chmod 600 deploy/agent-vault/private/app.router.env

mkdir -p deploy/agent-vault/private/router
cp deploy/agent-vault/egress-router.example.json deploy/agent-vault/private/router/config.json
# 写入 client-password 与每个 vault 的 agent token 文件
chown -R 1001:1001 deploy/agent-vault/private/router
chmod 700 deploy/agent-vault/private/router
chmod 600 deploy/agent-vault/private/router/*
```

路由器以 uid 1001 运行，整个目录只读挂载到 `/etc/aster-router`；JSON 内路径写作 `/etc/aster-router/...`，`upstream_proxy` 为 `172.30.82.2:14322`。`config.json` 中的 `listen` 与 `health_listen` 仍必须是回环地址。

1. 在 Infisical 项目中创建对应环境和路径，例如 `prod`、`/personal-agent/tools`。把实际需要的 `GITHUB_TOKEN`、`EXAMPLE_USERNAME`、`EXAMPLE_PASSWORD`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_OWNER_ID` 以及当前模型提供商的 API key 放入此路径。未使用的示例 key 不需要创建。
2. 创建只读 Machine Identity，权限仅覆盖该项目、环境、路径。将 Universal Auth client ID/secret 填入 `private/vault.env`，并设置强 Vault master password。该密码用于包装本地数据密钥，保护 Vault 数据卷中的凭据和 CA 私钥；它不是 Infisical 密码，也不传给应用。丢失后原数据卷无法解密，只能用 `agent-vault master-password change` 在知道当前密码时轮换。不要把此文件挂载到应用。
3. 先复制 `deploy/agent-vault/api-policy.example.yaml` 到 `private/api-policy.yaml`，把 `vault` 改为实际名称（本说明为 `personal-agent`），只保留实际需要并验证过的精确操作；示例只覆盖 Telegram 和 Anthropic Messages，其他模型提供商需要明确配置自己的推理路径。策略文件不含真实 token，设为 broker uid 65532 可读（例如 `chmod 644`），`private/` 保持 0700。Compose 把策略只读挂载给 broker，缺失时不自动创建目录；无效文件阻止启动。字段／限制的唯一权威见 [受审 broker schema](../deploy/agent-vault/broker/api_policy.go.in)，运行语义见 [构建说明](../deploy/agent-vault/broker/README.md)。然后仅启动 broker：

   ```sh
   docker compose -f docker-compose.agent-vault.yml up -d agent-vault
   ```

4. 管理端口默认不发布到宿主。设置 owner、导出 CA 等宿主侧操作需要临时叠加回环 override：

   ```sh
   docker compose -f docker-compose.agent-vault.yml -f docker-compose.management-loopback.yml up -d agent-vault
   ```

   该 override 只把管理端口发布在 `127.0.0.1`；不要改成其他宿主地址。通过 `http://127.0.0.1:14321` 设置 owner，远程使用 SSH 转发。创建名为 `personal-agent` 的 vault，credential store 选择 Infisical，绑定 project/environment/path，轮询周期初始 60 秒。确认同步成功，设置 `unmatched_host_policy=deny`。完成后移除 override 并重建 broker：`docker compose -f docker-compose.agent-vault.yml up -d --force-recreate agent-vault`。
5. 根据 `deploy/agent-vault/services.example.yaml` 配置实际服务规则。删除不用的示例，替换 example.com；每个规则引用的 key 必须已同步存在。CLI 导入 service 文件会替换整个规则集合，保留模型、Telegram、OAuth discovery/token/registration 等所需规则。服务 host 限定端口与路径，不能仅因为域名可信就允许所有凭证管理接口。
6. 创建只具备该 vault `proxy` 角色的 agent 身份，把 token 和 vault 名按 URL userinfo 编码填入 `private/app.env` 的两条 proxy URL。不能授予 member/admin；应用不需要 credential get/list-reveal 权限。
7. 从自己部署的管理端点获取公共 CA，并确认来自预期实例：

   ```sh
   curl --fail http://127.0.0.1:14321/v1/mitm/ca.pem -o deploy/agent-vault/private/ca.pem
   chmod 644 deploy/agent-vault/private/ca.pem
   ```

   只把 CA 公钥挂载给应用。首次启动必须已有有效 PEM，不能让缺失文件变成目录挂载。
8. 在 `app.env` 填 `MODEL_PROVIDER`、`MODEL_ID` 等非敏感配置。示例模型为 OpenAI，切换时按 `src/providers.ts` 选择变量并配置相应 Vault 服务。provider key 和 Telegram token 用占位值；Vault 分别在认证 header 与 `/bot__vault_TELEGRAM_BOT_TOKEN__/...` 路径中替换。

   从 Infisical 导出 owner ID，供应用读取：

   ```sh
   # 先用只读 Machine Identity 登录 Infisical CLI；参数按项目和 CLI 版本调整。
   infisical secrets get TELEGRAM_OWNER_ID --plain > deploy/agent-vault/private/telegram-owner-id
   chmod 644 deploy/agent-vault/private/telegram-owner-id
   ```

   该文件必须在 `up` 前存在，Compose secret 的源文件缺失会阻止启动。应用以 uid 1000 读取；file secret 是 bind mount，不能靠 Compose 的 `mode` 改权限，所以用 `644`。文件只含数字 owner ID，`private/` 目录保持 `700`。在 Infisical 修改 owner ID 后重新导出并重启应用；应用进程不持有 Infisical 身份。若导出工具用重命名方式替换文件，重启后仍可能看到旧 inode，此时用 `docker compose -f docker-compose.agent-vault.yml up -d --force-recreate personal-agent` 重新挂载。
9. 先停原 bot，保持整个持久化卷；再启动新部署。生产配置不构建镜像，先按 [部署运行手册](deployment-test-guide.md#3-构建与分发镜像) 在构建机产出并分发：

   ```sh
   docker compose -f docker-compose.agent-vault.yml config --quiet
   docker compose -f docker-compose.agent-vault.yml up -d --no-build
   docker compose -f docker-compose.agent-vault.yml stop personal-agent
   docker compose -f docker-compose.agent-vault.yml run --rm --no-deps personal-agent node dist/src/mcp-check.js
   docker compose -f docker-compose.agent-vault.yml start personal-agent
   ```

   只有本地开发才叠加 `docker-compose.agent-vault.build.yml` 后 `build`。多 vault 时在每条命令追加 `-f docker-compose.router.yml`，并先用 `aster-router:local check -config /etc/aster-router/config.json`（挂载 `private/router`）验证配置。

   默认规则不会允许 npm registry，所以 stdio MCP 应预装在镜像中，不能依赖运行时 `npx` 下载；若要下载，需要单独授权且计入供应链管理。

现有 OAuth 授权文件可继续使用。首次授权在可信运维环境中按 README 的 `mcp:auth` 流程执行；停止 bot 后安全迁移授权文件并保持应用 uid 1000 的文件权限。隔离容器不发布 OAuth loopback 回调端口，不能直接套用容器外 SSH 转发并假设回调可达。刷新和日常 MCP 请求可通过 passthrough 规则完成；要允许实际发现的认证端点，避免用宽泛通配符。

## 网络与数据边界

`tool-network` 在应用启动前设置 raw OUTPUT 规则：uid 1000 只允许 TCP 到固定 broker IP `172.30.82.2:14322` 与精确 loopback，拒绝其他 IPv4/IPv6/UDP 流量。这些地址与端口来自[部署环境描述](deployment-environments.md)，不是 `network.sh` 内的常量。规则在 Docker DNS DNAT 前匹配，不允许 `127.0.0.11` DNS 出网；应用通过代理让 broker 解析上游域名。应用容器固定 uid 1000，移除全部 capabilities、禁止提权、只读根文件系统，不共享 Docker socket。Vault 管理端口不能从应用网络直接访问。

叠加 `docker-compose.router.yml` 时，`tool-network` 收到 `ROUTER_ENABLED=1`：uid 1000 的应用不再允许直连 broker，只能访问精确 loopback；uid 1001 的路由器才允许访问 `172.30.82.2:14322` 与 loopback。路由器与应用共享同一网络命名空间，因此 `127.0.0.1:14323` 对应用可达，而路由器不发布任何宿主端口。没有这一覆盖时，应用直接使用 broker 的 proxy 身份。

固定子网与已有网络冲突时，不要逐个文件改 IP：项目名、卷、网络名／网段、broker 地址与管理端口由[部署环境描述](deployment-environments.md)统一给出，`network.sh`、router 上游和 Compose 都从同一组值派生。改描述后用 `npm run deployment:environment -- render` 与 `router` 核对，只改其中一处会阻断服务。不要手动给应用附加另一张网络、改变 uid 或开放 capabilities。防火墙容器配置变动/退出后，停止并重建整个应用、路由器和网络命名空间，不能只重启网络容器并保留旧应用。

loopback 允许应用与可信本地 MCP 通信，不能在该命名空间增加允许转发出网的特权进程。Vault 的 netguard 不应允许 broker 自己的管理端口、宿主内网或云 metadata 地址。`deny` 模式只限制目标 host/path/port，不提供 HTTP method 或业务级权限控制；目标接口若会回显认证值、导出或创建新 token，需要禁用相应路径或增加可信响应适配。

应用内存限制 1 GiB，Vault 512 MiB，网络容器 32 MiB，路由器 128 MiB，其他资源留给系统。实际并发与内存仍需在 4 GB 目标机测量。Vault 数据卷 `personal-agent-vault-data` 保存加密快照、CA 私钥与其他状态；应用只挂载原 `personal-agent-data`。同机容器不能抵御宿主 root 或内核逃逸；需要更强边界时把 broker 放到独立主机。

## 轮换、失败与验收

- 修改 Infisical 后按轮询周期传播；需要立即更新时由运维手动 sync。不要将每个代理请求描述为实时读取 Infisical。模型 API key 轮换后应用无需重启，因为请求只携带占位值。
- owner ID 不经过代理，修改 Infisical 后必须重新导出 `private/telegram-owner-id` 并重启应用；它不会随 Vault 轮询自动更新。
- 原生 Agent Vault 同步失败会继续用最后一次缓存，没有自动最大缓存年龄限制。本版保留该行为；监控同步失败并由运维阻断/吊销，**尚未实现规划中的五分钟超时关断**。紧急撤销应在目标服务吊销凭证并停用 Vault 服务/代理身份。
- 代理不可用、CA 不可信、服务未授权或 key 缺失时请求失败。应用不回退真实环境变量或直连；外部写操作超时结果未知时仍按原 durable 契约处理。
- 本地测试覆盖引用不解析真实 secret、代理配置拒绝、stdio 环境传递以及真实 TLS CONNECT 下 Node fetch/grammY 的代理路径。TLS 测试需要 `openssl` 可执行文件，用临时自签证书，不访问外网。
- 上线前必须用测试 token/password 验证：Infisical 同步、Bearer/API-key/Basic 注入、轮换、目标拒绝、直接 IP/忽略代理/UDP/Docker DNS 无法出网、管理端口不可达、OAuth 刷新、取消和持久化恢复。检查工具结果和日志没有测试秘密。
- 迁移成功后吊销应用旧工具 key，按保留策略清理原 env、容器配置与备份。保留 durable 数据与 OAuth 动态注册状态，不能删除整个数据卷。

详细原始规划及上游来源见 [接入计划](agent-vault-integration-plan.md)。其中 OAuth 全量迁移、缓存新鲜度关断是后续工作，以本文件的已实现范围为准。

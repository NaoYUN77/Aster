# Infisical Agent Vault 接入计划

状态：原始规划，部分已实施。调研日期：2026-10-23。

实施范围调整：用户确认优先管理工具 token、用户名和密码；MCP 外部 OAuth 保留现有授权流程。本文件后续的全量 OAuth 迁移及缓存超时关断仍是后续方案，不是当前功能。已实现配置、部署和验证边界见 [Agent Vault 运行说明](agent-vault.md)。

## 1. 目标与结论

用户要求：任何 tool 的任何凭证都经过开源 Agent Vault，Agent Vault 与 Infisical Secret Management 连通。

采用 **Infisical Secret Management 作为业务凭证权威来源，开源 Agent Vault 作为工具调用的强制认证出口**。工具使用稳定占位值或不带认证的请求，由代理在发送到已授权目标时注入真实凭证。应用不提供 `getSecret()` 工具，也不把真实凭证下载到主进程或子进程环境。

这既包括自定义工具、HTTP MCP，也包括 stdio MCP 后续发出的 HTTP 请求，以及 CodingTools 中 bash 启动的 CLI。stdio 本身是本地进程通信，Agent Vault 代理的是该进程的外部 HTTP 流量。

无凭证工具仍可使用；需要凭证但无法通过代理认证的工具，在适配完成前明确不可用。不能以环境变量、凭证文件、直连或本地 OAuth 缓存作为降级通道。

模型 API key 和 Telegram bot token 虽然属于宿主基础设施，也建议一并代理，避免通用工具从同进程环境或文件读取它们。Infisical 的机器身份、Vault 主密码和代理身份是启动信任根，须单独保护，不能通过自身递归获取。

## 2. 已核实的上游能力与限制

| 事项 | 核实结果 | 对方案的影响 |
| --- | --- | --- |
| 产品区分 | `Infisical/agent-vault` 是独立开源项目；Infisical 平台内另有商业 Agent Vault | 本计划采用独立开源版，不假设商业版的 access bundle/session API 可直接使用 |
| 许可证与成熟度 | 仓库说明主体 MIT，`ee` 目录例外；仍标记 Preview，API 可能变化 | 锁定发布包、校验来源，升级时重新验收代理契约 |
| Infisical 连接 | 原生支持 Infisical credential store；一个 vault 对应一个 store，按 project/environment/path 读取 | 不另建应用内 secret 同步器 |
| 静态秘密 | 定期同步为 Vault 本地加密快照，代理在请求时解密注入 | Secret Management 是权威来源，但并非每个请求实时远程取密钥 |
| 默认同步周期 | 文档默认 60 秒，可配置并支持手工 sync | 轮换有传播窗口，不能承诺撤销立即生效 |
| 上游故障 | 继续使用最后一次快照，没有自动过期拒绝机制；去掉 `INFISICAL_URL` 后也可能无限使用旧缓存 | 必须制定缓存新鲜度策略及独立监控/关断机制 |
| 认证注入 | Bearer、Basic、API-key、自定义 headers；可按配置替换 path/query/header/body/websocket 占位值 | 普通 API、HTTP MCP 与部分 CLI 可复用 |
| 规则匹配 | host、port、path glob；不按 HTTP method、header、query、body 匹配；未匹配默认转发 | 显式设置 `unmatched_host_policy=deny`；不能拿服务匹配代替业务写权限控制 |
| 角色 | `proxy` 不能读取秘密；member/admin 可以通过管理接口读取 | 工作负载只能拿 proxy 权限，不授予 member/admin |
| OAuth | 原生 OAuth 的登录和 token 导入接口要求 built-in store | Infisical-backed vault 不能直接组合原生 OAuth 自动刷新；见第 6 节 |
| 协议边界 | HTTP/HTTPS 代理，另有特定 WebSocket 替换能力 | 不等于原生数据库、SSH、客户端签名或任意 mTLS 的通用凭证代理 |

本次 GitHub API 查询中，latest 为 `v0.40.1`，但 release assets 为空；`v0.40.0` 有 Linux/macOS 发布包及校验文件。实施时以有可验证制品且通过验证的精确版本为准，容器镜像另核实 digest，禁止直接采用 `latest`。本文源码结论取自 `v0.40.1`；若选择其他版本，须复核对应 tag，不能把在线文档当成已安装版本保证。

## 3. 目标调用链与部署边界

调用链：工具/SDK 发起含占位值的请求 → 受控网络出口 → Agent Vault 校验身份及服务规则 → 注入从 Infisical 同步的秘密 → 目标 API。

管理链：运维配置 Infisical 中的秘密和权限 → Vault 使用只读 Machine Identity 同步 → 运维配置目标服务的认证规则。模型不能自行批准服务规则，也不能修改 credential store。

### 3.1 与当前 4 核 / 4 GB 基线兼容的部署

- 使用 `https://app.infisical.com` 的 Secret Management；不在现有小服务器上新增完整自托管 Infisical 服务集群。
- 单实例 Agent Vault 优先验证其 SQLite 模式，持久化目录与应用数据分开；先测资源占用和恢复行为，再决定是否需要额外数据库。不先引入 PostgreSQL 或 Kubernetes。
- 在单服务器约束下，拟将应用/工具和 Vault 分置独立容器与网络，Vault 不向工具挂载数据目录、主密码、Infisical 身份或管理凭证。应用容器无 Docker socket、宿主目录、特权模式及网络管理能力。
- 应用/工具出口在容器网络或宿主防火墙上强制只能到代理，以及严格枚举的必要基础设施。覆盖 IPv4/IPv6、直接 IP、UDP/QUIC、额外网络接口；DNS 也受控，不能提供任意 DNS 外传通道。
- 官方推荐 Vault 与 agent 使用不同主机。同机隔离只能作为本项目资源约束下的部署取舍，不能声称可抵御宿主 root 或内核逃逸；需要这一保证时迁到独立 Vault 主机。
- 当前直接运行于宿主的 systemd 方案，需要改为管理受限容器，或提供经过等价验收的独立用户、挂载/网络命名空间隔离。仅增加 `HTTPS_PROXY` 不构成强制模式。

代理端口默认 14322，管理端口默认 14321。管理接口仅运维网络可达；若 CLI 启动需要 CA/会话等管理 API，由可信启动组件提供，或只开放必需路径，不能为了启动方便放开全部管理面。跨主机连接采用受保护私网或 TLS 隧道，不能在公网明文传递代理身份。

### 3.2 身份与权限颗粒度

初期按环境和可信工作负载建立 vault，Infisical 划分 `dev` / `prod` 及对应路径，例如 `/personal-agent/tools`。key 使用 UPPER_SNAKE_CASE，非法 key 会使整次同步失败。

同一个进程/容器持有的代理身份可使用其所有已授权服务。因此，一个共享 vault 只提供工作负载级权限，不能宣称自动实现 tool 级隔离。需要工具之间互不使用凭证时，必须把工具/MCP server 分到独立执行身份与网络边界，并授予各自 vault 的 proxy 权限。

如果同一 API host/path 对应多个外部账号，同一 vault 的 host/path 匹配不足以按会话选择账号。以独立 vault 和代理身份隔离；不能让模型通过任意 header 选择真实账号。

## 4. 本仓库具体改造点

| 文件/入口 | 当前情况 | 计划改造 |
| --- | --- | --- |
| `src/tools.ts` | 注册 CodingTools 和 `current_time` | 保留底座工具契约；新网络工具依赖宿主提供的受控客户端。禁止模型参数携带 secret 或任意凭证选择信息 |
| `src/agent.ts` | `NodeExecutionEnv` 只有 cwd；cwd 不是沙箱 | 将执行环境置于隔离边界内；沿用 pi-durable agent loop 和恢复，不另造执行调度框架 |
| 底座 CodingTools | bash 继承环境，文件工具允许绝对路径 | 通过部署/执行环境限制能继承和能读取的内容，不直接修改 node_modules；不能仅靠提示词防止读取秘密 |
| `src/mcp-config.ts` | headers、args、env 支持字面量和 `${ENV}`；OAuth 有 clientSecret | 定义 brokered 配置模式：只保存非秘密元数据及受控占位值。拒绝 URL userinfo、认证 query 明文、认证 headers 明文、secret args、全量环境继承和旧 OAuth 模式 |
| `src/mcp.ts` | HTTP 传 headers，stdio 启子进程，本地 OAuth provider/store | HTTP transport 使用代理；stdio 使用最小非敏感环境、占位值、代理与 CA 配置。校验每种实际网络库是否使用代理；旧 FileOAuthStateStore 不可进入强制模式 |
| `src/mcp-auth.ts` | 交互登录并保存/复用本地状态 | 改为受信管理面的授权入口或授权指引；禁止把 token 交回运行 agent 的主机 |
| `src/mcp-check.ts` | 复用正式 MCP 连接，可能刷新 OAuth | 使用正式 brokered 路径，输出服务可达性和安全错误，不能另开本地凭证路径 |
| `src/config.ts`、`src/providers.ts` | 从环境检查/解析模型 API key | 仍以 provider 注册表为权威，改用占位值/代理，逐个实际启用的 SDK 验证；不为此放宽提供商注册条件 |
| `src/telegram.ts` | grammY 持有 bot token | 验证合法格式的占位 token，通过 path substitution 覆盖 Bot API 与文件下载 URL；禁止把真实 token 带回主进程 |
| `src/check-config.ts` | 离线配置校验 | 保留离线职责；新增明确的在线代理/权限检查，不隐式访问远端 |
| Docker / systemd / 安装脚本 | `.env`、EnvironmentFile、容器全局环境注入 | 环境文件只保留非敏感配置、占位值和受控代理启动材料；分离 Vault 数据、CA 私钥与应用卷，固定制品版本 |

`inheritEnv: false` 的 stdio 子进程也要显式获得必要代理/CA 配置；不应为了传代理变量重新启用全量继承。仅把 `HTTPS_PROXY` 写到 Node 启动后的 `process.env` 也不足以证明所有 SDK 生效。以项目 Node 24.19.0、已安装 pi 1.3.0、grammY 和实际 MCP 传输做端到端验证；必要时使用相应网络库的 dispatcher/agent 配置。

部署网络限制是强制保证，配置校验是前置诊断。校验不能靠猜测任意字符串是不是 secret；应采用明确的认证配置形状、固定服务策略和允许列表，并防止被调用服务的工具参数再次接收真实密钥。

## 5. Infisical 原生连通配置

拟使用 Universal Auth Machine Identity，授予指定 project/environment/path 的只读权限。以下变量仅出现在 Vault 的可信部署环境：

```text
INFISICAL_URL=https://app.infisical.com
INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=<machine-identity-client-id>
INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=<bootstrap-secret>
```

在运维侧创建 Infisical-backed vault，映射项目 ID、环境、路径和轮询周期。所有业务 key 在 Infisical 中管理，Vault 只同步，不人工维护第二份可写秘密。凭证绑定规则进入版本控制，但只包含 key 名、目标服务和注入方式，不含值。

Vault 主密码和 Infisical bootstrap secret 由服务管理器/部署凭证机制提供；CA 私钥仅保存在 Vault 侧。工具只信任只读 CA 公钥。工作负载代理 token 也是可用权限，必须最小授权、可撤销，不能当作无敏感性的普通配置。

## 6. OAuth 必须单列实施

已核实 `v0.40.1/internal/server/handle_oauth.go` 中 `handleOAuthConnect` 和 `handleOAuthTokenUpload` 都调用 `assertBuiltinCredentialStore`。原生 Infisical store 的同步逻辑只是读取静态 secret 并填充加密快照，不能据此推断它会导入 OAuth 元数据、刷新或回写旋转后的 refresh token。

以“所有业务凭证均在 Secret Management 管理”为目标，建议分两步：

1. **第一阶段**：支持静态 key/PAT、Bearer、Basic、自定义 header 等可代理工具；需要用户 OAuth 的 MCP 在强制模式下明确禁用，不保留旧本地登录作为例外。此阶段是可交付子集，不能标记为全部工具迁移完成。
2. **OAuth 阶段**：先选择实际需要的一家 MCP/provider，验证 Infisical 是否已有适用的原生 token 生命周期能力。若无，再在可信 Vault/管理边界实现专用 OAuth 管理组件：登录、PKCE、token 交换及刷新在此执行，将访问 token、refresh token、expiry 以明确契约保存到 Infisical，Agent Vault 同步访问 token 并注入。该组件使用独立且范围最小的写身份，不能扩大全局只读同步身份的权限。

OAuth 管理组件需要单写者/租约、提前刷新、同步传播余量、`invalid_grant` 终态、旋转 refresh token 写入失败的恢复，以及管理操作与 bot 并发控制。提供商返回新 refresh token 和保存到 Infisical 不是跨系统事务；保存结果未知时必须进入待恢复/重新授权状态，不能盲目重复使用旧 token。

MCP 的 protected-resource discovery、audience/resource、动态客户端注册与服务端挑战需逐一验证。不能仅凭“支持 OAuth 2.0”承诺兼容所有 MCP。

如果只要求“经过 Vault”，而允许 OAuth 凭证独立存于 Vault built-in store，原生 OAuth 路径会更简单；但它改变了统一 Secret Management 的目标，本计划不默认采用这一例外。

## 7. 轮换、故障与 durable 恢复

- 初始策略建议：静态秘密 60 秒轮询，允许最多 5 分钟距最后成功同步的窗口；这两个数是拟采用值，不是上游实时性保证。超窗阻断相应受保护流量并报警，恢复同步成功后再开放。
- 开源版没有上述过期关断能力，需在可信代理/网络出口实现监控与关断，不能只让应用在每次调用前自查，否则 bash/stdio 可跳过。独立守护状态应失败关闭，防止监控自身宕机后无限开放。
- 特别注意：已核实上游同步失败也会更新 `last_synced_at` 用于退避。不能直接以该字段计算最后成功时间。需追踪明确的成功事件/时间，或给上游增加独立成功时间与 max-staleness 契约；重启时无法证明缓存新鲜即拒绝。
- 紧急撤销优先在目标服务吊销真实凭证，并撤销 Vault 代理身份/服务权限；不能只等待同步或删除本地环境变量。
- Vault 不可达、凭证缺失、服务未授权、CA 不可信时停止调用，不能直连或回退 `.env`。
- durable 只保存业务参数、稳定服务引用及业务状态，不保存 secret、代理 token、真实认证 URL、PKCE verifier 或认证 headers。重新实际执行时重新经过代理权限判断。
- MCP 继续保留 `replay: unsafe`；业务写请求发生网络超时不能因重新取到凭证而重放。结果未知仍然是未知，投递重试不能重新执行业务。
- 错误映射区分配置错误、权限拒绝、代理暂时不可用、上游业务失败和结果未知。保留请求标识用于关联，但不把认证信息写入错误字符串。

## 8. 实施顺序与完成门槛

| 阶段 | 工作 | 完成条件 |
| --- | --- | --- |
| P0：兼容性验证 | 固定可验证发布制品；测试 Infisical store、真实网络库代理行为、CA、一个 HTTP MCP、一个 stdio MCP、模型流式调用与 Telegram | 有版本对应的验收证据、资源测量和支持矩阵；明确无法代理的工具 |
| P1：基础设施 | 配置 Infisical 权限、Vault、服务规则、proxy 身份、独立持久化、隔离与出口限制 | 宿主业务密钥不进入工具环境；直接 IP/忽略代理的程序无法绕过；管理面与 CA 私钥不可达 |
| P2：应用接入 | 配置契约、MCP/CLI/startup 路径、受控网络客户端、诊断与错误分类 | 已支持的所有工具只通过代理认证；旧明文/本地 OAuth 配置明确报错 |
| P3：生命周期与 OAuth | 缓存新鲜度关断、轮换、可信 OAuth 管理、MCP provider 兼容验证 | OAuth token 不到应用主机；并发刷新、吊销、同步延迟和重启恢复满足契约 |
| P4：迁移切换 | 清点实际启用工具和历史凭证位置、演练、迁移、撤销旧凭证、更新文档 | 所有启用的需认证工具通过强制模式验收；不支持的工具有明确禁用记录 |

迁移时先暂停接收新的执行，收敛/处理未完成工具调用，保留稳定工具名和参数兼容性；完成 canary 验证再恢复服务。先吊销旧凭证，再按保留要求清理 `.env`、OAuth 文件、旧容器环境、历史备份和可能污染的 SQLite/WAL。不得为了清理秘密直接丢弃整个 durable 状态库。

回滚采用停止受影响工具或回滚到仍然遵守代理策略的版本，不自动恢复明文凭证路径。旧凭证被吊销后，历史版本也不能不加检查地直接重启。

实施后更新 README、部署说明和 `docs/contracts-and-lifecycle.md` 的对应权威定义。本文件只记录本功能计划；长期通用规则和已安装技术基线才进入 CLAUDE.md。

## 9. 验收清单

使用专门生成的测试凭证与受控目标服务，不输出生产密钥。

- 代理能在正确目标注入预期测试凭证；工具参数、成功结果、流式输出、错误、durable SQLite、inbox、工作目录和日志不出现该测试秘密。
- 测试目标主动回显认证值，验证哪些响应会泄露；不把“代理注入”误认为通用响应脱敏。对于可回显/创建/导出凭证的接口，禁用该路径或增加可信响应适配；无法安全处理则不开放工具。
- 未批准 host/path/port、重定向目标、云 metadata 地址、直接 IP 和忽略代理的客户端均不能获得或绕过受控凭证。
- proxy 角色不能读取 credential、修改服务或批准提案；工具读不到 Vault 数据/管理凭证/Infisical 身份；工作目录路径跳转也不能跨越挂载边界。
- API key、Basic、header、query/path 注入分别验证；Telegram Bot API、文件下载及模型 streaming 的真实客户端通过测试。
- HTTP MCP、stdio MCP 的连接、会话保持、流式响应、取消、超时及重连不因代理损坏；任何需要凭证的 CLI 必须列入支持矩阵。
- Infisical 轮换后新值在规定窗口生效；同步失败、服务重启和监督进程故障不会无限使用旧缓存。
- OAuth access/refresh token 轮换、并发授权/刷新、`invalid_grant`、写入失败、跨同步窗口和重启均有明确结果。
- 中断恢复不持久化认证材料，不把鉴权失败当作可重放业务写请求的理由；重复投递不触发新业务调用。
- 单机资源基线下测试进程 RSS、代理并发、长连接、缓存和日志增长，定义应用与代理的内存、并发、body size、超时及日志保留上限。

## 10. 来源与证据范围

本计划完成了官方资料与源码核实，没有登录用户的 Infisical 项目、读取真实秘密、部署服务或运行端到端验证。

- [开源仓库与产品区分](https://github.com/Infisical/agent-vault)
- [发布记录](https://github.com/Infisical/agent-vault/releases)
- [Infisical credential store、同步与故障语义](https://docs.agent-vault.dev/learn/credential-stores)
- [Vault 连接 Infisical 的环境配置](https://docs.agent-vault.dev/self-hosting/environment-variables)
- [服务匹配与凭证注入](https://docs.agent-vault.dev/learn/services)
- [凭证角色与 OAuth](https://docs.agent-vault.dev/learn/credentials)
- [安全模型与网络边界](https://docs.agent-vault.dev/learn/security)
- [自定义应用接入](https://docs.agent-vault.dev/quickstart/custom-agent)
- [v0.40.1 OAuth handler：built-in store 限制](https://github.com/Infisical/agent-vault/blob/v0.40.1/internal/server/handle_oauth.go)
- [v0.40.1 Infisical sync：静态同步与失败时间更新](https://github.com/Infisical/agent-vault/blob/v0.40.1/internal/infisical/sync.go)

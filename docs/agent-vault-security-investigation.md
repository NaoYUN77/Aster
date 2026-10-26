# Agent Vault 0.40.0 密钥边界与 CD 准入调查

日期：2026-10-26。调查与补充实验跨 2026-10-26／2026-10-27。

## 结论与证据级别

**当前不能依据“密钥由 Infisical 保存并由代理注入”就批准无人值守 CD。** Agent Vault 本身会接收明文密钥、在请求时解密并向目标发送，因此它、数据卷、主密码、管理员以及获准接收凭据的目标服务都在信任边界内。[取密与加密流程][av-client]、[请求时解密][av-provider]可以证实这一设计；不能将其解释成 broker 永远接触不到秘密。

本次对本地实际镜像做了断网实验：HTTPS mock Infisical 接受虚构机器身份并返回合成秘密，再通过代理访问本地测试目标。确认四项直接影响准入的行为；输入、结果和限制见本文运行实验记录。

| 发现 | 对“秘密不进入应用／日志”的影响 | 证据状态 |
| --- | --- | --- |
| 上游登录跟随跨域 307 并重发 client secret | 初始 Infisical URL 即使为 HTTPS，若受信上游返回跳转，Universal Auth POST 正文仍可发到另一主机；机器身份秘密会离开配置的 origin | [SDK 登录][sdk-login]、[HTTP redirect 语义][go-http]；实际镜像实验 R12 接收端确认正文含合成 client secret |
| 上游取密失败的错误内容进入 WARN 日志 | SDK 对 HTTP 422 保留整个响应正文，Vault 原样记录 SDK 错误；上游若回显秘密，默认 info 等级也会留下该秘密。对调用者返回的 502 已脱敏，不代表容器日志已脱敏 | [SDK 错误正文][sdk-util]、[错误格式][sdk-error]、[同步日志][av-sync]；实际镜像实验 R08 两条 WARN 含错误标记值 |
| `host:443` 服务规则没有强制 TLS | 普通 `http://host:443/...` 请求也可进入同一凭据注入路径，端口号不能证明链路加密 | [明文代理入口][av-forward-entry]、[scheme 选择与注入][av-forward-inject]；实际镜像实验 R03 向明文 HTTP 注入了合成密钥 |
| 目标响应没有全面秘密过滤 | 已获准的目标若在响应头或正文回显认证值，应用可得到真实密钥；只约束请求出口不足以保证应用永远看不到真实值 | [响应头转发与正文复制][av-forward-response]；实际镜像实验 R03／R04 的回显响应含注入 key |

这些结果并不证明正常 Infisical Cloud 会主动回显秘密，也不能据此认定所有目标 API 都会泄露认证值；它们否定的是“不论上游错误或目标行为如何，broker 都会阻止秘密进入日志与应用”的强保证。本文没有完成镜像与源码的密码学对应验证，也没有以“没搜到外传代码”作安全背书。

## 调查范围与版本锚点

本次仅开展授权防御性调查：读取官方源码、官方发布元数据与仓库内公开部署文件；不读取 `private/` 或实际 env，不接触生产秘密，不修改远端，不运行下载目录内的解释器、构建或第三方脚本。下载目录为 `C:\Users\l\AppData\Local\Temp\aster-vault-audit.IZ7y5t\source`，作为不可信静态输入处理。

- 官方 `v0.40.0` tag 查询结果指向 commit `872578e4cdf9e03d5e3bcb5512023a70bf90ed65`，下列 Agent Vault 源码链接固定到该 commit；官方 release 发布于 2026-10-01。[tag API][av-tag]、[固定 commit][av-commit]、[v0.40.0 release][av-release]
- 该版本固定 `github.com/infisical/go-sdk v0.8.0`、`github.com/posthog/posthog-go v1.24.4`，传递 HTTP 库为 `github.com/go-resty/resty/v2 v2.13.1`。[依赖清单][av-mod] SDK `v0.8.0` tag 查询结果为 commit `4ed5667bdf11d36643da4fd9cd05c660e30e24dd`，SDK 链接固定到该 commit。[SDK tag API][sdk-tag]
- `docker image inspect` 确认本地镜像为 Linux amd64，RepoDigest 为 `infisical/agent-vault@sha256:4d490e2586c553ea121fa404b66812ad40c246cc841b0cc746682d0a360bdf1e`，无 labels。镜像内 `agent-vault version` 输出 `0.40.0`、commit `872578e`、Go `1.25.0`；这些自报信息与官方发布日志一致，独立验签仍未完成。详见发布链章节。[固定发布 workflow][av-release-workflow]、[该次官方发布任务][av-release-job]
- 本次静态范围为 Universal Auth、静态取密、TLS／路径与身份边界、本地缓存、遥测与错误日志、镜像构建发布链。运行实验覆盖代理响应、请求审计、管理接口授权、取密 TLS／跨域重定向及项目 router 的 CONNECT 限制。动态秘密仅说明与静态密钥不同的保存方式，不审计所有租约、数据库或 OAuth 流程。

## Universal Auth、取密与 TLS

### 认证与取密请求

Universal Auth 的 client ID 和 client secret 同时存在时，该方法在自动检测中优先；Vault 将空参数交给 SDK，SDK 从对应环境变量取值。[认证选择][av-auth]、[SDK 调用][av-client]、[SDK 登录][sdk-auth]

SDK 发送 JSON body 中的 `clientId`／`clientSecret`，向 `INFISICAL_URL` 加上 `/api` 后请求 `POST /api/v1/auth/universal-auth/login`。登录请求先清除 HTTP client 的 bearer token；成功后的 access token 和原始 Universal Auth 凭据保存在 SDK 对象中，后续 client 使用 `Authorization: Bearer ...`。Vault 显式开启自动 token refresh。[SDK endpoint 拼接][sdk-util]、[登录请求][sdk-login]、[登录及凭据保留][sdk-auth]、[token 保存与 bearer 设置][sdk-client]、[Vault client 初始化][av-client]

静态取密调用 `GET /api/v3/secrets/raw`，query 包括 `workspaceId`、`environment`、`secretPath`、`expandSecretReferences=true`、`include_imports=false`、`recursive=false`。Vault 不设置后二者，SDK 请求模型的 bool 零值及 query 构造确定了实际值；`AttachToProcessEnv=false`，因此该调用不会将返回的秘密批量写进 broker 进程环境变量。[Vault 取密选项][av-client]、[SDK 参数模型][sdk-secret-model]、[SDK 请求][sdk-list]、[SDK env／imports 分支][sdk-secrets]

一个 vault 的配置是 project／environment／secret path，而不是逐个 key allowlist；同步循环加密所有返回项。`recursive=false`、`include_imports=false` 限制直接列举，但 `ExpandSecretReferences=true` 仍请求上游展开值中的引用，不能仅据“不递归子目录”推断引用内容也在同一权限边界内。[配置校验][av-config]、[取密][av-client]、[全量快照加密][av-sync] **跨路径引用的实际授权与展开结果需要用最小权限测试身份验证，本文未向真实 Infisical 执行该验证。**

broker 使用一个实例级 SDK client；外部 vault 的建立与连接只有 owner 能使用该 client 探测和拉取，源码注释明确说明这是为了防止 member 借用 broker 身份拉取其他上游秘密。配置校验只检查字段必填和 path 前缀 `/`，不会在本地替代 Infisical 项目／环境／路径授权。[外部 vault 创建][av-vault-create]、[连接及探测][av-vault-connect]、[配置校验][av-config] 因此 CD 必须在 Infisical 一侧限制机器身份权限，不能只限制 UI 中填写的路径。

### TLS 的实际保证与缺口

在配置为 `https://...` 时，这条 SDK 路径使用 Resty 的标准 Go HTTP transport；Vault 没有为 Infisical 设置 `InsecureSkipVerify`，SDK 自定义 CA 分支也只设置 `RootCAs`。Go 的默认 TLS 语义会验证证书链与主机名，空 RootCAs 使用系统根证书，发布运行镜像安装 `ca-certificates`。[SDK transport 配置][sdk-client]、[Resty transport][resty-transport]、[Go TLS 语义][go-tls]、[发布运行镜像][av-runtime-image] 本次未连接真实 Infisical 验证其 TLS 握手；实际镜像连接正确 CA 的 HTTPS mock 可成功同步。不挂对应 CA 时登录报 `x509: certificate signed by unknown authority`，取密 GET 未到达。另一个实例将 `INFISICAL_URL` 设为本地 HTTP mock 后仍登录成功并发出取密 GET，证明该版本不会强制 HTTPS。这些是断网环境中的合成实验，详见 R01／R09／R10。

**Vault 没有要求 `INFISICAL_URL` 必须是 HTTPS，也没有对该 SDK client 配置禁止重定向／限定目标 origin。** 它直接把非空 env 传给 SDK，SDK 的 URL helper 只拼接 `/api`；Resty client 默认沿用 Go 的 redirect 行为。[Vault 初始化][av-client]、[SDK 配置][sdk-client]、[URL helper][sdk-util]、[Resty 构造][resty-create]、[Go HTTP redirect 语义][go-http]

实际镜像实验 R12 已确认跨主机 307：`https://infisical.audit.test:18889/api/v1/auth/universal-auth/login` 返回 `Location: https://attacker.audit.test:18890/...` 后，接收端拿到了含合成 `clientSecret` 的 POST 正文。两个测试站点均持有本次实验 CA 信任的有效证书，未关闭 TLS 验证；因此缺口是 origin／redirect 约束，不能归因于接受坏证书。实验没有验证真实 Infisical Cloud 会发出这种跳转，也不证明第三方在未控制上游的情况下可以触发它。

Go 对 307／308 可保留 POST 方法与 body，Resty 为 body 提供 `GetBody`；Universal Auth secret 在 body 中，所以跨目标重定向不能仅靠敏感 header 过滤来保护。源码还允许同域或子域复制 `Authorization`，且没有“必须同 scheme／同 port”的约束。[Go HTTP redirect 与 header][go-http]、[Go 方法与 body 规则][go-http-body]、[Resty body 重放][resty-body]、[Universal Auth POST][sdk-login] HTTP 降级跳转、308、同域／子域 bearer 转发尚未单独实测，不把 R12 结果扩大到这些变体。

此外 SDK transport 使用 `http.ProxyFromEnvironment`，部署时的 proxy 环境与 CA 信任也属于取密链路的信任配置。[Resty transport][resty-transport] 这与 Agent Vault 对应用请求的 MITM 代理属于两条不同路径；对应用代理做 HTTPS 实验不能代替取密 client 的 TLS／重定向验证。

对于应用到目标的代理路径，源码显式接受 absolute-form 的 `http://` 转发，传入 `useTLSUpstream=false`；随后以相同 host／port／path 调用凭据注入。[明文入口][av-forward-entry]、[注入路径][av-forward-inject] 实验 R03 中 `http://upstream.audit.test:443/echo` 实际得到注入，证明“服务规则显式写 :443”不能充当强制 TLS。CD 的修复或外围控制必须约束协议本身，仅限制 TCP 443 不满足此条件。上游自己的[普通 HTTP 凭据注入测试][av-plain-http-test]也明确验证该行为，它属于现有能力而非传输异常。

## 本地缓存、持久化与撤销

SDK 层 `CacheExpiryInSeconds=0` 关闭自身 secret cache；Agent Vault syncer 另行持有落库流程，默认每 vault 60 秒、最低 10 秒轮询，以 10 秒 tick 检查是否到期。[初始化及取密][av-client]、[轮询配置][av-config]、[syncer][av-sync] 因此“SDK cache 关闭”不等于“密钥不落磁盘”。

每次成功拉取后，Vault 使用随机 nonce 的 AES-GCM 加密每个 secret value，并在事务内替换该 vault 的静态 credentials。数据库保存 key 名、ciphertext、nonce；project／environment／path 等配置也单独保存。key 名和路径元数据不在这一 value 加密范围内。[快照加密][av-sync]、[AES-GCM 实现][av-crypto]、[存储事务][av-sql-sync]、[连接快照存储][av-sql-connect]

默认 SQLite 路径为 `~/.agent-vault/agent-vault.db`，发布镜像设置 `HOME=/data` 并声明 `/data` 卷。源码创建目录时使用 `0700`，创建数据库时临时设 `umask 0077`，并对数据库文件执行 `chmod 0600`。[默认数据库路径][av-db-path]、[SQLite 打开][av-db-open]、[发布镜像][av-runtime-image] 文件权限是该运行环境中的保护措施，不能取代卷和备份访问控制。

使用主密码建立的新实例会生成随机 32 字节 DEK，用 Argon2id 从主密码派生 KEK，再包装 DEK；默认参数为 time=3、memory=64 MiB、threads=4、keylen=32、saltlen=16。运行时 DEK 和解密后的密钥仍会出现在 broker 内存中，SDK 也保留 Universal Auth 凭据和 access token。[主密钥创建／解锁][av-master]、[KDF 参数][av-kdf]、[请求时解密][av-provider]、[SDK 凭据保留][sdk-auth]

**旧无密码实例是准入检查的特殊边界。** 源码提供 passwordless 模式，会把 DEK 明文保存；`unlockOrSetupWithPassword` 在已有 `DEKPlaintext` 时忽略新提供的密码，仍按 passwordless 解锁。因此只检查 `AGENT_VAULT_MASTER_PASSWORD` 非空不足以证明现存卷中的 DEK 已被密码包装。需要确认实例状态或通过上游主密码管理流程完成迁移。[无密码 DEK][av-master]、[启动忽略密码分支][av-startup-password]

同步失败只更新健康状态，保留原 credentials；失败时还更新 `last_synced_at` 用作重试退避。因此该时间在 error 状态下并不代表“最后成功获得秘密”的时间。代理从 credentials 表读取，不检查缓存最大年龄；官方同版本文档明确说明没有自动 fail-closed 窗口，取消 `INFISICAL_URL` 后缓存仍可无限期服务。[失败处理][av-sync]、[健康记录更新][av-sql-sync]、[代理读取][av-provider]、[官方故障语义][av-store-doc]

断开 Infisical 不会删除最后同步的秘密，而是保留为 built-in credentials。[断开实现][av-sql-connect]、[官方 store 切换语义][av-store-doc] 因此禁用上游身份／停止同步不能承诺立即撤销下游 token 使用；紧急撤销需要在目标服务吊销，或停用对应服务／proxy 身份。清理 DB 行也不能据此承诺已擦除 SQLite WAL、历史快照或备份，本文未做磁盘取证。

动态秘密是另一路径：SDK 可创建、续租和删除租约；Vault 把租约 fields 放入内存缓存，持久化 lease ID、来源配置和到期时间，不把这些 fields 写入静态 credentials 表。[动态 client][av-client]、[动态缓存及持久化][av-dynamic] 如将来启用动态秘密，需单独审核所需上游写权限、租约撤销失败和资源副作用，不能沿用“只读静态取密已通过”的结论。

## 遥测与错误日志

### 遥测数据流

该版本编译时可由 `POSTHOG_API_KEY` 注入 PostHog key；CLI 遥测 flag 默认开启，env `AGENT_VAULT_TELEMETRY=false` 或 `0` 会阻止 client 初始化。PostHog SDK 默认 endpoint 为 `https://us.i.posthog.com`。[发布编译参数][av-goreleaser]、[遥测初始化][av-telemetry-cmd]、[env 禁用判断][av-telemetry]、[PostHog 默认配置][posthog-config]

已追踪的事件调用使用显式属性：version、source、client_version、actor_type、vault 名、agent 名、email、隔离方式、数据库类型、MITM 是否启用等；认证用户的 email 或 agent 名也可成为 distinct ID；CLI 还可将 email 与机器标识关联。[服务端事件封装][av-telemetry-server]、[注册事件][av-register-event]、[agent 事件][av-agent-event]、[CLI run 事件][av-run-event]、[server-start 事件][av-server-event]、[email identify／alias][av-helpers]

在这些已追踪调用中，没有看到将 Infisical secret value、Universal Auth client secret、请求认证 header 或完整响应 body 作为遥测属性传入；credential-set 事件也传 `nil` 额外属性。[credential-set 事件][av-credential-event] 这是固定版本已检查调用点的静态结论，**不是证明镜像不可能外传秘密**。默认遥测仍会发送可识别元数据，也不宜称为完全匿名；本部署应持续显式禁用，并在隔离运行时检查是否仍有额外出站。

### 错误日志已确认的危险边界

SDK `NewAPIErrorWithResponse` 将请求 URL、状态、reqId、解析出的错误消息加入错误对象；`TryParseErrorBody` 遇 HTTP 422 直接返回整个原始 body，其余错误尝试提取 JSON `message`。[SDK 错误对象][sdk-error]、[错误正文提取][sdk-util]

Vault 在启动登录失败、初次探测失败、定时同步失败和手动同步失败时分别记录 `err.Error()`；日志没有按已拉取的 secret value 进行替换。成功同步的常规日志只记录 vault ID 与 key 数量，客户端错误和 persisted health 通常使用固定“See server logs”信息。[启动登录日志][av-startup-infisical]、[初始探测日志][av-vault-connect]、[同步日志及公开错误][av-sync]、[手动同步日志][av-vault-sync]

实验 R08 中，mock Infisical 返回包含合成错误标记值的 422 后，客户端得到 502 且不含该值，但 Docker 日志的 `infisical sync failed`、`manual infisical sync failed` 两处 WARN 均原样含该值。该实验说明 API 错误响应脱敏不覆盖运维日志；实际是否包含真实凭据取决于上游错误正文，正常取密成功路径并非必然输出 value。

将 log level 设为 info 无法消除 WARN。准入应要求上游错误日志仅保留状态、操作名、可信请求关联 ID 等受限信息，或有经过实验验证的出口脱敏；把日志限制为管理员可读只是减少暴露面，不能宣称日志中无秘密。

## 镜像构建、发布链与源码对应

固定版本 release workflow 由 `v*` tag push 触发，各 GitHub Action 使用完整 commit SHA；使用 `ubuntu-latest`、按 `go.mod` 设置 Go、Node 22、GoReleaser `~> v2`、cosign 和 syft。GoReleaser 先执行 `make web`，其内部为 `npm ci && npm run build`；再编译 Go binary，写入 version、short commit、build date 和 PostHog key。[发布 workflow][av-release-workflow]、[GoReleaser 配置][av-goreleaser]、[前端构建规则][av-make]

发布镜像使用 `Dockerfile.goreleaser`，复制这次预编译 binary 和 entrypoint，生成 amd64／arm64 image，再发布组合 manifest。该镜像基于固定 digest 的 Alpine 3.24.1、安装 ca-certificates、以 uid 65532 运行，entrypoint 仅 exec binary。仓库另有完整多阶段 `Dockerfile`，不能把它的 Go／Node 构建版本直接当作该次官方 release 的构建版本。[GoReleaser Docker 产物][av-goreleaser]、[实际发布 Dockerfile][av-runtime-image]、[entrypoint][av-entrypoint]、[另一路 Dockerfile][av-dockerfile]

发布构建并非每个输入都完全不可变：`ubuntu-latest`、Node 22、GoReleaser `~> v2` 和 `apk add ca-certificates` 的解析结果随构建时间变化；固定源码、Action SHA 和 base digest 有助于收敛输入，但不足以自行证明可重现构建。[workflow][av-release-workflow]、[运行镜像][av-runtime-image]

已核对的发布证据按强度分开记录：

| 证据 | 本次状态 | 能支持的结论与限制 |
| --- | --- | --- |
| GitHub tag、release、workflow run | tag 指向 `872578e...`；该 commit 的官方 Release run `36823171380` 完成成功 | 官方发布记录关联到固定 commit；成功状态不能代替产物验签。[tag][av-tag]、[run][av-release-run] |
| 发布日志中的镜像 digest | 官方任务在 `2026-10-01T06:12:33Z` 左右记录 `0.40.0` manifest digest 为 `sha256:4d490e2586c553ea121fa404b66812ad40c246cc841b0cc746682d0a360bdf1e`，与任务提供的本地 RepoDigest 相同 | 建立官方发布日志与本地 digest 的对应；这是日志证据，不是独立签名验证。[该次任务日志][av-release-job] |
| 镜像签名配置／执行日志 | GoReleaser 配置对 manifests 执行 cosign sign；同次日志显示 signing docker images | 能确认发布流程的声明与执行记录，尚未独立验证镜像签名、证书身份和透明日志。[签名配置][av-goreleaser]、[任务日志][av-release-job] |
| checksum 与归档签名 | release 发布了四平台 tar.gz、各归档 SBOM、`checksums.txt`、`checksums.txt.sig` | 不能把归档 checksum／SBOM 当成整个运行镜像的证明。[release assets][av-release]、[归档与 SBOM 配置][av-goreleaser] |
| GitHub build provenance | workflow 的 `subject-path` 是 `dist/*.tar.gz` 与 `dist/checksums.txt` | 该步骤不直接给 Docker manifest 生成相同的 GitHub provenance；本次未验归档 attestation。[provenance 配置][av-release-workflow] |
| binary 自报 version／commit | 源码通过 ldflags 提供并打印这些值 | 自报元数据可用于一致性检查，不是对 binary 内容或编译输入的密码学证明。[版本输出][av-version]、[编译参数][av-goreleaser] |

本次未独立执行 cosign verify，未完成镜像 registry manifest 的再次远程核验，也未完成镜像内 binary 与验签归档 binary 的比较／可重现构建。**不能写成“已证实这个镜像就是所审源码且没有其他行为”。**

官方同版本 `SECURITY.md` 要求通过 vulnerability disclosure 流程报告问题，并说明安全修复随最新 release 发出。[安全政策][av-security] 调查期间只读查询官方 repository security-advisories API，返回空数组；这是当时公开列表的查询结果，不能推断不存在未公开或未发现问题。[官方 advisory 列表 API][av-advisories] 本次未扩展为所有依赖的漏洞审计。

## 与本仓库公开部署配置的对照

以下是本地工作树快照事实，权威来源是本仓库文件，不能用上游 GitHub 链接替代；它们也不证明生产部署实际一致：

- [docker-compose.agent-vault.yml](../docker-compose.agent-vault.yml) 使用 `infisical/agent-vault:0.40.0`，尚未按 digest 固定；设置 `INFISICAL_URL=https://app.infisical.com` 和 `AGENT_VAULT_TELEMETRY=false`，管理端口仅绑定宿主 loopback，broker 独占 `/data` volume。broker 的 json-file 日志会落宿主并轮转，所以前述 WARN 错误正文有明确的持久化出口。
- [vault.env.example](../deploy/agent-vault/vault.env.example) 仅声明 master password、Universal Auth client ID／secret 与管理地址；Compose entrypoint 要求前三者非空。此措施能防止新实例漏配，但不能发现已经存在的 passwordless 数据卷，也不能证明机器身份权限最小化。
- [现有 Agent Vault 说明](agent-vault.md) 已说明本地加密快照、同步失败继续使用旧缓存、没有五分钟自动关断、proxy 身份不能授予 member／admin，并指出目标 API 回显秘密的边界。这些部署假设需要进入 CD 验收，不能只保留为人工阅读提示。

## CD 准入条件与待验证项

准入应绑定“固定镜像 digest + 配置 + 允许目标 + 运行隔离”这一具体组合。更换 tag、服务规则、Infisical 身份权限、主密码状态或网络控制后应重新评估相应边界。

| 条件 | 当前证据／缺口 | 通过标准 |
| --- | --- | --- |
| 固定并验明发布产物 | 官方发布日志与本地 digest 相同；独立验签未完成 | 部署固定 digest，验证 cosign 的精确 release workflow／`refs/tags/v0.40.0` 身份与 GitHub OIDC issuer，保存验证结果；确认平台 manifest 从属于所验 manifest。需要源码内容对应保证时，进一步比较已验证归档中的 binary 或做受控可重现构建 |
| Infisical 取密传输 | 正常配置是 HTTPS；源码不限制 URL scheme／origin／redirect | CI 拒绝非预期 origin、HTTP、userinfo、任意额外 proxy／CA；用合成身份验证坏证书、域名不匹配及重定向不会把 client secret 或 bearer 带到不可信目标。若依赖外围措施，记录其覆盖范围与失败行为 |
| 应用代理强制 TLS | 已复现明文 HTTP 到 :443 也注入；本项目 router 的单独进程实验拒绝普通 HTTP，但最终网络隔离未验 | 使用能在注入前拒绝明文 HTTP 的实现，或经验证的可信 CONNECT-only 边界；直接绕过该边界的 broker 出口也必须不可达。仅“目标端口是 443”不通过 |
| 目标响应边界 | 实际镜像已复现 echo 响应头／正文暴露注入 key | 对具体允许 host／path／method 验证回显、调试、导出凭据、新建 token 等能力；按任务需求删除不必要目标。若要求应用绝不接触真实值，需要可信响应适配／协议限制；不能把域名可信当作无回显保证 |
| 错误日志与遥测 | 422 正文进入 WARN；遥测禁用依赖配置 | 修复或可靠脱敏 SDK 原始错误出口，合成 secret 覆盖登录失败、首次探测、定时／手动同步的 4xx／422／5xx、网络错误；同时扫描 Docker 日志、日志采集出口、health／API 响应。显式禁用遥测并验证实际出站 |
| 上游最小权限 | 未读取生产身份配置，也未做真实测试项目联调 | 测试身份只允许指定 project／environment／path 的静态读取；验证兄弟路径、其他环境、引用展开以及动态租约请求受到正确授权；未使用功能不授额外权限 |
| 本地卷保护 | 源码加密 value；旧 passwordless 卷可继续使用明文 DEK | 确认实际 `DEKPlaintext` 不存在、已用主密码包装；限制 broker env、卷、备份和 Docker daemon 访问。用合成秘密验证持久化与恢复，不承诺抵御宿主 root 或进程内存读取 |
| 缓存撤销 | 没有自动最大缓存年龄；失败的 last_synced_at 仍推进 | 定义并验证停用／吊销流程和可接受陈旧时间；若要求自动关断，增加可靠的成功快照年龄状态与执行机制。禁用 Infisical 身份或断开 store 不能作为唯一撤销步骤 |
| 管理权限与出口隔离 | 已实测匿名 401、proxy 身份相关管理操作 403，以及 deny 模式未知 host 403；最终 Compose 内核隔离未验 | proxy 身份不能读取／reveal／改规则／创建外部 vault；显式配置 unmatched deny，应用不能触达管理口、绕过代理或持有上游身份。结果必须来自最终部署网络与最终规则 |
| 最终镜像成分与升级 | 本次没有全依赖或镜像漏洞扫描 | 上线前对固定 digest 生成／检查完整镜像 SBOM 与漏洞结果，结合官方 advisories 和支持政策处理；扫描结果只是准入证据之一，不替代上述语义验证 |

当前建议：可继续构建和本地／测试环境验收 CD，但暂不让未修复的 `0.40.0` 直接接入生产密钥并自动上线。先处理取密 client 的重定向约束、错误日志出口，以及应用代理协议边界；同时将目标 API 权限缩到可验证范围。下面的实验说明哪些行为已经观察到，未覆盖项继续保留为准入缺口。

## 实际镜像实验记录

### 环境与镜像

在 Windows Docker Desktop 的 Linux engine 中测试已有本地镜像，没有拉取生产秘密或联系真实 Infisical。`docker image inspect` 返回：

```text
RepoDigest: infisical/agent-vault@sha256:4d490e2586c553ea121fa404b66812ad40c246cc841b0cc746682d0a360bdf1e
OS/arch: linux/amd64
User: agentvault (uid 65532)
Created: 2026-10-01T06:12:18.393072582Z
```

镜像内版本命令输出：

```text
agent-vault 0.40.0
commit: 872578e
built: 2026-10-01T06:08:34Z
go: go1.25.0
os/arch: linux/amd64
```

测试 fixture 使用 `--network none`，broker 与 fixture 共享同一个断网网络命名空间；模拟 Infisical、目标 HTTPS／HTTP 服务器与重定向接收端都仅在本地运行。broker 根文件系统只读，`/data` 为 uid 65532 独占的 tmpfs，没有挂载现有 Vault 或应用数据卷；运行时显式 `AGENT_VAULT_TELEMETRY=false`。本地 CA 只用于这些临时域名，broker TLS 校验保持开启。仅为实验允许 loopback 目标，这不是生产配置建议。

测试密钥使用固定虚构值，目的为追踪数据是否流出边界。管理 token 在临时数据库中生成，结束后删除容器与内存盘。测试脚本、证书位于独立临时目录，未进入应用镜像、Git 或 CI artifact。没有执行下载的上游脚本；只运行所审镜像的程序与自己编写的 fixture。

### 观察结果

| 编号 | 输入／检查 | 实际结果与解释 |
| --- | --- | --- |
| R01 | Universal Auth 登录 HTTPS mock；创建 Infisical-backed vault，返回一个合成 `AUDIT_KEY` | 登录及取密成功；owner reveal 为 200，内容包含 mock 返回值，证明后续代理测试使用的是经取密链路同步的 key |
| R02 | 匿名与 `no-access` 实例角色、仅 vault `proxy` 授权的 agent 调用管理 API | 匿名 reveal 为 401；proxy reveal、修改 services、创建 external-store vault 均为 403；owner reveal 成功属于明确授权能力 |
| R03 | 配 `upstream.audit.test:443/*` bearer 规则；发送 absolute-form `http://upstream.audit.test:443/echo` | 明文 HTTP fixture 收到注入后的 Authorization；代理返回 200，响应头和正文均含该合成 key。说明 port=443 未强制 TLS |
| R04 | 通过 CONNECT 和受信 CA 访问 HTTPS echo | TLS 验证成功，响应为 200；正文及回显认证响应头含注入 key。broker 没有通用回显过滤 |
| R05 | 获准 HTTPS 目标返回 302，Location 为另一个测试主机 | broker 把 302 返回调用方，没有自己跟随；接收端调用次数为零。没有验证应用 SDK 之后的跟随行为，也不与取密 client 的 R12 混为一谈 |
| R06 | 新 vault 读取 unmatched policy；随后设为 deny 并请求未知 host | 默认值为 `passthrough`；显式 deny 后未知 host 为 403。上线不能依赖默认值实现默认拒绝 |
| R07 | 执行普通注入和 path substitution，再读取请求审计 | 五条持久化请求日志没有注入 key，path substitution 日志保留原 placeholder；只证明这组正常请求日志没有泄露，不覆盖全部错误路径 |
| R08 | 已同步后让 mock `secrets/raw` 返回 422，正文附带合成错误标记值，再手动 sync | sync API 返回 502 且不含标记；Docker 日志两条 WARN 均含原始标记。容器日志属于密钥潜在输出边界 |
| R09 | 不给另一个 broker 挂载测试 CA，连接相同 HTTPS mock | 登录报 `x509: certificate signed by unknown authority`，取密 GET 未到达，创建 external vault 为 503；正常证书校验确实生效 |
| R10 | `INFISICAL_URL=http://127.0.0.1:18080` | broker 日志显示 Universal Auth client ready，并向 mock 发送取密 GET；当时 mock 已设为返回 422，故 vault 创建为 502。这证明客户端接受 HTTP，并非成功取密的完整验收 |
| R11 | 本仓库 router Linux 二进制，单独运行于相同断网命名空间 | absolute-form HTTP 返回 400，CONNECT 返回 `200 Connection Established`；说明 router 可作为协议限制的一部分。未使用最终 router 镜像，未执行最终 Compose 的内核防火墙旁路验收 |
| R12 | Infisical HTTPS 登录入口返回跨主机 307 到另一个拥有有效测试证书的 HTTPS 接收端 | 接收端记录 `receivedLoginSecret=true`，收到 Universal Auth POST 正文中的合成 client secret；broker 登录仍成功。可见 HTTPS 本身没有限制凭据发送 origin |

R08 的 Docker 日志摘录（所有值均为测试数据）：

```text
level=WARN msg="infisical sync failed" ...
err="APIError: CallListSecretsV3Raw unsuccessful response [GET https://infisical.audit.test:18888/api/v3/secrets/raw?...]
[status-code=422] ... [message=...AUDIT_ONLY_ERROR_BODY_20261026_Y8...]"
level=WARN msg="manual infisical sync failed" ... [message=...AUDIT_ONLY_ERROR_BODY_20261026_Y8...]
```

R12 的接收端只记录存在性，不打印收到的正文：

```json
{"receivedLoginSecret":true,"receivedBearer":false,"receivedRequests":1}
```

`receivedBearer=false` 不代表 bearer 安全，只表示该次实验为登录阶段，尚未执行带 bearer 的取密重定向。

### 对本项目的适用边界

当前单 vault 模式允许应用 uid 1000 访问 broker:14322，所以直接存在 R03 的协议入口；项目 router 只接受 CONNECT（[实现](../router/internal/proxy/connect.go)），router 模式的 [network.sh](../deploy/agent-vault/network.sh) 按 UID 仅允许 router uid 1001 接触 broker。R11 证实进程级限制；最终 CD 仍须实测应用 uid 无法直接访问 broker，不能仅从规则文本推断隔离已成立。

[服务规则示例](../deploy/agent-vault/services.example.yaml) 中有 `/*`／`/v1/*` 等较宽路径，Agent Vault service 模型没有 HTTP method allowlist。因此需要逐个确认真实 API 的回显、调试、导出和生成新 token 能力；只收窄路径也未必足够。若必须承诺真实密钥永远不进入应用，需要在可信宿主／适配层对操作和响应作约束，通用字符串替换不足以覆盖编码、派生 token 或应用主动调用的凭据管理接口。

本次未完成 cosign 独立验签、远端 registry manifest 再次核验（连接超时）、全镜像 SBOM／漏洞扫描、真实 Infisical 最小权限／引用展开测试，以及生产日志采集链和最终 Compose 防火墙验证。测试通过和已确认问题均限定在上述镜像与合成输入；没有将正常同步不输出 value 扩大成整个镜像无泄露风险。

## 固定来源索引

Agent Vault 链接固定到 `872578e4cdf9e03d5e3bcb5512023a70bf90ed65`；SDK 链接固定到 `4ed5667bdf11d36643da4fd9cd05c660e30e24dd`。release、tag API、advisory API 属于官方发布／查询记录；API 内容可能随后变化，本文只陈述本次查询结果。GitHub Actions run 链接指向具体执行记录。

[av-tag]: https://api.github.com/repos/Infisical/agent-vault/git/ref/tags/v0.40.0
[av-commit]: https://github.com/Infisical/agent-vault/commit/872578e4cdf9e03d5e3bcb5512023a70bf90ed65
[av-release]: https://github.com/Infisical/agent-vault/releases/tag/v0.40.0
[av-mod]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/go.mod#L5-L62
[av-auth]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/infisical/auth.go#L30-L72
[av-client]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/infisical/client.go#L77-L163
[av-config]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/infisical/config.go#L9-L60
[av-sync]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/infisical/sync.go#L160-L254
[av-provider]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/brokercore/credential.go#L112-L207
[av-vault-create]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/server/handle_vaults.go#L474-L520
[av-vault-connect]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/server/handle_vaults.go#L557-L719
[av-vault-sync]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/server/handle_vaults.go#L112-L183
[av-startup-infisical]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/cmd/server.go#L247-L274
[av-crypto]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/crypto/crypto.go#L11-L50
[av-kdf]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/crypto/kdf.go#L9-L50
[av-master]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/auth/auth.go#L46-L150
[av-startup-password]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/cmd/server.go#L341-L447
[av-sql-sync]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/store/sql_store.go#L510-L585
[av-sql-connect]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/store/sql_store.go#L588-L650
[av-db-path]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/store/store.go#L664-L675
[av-db-open]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/store/sql_store.go#L75-L107
[av-store-doc]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/docs/learn/credential-stores.mdx#L44-L117
[av-dynamic]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/infisical/dynamic.go#L255-L345
[av-telemetry]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/telemetry/telemetry.go#L27-L115
[av-telemetry-cmd]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/cmd/telemetry.go#L10-L25
[av-telemetry-server]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/server/server.go#L131-L173
[av-register-event]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/server/handle_auth.go#L152-L171
[av-agent-event]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/server/handle_agents.go#L117-L128
[av-credential-event]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/server/handle_credentials.go#L57-L80
[av-helpers]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/cmd/helpers.go#L208-L215
[av-run-event]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/cmd/run.go#L673-L689
[av-server-event]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/cmd/server.go#L758-L769
[av-plain-http-test]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/mitm/forward_test.go#L103-L178
[av-forward-entry]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/mitm/forward.go#L48-L145
[av-forward-inject]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/mitm/forward.go#L220-L261
[av-forward-response]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/mitm/forward.go#L337-L426
[av-release-workflow]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/.github/workflows/release.yml#L1-L70
[av-goreleaser]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/.goreleaser.yml#L1-L149
[av-make]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/Makefile#L1-L20
[av-runtime-image]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/Dockerfile.goreleaser#L1-L21
[av-dockerfile]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/Dockerfile#L1-L50
[av-entrypoint]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/scripts/docker-entrypoint.sh#L1-L6
[av-version]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/cmd/version.go#L10-L27
[av-release-run]: https://github.com/Infisical/agent-vault/actions/runs/36823171380
[av-release-job]: https://github.com/Infisical/agent-vault/actions/runs/36823171380/job/110242950902
[av-security]: https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/SECURITY.md#L1-L27
[av-advisories]: https://api.github.com/repos/Infisical/agent-vault/security-advisories
[sdk-tag]: https://api.github.com/repos/Infisical/go-sdk/git/ref/tags/v0.8.0
[sdk-auth]: https://github.com/Infisical/go-sdk/blob/4ed5667bdf11d36643da4fd9cd05c660e30e24dd/auth.go#L101-L129
[sdk-login]: https://github.com/Infisical/go-sdk/blob/4ed5667bdf11d36643da4fd9cd05c660e30e24dd/packages/api/auth/universal_auth_login.go#L10-L30
[sdk-client]: https://github.com/Infisical/go-sdk/blob/4ed5667bdf11d36643da4fd9cd05c660e30e24dd/client.go#L237-L438
[sdk-list]: https://github.com/Infisical/go-sdk/blob/4ed5667bdf11d36643da4fd9cd05c660e30e24dd/packages/api/secrets/list_secrets.go#L15-L74
[sdk-secret-model]: https://github.com/Infisical/go-sdk/blob/4ed5667bdf11d36643da4fd9cd05c660e30e24dd/packages/api/secrets/models.go#L5-L24
[sdk-secrets]: https://github.com/Infisical/go-sdk/blob/4ed5667bdf11d36643da4fd9cd05c660e30e24dd/secrets.go#L59-L97
[sdk-error]: https://github.com/Infisical/go-sdk/blob/4ed5667bdf11d36643da4fd9cd05c660e30e24dd/packages/errors/api.go#L10-L58
[sdk-util]: https://github.com/Infisical/go-sdk/blob/4ed5667bdf11d36643da4fd9cd05c660e30e24dd/packages/util/helper.go#L18-L111
[resty-transport]: https://github.com/go-resty/resty/blob/v2.13.1/transport.go#L17-L35
[resty-create]: https://github.com/go-resty/resty/blob/v2.13.1/resty.go#L19-L25
[resty-body]: https://github.com/go-resty/resty/blob/v2.13.1/middleware.go#L211-L268
[go-http]: https://github.com/golang/go/blob/go1.25.0/src/net/http/client.go#L39-L77
[go-http-body]: https://github.com/golang/go/blob/go1.25.0/src/net/http/client.go#L505-L582
[go-tls]: https://github.com/golang/go/blob/go1.25.0/src/crypto/tls/common.go#L656-L690
[posthog-config]: https://github.com/PostHog/posthog-go/blob/v1.24.4/config.go#L238-L239

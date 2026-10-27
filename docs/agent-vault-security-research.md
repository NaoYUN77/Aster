# Infisical agent-vault v0.40.0 安全研究：凭据同步、身份认证与遥测边界

状态：调研记录（只读，未修改被测代码，未连接生产）。日期：2026-10-27。

本文回答用户提出的问题：**agent-vault 镜像与上游 Infisical Secret Management 是否存在凭据泄露风险**。范围包括镜像版本与构建信息、Infisical credential store 同步、Machine Identity 的认证与权限、传输安全、本地缓存加密、日志与遥测，以及管理 API 和代理响应边界。代理与权限行为用实际镜像二进制、假凭据和离线目标验证；不代表生产环境已经发生泄露。

所有事实以固定版本的源码为准。文档措辞与代码冲突时以代码为准。

## 1. 版本固定

| 对象 | 固定点 | 说明 |
| --- | --- | --- |
| agent-vault | tag `v0.40.0` = commit [`872578e4cdf9e03d5e3bcb5512023a70bf90ed65`](https://github.com/Infisical/agent-vault/tree/872578e4cdf9e03d5e3bcb5512023a70bf90ed65)，发布 2026-10-01 | 与 `docker-compose.agent-vault.yml` 中 `infisical/agent-vault:0.40.0` 对应 |
| go-sdk | tag `v0.8.0` = commit [`4ed5667bdf11d36643da4fd9cd05c660e30e24dd`](https://github.com/Infisical/go-sdk/tree/4ed5667bdf11d36643da4fd9cd05c660e30e24dd) | agent-vault `go.mod` 直接依赖 |
| posthog-go | tag `v1.24.4` = commit [`0216c2384b67ef39914e20fd0065c57243fb42d2`](https://github.com/PostHog/posthog-go/tree/0216c2384b67ef39914e20fd0065c57243fb42d2) | 唯一遥测客户端 |
| resty | tag `v2.13.1` = commit [`baf7c1219b781803557018eba206ad8fa544941f`](https://github.com/go-resty/resty/tree/baf7c1219b781803557018eba206ad8fa544941f) | go-sdk 的 HTTP 客户端 |
| Infisical 服务端 | tag `v0.167.2` = commit [`15390e1f0483ea3488b7354be88c54ee26ea59f5`](https://github.com/Infisical/infisical/tree/15390e1f0483ea3488b7354be88c54ee26ea59f5)，发布 2026-10-23 | 用于回答「云端是否可解密」；不是 v0.40.0 的依赖，只用于确认 API 语义 |

源码获取方式：从 GitHub 下载 tag 对应的 tarball 到独立临时目录解压，只读源码，不执行其代码。tarball SHA-256：`eca97d0ba4541c708e9d1b9ecee9bcf988f4b1f8e652cb40a0ae11c89ec8ee48`。

版本区间：`v0.40.0`（2026-10-01）到 `v0.40.2`（2026-10-22）的源码比较只有一个 commit `d5836ec`，内容是 Go 1.26.10 / Node 26.12.1 / CA bundle / 文档更新，所检查的凭据与遥测代码路径没有变化。实际二进制验证仅针对本地 v0.40.0，不替代对新版镜像的验收。

## 2. 结论摘要

1. **`AGENT_VAULT_TELEMETRY=false` 能真正关闭遥测**：进程初始化时直接不创建 PostHog 客户端，Go 侧没有第二套上报实现，Web 前端没有 analytics/Sentry 依赖。但禁用只覆盖「事件上报」，不改变调用点执行；并且官方镜像内置 PostHog key，默认是开启的。
2. **没有发现 secret 值进入遥测事件**。事件属性是版本、来源、邮箱或 agent 名、vault/服务/凭据键名等元数据。启用遥测时会把**登录邮箱**作为 distinctID 发往 `https://us.i.posthog.com`，这是账号标识外发，不是凭据外发。
3. **常规同步日志未见主动输出 secret 值的路径**；成功日志只记 vault_id 和 key 数量。失败日志包含未脱敏的 `err.Error()`；go-sdk 的 `APIError` 可包含上游 URL、状态码、reqId 和 `message`，若错误响应回显秘密，该值可能进入 stderr。未构造此失败场景，不能保证所有错误日志都不含秘密。
4. **本地缓存加密是 AES-256-GCM + KEK/DEK**，Infisical 快照与内置凭据共用同一 DEK，落库为 ciphertext+nonce；动态密钥只存 lease 元数据，值只在内存。passwordless 模式下 DEK 明文存库，仅靠文件系统权限——文档已声明，属取舍不是漏洞。
5. **Infisical identity token 不会传到代理目标**。Machine Identity 登录和 token 刷新只发生在 Agent Vault 进程与 Infisical 之间；代理注入的是本地解密出的业务凭据。需要注意部署边界：`vault run` 子进程继承 `os.Environ()` 且只 strip `AGENT_VAULT_*` 与代理相关键，**不 strip `INFISICAL_*`**，同环境启动时 agent 能读到 client secret。
6. **Infisical 服务端可解密并返回明文**。Agent Vault 走 raw secrets API（`GET /v3/secrets/raw`），响应字段 `secretValue` 就是明文；所检查的 Infisical 后端用项目 KMS 的 `CipherPair` 解密后返回。因此这条接入链路需要信任上游服务端及其密钥管理；本地缓存加密不能提供对上游的端到端保密。此结论不代表普通员工具有明文访问权限，也不证明 Cloud 当前运行的具体版本。
7. **只读 identity 的 blast radius 是「该 identity 可见范围内的全部 secret 明文」**，不是 Agent Vault 实际引用的那几个 key。Agent Vault 的 services 规则只决定注入哪些 key 到哪个 host，不限制 identity 能读多少。最小权限应把 project/environment/secret_path 收到最小。
8. **GitHub advisories 与 OSV 均为空，但不能据此认定无漏洞**。只说明没有被这些数据库收录；未做独立 CVE 扫描，不能断言旧版可利用性。
9. **TLS**：出站到 Infisical 用 resty 默认 transport，证书校验默认开启；Agent Vault 没有显式传入 SDK 的 `CaCertificate`，自建 CA 需由系统信任库等受控方式配置，未实测。resty 默认读取 `HTTP(S)_PROXY` 环境变量，broker 若继承代理变量，同步请求可能经该代理；使用 HTTPS 且证书校验有效时，代理本身不因此获得解密能力。到业务目标的 HTTPS 最低 TLS 1.2，未关闭校验。

## 3. 已确认事实（附源码位置）

### 3.1 telemetry=false 到底禁用了什么

`cmd/telemetry.go` 在 cobra `OnInitialize` 里执行：

- 若 `telemetry.IsDisabled()` 为真，直接 `return`，全局 `tel` 保持 `nil`（[cmd/telemetry.go#L13-L25](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/cmd/telemetry.go#L13-L25)）。
- 若 `--telemetry=false`，同样 `return`（同文件 L21-L23）。
- 两者都不满足时，才 `telemetry.New(posthogAPIKey, version)`。

`IsDisabled()` 的判定非常窄：只把 `AGENT_VAULT_TELEMETRY` 转小写后等于 `"false"` 或 `"0"` 视为禁用（[internal/telemetry/telemetry.go#L87-L92](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/telemetry/telemetry.go#L87-L92)）。`"off"`、`"no"`、`"0 "` 等不会禁用。

禁用后的实际效果：

- `Telemetry` 的所有方法在 `t == nil` 或 `client == nil` 时立即返回（[telemetry.go#L40-L83](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/telemetry/telemetry.go#L40-L83)）。
- `Server.AttachTelemetry(nil)` 后 `captureEvent` 直接返回（[internal/server/server.go#L133-L140](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/server/server.go#L133-L140)）。
- 但 `captureEvent` 的调用点仍然执行，只是内部 no-op。也就是说「禁用」是网络出口层面的，不是代码路径层面的。

是否有第二套上报：

- Go 侧只有 `internal/telemetry` 一个封装，唯一客户端是 `posthog-go`（[telemetry.go#L8-L35](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/telemetry/telemetry.go#L8-L35)）。`grep -ri "sentry|segment|mixpanel"` 无命中。
- Web 前端 `web/package.json` 只有 React/TanStack/Tailwind/Vite，没有 analytics 或 Sentry 依赖。唯一外部资源是 `theme.css` 引用 `fonts.googleapis.com`（无凭据）。
- `web/index.html` 没有第三方脚本。

默认是否开启：

- `posthogAPIKey` 通过 ldflags 注入：`Dockerfile` L23-L27、`.goreleaser.yml` L21、`.github/workflows/release.yml` L63。官方镜像/二进制因此内置 key，默认开启。自编译且不传该变量时 key 为空，`telemetry.New("")` 返回 `nil`（[telemetry.go#L29-L38](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/telemetry/telemetry.go#L29-L38)），等效于禁用。
- 主线程 compose 里显式设置 `AGENT_VAULT_TELEMETRY: "false"`，覆盖了默认。

### 3.2 遥测事件里有什么

事件属性来源：

- `av.server-start`：`mitm_enabled`、`database_backend`，distinctID 优先取本地 CLI session 的邮箱（[cmd/server.go#L758-L769](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/cmd/server.go#L758-L769)）。
- `av.run`：`agent_name`、`isolation`、`vault`（[cmd/run.go#L672-L688](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/cmd/run.go#L672-L688)）。
- 服务端事件：`source`（cli/web/api）、`client_version`、`actor_type`，distinctID 为 `actor.User.Email` 或 `agent:<name>`；事件名和附加属性见 `internal/server/handle_*.go` 中的 `captureEvent` 调用（例如 `av.credential-set` 不带额外属性，`av.vault-create` 带 vault 名，`av.agent-create` 带 agent 名）。
- `identify` 会把 `email` 作为属性发送（[cmd/helpers.go#L214-L215](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/cmd/helpers.go#L214-L215)、L272-L273）。

没有出现的字段：凭据值、请求体、header 值、Infisical project ID/environment/secret path、代理目标 URL。`captureEvent` 的 `extra` 参数由调用点显式传入，没有从凭据对象取值的路径。

隐私而非泄密：启用遥测时邮箱会发往 PostHog 默认端点 `https://us.i.posthog.com`（[posthog-go config.go#L239](https://github.com/PostHog/posthog-go/blob/0216c2384b67ef39914e20fd0065c57243fb42d2/config.go#L239)）。如果用户不希望账号标识外发，必须设置 `AGENT_VAULT_TELEMETRY=false`。

`MachineID()` 是 `/etc/machine-id` 经 `machineid.ProtectedID("agent-vault")` 派生，失败时回退到 hostname 的 SHA-256 前 8 字节（[telemetry.go#L94-L118](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/telemetry/telemetry.go#L94-L118)）。不含秘密，但 hostname 哈希在低熵主机名上可被枚举。

### 3.3 同步与错误路径是否带 secret

同步成功：

- 只记录 `vault_id` 和 `keys` 数量（[internal/infisical/sync.go#L203-L205](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/infisical/sync.go#L203-L205)）。
- 写入本地前先 `EncryptSecrets`，逐个 `crypto.Encrypt`（[sync.go#L217-L231](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/infisical/sync.go#L217-L231)）。明文还存在于 SDK 响应、同步结构和代理解密得到的字符串中；未做内存生命周期验证，不能承诺只在函数栈上短暂存在。

同步失败：

- stderr 日志记录 `vault_id` 和 `err.Error()`（[sync.go#L235-L242](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/infisical/sync.go#L235-L242)）。
- 持久化到 `last_sync_error` 的是固定文案 `"Infisical sync failed. See server logs for details."`（[sync.go#L26-L28](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/infisical/sync.go#L26-L28)），只有 `ErrInvalidKey` 会原样返回键名（[sync.go#L243-L246](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/infisical/sync.go#L243-L246)）。键名不是值。
- `err.Error()` 的来源是 go-sdk 的 `APIError`：`"APIError: <op> unsuccessful response [<method> <url>] [status-code=N] [reqId=...] [message=\"...\"]"`（[go-sdk packages/errors/errors.go#L12-L40](https://github.com/Infisical/go-sdk/blob/4ed5667bdf11d36643da4fd9cd05c660e30e24dd/packages/errors/errors.go#L12-L40)）。`message` 来自上游响应体的 `message` 字段（[go-sdk packages/util/helper.go#L83-L112](https://github.com/Infisical/go-sdk/blob/4ed5667bdf11d36643da4fd9cd05c660e30e24dd/packages/util/helper.go#L83-L112)）。
  - 因此：**若 Infisical 的错误响应回显了 secret 值，它会进 stderr 日志**。这是条件性风险，不是默认行为。422 时 go-sdk 会把整个响应体作为 message 返回（helper.go L98-L101），如果 422 校验错误里包含提交的值，同样会进日志。Agent Vault 的同步只发 GET，正常情况下不会触发 422 回显。
  - HTTP 层错误（`RequestError`）包含底层网络错误，不含 secret（[go-sdk errors.go#L4-L17](https://github.com/Infisical/go-sdk/blob/4ed5667bdf11d36643da4fd9cd05c660e30e24dd/packages/errors/errors.go#L4-L17)）。

动态密钥：

- 续租失败、持久化失败、撤销失败的日志只记 `vault_id`/`name`/`lease_id` 和 err（[internal/infisical/dynamic.go#L270-L276](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/infisical/dynamic.go#L270-L276)、L330-L334、L341-L346）。
- `DynamicLease.Fields` 的注释明确 `never log it`（[internal/infisical/client.go#L32-L37](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/infisical/client.go#L32-L37)）。未发现把 Fields 写入日志的路径。

代理请求日志：

- `ProxyEvent` 只包含 method/host/path/匹配规则/凭据键名/status/耗时/错误码，注释明确「no header values, no bodies, no query strings」（[internal/brokercore/logging.go#L30-L48](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/brokercore/logging.go#L30-L48)）。
- `AuthHeader` 字段存的是 header 名，不是值（logging.go L48、L61-L77）。
- 持久化层同样只写这些字段（[internal/requestlog/sink.go#L22-L42](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/requestlog/sink.go#L22-L42)）。
- 主线程实测：普通成功请求的 debug 日志未出现测试用假 key，与源码一致。

代理响应路径（仅作为「secret 是否可能外泄」的边界记录，代理行为由主线程负责）：

- 上游响应 header 逐条复制，只跳过 `ShouldStripResponseHeader` 命中的名字，body 用 `io.Copy` 原样转发（[internal/mitm/forward.go#L392-L410](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/mitm/forward.go#L392-L410)）。这意味着如果上游把注入的凭据回显在响应里（包括 `X-Echo-Authorization` 这类 header），Agent Vault 不会清洗，agent 能看到该值。这是「上游行为 + 代理原样转发」的组合条件，不是 Agent Vault 主动泄露。

### 3.4 本地密钥与缓存加密

- 加密原语：AES-256-GCM，每次随机 nonce（`crypto/rand`），无 AAD（[internal/crypto/crypto.go#L13-L46](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/crypto/crypto.go#L13-L46)）。
- KDF：Argon2id，time=3、memory=64 MiB、threads=4、keyLen=32、salt=16（[internal/crypto/kdf.go#L18-L30](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/crypto/kdf.go#L18-L30)）。
- 主密码模式：`WrapDEK` 用 KEK 包裹 DEK，KEK 不落盘（[internal/auth/auth.go#L46-L68](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/auth/auth.go#L46-L68)、L138-L156）。`AGENT_VAULT_MASTER_PASSWORD` 读后立即 `os.Unsetenv`（[cmd/server.go#L342-L348](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/cmd/server.go#L342-L348)），密码字节用 `WipeBytes` 尽力清零（server.go L401/L431/L443/L469/L479/L491/L500/L508）。
- passwordless 模式：DEK 明文存 `master_key.dek_plaintext`（[internal/store/038_master_key_kek_dek.go#L8-L20](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/store/038_master_key_kek_dek.go#L8-L20)、[auth.go#L70-L87](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/auth/auth.go#L70-L87)）。能读数据库文件/卷的人可解密全部凭据。这是文档已声明的取舍。
- 凭据表只存 `ciphertext` + `nonce`（[internal/store/20260617143022_postgres_baseline.go#L28-L38](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/store/20260617143022_postgres_baseline.go#L28-L38)）。
- Infisical 快照与内置凭据使用同一个 DEK：同步路径直接 `crypto.Encrypt(sec.Value, s.dek)`（[sync.go#L217-L231](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/infisical/sync.go#L217-L231)）。文档也这样声明（`docs/learn/credential-stores.mdx` L15）。
- 动态密钥：lease 值只在内存，DB 只存 lease 元数据和撤销所需的配置快照（[internal/store/050_dynamic_secret_leases.go#L8-L20](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/store/050_dynamic_secret_leases.go#L8-L20)）。
- 内存清零是 best-effort：`WipeBytes` 注释说明 GC 可能已复制，且 Go 字符串不可擦除（[kdf.go#L44-L49](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/crypto/kdf.go#L44-L49)）。DEK 在进程生命周期内常驻，这是设计而非缺陷。
- CA 私钥也用 DEK 加密（`internal/ca/soft.go` L98-L104、L222-L232）。

### 3.5 Machine Identity：认证方式与 token 是否外流

认证方式检测（优先级从高到低）：Universal Auth、Kubernetes、AWS IAM、GCP IAM、GCP ID Token、LDAP（[internal/infisical/auth.go#L29-L37](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/infisical/auth.go#L29-L37)）。多个同时配置时取最高优先级并打一条 Warn（auth.go L45-L73）。

登录：

- Universal Auth 调 `/v1/auth/universal-auth/login`，凭据来自 `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID/SECRET`（[go-sdk packages/api/auth/universal_auth_login.go#L10-L31](https://github.com/Infisical/go-sdk/blob/4ed5667bdf11d36643da4fd9cd05c660e30e24dd/packages/api/auth/universal_auth_login.go#L10-L31)、[agent-vault client.go#L326-L341](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/infisical/client.go#L326-L341)）。
- SDK 开启 `AutoTokenRefresh`，用 renew 或重新认证维持 access token（[go-sdk client_auth_helper.go#L24-L120](https://github.com/Infisical/go-sdk/blob/4ed5667bdf11d36643da4fd9cd05c660e30e24dd/client_auth_helper.go#L24-L120)）。
- `NewClient` 显式设置 `CacheExpiryInSeconds: 0`，禁用 SDK 侧 secret 缓存，由 Agent Vault 自己管理缓存（[client.go#L94-L99](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/infisical/client.go#L94-L99)）。

token 去向：

- access token 只设置到 go-sdk 的 resty 客户端（`SetAuthToken`），用于 Infisical API 请求（[go-sdk client.go#L226-L246](https://github.com/Infisical/go-sdk/blob/4ed5667bdf11d36643da4fd9cd05c660e30e24dd/client.go#L226-L246)）。
- 代理注入走 `brokercore`，注入的是服务规则引用、从本地 `credentials` 表解密出的值，不是 Infisical token。
- 代理入口的 `Proxy-Authorization` 和 `X-Vault` 属于 broker-scoped header，在转发前被剥离（[internal/brokercore/brokercore.go#L30-L100](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/brokercore/brokercore.go#L30-L100)）。主线程已实测。
- 结论：**Infisical client secret / access token 不会出现在发往代理目标的请求里**。

需要留意的部署边界：

- `vault run` 用 `os.Environ()` 构造子进程环境，只 strip `AGENT_VAULT_*` 和 `HTTPS_PROXY/HTTP_PROXY/NO_PROXY/NODE_USE_ENV_PROXY/OPENCLAW_PROXY_URL/*_CA_*`（[cmd/run.go#L180-L205](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/cmd/run.go#L180-L205)、L455-L487）。`INFISICAL_*` 不在 strip 列表里。
- 因此如果 broker 和 agent 在同一 shell 环境启动（例如本机直接用 `vault run`，而 `INFISICAL_*` 恰好也在该 shell 里），agent 进程能读到 `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET`。当前 compose 部署把 broker 和 app 分容器，app 的 `env_file` 不含 `INFISICAL_*`，不受影响；本机 `vault run` 模式需要显式清理环境。
- `spawnDetached` 也继承 `os.Environ()`（[cmd/server.go#L645-L665](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/cmd/server.go#L645-L665)），这是 broker 自己的子进程，风险较低。

### 3.6 Infisical 云端是否服务端可解密、返回明文

Agent Vault 调用的 API：

- `FetchSecrets` → `ListSecrets` → go-sdk `CallListSecretsV3` → `GET /v3/secrets/raw`（[agent-vault client.go#L124-L145](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/infisical/client.go#L124-L145)、[go-sdk packages/api/secrets/list_secrets.go#L33-L58](https://github.com/Infisical/go-sdk/blob/4ed5667bdf11d36643da4fd9cd05c660e30e24dd/packages/api/secrets/list_secrets.go#L33-L58)）。
- 请求带 `expandSecretReferences=true`、`include_imports=false`、`recursive=false`（go-sdk list_secrets.go L40-L51；agent-vault 只显式设置 `ExpandSecretReferences: true`）。
- 响应模型 `models.Secret` 的 `SecretValue` 是明文字符串（[go-sdk packages/models/secrets.go#L15-L27](https://github.com/Infisical/go-sdk/blob/4ed5667bdf11d36643da4fd9cd05c660e30e24dd/packages/models/secrets.go#L15-L27)）。
- go-sdk 客户端**不做任何解密**：`grep -ri "decrypt|aes|encrypt"` 在 secrets API 包无命中。

Infisical 服务端行为：

- 路由注册：`GET /api/v3/secrets/raw`（deprecated）与 `GET /api/v4/secrets`，认证支持 JWT、identity access token、service token（[infisical backend-go/internal/server/api/secretmanager_routes.go](https://github.com/Infisical/infisical/blob/15390e1f0483ea3488b7354be88c54ee26ea59f5/backend-go/internal/server/api/secretmanager_routes.go#L28-L47)）。
- `listSecrets` 先取权限，再拉取全部 secret，按 `CanReadSecretValue` 过滤；无读值权限时把 `Value` 置为 `"<hidden-by-infisical>"`（[list_secrets.go#L60-L115](https://github.com/Infisical/infisical/blob/15390e1f0483ea3488b7354be88c54ee26ea59f5/backend-go/internal/server/api/secretmanager/secret/list_secrets.go#L60-L115)、L186-L203）。
- 有权限时响应直接填 `SecretValue: ps.Value`（list_secrets.go L366、L411）。
- 解密发生在服务端：`DecryptSecretFields` 用项目 KMS 的 `cipherPair.Decrypt` 解出 `rawValue`（[backend-go/internal/services/secretmanager/secret/secret.go#L526-L575](https://github.com/Infisical/infisical/blob/15390e1f0483ea3488b7354be88c54ee26ea59f5/backend-go/internal/services/secretmanager/secret/secret.go#L526-L575)）。
- 因此这条接入链路不是对 Infisical 服务端保密的端到端加密：所检查的服务端实现具备解密并返回明文的能力。Cloud 服务端和密钥管理应纳入信任边界；源码不能证明 Cloud 当前部署版本或具体员工权限。

对 Agent Vault 的含义：

- 「本地缓存加密」只保护落盘，不改变上游可解密这一事实。
- 如果威胁模型包含 Infisical Cloud 运营方，Agent Vault 的加密层不提供额外保护。
- 自托管 Infisical 时，明文可读性取决于你自己的实例和 KMS 配置（本文未展开 KMS root key 存储细节）。

### 3.7 只读 identity 的实际 blast radius

Agent Vault 使用的 Infisical 能力：

- 静态 secret：`ListSecrets`（读）。
- 动态 secret：`List`、`Leases().Create/RenewById/DeleteById`（[client.go#L147-L230](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/infisical/client.go#L147-L230)）。
- 项目 slug 解析：`GET /api/v1/workspace/{id}`（client.go L272-L299）。
- 未调用 go-sdk 的 `Update`/`Create`/`Delete` secret 方法（这些方法存在于 SDK，但 agent-vault 没有使用）。

只读 identity 能做什么：

- 读取该 identity 在 project/environment/secret_path 范围内**所有** secret 的明文。范围由 Infisical 的权限配置决定，不由 Agent Vault 的 services 规则决定。
- 如果配置了动态 secret 权限，能 mint/renew/revoke lease，从而让上游创建临时资源。
- 不能修改 secret、不能改权限、不能创建/删除 secret。

不能做什么（基于代码调用面）：

- Agent Vault 没有写入 Infisical 的代码路径，所以即使 identity 有写权限，Agent Vault 也不会用。
- 只读 identity 泄露的影响是「该范围内全部 secret 明文」，而不是「Agent Vault 实际注入的那几个 key」。这是最小权限配置时最容易低估的一点。

建议的最小权限：

- Secret Manager：只授予目标 project/environment/secret_path 的 read（含 read value）。
- 如果不用动态 secret，不授予 dynamic secret 权限。
- 用专用 project/environment/path 缩小当前 broker identity 的权限。当前 broker 从进程环境选择一套上游身份，多个 vault 共用它；仅拆成多个 vault 不会形成独立的上游身份边界。需要每个 vault 独立 identity 时，应分离 broker 实例或先验证上游是否提供相应能力。
- 注意 `expandSecretReferences=true` 会让服务端展开引用；Infisical 侧已做权限过滤，不会因为引用而泄露无权限的 secret（list_secrets.go L83-L110）。

### 3.8 TLS 与网络出口

出站到 Infisical：

- go-sdk 用 resty 默认 transport，`Proxy: http.ProxyFromEnvironment`（[resty transport.go#L17-L35](https://github.com/go-resty/resty/blob/baf7c1219b781803557018eba206ad8fa544941f/transport.go#L17-L35)）。
- 证书校验默认开启；只有 `Config.CaCertificate` 非空时才替换 `RootCAs`（[go-sdk client.go#L423-L437](https://github.com/Infisical/go-sdk/blob/4ed5667bdf11d36643da4fd9cd05c660e30e24dd/client.go#L423-L437)）。Agent Vault 调用 `sdk.NewInfisicalClient` 时只传 `SiteUrl` 和 `AutoTokenRefresh`/`CacheExpiryInSeconds`，**没有传 `CaCertificate`**（[agent-vault client.go#L90-L99](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/infisical/client.go#L90-L99)）。
  - 后果：自签 CA 的 Infisical 实例无法直接使用（除非把 CA 装进系统信任库）。
  - 后果：`INFISICAL_URL` 若是 `http://`，SDK 会以明文 HTTP 发送 client secret 和读取到的 secret。代码没有强制 https（`INFISICAL_URL` 只做非空检查，client.go L80-L82）。这是一个配置项风险，不是默认行为。
- resty 默认读 `HTTP(S)_PROXY`：如果 broker 进程环境里有代理变量，Infisical 同步请求会走该代理。主线程 compose 里 broker 未设置 `HTTP_PROXY`（只有 app 设置），当前部署不受影响；但这是一个需要显式检查的部署项。

上游 MITM：

- `MinVersion: tls.VersionTLS12`，未设置 `InsecureSkipVerify`（[internal/mitm/proxy.go#L82-L90](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/mitm/proxy.go#L82-L90)、[connect.go#L104-L110](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/mitm/connect.go#L104-L110)）。
- SMTP 的 `InsecureSkipVerify` 是用户可配置的独立项（[internal/notify/notify.go#L127](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/notify/notify.go#L127)），与 Infisical 无关。

HTTP 上游（仅记录文档冲突，代理细节由主线程补充）：

- `isAbsoluteForwardProxyRequest` 只接受 `http://`，并明确说明「We accept only http://. https:// is rejected」（[internal/mitm/forward.go#L53-L76](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/mitm/forward.go#L53-L76)）。
- 这与 `docs/learn/security.mdx` L112「All proxied requests are forwarded over HTTPS」不一致。代码优先。

### 3.9 官方安全公告与版本差异

- `GET /repos/Infisical/infisical/security-advisories` 返回 `[]`；`GET /repos/Infisical/agent-vault/security-advisories` 返回 `[]`。
- OSV 查询 `infisical-python`（PyPI）、`@infisical/sdk`（npm）、`github.com/infisical/go-sdk`（Go）均返回 `{}`。
- 这不等于「无漏洞」，只说明这些数据库没有收录该仓库的 advisory。未做独立 CVE/NVD 扫描，不能断言 v0.40.0 是否存在可利用漏洞。
- Infisical 的披露政策在 `SECURITY.md`：通过 https://infisical.com/vulnerability-disclosure 报告；Cloud 的 bounty 是私有邀请制。
- 版本差异：`v0.40.0...v0.40.2` 只有一个 commit `d5836ec`（Go 1.26.10、Node 26.12.1、CA bundle、文档），没有业务逻辑修复。

### 3.10 文档措辞与代码的差异（代码优先）

| 文档声明 | 代码事实 | 影响 |
| --- | --- | --- |
| `security.mdx` L10：「No credential value stored in the vault is ever returned in an API response」 | `GET /v1/credentials?reveal=true` 对 member+ 返回明文（[handle_credentials.go#L114-L220](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/server/handle_credentials.go#L114-L220)） | 表述过强。reveal 是授权行为，proxy 角色被挡（L125-L131、[server.go#L662-L692](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/server/server.go#L662-L692)），不是绕权漏洞。同页 L191 的表格表述是准确的 |
| `security.mdx` L112：「All proxied requests are forwarded over HTTPS」 | 代码允许 `http://` 上游（forward.go L53-L76） | 表述过强。秘密可能已随明文请求发出，即使目标随后拒绝 HTTP；出口网络上的观察者也可能读取，并不要求控制响应 |
| `credential-stores.mdx` L15：Infisical 快照与内置凭据「at-rest threat model is identical」 | 属实（同一 DEK），但文档没有说明 Infisical 服务端可解密明文 | 容易让读者误以为端到端加密。建议补充「上游可读明文」 |
| `environment-variables.mdx` L79：「No credential values, request payloads, or secret data are ever included」 | 属实；但事件包含登录邮箱 | 「anonymous usage telemetry」与邮箱 distinctID 并存，措辞可以更准确 |

## 4. 未验证 / 限制

以下内容没有足够证据，不应写成结论：

1. **未连接真实 Infisical Cloud 或自托管实例**。Infisical 服务端行为来自源码阅读（v0.167.2），未用真实租户验证 raw API 的权限过滤和错误体内容。
2. **未构造上游错误体回显 secret 的场景**。3.3 节的条件性风险（`APIError.message` 进 stderr）是基于代码路径的推断，未实测。
3. **未做 CVE/NVD 扫描**。advisories 为空不代表无漏洞。
4. **未展开 Infisical KMS root key 的存储与访问控制**。只确认了「服务端用 CipherPair 解密」这一层。
5. **未验证自定义 CA 缺失在实际部署中的影响**（例如企业自签 Infisical 是否必须改代码）。
6. **未验证 `HTTP(S)_PROXY` 环境变量在 broker 容器中的实际取值**。compose 里 broker 未设置，但运行环境可能注入。
7. **动态密钥的 lease 值在内存中的生命周期**只读到续租/撤销逻辑，未做内存取证。
8. **镜像签名和发布包比对**未完成，详见 5.1。
9. **额外临时容器归属未确认**：研究过程中发现 4 个 `aster-vault-audit-*` 容器；后台研究任务尝试清理时被自动审批拒绝，理由是无法确认由其创建。主线程本次离线探测使用 `docker run --rm`，未据此扩大删除范围，未删除这 4 个容器或相关匿名卷。

## 5. 镜像、管理 API 与代理边界：源码与离线验证

### 5.1 镜像来源验证的结果与限度

本地 `infisical/agent-vault:0.40.0` 的 `RepoDigests` 报告 `infisical/agent-vault@sha256:4d490e2586c553ea121fa404b66812ad40c246cc841b0cc746682d0a360bdf1e`。这是本地 Docker 元数据，尚未独立核对远端多平台 manifest 或 cosign 签名，不应直接当成已核验的生产锁定摘要。

实际镜像二进制报告 `0.40.0`、commit `872578e`、构建时间 `2026-10-01T06:08:34Z`、`go1.25.0`。`go version -m` 的 `vcs.revision` 与 v0.40.0 tag 的完整 SHA 一致。记录同时包含 `vcs.modified=true`：不能据此认定恶意修改，也不能宣称已完成可复现构建验证。

镜像默认用户为 `agentvault`（Dockerfile 定义 uid 65532），默认环境只有 PATH/HOME。Dockerfile、entrypoint 和 `docker history` 未见本项目运行凭据或 Machine Identity 被嵌入；未扫描全部层，不能据此证明没有后门。[Dockerfile.goreleaser](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/Dockerfile.goreleaser#L1-L21)、[entrypoint](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/scripts/docker-entrypoint.sh#L1-L6)

发布配置声明对 manifests 做 cosign 签名，并为发布包生成校验和及 provenance。当前主机没有 cosign；Docker Hub 远端摘要请求及 GitHub release 二进制下载超时，未完成签名与发布包二进制比对。[签名配置](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/.goreleaser.yml#L39-L63)、[发布工作流](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/.github/workflows/release.yml#L49-L70)

上游已发布 [v0.40.2](https://github.com/Infisical/agent-vault/releases/tag/v0.40.2)，更新 release Go 运行时与 CA 包。建议评估升级并重新验收；本次没有 CVE 扫描，不能据此断言旧版存在可利用漏洞。[版本比较](https://github.com/Infisical/agent-vault/compare/v0.40.0...v0.40.2)、[PR 458](https://github.com/Infisical/agent-vault/pull/458)

### 5.2 响应回显会向应用暴露秘密

只过滤 hop-by-hop / Set-Cookie 响应头，其余响应头与正文直接转发。允许的接口若回显注入的认证信息、签发新 token，或目标被攻陷，应用可能获得秘密。这是响应信任边界，不等于存在任意目标取密漏洞。[过滤代码](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/brokercore/brokercore.go#L152-L158)、[响应转发](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/mitm/forward.go#L392-L410)

本仓库示例存在 `api.github.com:443/*`、`api.deepseek.com:443/*`、`api.openai.com:443/v1/*` 等宽路径。这不证明服务正在回显 key，但上线前需要审查实际放行接口，尤其是认证诊断、凭据管理和 token 签发。规则只匹配 host/path/port，没有 HTTP method 或业务动作约束。[规则类型](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/broker/broker.go#L30-L38)、[本仓库示例](../deploy/agent-vault/services.example.yaml)

### 5.3 端口 443 不等于强制 TLS

HTTP absolute-form 与 CONNECT 内部的 HTTPS 共用凭据注入，匹配不含 scheme。因此 `http://allowed-host:443/path` 仍可能匹配 `allowed-host:443/*`，把真实认证信息发在明文请求中。真实目标可能拒绝请求，但凭据可能已经被出口网络上的观察者取得，不要求攻击者控制响应。[HTTP 入口](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/mitm/forward.go#L48-L75)、[scheme 与注入](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/mitm/forward.go#L223-L241)、[上游 HTTP 注入测试](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/mitm/forward_test.go#L103-L177)

单 vault 模式让应用直连 broker，存在该请求入口。多 vault router 仅允许 CONNECT，配合 uid 防火墙禁止应用绕过，可以阻断该入口；完整内核隔离尚未实跑，不应当作已验收。[router](../router/internal/proxy/connect.go)、[网络规则](../deploy/agent-vault/network.sh)

CONNECT 外层 `Proxy-Authorization` 本身也通过 HTTP 发送，Basic 编码不加密。当前同机私有 bridge 收窄暴露范围，不能抵御宿主 root、Docker 管理员或具有抓包能力的入侵；跨主机应增加经认证的加密通道。该代理 header 会在转发到目标前被剥离。[传输说明](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/docs/learn/security.mdx#L121-L126)、[剥离代码](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/brokercore/brokercore.go#L67-L119)

### 5.4 未匹配目标默认放行，需要显式设置 deny

缺少或非法 `unmatched_host_policy` 的行为为 passthrough。未知目标不会自动获得注入的凭据，但可通过 broker 访问其他公网主机，扩大已有数据的外传范围。仓库文档要求设置 deny；Compose 本身不负责修改 broker 数据库中的该策略，必须验收实际状态。[默认策略](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/server/handle_vaults.go#L44-L62)、[未匹配分支](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/brokercore/credential.go#L145-L154)

### 5.5 当前部署中的宿主凭据和缓存撤销边界

Compose 通过 `private/vault.env` 的环境变量把主密码和 Machine Identity 交给 broker。该文件和 Docker 容器配置都属于秘密材料；应用未挂载它们，但宿主管理员或 Docker 管理权限仍能接触。程序调用 `os.Unsetenv` 不会删除宿主 env 文件或 Docker 保存的配置。不要把 broker 主机或已配置容器当成无秘密组件。[Compose](../docker-compose.agent-vault.yml)、[env 模板](../deploy/agent-vault/vault.env.example)

同步失败发生在 `ReplaceVaultCredentialsForSync` 之前时，只记录失败，不删除上次成功的缓存。撤销 Infisical 读取权限不会立即撤销已经缓存、仍可用于目标服务的 API key；紧急撤销需要在目标服务吊销凭据，并停用相应代理授权。当前没有最大缓存年龄关断。[同步代码](https://github.com/Infisical/agent-vault/blob/872578e4cdf9e03d5e3bcb5512023a70bf90ed65/internal/infisical/sync.go#L172-L187)、[当前运行契约](agent-vault.md#轮换失败与验收)

### 5.6 假凭据离线验证记录

从现有镜像复制二进制，在 `aster:local` 中使用 `--network none`、只读根目录与 tmpfs 状态运行。创建虚构 owner、proxy 角色 agent 与绑定 127.0.0.1:443 的 HTTP echo 服务。仅为本地假服务设置 `AGENT_VAULT_ALLOW_PRIVATE_RANGES=true`；生产应保留默认拒绝私有地址，不能照搬该开关。未挂载项目数据或 private 文件，探测容器使用 `--rm`，状态随 tmpfs 删除。

| 验证 | 结果 |
| --- | --- |
| 新 vault 未匹配策略 | passthrough |
| Owner 通过管理 API reveal | 成功，属于授权行为 |
| Proxy 角色通过管理 API reveal | 403 |
| HTTP 请求到匹配 host:443 的目标 | 注入测试凭据 |
| 目标回显 Authorization 到响应正文 | 应用得到测试凭据 |
| 目标回显 Authorization 到普通响应头 | 应用得到测试凭据 |
| 目标收到 Proxy-Authorization | 没有，剥离成功 |
| 此正常请求的 debug 日志含测试凭据 | 没有；不代表所有失败路径均安全 |

没有连接实际 Telegram、模型 API、Infisical 或 PostHog；没有对完整生产拓扑做网络验收。生产是否发生泄露不在本次检查可判断的范围内。

## 6. 引用清单

agent-vault v0.40.0（`872578e4cdf9e03d5e3bcb5512023a70bf90ed65`）：

- `internal/telemetry/telemetry.go`、`cmd/telemetry.go`、`cmd/version.go`
- `internal/server/server.go`、`internal/server/handle_credentials.go`、`internal/server/handle_vaults.go`
- `internal/infisical/auth.go`、`client.go`、`sync.go`、`dynamic.go`、`config.go`
- `internal/crypto/crypto.go`、`kdf.go`；`internal/auth/auth.go`
- `internal/store/038_master_key_kek_dek.go`、`050_dynamic_secret_leases.go`、`20260617143022_postgres_baseline.go`
- `internal/brokercore/brokercore.go`、`logging.go`；`internal/requestlog/sink.go`
- `internal/mitm/forward.go`、`proxy.go`、`connect.go`
- `cmd/server.go`、`cmd/run.go`、`cmd/helpers.go`
- `Dockerfile`、`.goreleaser.yml`、`.github/workflows/release.yml`
- `docs/learn/security.mdx`、`docs/learn/credential-stores.mdx`、`docs/self-hosting/environment-variables.mdx`

依赖：

- go-sdk `4ed5667bdf11d36643da4fd9cd05c660e30e24dd`：`secrets.go`、`client.go`、`client_auth_helper.go`、`packages/api/secrets/*`、`packages/api/auth/universal_auth_login.go`、`packages/models/secrets.go`、`packages/errors/errors.go`、`packages/util/helper.go`
- posthog-go `0216c2384b67ef39914e20fd0065c57243fb42d2`：`config.go`
- resty `baf7c1219b781803557018eba206ad8fa544941f`：`transport.go`

上游 Infisical `15390e1f0483ea3488b7354be88c54ee26ea59f5`（v0.167.2）：

- `backend-go/internal/server/api/secretmanager_routes.go`
- `backend-go/internal/server/api/secretmanager/secret/list_secrets.go`
- `backend-go/internal/server/api/secretmanager/secret/get_secret_by_name.go`
- `backend-go/internal/services/secretmanager/secret/secret.go`

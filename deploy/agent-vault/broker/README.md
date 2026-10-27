# 受审 Agent Vault 构建

本目录生成 `aster-vault` 镜像：在固定上游源码上应用本仓库补丁，用于替换存在已确认取密重定向与错误日志问题的 `infisical/agent-vault:0.40.0`。构建产物仍需通过 [密钥边界回归](../../../scripts/ci/README.md) 才能作为 Vault 模式镜像。

## 来源

| 组件 | 固定引用 | 校验 |
| --- | --- | --- |
| Agent Vault | commit `872578e4cdf9e03d5e3bcb5512023a70bf90ed65`（`v0.40.0`） | 归档 SHA256，见 `prepare.mjs` |
| Infisical go-sdk | commit `4ed5667bdf11d36643da4fd9cd05c660e30e24dd`（`v0.8.0`） | 同上 |
| Go 工具链 | `go1.25.6` 官方归档 | 下载后校验 SHA256，`GOTOOLCHAIN=local` |
| 构建 Node | `node:24.19.0-bookworm-slim` 固定 digest | 与 `.node-version` 一致 |
| 运行基底 | `infisical/agent-vault@sha256:4d490e25...` | 只复用运行环境、CA、账号和 entrypoint |

`prepare.mjs` 直接下载固定 commit 的归档，校验 SHA256 后只解出所需文件；不解析 tag 或分支，不执行上游脚本、Dockerfile、Makefile 或构建钩子。`git apply` 使用精确上下文，补丁不匹配即失败，不做模糊匹配。

## 补丁范围

`upstream.patch` 与 `infisical_security.go.in` 共同实现：

- `INFISICAL_URL` 必须是显式 HTTPS origin，拒绝 userinfo、路径、query、fragment 和非法端口。
- 所有 SDK 与手写请求共用受控 `http.Client`：只允许该 origin，拒绝全部重定向（含同域），禁用环境代理，强制 TLS 校验与最低 TLS 1.2。
- 只允许 Universal Auth。其他云身份方法会使用独立 metadata／STS 客户端，不在本次审核范围，返回固定错误。
- SDK 内部重试关闭，由现有同步器负责重试，避免拒绝重定向被当作网络错误重发登录或写请求。
- SDK 日志出口丢弃库提供的参数，仅保留固定事件；错误只保留受限状态码或固定信息，不输出上游正文、URL、凭据或完整错误。
- 登录失败时取消 SDK 后台生命周期，不留下续期任务。
- `getProjectSlug` 对 project ID 做路径转义，限制响应大小并统一错误。

`api_policy.go.in` 的 `APIPolicy`／`APIRule` 和严格加载器是 API 操作策略的唯一 schema 权威；不另建 JSON Schema 或在 router 复制 method/path 清单。`api-policy.example.yaml` 只提供部署示例。字段为 `version: 1` 和 `rules`，每条规则精确匹配已认证的 `vault`、`target`（小写 DNS host:port）、大写 `method`、注入前的 `path`。`rules: []` 明确拒绝全部。未知／重复字段、重复规则、多文档、非法值、超过 1 MiB 或 1024 条规则均拒绝；不支持通配符、前缀、regex 或隐式 HEAD。路径只支持未编码的 ASCII 规范路径，拒绝百分号编码、点段、重复斜线、尾斜线和 query 写在 path 字段中。

正式 `cmd/server.go` 通过 `ASTER_VAULT_API_POLICY` 加载只读文件并把不可变快照传给 MITM；未设置策略时代理全部返回 403，设置后文件缺失、不可读、无效则启动失败。修改文件后须重建 broker 容器／重启进程，不做热加载。正式 `forwardRequest` 对每个 TLS 解密请求在凭据读取、替换、body 读取及上游 I/O 之前判定，复用同一 CONNECT tunnel 也逐次校验；普通 HTTP、协议升级和常用 method/path override header 被拒绝。单 vault 直连 broker 和多 vault router 最终进入同一门禁，vault 取自认证后的 scope，不信任客户端自报身份。上游服务规则仍负责凭据注入，两者取交集；宽泛注入 selector 本身不能授予 API 操作。

该策略只约束操作地址与 method，允许路径中的 query/body 参数及响应内容尚未受语义约束；代理不会过滤获准接口回显的认证值或派生 token。凭据回显风险仍是生产准入阻塞，不能因本阶段通过而宣称已解决。管理 API 使用既有权限边界；本策略只适用于 MITM 代理出口。

持久化格式未改动。`infisical_security_test.go.in` 随构建执行，覆盖真实客户端的登录、取密、project 查询、自动续期、301/302/303/307/308、同域与跨域重定向、400/422/500、TLS 与 origin 校验，以及双日志出口。

## 构建

```sh
docker build -t aster-vault:local deploy/agent-vault/broker
```

`go test` 在构建阶段执行，失败即中止。镜像标签记录上游 commit 与版本。构建需要访问 GitHub 归档和 `go.dev`；下载或校验失败时不使用缓存产物冒充成功。

## 验证与已知边界

```sh
npm run test:vault-security
```

`npm run test:vault-security` 默认使用 `aster-vault:ci`，可用 `VAULT_CI_IMAGE` 指定。回归覆盖真实镜像的取密、权限、错误日志、重定向、TLS 与 API 操作策略；历史取密补丁为 16/16（本机与 GitHub 托管 runner），新增 API 策略的本地结果见 [实施计划](../../../docs/ci-cd-implementation-plan.md)。构建期实际执行整个 MITM 测试包（`go test -v -count=1`）及 `go vet`。上游 TLS 用例逐项配置经正式加载器校验的精确测试规则，保留凭据注入、透传、端口路由、TLS 验证、替换、请求／响应限额和流式传输断言；`setupProxy` 默认仍为 nil 策略。可迁移的 HTTP 注入、逐跳 header 清理、SSRF、日志、keepalive 和端口提取用例改走 CONNECT/TLS；HTTP 成功认证限流用例验证认证后返回 403 且不消耗失败预算。chunked 响应限额用例额外要求先收到 200，避免默认拒绝导致假通过。6 项 WebSocket 入口测试（含原本需要真实密钥的 xAI／OpenAI 集成）、普通 HTTP WebSocket 和 IPv6 转发成功用例共 8 项显式跳过：新策略禁止 upgrade、普通 HTTP 和 IPv6 策略 target，不能保留这些成功预期。WebSocket 帧处理与 Host 格式单元测试仍执行；`TestReviewedAPI*` 通过真实 CONNECT/TLS 验证这些入口的拒绝及零凭据／上游调用，不把跳过项计为通过。完整拓扑另需 `npm run test:topology`，见 [CI 运行入口](../../../scripts/ci/README.md)。

尚未完成：

- 与上游发布产物的独立签名验证、完整镜像 SBOM／漏洞扫描和可重现构建比对。
- 升级到上游新版本后的等价性验证；新版本必须先通过同一回归，不能只改版本号。
- 多架构运行证据。当前只验证 linux/amd64。
- 数据卷从旧版本升级、主密码迁移和备份恢复。

这些缺口属于发布准入条件，见 [CI/CD 实施计划](../../../docs/ci-cd-implementation-plan.md)；本目录的构建成功不代表生产已可接入真实密钥。

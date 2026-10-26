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

`npm run test:vault-security` 默认使用 `aster-vault:ci`，可用 `VAULT_CI_IMAGE` 指定。回归覆盖真实镜像的取密、权限、错误日志、重定向与 TLS 行为；当前受审构建 16/16 通过（本机与 GitHub 托管 runner）。完整拓扑另需 `npm run test:topology`，见 [CI 运行入口](../../../scripts/ci/README.md)。

尚未完成：

- 与上游发布产物的独立签名验证、完整镜像 SBOM／漏洞扫描和可重现构建比对。
- 升级到上游新版本后的等价性验证；新版本必须先通过同一回归，不能只改版本号。
- 多架构运行证据。当前只验证 linux/amd64。
- 数据卷从旧版本升级、主密码迁移和备份恢复。

这些缺口属于发布准入条件，见 [CI/CD 实施计划](../../../docs/ci-cd-implementation-plan.md)；本目录的构建成功不代表生产已可接入真实密钥。

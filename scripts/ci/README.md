# CI 运行入口

设计与进度见 [CI/CD 实施计划](../../docs/ci-cd-implementation-plan.md)。这些检查使用虚构凭据，不读取 `deploy/agent-vault/private` 或生产数据卷，也不联系真实 Infisical、Telegram 或模型服务。

## Broker 镜像回归

需要 Node.js（版本见 `.node-version`）、Linux Docker engine、OpenSSL，以及本地已有的 fixture 镜像。

```sh
docker build -t aster-vault:ci deploy/agent-vault/broker
npm run test:vault-security
```

可通过 `VAULT_CI_IMAGE` 选择待测 broker 镜像，`CI_NODE_IMAGE` 选择 fixture 镜像（默认 `node:24.19.0-bookworm-slim`），`CI_OPENSSL` 指定 OpenSSL 可执行文件。脚本不自动构建或发布镜像。Windows 使用 PowerShell 环境变量语法，例如 `$env:CI_OPENSSL='C:\Program Files\Git\mingw64\bin\openssl.exe'`。

脚本创建每轮独立的临时文件夹、证书和随机合成凭据。fixture 在 `--network none` 下运行，broker 共享其网络命名空间，数据在 tmpfs；仅测试实例读取测试 CA。检查结束删除本轮容器和临时文件，不使用 `docker system prune` 或生产卷名。

通过标准包括正常 HTTPS 登录取密、proxy 管理权限拒绝、首次／手动／定时同步错误输出、登录错误、登录和带 bearer 取密的跨域 307/308、同域跳转、HTTP 降级、HTTP 配置、未知 CA 和主机名不匹配。自动 token 刷新由受审构建的客户端回归补充，不能将镜像这组用例独自解释为覆盖所有 SDK 路径。

脚本检查容器 stdout 和 stderr；API 输出、日志中出现合成秘密或常见编码即失败。错误只输出步骤名称，不输出捕获的正文、环境、完整断言值或容器日志。失败时不自动上传数据库、证书私钥或日志。

可用原始镜像验证阻断行为：

```sh
VAULT_CI_IMAGE=infisical/agent-vault:0.40.0 npm run test:vault-security
```

原始 `0.40.0` 的上游错误日志包含合成秘密，应退出 1。这个预期失败只用于确认回归能检测缺陷；正式 CI 不反转退出码，不把已知泄露列为通过。

## 完整拓扑

完整拓扑由 `compose-topology.mjs` 和 `topology` 系列脚本运行正式 Compose 和最终镜像：

```sh
docker build -t aster:ci .
docker build -t aster-router:ci router
docker build -t aster-network:ci -f deploy/agent-vault/network.Dockerfile deploy/agent-vault
# 还需前一节的 aster-vault:ci
npm run test:topology
```

仅检查临时 Compose 渲染及边界，不启动镜像：

```sh
npm run test:topology -- --render-only
```

镜像可通过 `ASTER_IMAGE`、`ASTER_ROUTER_IMAGE`、`ASTER_NETWORK_IMAGE`、`VAULT_CI_IMAGE` 指定，默认均为上述 `:ci` tag。脚本运行正式 app/router/firewall 入口，通过测试 CA 与本地域名映射连接模拟 Infisical、Telegram 和一个模型提供商；没有修改生产 endpoint 或 TLS 校验。

未匹配主机策略由 broker 在 CONNECT 隧道内判定，隧道 TLS 使用 broker 自签发的 MITM CA（`/v1/mitm/ca.pem`），不是 fixture CA；探针按此读取隧道内状态码，不对 CONNECT 自身的 200 作策略断言。

临时 `AGENT_VAULT_ALLOW_PRIVATE_RANGES=true` 仅用于 broker 访问本地 fixture，不能复制到生产。防火墙否定测试先用同命名空间 uid 0 连接活跃目标和 DNS 作正控；公网正控依赖 `1.1.1.1:443`，无相应网络时该项失败，不能计为隔离通过。IPv6、执行中／投递中崩溃点、完整 API 方法／路径限制及响应回显预防仍需后续验收。具体覆盖以实施计划和脚本实际检查为准；容器存在、渲染成功不能替代业务与网络验收。

当前运行验收为 11 项全部通过（本机，四个最终镜像）。失败时只输出失败步骤名与阶段标识，不输出容器日志、环境、断言值或响应正文；排查需自行复现，不能把日志上传当作诊断捷径。

## GitHub Actions

`ci.yml` 包含 Linux Node、Go 和最终镜像 jobs。它不发布镜像、不部署，也不持有生产 secrets。完整镜像 job 依次构建受审 broker、运行泄露回归、构建其他正式镜像并执行拓扑检查。构建、检查或网络依赖失败均保留失败状态，不使用 `continue-on-error` 放行。

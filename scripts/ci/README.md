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

通过标准包括正常 HTTPS 登录取密、proxy 管理权限拒绝、正式 CONNECT/TLS 解密路径下的单／多 vault 操作正反检查、策略未配置／空规则默认拒绝与无效／不可读文件启动失败、首次／手动／定时同步错误输出、登录错误、登录和带 bearer 取密的跨域 307/308、同域跳转、HTTP 降级、HTTP 配置、未知 CA 和主机名不匹配。操作负例使用同域错误方法、导出／token／echo 路径、编码路径和 method override，并检查未到达 fixture；正例验证凭据注入。自动 token 刷新由受审构建的客户端回归补充，不能将镜像这组用例独自解释为覆盖所有 SDK 路径。

API 策略的唯一 schema 位于 [`api_policy.go.in`](../../deploy/agent-vault/broker/api_policy.go.in)。构建期运行 MITM 测试包和 `go vet`；旧测试按新策略适配，禁止的旧入口测试显式跳过，详见 [broker 验证说明](../../deploy/agent-vault/broker/README.md)。本阶段不校验获准接口的 query/body 语义，也不阻止其响应回显认证值；该缺口继续阻塞生产准入。

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

只有 Docker 的 Linux 主机可通过 `bash scripts/ci/topology-on-docker-host.sh` 在临时运维容器里执行同一组检查，要求显式设置上述四个变量及 `ASTER_DEPLOYMENT_TOOLS_IMAGE`，所有镜像须已导入本机。准备方法和隔离限制见 [主机演练入口](../deploy/README.md#隔离演练)。直接运行 Node 入口时，若未提供运维镜像则自动构建本轮临时运维镜像；提供时只复用，不拉取、不重建或删除该镜像。

每轮在独立临时目录生成 `api-policy.yaml`，仅允许 `telegram` vault 的四个 POST 操作（`getMe`、`getWebhookInfo`、`getUpdates`、`sendMessage`）及 `deepseek` vault 的 `POST /chat/completions`，Telegram 路径使用 token 占位符。通过 `ASTER_VAULT_API_POLICY` 指向 broker 的只读 bind mount，并在 render 中核对策略源文件、挂载属性及全部资源隔离边界；不挂载生产策略或读取 private 目录。策略 schema 仍以 [`api_policy.go.in`](../../deploy/agent-vault/broker/api_policy.go.in) 为准。

未匹配主机与 API 操作策略由 broker 在 CONNECT 隧道内判定，隧道 TLS 使用 broker 自签发的 MITM CA（`/v1/mitm/ca.pem`），不是 fixture CA；探针按此读取隧道内状态码，不对 CONNECT 自身的 200 作策略断言。两 vault 各有一个获准操作正例，验证路径替换／bearer 注入；同域错误方法、export／tokens／echo 路径、编码路径、尾部斜杠及 method override 必须返回 403，且 fixture 应用请求计数不变。正反例使用合成凭据并扫描响应；这不证明获准接口自身不能回显认证值。

临时 `AGENT_VAULT_ALLOW_PRIVATE_RANGES=true` 仅用于 broker 访问本地 fixture，不能复制到生产。防火墙否定测试先用同命名空间 uid 0 连接活跃目标和 DNS 作正控；公网正控依赖 `1.1.1.1:443`，无相应网络时该项失败，不能计为隔离通过。执行和投递中断、IPv6 与 API 策略的具体覆盖及实际运行结果以实施计划为准；响应回显防护仍待验收。容器存在、渲染成功不能替代业务与网络验收。

历史版本曾在本机与 GitHub 托管 runner 通过 11 项；这不是当前扩展用例的托管验证结果。本轮本机以 `VAULT_CI_IMAGE=aster-vault:ci05`、`aster:ci`、`aster-router:ci` 和重建的 `aster-network:ci` 运行，render 通过，完整拓扑 **16 项全部通过**：包括 API 操作正反检查、执行中／投递中 SIGKILL 恢复、IPv6 活跃目标 uid 0 正控及 uid 1000／1001 出站拒绝，以及 IPv6 入站 TCP 拒绝。入站检查在 app 命名空间启动真实 IPv6 监听器，由 uid 0 从该命名空间地址确认监听可达，再确认 fixture IPv6 目标可达，从 fixture 连接该监听器须超时；拒绝不以无路由或端口未监听冒充通过。此前 IPv6 正控失败保留为历史失败；本轮使用主代理修正 NDP 后重建的网络镜像，拓扑脚本未改写防火墙规则。随后以最终 broker 镜像 `aster-vault:mitm-reviewed-20261027`（MITM 全包 56 PASS／8 显式 SKIP）复跑，同样 16 项通过。推送后的托管运行 40457199779 三个 job 全部通过，实际输出 `Vault image regression passed: 21 checks` 与 `Topology acceptance passed: 16 checks`，与本机一致。

未覆盖中断的不安全工具重放、公网 IPv6／DNS IPv6 正控、获准接口的 query/body 语义与认证值回显防护，以及发布／生产准入。失败时只输出失败步骤名与阶段标识，不输出容器日志、环境、断言值或响应正文；排查需自行复现，不能把日志上传当作诊断捷径。

## 离线发布清单绑定预检（CI-07 基础）

`npm run release:preflight` 是只读、离线的发布材料一致性检查，要求 Node.js（版本见 `.node-version`）及本地已安装的项目依赖；可在交付准备机运行，不改变目标服务器只需 Docker 的部署基线。它不运行 Docker、Compose、Git 或外部程序，不读取环境里的镜像变量、private 配置和数据卷，不拉取镜像、不联网、不写部署文件。这里的策略文件由调用者显式选择，不默认读取或假定仓库已有 CI-05 策略。

版本化 JSON 契约的权威来源是 [`ReleaseManifestSchema`](../../src/release-manifest.ts)。v1 的 `kind` 固定为 `aster.release-bindings`，表示完整发布清单的绑定基础；未来签名、扫描与验收证据需要单独定义和验证，不能往 v1 填入 `signatureVerified`、`accepted` 等字段冒充完成。所有层级拒绝未知字段，JSON 重复键（含转义后同名）也拒绝。

清单形状如下；尖括号为必须替换的占位说明，不能原样通过校验：

```json
{
  "schemaVersion": 1,
  "kind": "aster.release-bindings",
  "sourceCommit": "<40 位小写十六进制 Git commit>",
  "platform": "linux/amd64",
  "images": {
    "app": "ghcr.io/<owner>/aster@sha256:<64 位小写十六进制>",
    "router": "ghcr.io/<owner>/aster-router@sha256:<64 位小写十六进制>",
    "network": "ghcr.io/<owner>/aster-network@sha256:<64 位小写十六进制>",
    "broker": "ghcr.io/<owner>/aster-vault@sha256:<64 位小写十六进制>"
  },
  "compose": [
    { "path": "docker-compose.agent-vault.yml", "sha256": "sha256:<64 位小写十六进制>" },
    { "path": "docker-compose.router.yml", "sha256": "sha256:<64 位小写十六进制>" }
  ],
  "policy": { "sha256": "sha256:<64 位小写十六进制>" }
}
```

摘要计算对象是本地文件的**完整原始字节**，不规范化换行、不解析 YAML、不展开 Compose 环境变量。Compose 仅支持上述固定顺序的 Vault + router 两文件组合，不接受 build override、其他部署模式或清单提供的任意路径。策略对象没有路径字段；本地路径只来自 `--policy`。文件必须是普通文件，清单上限 64 KiB，单份 Compose／策略上限 1 MiB；策略不能为空。使用 POSIX 命名管道等特殊文件也会拒绝。清单编码限定严格 UTF-8，无 BOM。

`docker-compose.management-loopback.yml` 与[部署环境描述](../../docs/deployment-environments.md)不属于 v1 绑定范围：v1 语义保持不变，也不会因为文件出现在仓库里就被视为已绑定。把它们纳入发布材料需要新的版本化契约（阶段 B），在此之前叠加了回环 override 的部署不能用现有 v1 清单声称材料完整。

从独立、可信的交付选择中取得预期 commit 和四镜像完整引用，再显式传入（以下变量需由运维自行设置，不从待检查清单提取）：

```sh
npm run release:preflight -- \
  --manifest /staging/release.json \
  --compose-root /staging/checkout \
  --policy /staging/selected-policy.yaml \
  --commit "$EXPECTED_COMMIT" \
  --app "$APP_REF" --router "$ROUTER_REF" \
  --network "$NETWORK_REF" --broker "$BROKER_REF"
```

四镜像都必须使用显式 DNS registry（可带 1–65535 端口）及无 tag 的 `repository@sha256:<digest>`，例如 `ghcr.io/team/aster@sha256:…`；拒绝裸 digest、本地 tag、隐式 Docker Hub、带 tag 的 digest 引用及 URL。逐角色核对**完整引用**，相同 digest 换仓库也失败。`sourceCommit` 与调用者预期值比较，不证明本地 checkout 或镜像由该提交构建。`platform` 仅限定清单声明为当前支持的 `linux/amd64`，不证明镜像平台。把预期引用从同一份未受信清单复制出来无法提供独立核对。

通过时退出 0，并输出：

```json
{"status":"offline-bindings-ok","productionAdmission":"not-evaluated"}
```

失败时退出 1，仅输出固定 `code`，例如 `MANIFEST_INVALID_SCHEMA`、`COMMIT_MISMATCH`、`IMAGE_BROKER_MISMATCH`、`COMPOSE_0_DIGEST_MISMATCH`、`POLICY_UNREADABLE`、`POLICY_DIGEST_MISMATCH`；不回显输入内容、路径或底层异常。`COMPOSE_0`／`COMPOSE_1` 分别对应上述顺序的两文件。`--help` 只展示用法，不执行检查。

此结果只证明本次读取的材料绑定一致。策略内容视为不透明字节：任意非空文件即使摘要匹配，也不能证明 schema、方法／路径限制、响应回显保护或 broker 实际执行已满足 CI-05。缺失策略文件会失败，没有“跳过策略”选项；测试中的合成策略仅用于验证摘要绑定。当前仓库没有可据此宣布安全准入的正式策略，生产仍被该关卡阻断。

该工具还不验证清单或镜像签名、发布者身份、registry 内容／平台、同产物验收证据、SBOM／扫描，不证明当前环境实际使用这些四镜像引用；也不检查真实 Infisical 权限、DEK 包装、主密码、卷权限、备份、单实例更新及业务就绪。独立的卷元数据检查与整卷备份入口见 [CI-07 主机准备与离线备份](../deploy/README.md)，不改变此工具的离线绑定职责。调用后文件仍可能变化，不提供部署锁或事务。后续 CD 必须在完成验签与其他准入关卡后，使用相同材料和引用并防止检查后被替换；退出 0 不能直接作为生产 `up` 的授权。CI-05、CI-06 和完整 CI-07 保持待完成。

测试随 `npm test` 执行；单独运行：

```sh
npx tsx --test test/release-preflight.test.ts
```

## GitHub Actions

`ci.yml` 包含 Linux Node、Go 和最终镜像 jobs。它不发布镜像、不部署，也不持有生产 secrets。完整镜像 job 依次构建受审 broker、运行泄露回归、构建其他正式镜像、运行 Linux 卷权限及独立只读 WAL 检查，最后构建临时运维镜像并通过 Docker 主机入口执行拓扑检查。构建、检查或网络依赖失败均保留失败状态，不使用 `continue-on-error` 放行。

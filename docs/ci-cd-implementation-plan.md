# Aster CI/CD 设计与实施计划

日期：2026-10-27。状态：实施中。

本文记录本次 CI/CD 的设计、任务与验收进度。运行命令以 `package.json` 和相应脚本为准；部署步骤见 [部署指南](deployment-test-guide.md)，安全证据见 [Agent Vault 调查](agent-vault-security-investigation.md)。本文的待办项不代表已实现或已获生产准入。

## 目标与交付边界

交付单位是一组已验收的镜像、Compose 与 API 策略。CI 验证代码、最终运行镜像、完整架构与密钥边界；发布绑定受测产物的 digest；部署验证真实环境条件。生产密钥只留在部署环境，普通 PR 不接触真实 Infisical、Telegram 或模型凭据。

当前优先交付 broker 受审构建与泄露回归、完整 Compose 验收、PR CI。镜像发布、签名、远端设置和生产部署须在相应关卡具备证据后接入；本次本地实施不等于已经执行发布或部署。

## Broker 受审构建

固定 Agent Vault 上游 commit，保存补丁、构建入口和测试。补丁至少要求：

- Infisical 地址为显式 HTTPS origin，不允许 userinfo、路径、query 或 fragment；实际客户端拒绝全部重定向，包括同域跳转。
- 约束传输层请求目标，不能仅检查启动环境变量；TLS 证书和主机名校验保持启用。
- 登录、自动刷新、首次取密、定时与手动同步以及重试日志不得输出原始上游正文、请求凭据或完整 SDK 错误。
- 保持现有持久化格式，另行验证加密数据卷恢复与升级兼容性。

维护范围明确的 `aster-vault` 构建，记录上游来源和补丁。受审构建只支持当前部署所用的 Universal Auth；其他云身份流程具有独立 metadata／STS 网络链路，需要单独审核后才能启用。上游新版本通过同一回归后再替换；固定 tag、关闭 debug 或日志掩码不代替修复。

## 工作流与权限

| 文件 | 触发 | 职责 | 权限 |
| --- | --- | --- | --- |
| `.github/workflows/ci.yml` | PR、main 提交、手动 | Linux Node/Go 检查，最终镜像与安全验收 | contents read；无真实凭据，无发布权限 |
| `.github/workflows/release.yml`（待实现） | 指定 main 提交或版本 tag | 构建并验收待发布产物，SBOM、扫描、签名与发布清单 | 发布 job 才获得 packages write / id-token write |
| `.github/workflows/deploy.yml`（待实现） | 初期手动选择发布版本 | 验签、目标机预检、单实例更新及业务检查 | 受保护部署环境，仅部署所需权限 |

Actions 固定完整 commit SHA。PR 不通过 `pull_request_target` 携带秘密执行贡献者代码。没有完整准入结果时，基础 CI 成功只能说明其实际覆盖的检查成功。

## 最终镜像与架构验收

实际链路为：最终应用镜像 → CONNECT router → broker → 模拟 Telegram／模型／工具 API，broker 向模拟 Infisical 登录和取密。

运行镜像中的正式 `main.js`、实际协议客户端与 pi-durable。通过临时 DNS 和测试 CA 指向 fixture；不增加生产任意 endpoint 或关闭 TLS 的测试开关。模拟服务实现所需协议和流式响应，不替换正式业务入口。

测试 Compose 必须保留生产 UID、网络命名空间、防火墙及只读挂载边界，只替换 fixture、CA、虚构凭据和临时资源。生产 Compose 使用显式卷名，CI 必须覆盖成每次运行独立的卷，不能仅改 project name。清理只操作本次创建的资源。

| 验收面 | 通过标准 |
| --- | --- |
| 正常业务 | Telegram 接收 → 模型流式响应 → 回复投递，状态持久化 |
| 恢复 | 明确同步点中断并重启，复用执行和已保存回复；未知投递遵守现有契约 |
| 单实例与关闭 | 同卷第二实例被拒绝；SIGTERM 关闭；强杀后恢复 |
| 取密传输 | 坏 CA／主机名拒绝；跨域 307/308、同域跳转及降级不能发送 client secret 或 bearer |
| 日志 | 登录、刷新、首次／定时／手动同步的 4xx/422/5xx 错误夹带秘密时，容器日志、health 和 API 无秘密 |
| 网络 | app uid 无法直连公网、broker 代理或管理端口；普通 HTTP 被拒绝，合法 CONNECT 可用；IPv4/IPv6/DNS 旁路受限 |
| 管理权限 | 匿名未认证，proxy 不能 reveal、改规则或创建外部 vault；未知目标显式 deny |
| 镜像及挂载 | app 不含 Infisical 身份或主密码；镜像层与发布材料不含秘密 |

每轮生成虚构随机秘密，检查原值及常见编码。允许目标接收认证值；应用输出、日志及产物不允许。诊断先扫描再输出，不无条件上传容器日志、数据库或环境。保留测试失败状态，不能将“检测到了泄露”计为生产验收通过。

Linux 文件系统失败测试应触发真实失败并断言旧文件完整和重试行为；修正 `chmod 0444` 可以阻止 Linux rename 的错误假设，不跳过用例。

## API 操作策略

CONNECT router 约束 host:port；解密后的路径和 HTTP method 必须由 broker 或可信适配层执行。用一份带 schema 的策略作为权威来源，并生成或校验实际 broker 规则，不复制维护多份清单。

按功能只开放实际需要的 Telegram、模型推理和工具操作；验证同域未授权路径／方法、凭据导出、回显与 token 创建被拒绝。当前宽泛 `/*`、`/v1/*` 和缺少 method allowlist 的规则不足以直接放行生产。

获准接口若可回显认证值，普通代理不能保证应用看不到秘密。该接口需要专用可信响应适配或移出支持范围；通用字符串替换不能覆盖派生 token 与任意编码。响应回显缺口必须保留为准入阻塞。

## 发布产物

构建最终镜像 → 验收同一批镜像 → 完整镜像 SBOM 与漏洞扫描 → 发布同一产物 → digest 签名 → 签名发布清单。验收后不重新构建另一批镜像。

清单关联应用、router、network、broker digest、源码 commit、Compose 与策略摘要及验收证据。上游镜像验证预期发布身份；受审构建验证本仓库 release workflow 身份。签名／扫描工具失败不跳过，漏洞例外明确范围和期限。初期只发布实际验收过的 linux/amd64，其他架构需补运行证据。

## 部署环境预检与更新

CI 无法证明生产机器身份和旧数据卷状态。目标机预检只返回状态或受限错误码，不导出秘密：

- 核对真实机器身份仅对指定项目、环境、路径静态读取，包含引用展开边界。拒绝写入、兄弟路径、其他环境和未使用动态租约的验证在专用测试项目进行。
- 检查现存 Vault DEK 已被主密码包装，不能只看环境变量非空；passwordless 卷需迁移。
- 核对实际规则、主密码、卷权限、备份与被批准策略匹配。
- 使用独立测试 bot 做真实服务联调，记录目标机资源使用；单台 4c/4g 不同时启动两个实例消费同一 bot。

验证签名清单 → 预检 → 停止并备份持久化状态 → 更新相关服务及共享网络命名空间 → 业务验收。容器 running、离线配置检查、router 当前 `/readyz` 均不能单独证明业务就绪。

回滚需区分镜像与数据兼容性；失败可以停止推进，不能自动恢复旧数据库备份冒充无损回滚。

## 实施任务与进度

| 编号 | 交付 | 完成条件 | 状态 |
| --- | --- | --- | --- |
| CI-01 | 方案保存、来源及验收边界 | 本文、README 入口 | 已完成 |
| CI-02 | broker 固定来源与补丁 | 真实客户端重定向／错误日志回归通过 | 已完成 |
| CI-03 | Linux 基础 CI | Node check/test/build，Go race/vet，文件失败测试修正 | 已完成（本地与托管均通过） |
| CI-04 | 完整最终镜像拓扑 | 临时资源、业务链路、恢复及内核网络拒绝用例 | 已完成（本地与托管均为 11/11） |
| CI-05 | API 策略执行 | schema、正式执行路径及正反用例 | 待实现 |
| CI-06 | 发布与供应链验证 | 同产物扫描、签名、发布清单 | 待实现 |
| CI-07 | 部署预检与 CD | 真实最小权限、卷保护、备份更新与业务检查 | 待实现 |

验收记录随实施追加在相应任务下，明确本地执行结果、Linux/GitHub 执行情况和剩余阻塞。

### 2026-10-27 第一阶段记录

- 已增加 `.github/workflows/ci.yml` 的 Node、Go 与最终镜像验收 jobs，工作流仅 `contents: read`，checkout 不持久化凭据。Action 版本固定完整 SHA，`actionlint v1.7.12` 校验通过；尚未推送或触发 GitHub 托管执行。
- 文件失败测试改用真实临时路径冲突，Windows 和 Linux 的 memory daily 用例均 7/7 通过。Linux Node 24.19.0 独立临时容器中 `npm ci`、`npm run check`、137/137 测试、`npm run build` 通过；精简镜像第一次因缺 OpenSSL 为 136/137，安装测试所需 OpenSSL 后全量通过。验证容器未挂载生产目录或卷。
- Linux Go 1.25.6 独立临时容器中 `go test -race ./...` 和 `go vet ./...` 通过。
- `npm run test:vault-security` 使用临时断网 fixture、每轮随机合成秘密与内存数据卷，涵盖正常 HTTPS 同步、管理权限、上游错误、重定向及 TLS。受审镜像 `aster-vault:ci` 16/16 通过。以原始 `0.40.0` 作反向验证时，正常同步通过，错误日志检查如预期失败，退出 1；这次预期失败证明该旧镜像被阻断，不是生产验收通过。
- Compose broker 默认改为 `ASTER_VAULT_IMAGE`／`aster-vault:local`，避免默认继续使用已确认存在问题的上游 tag。受审构建位于 `deploy/agent-vault/broker/`，固定上游 commit、SDK commit、Go 归档与运行基底 digest；构建阶段执行客户端安全测试，失败即中止。
- 完整拓扑脚本已增加 `npm run test:topology`。`npm run test:topology -- --render-only` 本地通过，验证独立卷、无生产 private 挂载、无发布端口、正式 app/router 入口及 UID／只读／capabilities 边界。
- 本机完成四个最终镜像构建后，完整拓扑运行验收 11/11 通过：Compose 隔离与生产边界、最终镜像存在、临时 CA、broker HTTPS 同步与 proxy 权限（含匿名 401、proxy reveal／改规则／建外部 vault 均 403、隧道内未知主机 403）、最终 `main.js` 的 Telegram 接收→模型流式响应→回复投递与持久化、同命名空间 uid 0 网络正控、uid 1000 防火墙拒绝与 CONNECT 允许、同卷第二实例 flock 拒绝、SIGTERM 与 SIGKILL 重启不重放已完成请求、容器日志无合成凭据。
- 本机构建 `aster-router:ci` 与 `aster-network:ci` 时，Docker Hub 匿名 token 服务连接超时。改用本地已有的同 digest 基础镜像（`debian:bookworm-slim`、`alpine:3.24.1@sha256:28bd5fe8…`）后构建成功；仓库 Dockerfile 的固定引用未改动，因此产物与固定基础镜像一致，但这只说明本机取镜像路径受限，不代表托管 runner 的网络条件已验收。
- 拓扑脚本修正了两处验收层错误：CONNECT 隧道由 broker 用自签发 CA 终结，未匹配主机策略在隧道内判定，原先对 CONNECT 响应断言 403 属错误层级；fixture 控制请求需要显式 JSON Content-Type。诊断只输出步骤名，不输出容器日志、环境或断言值。
- 脚本目前覆盖完成请求的重启去重，不代替执行中／投递中崩溃点验收；IPv6 无可达正控时不计为已覆盖；API 方法与路径限制、凭据回显预防仍待 CI-05。未完成的安全关卡不以基础测试成功替代。

### 2026-10-27 托管执行记录

- `ci.yml` 已推送到 `feat/memory-archive` 并由 PR 触发托管执行。运行 40376404907 三个 job 全部通过：Node.js（`npm ci`、`check`、137/137 测试、`build`）、Go router（`go test -race ./...`、`go vet ./...`，补齐了本机 Windows 无 CGO 的缺口）、Final images and credential boundaries（受审 broker 构建含构建期客户端测试、16/16 密钥边界回归、三个正式镜像构建、11/11 完整拓扑）。
- 托管 runner 上的实际检查输出为 `Vault image regression passed: 16 checks` 与 `Topology acceptance passed: 11 checks`，与本机结果一致；因此四个最终镜像在托管 runner 上同样构建成功，先前记录的取镜像受限只是本机网络条件。
- 托管执行暴露了一个本机无法复现的缺陷：fixture 容器以 root 加 `--cap-drop ALL` 运行，没有 `CAP_DAC_OVERRIDE`，而 `openssl` 以调用者身份写出 0600 的 `key.pem`；runner 上调用者既非 root 也不在文件组内，读失败导致 fixture 退出 21。Windows bind mount 不保留真实 mode，所以本机一直通过。修复方式是在 fixture 启动前把合成 `key.pem` 放宽到 0644（与 `ca.pem` 一致），不为此给 fixture 容器增加特权；本机用 1001 属主的 0600 key 复现了退出 21，改权限后恢复正常。
- 诊断仍只输出固定标识。fixture 自身的启动失败改为固定退出码（20 凭据、21 key、22 证书、23 监听、24 未捕获），编排脚本据此报告失败类别，不输出容器 stderr、日志、环境或断言值。拓扑 fixture 以 `user: "0:0"` 运行并显式保留 `DAC_OVERRIDE`，不存在同一问题，未改动。
- 本次托管执行不发布镜像、不签名、不部署，也没有使用真实 Infisical、Telegram 或模型凭据。`release.yml` 与 `deploy.yml` 仍未实现，CI-05 至 CI-07 保持待办。

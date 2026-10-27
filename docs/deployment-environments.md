# 部署环境描述与检查（阶段 A 配置基础）

日期：2026-10-27。状态：配置与离线／只读检查已实现；测试实例启停／重置、同机并行运行证据与真实凭据核对尚未实现。

本文是 `test`／`production` 两个部署环境的公开资源身份、宿主私有配置边界和检查入口的唯一说明。字段语义以 [`src/deployment-environment.ts`](../src/deployment-environment.ts) 的 TypeBox schema 为准；其他文档引用本文件，不另列一份参数清单。

## 职责划分

| 内容 | 权威来源 | 是否进入仓库 |
| --- | --- | --- |
| 公开部署参数（项目名、卷名、网络名／网段、broker 地址、管理端口、私有目录路径） | 一份环境描述 JSON，经 `deployment-environment` schema 校验 | 只有 `deploy/environments/*.example.json` 占位示例 |
| 宿主私有配置（`vault.env`、`app.env`、`app.router.env`、`api-policy.yaml`、CA、owner ID、router 目录） | 目标机私有目录，按 [Agent Vault 运行说明](agent-vault.md) 生成 | 否（`deploy/agent-vault/private/` 已在 gitignore／dockerignore） |
| 镜像、Compose 与策略字节 | 发布清单与后续版本化发布契约 | 是 |
| 环境中的 bot、Infisical 身份与主密码 | 各自的 Infisical 环境与私有文件 | 否 |

环境描述只包含标识与资源名，不含任何凭据。`identity.botId` 是 Telegram bot 的数字用户 ID，属于标识而非秘密；它让离线检查拒绝两个环境消费同一个 bot。真实 bot 身份与凭据作用范围需要可信适配层核对（阶段 A2），本文件描述的检查不能代替。

## 描述格式

完整字段见 `EnvironmentSchema`，示例见 [`deploy/environments/test.example.json`](../deploy/environments/test.example.json) 与 [`production.example.json`](../deploy/environments/production.example.json)。要点：

- `schemaVersion: 1`、`kind: "aster.deployment-environment"`；未知字段被拒绝。
- `environment` 只能是 `test` 或 `production`。
- `composeProject` 是小写 Docker 项目名；`volumes.app`／`volumes.broker` 与 `network.name` 是显式资源名，不由 Compose 从项目名派生。
- `network.subnet` 必须是 IPv4 网段，前缀 `/8`–`/30`；`network.brokerAddress` 必须在网段内，且不能是网络或广播地址。只支持 IPv4：防火墙规则、router 上游与 broker 地址都是 IPv4 字面量。
- `broker.managementPort` 是 broker 容器内监听端口，默认不发布到宿主；需要宿主访问时叠加 `docker-compose.management-loopback.yml`，只绑定 `127.0.0.1`。
- `privateDirectory` 是目标机上的绝对路径，不允许 `..` 段。`privateFiles` 是相对于它的路径，不能是绝对路径、不能含 `..` 或结尾斜线，同一环境内不得重复；这样一份描述只能读取自己的私有目录。

`network.name` 可以省略，此时 Compose 派生 `<project>_vault`。已部署环境若已有网络名，必须写入描述，避免创建第二张网络。

实际描述放在目标机（例如 `/srv/aster/<environment>/environment.json`），不提交到仓库；示例文件中的路径、卷名与端口都是占位值。

## 检查入口

```sh
npm run build
npm run deployment:environment -- <command> [options]
```

| 命令 | 作用 |
| --- | --- |
| `render --environment <file> [--router] [--management-loopback]` | 用描述派生全部 `ASTER_*` 插值，渲染 Compose 并逐项核对 |
| `router --environment <file> --config <file> [--broker-port <port>]` | 核对将要挂载的 router 配置指向本环境的 broker |
| `host --environment <file> [--volumes absent\|present\|any] [--management-loopback]` | 只读查询 Docker，报告宿主资源冲突 |
| `compare --first <file> --second <file>` | 拒绝会在同一主机上冲突的两个环境 |

所有命令只读。`render` 在临时目录写一个仅含资源名的 env 文件，调用 `docker compose config --format json`，不创建容器、网络或卷；`host` 只执行 `docker ps`／`volume inspect`／`network inspect`。成功输出固定带 `productionAdmission: "not-evaluated"`。

`--volumes absent` 用于首次安装（项目不得有任何容器，目标卷必须不存在），`present` 用于更新（项目不得有运行中的容器，卷必须已存在且无任何消费者）。更新预检应在停止写入者之后运行。已存在的生产卷不会被静默改名、迁移或接管。

## 渲染核对内容

`render` 不信任 Compose 插值结果，渲染后逐项比较：

- 项目名、两个卷的显式名称、网络名与唯一子网、broker 的 `ipv4_address`。
- broker 入口脚本中的管理端口，以及管理端口默认不发布；叠加回环 override 后必须只发布在 `127.0.0.1` 且端口一致。任何其他已发布端口被拒绝。
- 私有目录：CA、策略、owner 文件与 router 目录必须从描述指定的确切路径挂载；私有目录内的其他 bind 源被拒绝；私有目录与本次用到的私有文件／目录必须已存在（缺失时 Compose 会创建目录并挂载空文件，或直接拒绝渲染）。
- 边界不回退：app `1000:1000`、共享 `tool-network` 命名空间、只读根、`cap_drop: ALL`；`tool-network` 只读且仅 `NET_ADMIN`；router `1001:1001`；`tool-network` 收到的 broker 地址与描述一致。

## 失败码

检查只输出固定错误码，不回显路径、渲染值、环境内容或 daemon 输出。

| 前缀 | 含义 |
| --- | --- |
| `ENVIRONMENT_*` | 描述本身：过大、JSON 非法、重复键、schema 不符、不可读、非普通文件、不支持的网段、资源重叠 |
| `RENDER_*` | 渲染结果与描述不符：项目／卷／网络／broker 地址／管理端口／私有目录／服务集合／边界 |
| `ROUTER_*` | router 配置 JSON 非法、上游与本环境 broker 不一致、监听不在回环或端口不符 |
| `HOST_*`／`PROJECT_*`／`VOLUME_*`／`NETWORK_*`／`PORT_IN_USE`／`DOCKER_UNAVAILABLE` | 宿主上已有资源冲突或无法查询 |
| `ARGUMENTS_INVALID` | 命令或参数不合法 |

## 与 Compose、防火墙、router 的关系

`docker-compose.agent-vault.yml` 的所有宿主可见资源都来自 `ASTER_*` 变量，默认值等于现有生产部署：

| 变量 | 描述字段 |
| --- | --- |
| `ASTER_APP_VOLUME` | `volumes.app` |
| `ASTER_BROKER_VOLUME` | `volumes.broker` |
| `ASTER_NETWORK_NAME` | `network.name`（省略时不设置） |
| `ASTER_VAULT_SUBNET` | `network.subnet` |
| `ASTER_BROKER_ADDRESS` | `network.brokerAddress` |
| `ASTER_BROKER_MANAGEMENT_PORT` | `broker.managementPort` |
| `ASTER_PRIVATE_DIR` | `privateDirectory` |
| `ASTER_BROKER_PORT` | broker 代理端口，固定 14322，不由描述配置 |

`network.sh` 从容器环境读取 `ASTER_BROKER_ADDRESS`／`ASTER_BROKER_PORT`，在使用 `iptables` 前做点分 IPv4 与端口范围检查；`docker-compose.router.yml` 挂载同一私有目录下的 router 目录。三者由同一描述驱动，修改网段必须同时通过 `render` 与 `router` 检查，不能只改 Compose。

## 尚未实现

- 测试实例启停／重置入口、合成生产哨兵隔离演练、两环境真实 Linux 并行运行证据（PR A2）。
- 真实 bot 身份、Infisical 读取作用域、主密码与 CA 归属的可信核对。
- 宿主资源检查不验证凭据、策略内容、签名或业务就绪；`host` 通过只说明当前查询结果没有冲突。

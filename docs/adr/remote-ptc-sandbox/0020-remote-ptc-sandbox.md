# ADR-0020：远程 PTC sandbox（脚本与工具同在执行 VPS）

- **状态**：Accepted
- **日期**：2026-11-02
- **功能**：remote-ptc-sandbox

## 上下文

[ADR-0019](../codemode-ptc/0019-codemode-ptc.md) 在控制面用 QuickJS worker 实现了 PTC：模型写脚本，脚本通过 `tools.*` 调用白名单工具，只有脚本结果进入模型上下文。远程执行阶段 1（[ADR-0015](../0015-control-execution-split.md)）只有 `bash`，`RemoteExecutionEnv` 的文件 API 返回 `not_supported`；嵌套 `bash` 通过 one-shot broker 每次新建 SSH 连接。

这留下两个问题：

- PTC 的脚本可能包含密集的过滤、解析和循环；脚本本身跑在控制面的 4 核／4 GB 主机上，会和 agent、Telegram 适配器和持久化争抢资源。
- 脚本运行环境不是 OS sandbox。QuickJS 只限制 JavaScript 能力；真正执行命令的是高权限执行主机上的普通进程，PTC 没有把脚本和工具一起关进资源／文件系统／网络边界。

`@earendil-works/pi-codemode` 1.3.0 提供了 `RemoteCodemodeSandbox` 和 `serveCodemodeRemote`：VM 可以放在远端，宿主仍保留工具表、调用 id、deadline 和 abort。它解决“VM 在哪”，不解决“远端工具如何执行”和“脚本和工具如何被隔离”。现有 broker 协议是一连接一请求，没有 session、`callId` 或双向持续流。

执行 VPS 已具备 Linux、unprivileged user namespaces 和 cgroup v2，并计划安装 `bwrap`。控制面是单台 4 核／4 GB 主机，不新增公网监听。

## 决策驱动因素

- 脚本和嵌套工具必须在执行 VPS 的同一资源／文件系统／网络边界内运行，避免控制面被脚本计算拖垮，也避免脚本与工具处于不同隔离层。
- 每次嵌套调用仍需经过控制面注册表、参数 schema、authz、嵌套任务和 durable journal，以复用 ADR-0008／0009 的恢复与顺序语义。
- 一个脚本可能连续调用很多次工具；不能每次调用重建 SSH 连接，也不能把协议设计成只能一问一答。
- 中间大输出必须留在远端；控制面 journal 只保存有界结果，避免循环调用撑爆 SQLite。
- 控制面重启后，同一 `jobId` 必须复用同一 workspace，已完成调用从 journal 返回，未完成调用继续执行。
- 默认无网络；超时和取消必须传递到 VM、bwrap 和命令进程组，不能留下后台计算或孤儿进程。
- 隔离能力不能靠配置假设：user namespace 和 cgroup 必须实际探测；不能自动把“无 sandbox”当成降级。
- 阶段 1 用最少工具闭合链路；阶段 2 尽快提供文件原语，因为批量代码／文本读取与修改是 PTC 的核心高频场景，bash 拼接文件内容对模型不友好且容易触发转义问题。

## 备选方案

- **方案 A：脚本仍跑控制面，只把嵌套工具放远端**：成本最低，但 PTC 的 CPU 密集脚本仍占用控制面，脚本与工具不在同一 sandbox，且无法用 cgroup 统一限制。不采用。
- **方案 B：远端 runner 自己执行工具，只把最终结果回控制面，不逐次回调**：通道最简单，脚本和工具天然同 sandbox；但绕过控制面工具注册表、schema、authz 和 `NestedCallDoc`，需要另建授权、审计和重放语义，与 ADR-0008／0009 及既有 durable 恢复冲突。阶段 1 不采用。
- **只使用 `RemoteCodemodeSandbox`，工具仍在控制面进程内执行**：VM 在远端，文件／命令却仍在控制面，违背“脚本与工具共同受限”；并且嵌套 `bash` 仍走 one-shot SSH。不采用。
- **在控制面用 Node `vm` 或容器直接跑脚本**：与 ADR-0019 重复，需要自建工具桥和隔离；控制面资源问题仍未解决。不采用。
- **把全部命令升级为 bwrap 执行**：会改变直接 `bash` 的既有语义、路径和部署，超出 PTC 范围。阶段 1 只包装 PTC；直接 `bash` 的安全不对称在文档中明确。
- **默认降级到 `prlimit`-only**：实现简单，但没有 mount／PID／network namespace，不能称为 sandbox；默认失败关闭，只有显式 `PTC_ALLOW_DEGRADED=1` 才允许。
- **每次嵌套调用新建 SSH 连接**：复用现有 one-shot broker 最省事，但一个脚本几十次调用会产生大量握手、认证和 socket 开销，也无法在有在途调用时正确取消。不采用；改为一条 session SSH 流。
- **把完整工具输出存入控制面 journal，再由模型截断**：实现直观，但会随着循环调用线性放大 SQLite 和备份体积。改为远端窗口截断＋job workspace spill，控制面只保存有界结果。

## 决策

采用“远程 VM + 远程 bwrap sandbox，控制面保留授权与 journal”的混合架构。

### 控制面

- `CODEMODE_ENABLED=1` 且 `EXECUTION_MODE=remote` 时，`createCodemodeHost()` 使用 `RemoteCodemodeSandbox`；本地模式继续 `CodemodeSandbox`。
- 每个 codemode 调用由宿主派生稳定 `jobId`：`ptc-` + SHA-256 版本盐＋`conversationId`＋codemode 任务 id 的前 32 个十六进制字符。模型不能指定。
- 任务作用域提交 `PtcJobDoc`，记录 `jobId` 和 `workspaceReady`；收到 `session.ready` 后、发送 `vm.start` 前提交 `workspaceReady=true`。
- 每次嵌套调用仍走 `api.executeTool(name, args, context, { key: "c" + callId })`；注册表做名称、schema、authz，结果写入 `NestedCallDoc`。控制面把 session 放进嵌套 context，`HarnessOptions.env` 从上下文取到 `PTC_SESSION`，以 `cwd=/workspace` 构造带 session 的 `RemoteExecutionEnv`。
- 阶段 1 远程脚本白名单为 `{ "bash" }`；阶段 2 加 `read`／`write`／`edit`。模型仍能看到全部工具，白名单只影响脚本可见面。
- 嵌套调用继续串行；session 关闭、超时、取消时中止嵌套 context。

### 执行 VPS

- broker 在宿主侧保持 Unix socket；每个 PTC job 通过一条长生命周期 SSH 流连接到执行用户的强制命令 `aster-ptc-host`，不新增监听端口。
- `aster-ptc-host` 负责预检、workspace 创建／复用、cgroup 准备、启动 bwrap、转发帧和强杀。
- `aster-ptc-runner` 在 bwrap 内运行，使用 `serveCodemodeRemote` 启动 QuickJS VM，并在同一 sandbox 内执行 `bash`（阶段 2 加文件操作）。
- bwrap 使用 `--die-with-parent --new-session`，逐项强制 `--unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup --unshare-net`，`--clearenv`、只读系统运行时和 runner bundle 绑定、可写 `/workspace`、tmpfs `/tmp`、`--cap-drop ALL --no-new-privs`；不整体绑定 `/` 或 `/home`。不使用 `--unshare-all`，因为它的 `-try` 变体会在 user namespace 不可用时静默继续。
- 默认无网络；不通过脚本参数或 session 帧打开网络。
- `/home/aster/jobs/<jobId>/workspace` 挂载为 `/workspace`；同一 `jobId` 重放必须复用同一目录。`workspaceReady=true` 而目录缺失时失败为 `workspace_missing`，不静默创建空目录。
- 阶段 2 可在显式配置时把直接 `bash` 的工作目录以 `ro` 或 `rw` 挂到 `/shared`，用于批量读取／修改代码；默认 `none` 不挂载。`/shared` 不是 job 私有，重放语义与直接 `bash` 相同。

### 通道与协议

- 新增独立的 `PTC_PROTOCOL_VERSION=1`，换行 JSON；`session.open` 后保持长连接，VM 帧和工具帧复用同一条流。
- 工具帧携带 `callId`；阶段 1 控制面串行发送，协议允许同一 session 内多个在途调用。所有帧带 `sessionId`；未知／错配 id、未知字段、版本不符都关闭 session 且不执行工具。
- 帧大小、命令、argv、env、cwd、并发 session 数都有硬上限；慢客户端触发 backpressure 时显式关闭，不静默丢帧。
- 超时／取消的强杀顺序：控制面发送 `session.close` 或断开 socket → broker 杀 SSH 进程组 → host 关闭 bwrap（`--die-with-parent`）→ 有 cgroup 时写 `cgroup.kill=1` → runner 退出并停止 VM／命令。

### 隔离与降级

- 启动前执行实际 probe，而不是只看 sysctl：`bwrap` 可运行、user namespace 可创建、cgroup v2 的 `memory`／`pids`／`cpu` 可用且可写、runner／QuickJS 版本匹配、workspace 路径安全。
- bwrap／user namespace 不可用时默认失败关闭；只有显式 `PTC_ALLOW_DEGRADED=1` 才进入 `prlimit`-only 模式，并记录 `isolation.mode="degraded-prlimit"`，明确它不是文件系统／网络隔离。
- cgroup 不可用但 bwrap 可用时，保留 namespace 隔离，资源限制降级到 `prlimit`，记录 `cgroup="none"`。`prlimit` 不能替代 user namespace；两者是不同层保护。
- cgroup 默认 `memory.max=512 MiB`、`memory.swap.max=0`、`pids.max=128`、`cpu.max="200000 100000"`；关闭时用 `cgroup.kill` 强杀整个组。

### 输出与 journal 增长

- runner 在本地维护单工具输出窗口（默认 32 KiB／1000 行，保留尾部），只把尾部、丢弃计数和元数据发给控制面；完整输出写入 `/workspace/.ptc/spill/`，有单文件上限。
- `NestedCallDoc` 只保存有界结果；`fullOutputPath` 是 sandbox 内路径，控制面不能读取。
- 每次脚本默认最多 500 次嵌套工具调用、累计结果预算 8 MiB；超过后拒绝新调用并附加诊断，不静默丢弃已有结果。codemode 最终给模型的文本仍限制为 32 KiB／1000 行。

### 分阶段

- 阶段 1：`bash` only，闭环验证远端 VM 注入、控制面工具回调、journal 重放、workspace 衔接、超时强杀和网络隔离。
- 阶段 2：阶段 1 验收通过后立即跟进，不作为可选后续。在同一 session／sandbox 上增加 `read`／`write`／`edit`，由 `RemoteExecutionEnv` 通过文件帧执行；路径限制在 `/workspace`、`/tmp` 和显式启用的 `/shared`，拒绝越界和符号链接逃逸。这是 PTC 批量处理代码／文本的核心场景，不能长期只靠 `bash` 拼接。

## 后果

- 控制面不再承担 PTC 脚本的 CPU 和内存；脚本和工具共同受 bwrap、user namespace、cgroup 和 network namespace 约束。
- 每个嵌套调用增加一次控制面往返，但复用一条 SSH 流和 `callId`，避免连接建立成本；阶段 1 的串行边界和 durable 语义不变。
- 控制面仍需承受与调用次数相关的 durable 记录开销，但不再与原始 stdout 大小相关；上限使 journal 增长有界。
- 执行主机新增部署要求：Node 24、bwrap、user namespaces、cgroup v2、执行用户、`/home/aster/jobs`、runner bundle、SSH 强制命令和保留期清理。预检失败会阻止远程 PTC 启动，而不是静默退回不安全模式。
- 重放只恢复 workspace 文件，不恢复进程、内存、文件锁、后台任务或 `/tmp`；未完成的 `bash` 仍是 unsafe，按结果未知处理，不能承诺恰好一次。
- 直接 `bash` 仍不在 bwrap 内，PTC 的隔离结论不能外推到直接命令；生产环境仍使用独立低权限执行用户。
- 新增 `@earendil-works/pi-codemode` 的远程运行形态和自有 runner 构建产物；控制面与执行主机的版本／指纹必须同步，否则重放显式失败。
- `/shared` 的 `rw` 模式是显式能力：脚本可以修改直接 `bash` 的工作区，重放时未完成的编辑按结果未知处理。

## 分阶段决策与缺陷历史

### 2026-11-02：设计阶段

- 相关 spec：`docs/spec-20261102-remote-ptc-sandbox.md`（本功能完成后删除，文件名保留为历史标识）
- 决策与取舍：确认采用远程 VM + 远程 sandbox，控制面保留 journal 和 authz；拒绝方案 A（脚本留控制面）和方案 B 阶段 1 形态（runner 完全自执行、不逐次回调）。通道采用单条 SSH session 流和 `callId`；阶段 1 只开放 `bash`，阶段 2 加文件原语。隔离以 bwrap + user namespace 为必需层，cgroup 优先、`prlimit` 仅作资源降级，且 userns 缺失时默认失败关闭。输出采用远端窗口截断＋workspace spill，控制面 journal 只存有界结果。workspace 通过稳定 `jobId` 和 `workspaceReady` 保证重放衔接，缺失时显式失败。
- 相关缺陷：尚未实现；已识别的风险包括 userns 在 Debian／Ubuntu／AppArmor 环境下的可用性差异、cgroup 委派失败后的弱降级、`serveCodemodeRemote` 在客户端超时后可能继续计算到下一个工具调用或中断预算、以及直接 `bash` 与 PTC 的安全不对称。实现阶段须用实际 probe、超时强杀和无遗留进程验收逐项确认，不能只以配置存在作为证据。

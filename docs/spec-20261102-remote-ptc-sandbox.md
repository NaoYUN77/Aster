# 远程 PTC sandbox（阶段 1：bash 闭环，阶段 2：文件原语）

- **状态**：设计已确认；阶段 1 待实现
- **日期**：2026-11-02
- **功能**：remote-ptc-sandbox
- **所属 ADR**：[ADR-0020](adr/remote-ptc-sandbox/0020-remote-ptc-sandbox.md)
- **前置决策**：[ADR-0019](adr/codemode-ptc/0019-codemode-ptc.md)、[ADR-0015](adr/0015-control-execution-split.md)

## 用户目标

模型写一段程序调用工具，程序本身和它调用的工具都在执行 VPS 的同一个受限 sandbox 内运行；控制面只负责工具授权、调用日志、恢复和最终投递。目标是：

- 脚本中的密集过滤、解析和循环不占用控制面的 4 核／4 GB 资源。
- 嵌套工具调用仍经过控制面的工具注册表、参数校验、authz 和 durable 记录，不绕过既有安全边界。
- 只有脚本结果进入模型上下文；单次工具的大输出留在远端 sandbox，控制面 journal 只保存有界结果。
- 控制面重启后，同一 `jobId` 复用同一 workspace 继续重放；已完成的嵌套调用不重复执行，未完成的调用按各工具的重放策略处理。
- 默认无网络；脚本、命令和子进程受 bwrap、user namespace、cgroup v2（或显式降级的 `prlimit`）约束。

阶段 1 先闭合 `bash` 的远程 PTC 链路，验证 VM 注入、工具回调、journal 重放、workspace 衔接和超时强杀。阶段 2 在同一 session／sandbox 上增加 `read`／`write`／`edit` 文件原语，用于代码和文本的批量读取与修改。

## 本次范围

### 阶段 1（必须完成）

- `EXECUTION_MODE=remote` 且 `CODEMODE_ENABLED=1` 时，codemode 的 QuickJS VM 运行在执行 VPS，而不是控制面。
- 每个 codemode 调用一条长生命周期的 SSH 流；同一脚本的 VM 消息和全部嵌套工具帧复用这条流，不按调用重建 SSH。
- 协议帧携带 `callId`，从 VM 的调用 id 贯通到嵌套工具任务；阶段 1 控制面仍按 ADR-0009 串行发送，协议允许将来同一脚本内多个在途调用。
- 阶段 1 脚本白名单只有 `bash`；`read`／`write`／`edit` 在脚本中不可见。
- bwrap sandbox：user namespace、PID／mount／IPC／UTS／cgroup namespace、无网络、只读系统运行时、可写 job workspace、`/tmp` tmpfs、清空环境、丢弃 capability、`no-new-privs`。
- cgroup v2 资源限制；cgroup 不可用时按明确规则降级到 `prlimit`；user namespace 不可用时默认失败关闭，显式允许才降级。
- 每个工具输出在远端按窗口截断；控制面只收到有界尾部、丢弃计数和远端完整输出路径，不保存原始大 stdout。
- 嵌套调用数、累计 journal 结果大小、脚本期限、工具期限、session TTL、并发 session 数均有上限。
- 控制面重启重放时，同一 `jobId` 复用 `/home/aster/jobs/<jobId>/workspace`；workspace 缺失时显式失败或记录，不静默当作空目录继续。
- 超时、取消、控制面退出、broker 退出、SSH 断开都传递到 runner、bwrap 和命令进程组，最终强杀。
- 启动预检：bwrap、user namespace、cgroup v2、runner 版本与 codemode 版本匹配；远程 PTC 启用但预检失败时启动失败（显式降级除外）。

### 阶段 2（紧随阶段 1，必须跟进）

阶段 1 验收通过后立即开展，不作为可选后续。PTC 的核心高频场景是代码／文本的批量读取与修改；只有 `bash` 会迫使模型拼接 shell 和转义文件内容，既难用又容易出错。

- 在同一远程 sandbox 和同一套 session 协议上增加 `read`、`write`、`edit` 文件原语；脚本白名单加入这三个工具。
- 文件原语由 control plane 的 `RemoteExecutionEnv` 通过 session 帧调用远端 runner，不在控制面执行，也不用 bash 拼接文件内容。
- 文件路径限制在 `/workspace`、`/tmp`，以及显式启用的共享工作区 `/shared`；拒绝 `..`、NUL、符号链接逃逸和越界路径。
- `read` 返回有界内容和截断元数据；`write`／`edit` 返回小型结构化结果；文件内容不整块进入控制面 journal。
- 阶段 2 在显式配置时允许把直接 `bash` 使用的工作目录以可读写方式挂到 `/shared`，用于批量修改现有代码／文本；默认 `none` 不挂载。该挂载不是 job 私有的，重放语义与直接 `bash` 相同，必须在结果和文档中明确。

### 非目标

- 脚本内调用 MCP、Web、记忆或模型工具；这些仍由模型直接调用。
- 控制面并发执行嵌套工具；阶段 1 仍串行，协议只预留 `callId` 和多在途调用的形状。
- 在控制面保留完整远端输出，或让控制面读取 `/home/aster/jobs/...` 下的文件。
- 把直接 `bash` 也迁入 bwrap；直接命令仍走 ADR-0015 的现有路径。
- 多租户隔离、跨用户共享执行主机、脚本递归、网络访问、GPU、Windows 执行主机。
- 用 PTC journal 替代外部副作用幂等；bash 和文件写入仍不是恰好一次。
- 对整个 `/` 做只读绑定，或把执行用户的 home、SSH 私钥、控制面凭据暴露给 sandbox。

## 现有事实与约束

- 本地 codemode 使用 `CodemodeSandbox`：每次执行一个 QuickJS WASM worker，VM 在控制面进程内。远程模式目前只在嵌套 `bash` 时通过 one-shot broker 打开 SSH；脚本本身仍在控制面。
- 现有 broker 协议是“一连接一请求”的换行 JSON：`exec` 或 `ping`，没有 session、没有 `callId`、没有双向持续流。`RemoteExecutionEnv` 只实现 `exec()`；所有文件 API 返回 `not_supported`。
- `@earendil-works/pi-codemode` 已提供 `RemoteCodemodeSandbox` 和 `serveCodemodeRemote`：VM 可以运行在远端，工具仍由调用方执行；消息是 `CodemodeRemoteMessage[]`，工具调用通过 `exchange` 回到宿主。它本身只解决 VM 位置，不提供远程工具执行或 sandbox。
- pi-durable codemode 的持久化分三层：
  - `pi.codemode.run`：脚本开始数据、指纹、最终结果。
  - `pi.codemode.journal`：按交付顺序记录 VM 调用 id、时间和全局调用结果。
  - 每个嵌套工具的 `NestedCallDoc`：以 `c<callId>` 为 key 保存该嵌套任务的真实结果。
  
  本 spec 中的“journal”指这些 durable 记录的整体；控制面不保存远端原始 stdout。
- 嵌套 bash 的 `structuredOutput` 含 `output`（宿主保留的尾部）、`truncated`、可选 `fullOutputPath` 和 `exitCode`。`fullOutputPath` 在远程模式下只能是 sandbox 内路径，控制面不能打开它。
- ADR-0009 要求同一回合工具顺序执行；ADR-0008 规定不安全工具不自动重放。`bash` 是 unsafe；codemode 工具本身是 safe replay。
- 执行 VPS 是 Linux，执行用户示例为 `aster`，job 根目录为 `/home/aster/jobs`；要求支持 unprivileged user namespaces 和 cgroup v2，安装 bubblewrap。控制面是单台 4 核／4 GB 主机，不新增监听端口。

## 目标架构

```text
Telegram / 请求
        │
        ▼
控制面 app 容器
  pi-durable codemode extension
    └─ RemoteCodemodeSandbox
         └─ PtcSessionClient ── Unix socket ── execution-broker（宿主侧）
                                                │ 每个 job 一条 SSH 流
                                                ▼
                                      执行 VPS
                                        aster-ptc-host（bwrap 外，supervisor）
                                          ├─ 创建/复用 workspace
                                          ├─ 创建 cgroup / 降级 prlimit
                                          └─ bwrap
                                              └─ aster-ptc-runner
                                                  ├─ serveCodemodeRemote（QuickJS VM）
                                                  └─ 执行 bash / 阶段 2 文件操作
```

### 角色边界

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| 控制面 codemode extension | 脚本开始数据、journal、嵌套调用任务、最终结果上限 | 执行脚本、执行命令、读写远端文件 |
| `RemoteCodemodeSandbox` | 宿主侧 VM 控制、调用 id、deadline、abort、结果交付 | 远端进程和文件隔离 |
| 控制面 `PtcSession` | 建立 session、复用 SSH 流、注入 `PTC_SESSION` 上下文、路由 VM／工具帧 | 信任脚本参数或远端路径 |
| broker | 校验 session 帧、限制并发、转发、关闭时杀 SSH 进程组 | 执行工具、保存业务 journal |
| `aster-ptc-host` | 预检、workspace、cgroup／prlimit、启动 bwrap、监督生命周期 | 运行 VM、执行工具 |
| `aster-ptc-runner` | 在 bwrap 内运行 QuickJS、执行白名单工具、输出窗口 | 访问控制面状态、网络、宿主任意路径 |

### 一次调用的流程

1. 模型调用 `codemode`。宿主从 `conversationId` 和该 codemode 调用的 durable `taskId` 派生稳定的 `jobId`。
2. 控制面在任务作用域提交 `PtcJobDoc`（记录 `jobId`、`workspaceReady`、创建时间），然后通过 broker 的 `session.open` 打开 session。
3. `aster-ptc-host` 校验 `jobId`／`sessionId`，创建或复用 `/home/aster/jobs/<jobId>/workspace`，准备 cgroup，启动 bwrap 内的 `aster-ptc-runner`。runner 返回 `session.ready`，包含实际隔离模式和 workspace 状态。
4. 控制面提交 `workspaceReady=true`（在 VM 启动前），随后发送 `vm.start`。runner 调用 `serveCodemodeRemote` 启动 QuickJS VM。
5. VM 发出 `call`。控制面的 `RemoteCodemodeSandbox` / codemode extension 以 `api.executeTool(name, args, context, { key: "c" + callId })` 进入正常工具路径；注册表做名称、参数 schema、authz，嵌套任务在 `NestedCallDoc` 中记录。
6. 嵌套 `bash` 工具通过 `RemoteExecutionEnv.exec()` 执行。该 env 从上下文看到 `PTC_SESSION`，使用 `cwd=/workspace`，把 `tool.exec` 帧（含 `callId`、命令、cwd、env、timeout、window）发到同一 session；不再新建 SSH。
7. broker 和 `aster-ptc-host` 校验并转发；runner 在 bwrap 内执行 bash，按窗口流式返回 `tool.output`、`tool.exit`／`tool.error`。完整输出只写入 job workspace 的 spill 文件。
8. 控制面把嵌套结果写入 `NestedCallDoc`，再把结果交付给 VM。脚本继续；只有最终脚本结果进入模型上下文。
9. 脚本结束、失败、超时或取消时关闭 session；workspace 保留到保留期结束，供同一 `jobId` 重放使用。

### 为什么控制面仍参与每次嵌套调用

阶段 1 接受每次嵌套调用经过控制面，是为了复用：

- 工具注册表的名称／schema／authz／权限复核；
- `NestedCallDoc` 的 durable 结果和 `c<callId>` 重放关联；
- ADR-0008 的重放策略和 ADR-0009 的串行边界；
- 统一的工具审计和错误语义。

代价是每个嵌套调用有控制面往返。通过单条 SSH 流复用连接、`callId` 关联、串行发送和小帧，避免连接建立和并发竞争的成本；不把工具执行本身搬回控制面。

## 身份、状态与接口

### `jobId`

- 由宿主派生，模型不能指定：
  `sha256("remote-ptc-sandbox\0" + conversationId + "\0" + codemodeTaskId)`，取前 32 个十六进制字符，前缀 `ptc-`。
- 只允许 `[A-Za-z0-9_-]{1,64}`。同一 codemode durable 任务在恢复后得到同一个 `jobId`；新任务得到新 `jobId`。
- `jobId` 是 workspace 的唯一宿主侧身份；不作为认证凭据，也不从模型参数或脚本读取。

### `sessionId` 与 `callId`

- `sessionId`：每次尝试随机生成 16 个十六进制字符，只用于关联当前连接；重放会生成新 `sessionId`，但复用同一 `jobId`。
- `callId`：pi-codemode VM 的整数调用 id（从 1 开始），在一次脚本执行内唯一。控制面的嵌套任务 key 继续保持 `c<callId>`。
- 阶段 1 控制面一次只发一个 `tool.exec`；协议和 runner 按 `callId` 关联，允许将来同一脚本内多个在途调用。同一次执行内不得把 `callId` 分配给不同逻辑调用；重放时 VM 会重新从 1 开始并发出相同 id，该 id 正是关联 `NestedCallDoc` 的键，已记录的结果不会再发 `tool.exec`。
- 所有 session 帧携带 `sessionId`；`callId` 出现在工具帧中。未知或错配的 id 关闭 session，按协议错误处理，不能把结果交给另一个调用。

### `PtcJobDoc`

控制面任务作用域文档，建议 kind `ptc.job`，至少包含：

```ts
{
  jobId: string;
  workspaceReady?: true;
  createdAt: number;
}
```

- 首次尝试在打开 session 前提交 `jobId`。
- 收到 `session.ready` 后、发送 `vm.start` 前提交 `workspaceReady=true`；提交失败则不发送 `vm.start`，关闭 session 并按启动错误处理，不能在没有持久标记的情况下开始产生 journal。
- 恢复时若 `workspaceReady` 已为 true，而执行主机报告 workspace 不存在，必须失败为 `workspace_missing`，不创建空目录继续。
- 若 `workspaceReady` 尚未提交，允许创建／复用；若目录已存在（上次在 ready 后、提交前崩溃），复用并记录。

### Session 协议

新增独立版本 `PTC_PROTOCOL_VERSION=1`，仍使用换行分隔 JSON；一个 session 连接在 `session.open` 后保持长连接。现有 one-shot `exec`／`ping` 连接保持不变。

建议帧：

```ts
type PtcOutputWindow = {
  maxBytes: number;
  maxLines: number;
  minIntervalMs: number;
  bytesPerSecond: number;
};

type PtcToolErrorCode =
  | "invalid"
  | "spawn_failed"
  | "timeout"
  | "aborted"
  | "too_large"
  | "io_error"
  | "not_supported"
  | "busy"
  | "protocol_error";

type PtcClientFrame =
  | { v: 1; type: "session.open"; sessionId: string; jobId: string; limits: PtcLimits }
  | { v: 1; type: "vm.start"; sessionId: string; request: CodemodeRemoteRequest }
  | { v: 1; type: "vm.reply"; sessionId: string; reply: CodemodeRemoteReply }
  | { v: 1; type: "tool.exec"; sessionId: string; callId: number; tool: "bash"; command: string | string[]; cwd: string; env: Record<string, string>; inheritEnv: boolean; timeoutSeconds: number; window: PtcOutputWindow; spill?: { afterBytes: number; afterLines: number } }
  | { v: 1; type: "tool.cancel"; sessionId: string; callId: number; reason: string }
  | { v: 1; type: "session.close"; sessionId: string; reason: string };

type PtcRunnerFrame =
  | { v: 1; type: "session.ready"; sessionId: string; executionId: string; workspace: { path: "/workspace"; created: boolean; reused: boolean }; isolation: PtcIsolation; runner: PtcRunnerInfo }
  | { v: 1; type: "vm.messages"; sessionId: string; messages: CodemodeRemoteMessage[] }
  | { v: 1; type: "tool.output"; sessionId: string; callId: number; stream: "stdout" | "stderr"; text: string; skipped?: ShellOutputSkip }
  | { v: 1; type: "tool.exit"; sessionId: string; callId: number; exitCode: number; spillPath?: string; spillTruncated?: boolean }
  | { v: 1; type: "tool.error"; sessionId: string; callId: number; code: PtcToolErrorCode; message: string; spillPath?: string; spillTruncated?: boolean }
  | { v: 1; type: "session.closed"; sessionId: string; reason: string };
```

`PtcIsolation` 至少包含 `{ mode: "bwrap" | "degraded-prlimit"; userNamespace: boolean; cgroup: "v2" | "none"; network: "none" | "shared" }`；`PtcRunnerInfo` 至少包含 `{ version: string; codemodeVersion: string; fingerprint: string }`。`PtcLimits` 至少包括 `scriptTimeoutMs`、`memoryLimitBytes`、`maxToolCalls`、`nestedOutput: { maxBytes, maxLines }`、`maxJournalBytes`。执行主机用自己的配置再 clamp，不能由控制面放宽本机上限。

阶段 2 在同一协议上增加文件帧（名称可在实现时定为 `file.read`、`file.write`、`file.edit`、`file.stat`，或统一的 `tool.file`）：

```ts
type PtcFileFrame =
  | { v: 1; type: "file.read"; sessionId: string; callId: number; path: string; maxBytes: number; maxLines?: number }
  | { v: 1; type: "file.write"; sessionId: string; callId: number; path: string; content: string; mode?: "create" | "truncate" }
  | { v: 1; type: "file.edit"; sessionId: string; callId: number; path: string; oldText: string; newText: string };
```

文件帧的路径、内容大小和结果都受边界检查；详细候选见阶段 2。

### 帧边界与校验

- `PTC_MAX_FRAME_BYTES` 默认 4 MiB（VM 帧可携带脚本和工具声明）；工具帧单帧默认 1 MiB；输出 chunk 默认不超过 16 KiB。
- 单条命令 64 KiB；argv 最多 256 项、总和 64 KiB；env 最多 128 项、总值 32 KiB；cwd 最多 4096 字节；`callId` 为 1..2^31-1 的整数。
- 所有未知字段、未知类型、版本不符、错配 `sessionId`、错配 `callId` 都拒绝；拒绝时关闭 session，不执行任何工具。
- 输出帧按 stream 和 `callId` 有序；终止帧在输出之后。控制面收到未知 `callId` 或跨调用帧时按协议错误关闭，不猜测归属。
- 慢客户端不能把 socket 队列变成无界缓冲。设 1 MiB 高水位；超过时关闭 session 并报告 `backpressure`，不静默丢弃输出。
- broker 最多同时保持 `EXECUTION_BROKER_PTC_MAX_SESSIONS` 个 PTC session（默认 1）；超限返回 `busy`，不排队。

### 控制面接入点

- `createCodemodeHost()` 在远程模式下使用 `RemoteCodemodeSandbox`，由 `PtcSession` 提供 `remote()`；本地模式继续 `CodemodeSandbox`。
- codemode 工具包装层在每次嵌套调用前把 `PTC_SESSION` 放进嵌套 context（`withContextValue`），从嵌套调用 options 的 `key`（`c<callId>`）取得 `callId`，并把 session 的 `cwd=/workspace` 与输出上限传给 env 工厂。`callId` 不从模型参数读取，框架也不允许模型覆盖 `key`。
- `HarnessOptions.env` 的 `(target, context)` 读取 `PTC_SESSION`：
  - 有 session：构造带 session 的 `RemoteExecutionEnv`，`cwd=/workspace`；
  - 无 session：保持现有 `execution.remoteCwd` 的 one-shot 行为。
- `restrictScriptTools` 阶段 1 远程白名单为 `{ "bash" }`，阶段 2 加 `{ "read", "write", "edit" }`；模型仍能看到全部工具。
- 包装层继续串行化嵌套调用，并在 codemode 调用结束、失败、超时或取消时中止仍在运行的嵌套 context；session 关闭后再由 broker 强杀。
- 模型指令和 codemode section 必须说明：脚本 cwd 是 `/workspace`；`/workspace` 是 job 私有、可重放的工作区；直接 `bash` 的 `EXECUTION_REMOTE_CWD` 是另一个路径；阶段 2 的 `/shared` 才与直接 `bash` 共享。

## Workspace 与重放一致性

### 路径与权限

- job 根目录：`PTC_WORKSPACE_ROOT`，默认 `/home/aster/jobs`。
- job workspace：`/home/aster/jobs/<jobId>/workspace`，属主为执行用户，权限 `0700`；父目录不可被其他用户遍历。
- 沙箱内挂载为 `/workspace`，可写；`/workspace` 是默认 cwd。
- 启动前检查 `jobId` 格式、路径不逃逸根目录、workspace 不是符号链接；拒绝不安全的目录和文件类型。
- 只持久化 `/workspace`；`/tmp` 是 tmpfs，VM 内存、进程、临时目录和文件锁不跨重放保留。

### 首次运行与重放

| 情况 | 行为 |
| --- | --- |
| 首次运行，目录不存在 | 创建；`session.ready.workspace.created=true`；提交 `workspaceReady` 后启动 VM |
| 首次运行，目录已存在（陈旧目录） | 复用并记录 `reused=true`；不自动清空 |
| 重放，`workspaceReady=true`，目录存在 | 复用；同一 `jobId` 的文件上下文衔接 |
| 重放，`workspaceReady=true`，目录不存在 | 失败 `workspace_missing`；不创建空目录，不发送 live `tool.exec` |
| 重放，`workspaceReady` 未提交，目录存在 | 复用；记录 `reused=true` |
| 重放，`workspaceReady` 未提交，目录不存在 | 创建；记录 `created=true`；journal 中已完成结果仍可交付，但相关文件可能缺失，必须产生诊断 |

重放流程：

1. 同一 codemode durable task 重新执行，派生同一 `jobId`。
2. 打开新 session，挂载同一 workspace；VM 重新开始并读取 `pi.codemode.run` 的 start 数据。
3. 对 journal 中已完成的 `callId`，`executeTool` 以 `c<callId>` 重新关联 `NestedCallDoc`，直接返回已保存结果，不发送 `tool.exec`，不重新执行命令。
4. journal 未覆盖的 live 调用继续执行；它们看到的是上次尝试留下的 `/workspace` 文件。
5. 若 VM 指纹、模块版本或脚本路径与上次不一致，显式失败，不执行 live 调用。

`workspaceReady` 在 `vm.start` 前提交，保证“已经有 journal 记录”时 workspace 已被标记为初始化；因此缺失时可以安全地失败而不是猜测。

### 保留与清理

- `PTC_JOB_RETENTION_HOURS` 默认 168 小时（7 天）；只清理没有活跃 session、最后修改时间超过保留期的 job。
- 清理是删除整个 `/home/aster/jobs/<jobId>`；清理前记录 jobId、大小和时间，不删除活跃或未知状态的 job。
- 磁盘上限：单个 spill 文件默认 64 MiB、最大 256 MiB；单文件 `prlimit --fsize`；建议执行主机用文件系统配额或独立的 job 文件系统限制总量。没有配额的部署必须监控 workspace 总大小。
- 成功完成的 codemode 调用也保留 workspace 到保留期，避免“刚提交结果就删除、随后恢复需要”的窗口；由清理任务统一回收。

### 与直接 `bash` 的关系

- 直接 `bash` 继续使用 `EXECUTION_REMOTE_CWD`，不在 bwrap 内，也不与 job workspace 自动共享。
- 阶段 1 默认不挂载 `EXECUTION_REMOTE_CWD`；设置 `PTC_SHARED_WORKSPACE_MODE=ro` 时以只读方式挂到 `/shared`。脚本可以通过 `/workspace` 和 spill 文件完成闭环。需要读取项目文件时，模型可先用直接 `bash` 将文件复制到 job workspace，或在阶段 2 显式启用 `/shared` 的 `ro`／`rw`。
- 阶段 2 增加 `/shared`（来源 `EXECUTION_REMOTE_CWD`）：
  - 默认 `ro`：脚本可读取代码／文本，写入仍落在 `/workspace`；
  - 显式 `rw`：脚本和文件工具可直接批量修改共享工作区。该修改与直接 `bash` 共享，不是 job 私有，重放时已提交的编辑不会重复执行，未完成的编辑按结果未知处理。
- 是否启用 `/shared` 由执行主机配置决定，模型不能选择路径或读写模式。

## 隔离、资源与网络

### 启动预检

执行主机上的 `aster-ptc-host --check` 和 broker 的 `ptc.preflight` 必须检查：

1. `bwrap` 可执行文件存在且可运行。
2. user namespace 可用：优先实际执行 `bwrap --unshare-user --uid 0 --gid 0 true` 或等价的 `unshare -Ur true`，不能只看 sysctl。若存在 `/proc/sys/kernel/unprivileged_userns_clone`，同时读取；若存在 `/proc/sys/kernel/apparmor_restrict_unprivileged_userns=1`，必须为 bwrap 配置允许的 AppArmor profile，或由运维显式调整；不能假定 Ubuntu 24.04 默认允许 unprivileged userns。
3. cgroup v2 可用：`/sys/fs/cgroup/cgroup.controllers` 含 `memory`、`pids`、`cpu`，且 `PTC_CGROUP_ROOT` 可写、可创建子 cgroup；检查 `cgroup.kill` 是否存在，缺失时记录并用 `cgroup.procs` 逐项终止作为回退。
4. runner 版本、`@earendil-works/pi-codemode`／QuickJS 版本与构建指纹；与控制面不一致时启动失败。
5. workspace 根目录可写，执行用户可用；共享 workspace 路径（若配置）存在且不是危险符号链接。
6. `prlimit` 可用（仅降级路径需要）。

预检失败策略：

- user namespace 或 bwrap 不可用：**默认失败关闭**，远程 PTC 启动失败；不能自动退化成无文件系统／无网络隔离的普通进程。
- 只有显式设置 `PTC_ALLOW_DEGRADED=1` 时，才允许 `prlimit`-only 模式。该模式没有 bwrap 的 mount／PID／network 隔离，只有资源上限；必须记录 `isolation.mode="degraded-prlimit"`、启动日志和 session.ready，不能标记为安全 sandbox。
- cgroup v2 不可用但 bwrap 可用：仍使用 bwrap 的 namespace 隔离，资源限制降级到 `prlimit`；`isolation.cgroup="none"`，记录降级；这比无 userns 的降级安全，但聚合 CPU／内存／PID 约束更弱。
- `prlimit` 也不能替代 user namespace；两者不是同一层保护。

### bwrap 配置

目标命令形状（实现时按发行版调整只读运行时绑定）：

```sh
bwrap \
  --die-with-parent --new-session \
  --unshare-user --unshare-pid --unshare-ipc --unshare-uts \
  --unshare-cgroup --unshare-net \
  --clearenv \
  --setenv PATH /usr/local/bin:/usr/bin:/bin \
  --setenv HOME /workspace --setenv TMPDIR /tmp \
  --setenv LANG C.UTF-8 --setenv TZ UTC \
  --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
  --ro-bind /bin /bin --ro-bind /sbin /sbin \
  --ro-bind /opt/aster/ptc /opt/aster/ptc \
  --ro-bind-try /etc/passwd /etc/passwd \
  --ro-bind-try /etc/group /etc/group \
  --ro-bind-try /etc/nsswitch.conf /etc/nsswitch.conf \
  --ro-bind-try /etc/ld.so.cache /etc/ld.so.cache \
  --proc /proc --dev /dev --tmpfs /tmp \
  --bind /home/aster/jobs/<jobId>/workspace /workspace \
  --chdir /workspace \
  --cap-drop ALL --no-new-privs \
  -- /usr/bin/node /opt/aster/ptc/runner.mjs
# 当 PTC_SHARED_WORKSPACE_MODE=ro 时，在 --bind workspace 之后追加：
#   --ro-bind /home/aster/workspace /shared
# 阶段 2 的 rw 模式改用 --bind；none 时省略。
```

- 不直接使用 `--unshare-all`：它当前等价于带 `-try` 的变体（包括 `--unshare-user-try`），user namespace 不可用时会静默继续，和“默认失败关闭”冲突。逐项使用强制的 `--unshare-user`、`--unshare-pid`、`--unshare-ipc`、`--unshare-uts`、`--unshare-cgroup`、`--unshare-net`，让缺少能力时 bwrap 直接失败。
- `/shared` 默认不挂载；`PTC_SHARED_WORKSPACE_MODE=none` 时省略该绑定，脚本只能看到 `/workspace`。显式 `ro` 时只读绑定，阶段 2 的显式 `rw` 使用可写绑定。
- `--unshare-net` 显式启用 network namespace；不使用 `--share-net`。验收时确认只有 loopback，无外部连接和 DNS。
- `/usr`、`/lib*`、`/bin`、`/sbin` 按发行版实际路径只读绑定；若它们是符号链接，用 bwrap 的 `--symlink` 在沙箱内重建。禁止整体 `--ro-bind / /`。
- `/opt/aster/ptc` 只读绑定 runner bundle 和 wasm；不绑定 `/opt` 的其他内容。
- `/etc` 只绑定运行所需的最小文件；不绑定整个 `/etc`，避免把执行主机的配置或凭据暴露给脚本。`/home`、SSH 目录、控制面凭据不绑定。
- `/tmp` 是 tmpfs；有 cgroup 时其内存计入 `memory.max`，无 cgroup 时记录降级。
- `/workspace` 可写；`/shared` 仅在显式配置时挂载，阶段 1 只允许 `ro`，阶段 2 允许 `ro` 或 `rw`。
- `--die-with-parent` 保证宿主 supervisor 退出时 bwrap 被杀；`--new-session` 防止终端注入；`--cap-drop ALL` 和 `--no-new-privs` 防止提权。
- sandbox 内 uid/gid 映射按 bwrap 默认执行用户映射；不额外授予 root 能力。workspace 属主与映射一致。

### cgroup v2 与 `prlimit`

优先使用 cgroup v2，每个 job 一个子 cgroup：

| 文件 | 默认 | 说明 |
| --- | --- | --- |
| `memory.max` | 512 MiB | 包含 Node、runner、QuickJS、bash、tmpfs |
| `memory.swap.max` | 0 | 不建议将 swap 作为 sandbox 缓冲 |
| `pids.max` | 128 | 限制脚本和命令 fork |
| `cpu.max` | `200000 100000` | 2 核配额；按执行主机调整 |
| `cgroup.kill` | 关闭时写 `1` | 强杀整个 cgroup，包括残留子进程 |

- 脚本 VM 自身的内存上限仍由 `CODEMODE_MEMORY_LIMIT_BYTES`（默认 128 MiB）控制；cgroup 的 512 MiB 是进程组总预算，不是 VM 堆上限。
- 启动 bwrap 后把 bwrap 的 PID 写入 `cgroup.procs`；关闭时先写 `cgroup.kill`，再等待 `cgroup.events` 变为 `populated 0`，最后删除 cgroup。内核不支持 `cgroup.kill` 时，读取 `cgroup.procs` 并逐项 SIGKILL，再等待为空；该回退必须记录，因为它可能漏掉检查后新 fork 的进程。
- cgroup 不可用时使用 `prlimit`：`--nproc`、`--nofile`、`--fsize`、`--cpu`、`--core=0`；内存可用 `--as` 做尽力而为的上限，但 Node 的虚拟地址预留可能导致误杀或失效，不能承诺与 `memory.max` 等价。记录 `isolation.cgroup="none"`。
- `prlimit` 只限制单进程及其继承，不能可靠限制整个进程组的聚合资源；这是显式接受的降级代价。

### 网络

- 默认逐项强制 unshare 所有 namespace，其中 `--unshare-net` 使 sandbox 无外部网络、无 DNS、无监听端口；只有 sandbox 内的 loopback。
- 验收命令应检查 `/proc/net/dev` 只有 `lo`，`curl`／`wget` 失败，DNS 解析失败。
- 不把执行 VPS 加入控制面的 MITM 网络；模型调用仍由控制面经既有代理完成，sandbox 不持有模型密钥。
- 将来若需要网络，必须单独决策，不能通过脚本参数打开。

## 输出、journal 增长与截断

### 远端输出窗口

- runner 对每个工具的 stdout／stderr 按到达顺序维护一个合并窗口（默认 32 KiB／1000 行，保留尾部），与 `ShellOutputWindow` 的“合并尾部”语义一致；不能对两个流各留一份，否则总量会超过控制面窗口。收到 `tool.exec.window` 时以请求值为上限，并用本机硬上限 clamp。
- runner 只把保留的尾部通过 `tool.output` 发送给控制面；`stream` 表示该 chunk 最后来源，一个 chunk 可能跨两个流；被丢弃的内容用 `ShellOutputSkip`（bytes、newlines、endsWithNewline）计数，不能把完整 stdout 放进帧。
- 控制面的 bash 工具仍用自己的输出缓冲做第二层上限；最终 `structuredOutput.output` 是有界尾部，`truncated` 为真时附带远端 `fullOutputPath`。
- 大输出处理：
  - 从开始就把完整输出写入 `/workspace/.ptc/spill/<sessionId>/c<callId>.log`（或等价的 job 内路径）；用 `sessionId` 子目录隔离不同尝试，避免重放覆盖已完成调用引用的旧文件；超过 `PTC_SPILL_MAX_BYTES` 时停止写入并标记 `spillTruncated`；
  - `fullOutputPath` 是 sandbox 内路径，控制面不能打开；同一脚本内的后续 `bash` 可以读取；阶段 2 的 `read` 可按路径读取（仍受文件工具边界）；
  - 不在控制面临时目录生成完整副本，避免控制面磁盘和 journal 膨胀。
- 如果 `fullOutputPath` 在重放时已不存在，后续命令读取该路径会显式失败；不能当作空文件或成功。

### Journal 上限

- 嵌套 bash 结果的 `output` 默认限制为 32 KiB／1000 行；这是 `NestedCallDoc` 中最大的可变字段。命令参数、诊断和结构化结果也计入预算。
- 每个 codemode 任务默认最多 500 次嵌套工具调用（`CODEMODE_MAX_TOOL_CALLS`，范围 1–5000）。包装层在调用前检查；超过后拒绝新调用，不创建新的嵌套任务。脚本即使捕获错误继续循环，也不会继续增长 journal。
- 累计 journal 结果预算默认 8 MiB（`CODEMODE_MAX_JOURNAL_BYTES`，范围 1–64 MiB）。包装层在每次调用返回后估算参数＋结果＋诊断的 JSON 字节数；超过后拒绝新调用，并在 codemode 结果中附加明确诊断。单次越界最多保留一个结果，预算不是精确的数据库页级限制。
- codemode 最终给模型的文本结果继续限制为 32 KiB／1000 行（ADR-0019）；脚本输出目录和完整输出不进入模型上下文。
- 这些上限使控制面 SQLite 的增长与调用次数和单次结果上限相关，而不与原始 stdout 大小相关。

## 副作用、授权与安全边界

### 授权

- `codemode` 仍只允许模型调用（`callers: ["model"]`），脚本不能递归启动 codemode。
- 脚本可见工具由宿主白名单和 `callers` 决定；阶段 1 远程只有 `bash`，阶段 2 加 `read`／`write`／`edit`。模型仍能看到全部工具，白名单不改变模型直接调用面。
- 每次嵌套调用仍经过注册表的名称、启用状态、参数 schema、authz 和 `beforeTool`／`afterTool`；session 帧不是第二条绕过注册表的工具通道。
- 模型不能指定执行主机、SSH 用户、密钥、broker socket、workspace 根目录、`jobId`、`sessionId`、`/shared` 路径或读写模式；这些全部由宿主配置和 durable 上下文提供。
- `PTC_SESSION` 只由 codemode 包装层注入嵌套 context，模型参数无法伪造；它是宿主侧句柄，不得序列化进工具结果、诊断或模型可见文本。

### 输入与协议

- 脚本、命令、cwd、env 和文件路径都是不可信输入，在 broker、host、runner 三个边界校验，未知字段拒绝。
- 命令按现有 `validateCommand` 规则校验；cwd 必须是 sandbox 内绝对路径；文件路径必须落在允许根目录内。`..`、NUL、控制字符、符号链接逃逸都拒绝。
- `tool.exec.inheritEnv` 在 PTC sandbox 中不表示继承 SSH 登录环境或 supervisor 环境：runner 始终从 bwrap 的固定基线（`PATH`、`HOME`、`TMPDIR`、`LANG`、`TZ`）开始，`env` 只能在此基础上覆盖；`LD_PRELOAD`、`LD_LIBRARY_PATH`、`NODE_OPTIONS`、`BASH_ENV`、`ENV`、`SHELLOPTS`、`PROMPT_COMMAND` 等可改变加载或 shell 行为的变量拒绝。模型参数不能直接提供 `env`；阶段 2 若开放，必须先经过宿主白名单。
- 工具失败、业务失败和执行异常区分：
  - bash 非零退出是工具错误结果，携带 `exitCode`，脚本可读取；
  - spawn／timeout／abort／协议错误是执行错误，不能被伪装成成功；
  - 远端 runner 崩溃、SSH 断开、broker 重启都按结果未知处理，不能当作未执行。
- 不把凭据、认证身份、宿主路径或服务客户端放进脚本参数、命令、env 或工具结果；脚本源码和命令会进入 durable 会话记录。

### Sandbox 边界

- QuickJS 只限制脚本运行时能力；真正的 OS 隔离来自 bwrap + user namespace + cgroup + 网络 namespace。
- 直接 `bash` 不在该 sandbox 内，这是已知的安全不对称；生产环境仍应使用独立低权限执行用户，不能把 PTC 的隔离能力宣传为直接命令的隔离。
- `/shared` 在阶段 2 可写时，sandbox 能修改与直接 `bash` 共享的工作区；这是显式能力，不是越权。路径和模式由执行主机配置决定。
- 执行用户 home 中的 SSH 私钥、控制面凭据、其他 job 的 workspace 不能绑定或可读；`/home` 不整体绑定。
- 执行主机上的 runner 和 host supervisor 以执行用户运行；需要 root 的 cgroup／namespace 设置由部署阶段完成，不能让 runner 自行提权。

## 失败、恢复与超时

### 失败语义

| 现象 | 含义与处理 |
| --- | --- |
| 预检失败（bwrap／userns） | 默认启动失败；显式 `PTC_ALLOW_DEGRADED=1` 才进入 `degraded-prlimit`，并记录 |
| cgroup 不可用 | bwrap 仍在；资源限制降级到 `prlimit`，`isolation.cgroup="none"`，记录警告 |
| `workspace_missing` | 已标记初始化的 job 在重放时找不到 workspace；codemode 返回错误，不创建空目录，不执行新调用 |
| `busy` | 同时 PTC session 超限；显式拒绝，不排队、不静默等待 |
| `protocol_error` | 未知帧／字段／版本／id 错配；关闭 session，不执行工具 |
| SSH／broker／runner 断开 | 当前嵌套调用结果未知；codemode 失败；恢复时按 journal 和工具 replay 策略处理 |
| 脚本超时 | 关闭 session、强杀 VM 和命令进程组；返回 timeout；workspace 保留 |
| 请求取消 | 同上；返回 aborted；已产生的外部副作用按未知记录 |
| bash 非零退出 | 工具结果 `isError`＋`exitCode`；不是 sandbox 失败，脚本可继续 |
| 工具 spawn 失败 | 工具错误；脚本可决定是否继续 |
| 输出截断 | 返回尾部、`truncated`、可选 `fullOutputPath`；不把截断当完整 |
| 调用／journal 预算超限 | 拒绝后续嵌套调用并附加诊断；不静默丢弃已有结果 |
| 文件过大／路径越界 | 文件工具返回 `invalid`／`too_large`；不写入边界外 |
| 指纹／版本不匹配 | 重放显式失败；不执行 live 调用，避免不同 VM 语义下继续 |

### 超时与强杀

- 脚本期限：控制面 codemode deadline（`CODEMODE_TIMEOUT_MS`，默认 240 秒）是主时钟；runner 的 session TTL 为请求期限加余量（建议 +30 秒），作为控制面失联时的兜底。
- 工具期限：`bash` 的 timeout 和 `EXECUTION_MAX_TIMEOUT_SECONDS` 仍生效；runner 再把工具期限 clamp 到 session 剩余时间。
- 取消：`serializeNestedCalls` 在 codemode 调用结束时中止嵌套 context；session 客户端发送 `tool.cancel`，runner 杀命令进程组；随后 `session.close` 关闭 VM。
- 超时／取消后的强杀顺序：
  1. 控制面发送 `session.close` 或直接断开 Unix socket；
  2. broker 向 SSH 子进程组发 SIGTERM，2 秒后 SIGKILL；
  3. 执行主机 supervisor 收到 EOF／SIGHUP，关闭 bwrap；`--die-with-parent` 保证 bwrap 不遗留；
  4. 有 cgroup 时写 `cgroup.kill=1`；没有 cgroup 时杀 bwrap 进程组并等待；
  5. runner 从 stdin EOF 退出，停止 VM 和命令。
- 控制面进程退出、broker 重启、执行主机重启都走同一原则：先停止新工作，再强杀，最后保留 workspace；不能把“连接断了”当作“命令没执行”。
- 不得让 remote VM 在控制面超时后继续长时间计算。`serveCodemodeRemote` 的 interrupt budget 是远端兜底；本设计用 session 强杀把兜底时间压到秒级，验收必须检查无遗留进程。

### 恢复

- codemode 工具本身 `replay: "safe"`；脚本开始数据、指纹、journal 和嵌套结果按 pi-durable 规则恢复。
- `bash` 仍是 unsafe：崩溃时正在运行、尚未保存结果的命令不会被自动重跑；按结果未知记录。已保存结果的调用从 `NestedCallDoc` 返回，不重新执行。
- 文件原语（阶段 2）沿用各工具的重放策略；`write` 可幂等，`edit` 依赖精确匹配，完成结果已 journal 的不重跑，未完成的按未知处理。
- 同一 `jobId` 重放挂载同一 workspace；只恢复文件系统，不恢复进程、内存、文件锁、后台任务或 `/tmp`。
- 脚本在重放时如果走了不同路径、发出不同调用顺序或等待的调用与 journal 不一致，按 pi-durable 既有逻辑显式失败，不猜测。

## 配置与部署

### 控制面

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CODEMODE_ENABLED` | `0` | 启用 codemode；远程模式 + 此开关才启用远程 PTC |
| `CODEMODE_TIMEOUT_MS` | `240000` | 脚本期限；范围 1000–300000 |
| `CODEMODE_MEMORY_LIMIT_BYTES` | `134217728` | QuickJS VM 内存；范围 16–512 MiB |
| `CODEMODE_MAX_TOOL_CALLS` | `500` | 每次脚本最多嵌套工具调用；范围 1–5000 |
| `CODEMODE_MAX_JOURNAL_BYTES` | `8388608` | 嵌套结果累计预算；范围 1–64 MiB |
| `EXECUTION_BROKER_PTC_MAX_SESSIONS` | `1` | broker 同时 PTC session 上限；1–4 |

`CODEMODE_MAX_TOOL_CALLS` 和 `CODEMODE_MAX_JOURNAL_BYTES` 也应在 `readCodemodeConfig()` 中校验；未启用 codemode 时保持原配置形状。

### 执行主机

建议放在 root 拥有、执行用户只读的 `/etc/aster/ptc.conf` 或等价的 systemd 环境文件；不能由模型请求覆盖。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PTC_WORKSPACE_ROOT` | `/home/aster/jobs` | job 根目录 |
| `PTC_SHARED_WORKSPACE` | `/home/aster/workspace` | 直接 `bash` 工作目录；仅 `PTC_SHARED_WORKSPACE_MODE` 非 `none` 时挂到 `/shared` |
| `PTC_SHARED_WORKSPACE_MODE` | `none` | `none`／`ro`／`rw`；`rw` 仅阶段 2 允许 |
| `PTC_SESSION_TTL_MS` | `270000` | session 兜底期限；应大于脚本期限并留余量 |
| `PTC_CGROUP_ROOT` | `/sys/fs/cgroup/aster-ptc` | 可写的 cgroup v2 子树 |
| `PTC_CGROUP_MEMORY_MAX_BYTES` | `536870912` | 512 MiB |
| `PTC_CGROUP_PIDS_MAX` | `128` | 进程／线程数上限 |
| `PTC_CGROUP_CPU_MAX` | `200000 100000` | 2 核配额 |
| `PTC_VM_MEMORY_MAX_BYTES` | `536870912` | 对控制面请求的 VM 内存再 clamp |
| `PTC_MAX_FRAME_BYTES` | `4194304` | session 单帧上限；按部署内存调整 |
| `PTC_TOOL_FRAME_BYTES` | `1048576` | 工具帧单帧上限 |
| `PTC_OUTPUT_CHUNK_BYTES` | `16384` | `tool.output` 单帧文本上限 |
| `PTC_NESTED_OUTPUT_MAX_BYTES` | `32768` | 单工具输出尾部上限 |
| `PTC_NESTED_OUTPUT_MAX_LINES` | `1000` | 单工具输出行数上限 |
| `PTC_SPILL_MAX_BYTES` | `67108864` | 单个完整输出 spill 上限 |
| `PTC_ALLOW_DEGRADED` | `0` | 仅显式允许无 userns 的 `prlimit` 降级 |
| `PTC_JOB_RETENTION_HOURS` | `168` | workspace 保留期 |

### 执行主机准备

1. 创建执行用户（示例 `aster`）和 `/home/aster/jobs`；workspace 根目录权限 `0700`，属主为执行用户。
2. 安装 bubblewrap、util-linux（`prlimit`）、Node.js 24.19.0，以及只读的 runner bundle 和 QuickJS wasm 到 `/opt/aster/ptc`。
3. 配置 unprivileged user namespace；Ubuntu 24.04 若启用 `apparmor_restrict_unprivileged_userns`，为 bwrap 配置允许的 profile，或在明确的安全评估后调整；不能默认假设可用。
4. 创建并委派 cgroup v2 子树给执行用户；确认 `memory`、`pids`、`cpu` controller 已启用。
5. SSH `authorized_keys` 使用强制命令，例如：
   `command="/usr/local/bin/aster-ptc-host",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding`
   只允许该执行用户和该命令；broker 仍使用现有固定 `known_hosts` 和私钥。
6. 先运行 `aster-ptc-host --check`，确认 bwrap、userns、cgroup、版本和 workspace 路径；再启动应用。
7. 建议用独立文件系统或配额限制 `/home/aster/jobs`，并监控保留期清理和磁盘占用。

### 启动与迁移

- `CODEMODE_ENABLED=0` 或 `EXECUTION_MODE=local` 时行为不变，不执行远程预检。
- `CODEMODE_ENABLED=1` + `EXECUTION_MODE=remote` 时，`openAgent()` 在 broker ping 之后执行 `ptc.preflight`；预检失败按配置错误退出，不静默回退到控制面 VM 或普通进程。
- 升级前先收敛在途 codemode 任务：旧任务的 `pi.codemode.run.start.fingerprint` 来自控制面本地 sandbox，远程 runner 指纹可能不同；恢复会显式失败。至少不要让旧任务在切换后自动重放。
- 执行主机和应用使用同一版本的 `@earendil-works/pi-codemode`、QuickJS wasm 和 runner bundle；预检比较版本，避免跨版本重放。
- 不新增网络监听；broker 仍只通过宿主 Unix socket 与 app 通信。

## 实施步骤

### 阶段 1

1. **协议与配置**
   - 新增 `src/execution/ptc-protocol.ts`：帧类型、解析、严格字段／大小校验、`PTC_PROTOCOL_VERSION`。
   - 扩展 `readCodemodeConfig()` 和 broker 配置：调用／journal 预算、session 上限、执行主机限额。
   - 单元测试覆盖未知字段、超限、错配 id、版本和窗口。
2. **执行主机 host／runner**
   - `aster-ptc-host`：预检、`session.open`、workspace 创建／复用、cgroup 设置、启动 bwrap、转发帧、超时和 `cgroup.kill`。
   - `aster-ptc-runner`：bwrap 内运行；`serveCodemodeRemote`；`bash` 执行、输出窗口、spill、取消和进程组清理。
   - 构建为可部署 bundle，包含 QuickJS wasm；版本号和指纹可由预检读取。
3. **broker**
   - 兼容现有 one-shot 协议；新增 `ptc.preflight` 和持久 `session.open` 处理。
   - 校验帧、限制 session 数、SSH 子进程组强杀、关闭时清理；记录 session 生命周期但不记录完整工具输出。
4. **控制面接入**
   - `PtcSessionClient`：打开 session、VM 消息交换、工具帧请求／响应、取消、关闭。
   - `SessionCodemodeRemote`：实现 `CodemodeRemote`，把 `CodemodeRemoteMessage[]` 映射到 `vm.messages`／`vm.reply`。
   - `createCodemodeHost()` 远程分支使用 `RemoteCodemodeSandbox`；`PTC_SESSION` 注入嵌套 context；`HarnessOptions.env` 根据上下文选择 `/workspace` 的 session env。
   - `PtcJobDoc`、稳定 `jobId`、`workspaceReady` 提交顺序和 `workspace_missing` 失败。
5. **预算、恢复和强杀**
   - 包装层统计调用次数和累计结果字节；超限拒绝新调用并附加诊断。
   - 嵌套 bash 设置 32 KiB／1000 行输出上限；spill 路径由 runner 返回。
   - session 关闭、超时、取消、控制面崩溃、broker 崩溃的强杀路径和 watchdog。
   - 重放：同一 jobId、workspace 复用、journal 已完成结果不重跑、未完成 bash 结果未知。
6. **部署与验证**
   - 执行主机准备脚本／文档、强制命令、cgroup 委派、预检。
   - 单元测试、fake session 集成测试、Linux bwrap smoke、控制面重启和超时强杀验收。

### 阶段 2

1. 扩展协议：文件帧、路径校验、内容大小上限、原子写入和错误码。
2. `RemoteExecutionEnv` 在 session 上下文实现 `readTextFile`、`writeFile`、`edit` 所需文件 API；非 session 远程模式仍返回 `not_supported`。
3. 远程脚本白名单加入 `read`／`write`／`edit`；更新 codemode section、模型指令和 `docs/codemode.md`。
4. `/shared` 挂载：阶段 2 可配置 `rw`；路径限制为 `/workspace`、`/shared`、`/tmp`；拒绝符号链接逃逸和越界。
5. 文件工具结果上限和 journal 预算；大文件分块读取；写入／编辑的幂等性和重放语义。
6. 验收：批量读改写、路径逃逸、符号链接、超大文件、重放和直接 `bash` 共享一致性。

## 验收条件

### 阶段 1

- **脚本在远端**：脚本 `tools.bash({ command: "hostname" })` 返回执行 VPS 主机名；控制面主机名不同。控制面 CPU 在脚本执行期间没有持续占用。
- **工具被代理**：脚本中两次 `bash` 都经过控制面注册表和 `NestedCallDoc`；模型 transcript 中只有一个 codemode `toolResult`，嵌套命令输出不进入 transcript。
- **单条 SSH 流**：一个脚本内连续 10 次 `bash` 只产生 1 条 SSH session；broker 统计的连接数不随嵌套调用增加。
- **同 sandbox**：`bash` 写出的文件出现在 `/home/aster/jobs/<jobId>/workspace`；脚本内命令和 VM 都在同一 bwrap 进程树／cgroup 下。
- **网络边界**：`/proc/net/dev` 只有 `lo`；`curl`／`wget` 连接失败；DNS 失败；没有监听端口。
- **workspace 重放**：在脚本中途模拟控制面重启；同一 `jobId` 重新打开 session，已 journal 的调用没有重复执行（命令追加日志的计数不增加），未完成的 bash 不自动重跑，已有文件仍在。
- **workspace 缺失**：删除已初始化 job 的 workspace 后重放，返回 `workspace_missing`；没有创建空目录，没有执行后续 live 调用。
- **超时强杀**：脚本内 `sleep 300` 且 `CODEMODE_TIMEOUT_MS=2000`；超时后执行主机上没有该 job 的 `sleep`、runner、bwrap 进程；cgroup 为空；workspace 保留；结果是 timeout。
- **取消**：请求取消或关闭控制面时，session 在数秒内关闭，无遗留进程；结果按 aborted／unknown 记录。
- **输出截断**：命令产生 10 MiB 输出；模型可见 codemode 结果不超过 32 KiB／1000 行；`NestedCallDoc` 中的 bash `output` 不超过 32 KiB／1000 行；完整输出只在 `/workspace/.ptc/spill/...`，控制面 SQLite 不出现 10 MiB 原始 stdout。
- **预算**：循环 600 次 `bash` 时，超过 `CODEMODE_MAX_TOOL_CALLS` 的调用被拒绝，不产生新的嵌套任务；累计结果超过 `CODEMODE_MAX_JOURNAL_BYTES` 时同样拒绝并产生诊断。
- **协议**：未知帧字段、超大帧、错误 `sessionId`、错误 `callId`、错误版本都导致 session 关闭且不执行工具；慢客户端触发 backpressure 时显式失败。
- **预检与降级**：userns 不可用时默认启动失败；`PTC_ALLOW_DEGRADED=1` 时启动并报告 `degraded-prlimit`，日志明确无文件系统／网络隔离；cgroup 不可用时仍用 bwrap，报告 `cgroup=none` 并使用 `prlimit`。
- **不回归**：本地 codemode、直接远程 `bash`、无 codemode 配置的启动和测试保持原行为。

### 阶段 2

- 脚本可以批量 `read` 多个文件，`write`／`edit` 修改 `/workspace` 或显式 `rw` 的 `/shared`；不需要 bash 拼接内容，不触发 shell 转义问题。
- `read` 超过上限时返回有界内容和 `truncated` 元数据；`write`／`edit` 返回小型结构化结果；journal 不保存完整大文件。
- 路径 `/shared/../../etc/passwd`、`/workspace/link` 指向边界外、NUL、控制字符被拒绝；合法 `/workspace`、`/shared`、`/tmp` 路径可用。
- 写入采用同目录临时文件＋flush＋rename；失败不留下半写文件；符号链接不跟随到边界外。
- 直接 `bash` 能看到 `/shared` 的修改；`/workspace` 仍是 job 私有。重放时已完成的编辑不重复，未完成的编辑按结果未知处理。
- 阶段 1 的远端执行、单 SSH、网络、workspace、超时、输出和预算验收继续通过。

## 风险与待验证

- **userns 环境差异**：Debian／Ubuntu 的 sysctl、AppArmor 和 bwrap 版本可能使 `bwrap --unshare-user` 失败；必须用实际 probe，不能只看配置。生产部署要在目标执行 VPS 上跑预检验收。
- **cgroup 委派**：容器或 systemd 环境可能没有可写的 `cgroup.subtree_control`；此时会降级到较弱的 `prlimit`，需要监控并明确记录。
- **直接 bash 安全不对称**：PTC 的 bwrap 隔离不覆盖直接 `bash`；不能把 PTC 的安全结论外推到直接命令。
- **workspace 与共享工作区**：阶段 1 的 job workspace 与直接 `bash` 工作目录隔离；阶段 2 的 `/shared` 才提供批量编辑现有代码的路径。未启用 `/shared` 时，模型需要先复制文件到 job workspace。
- **远端 VM 超时语义**：`serveCodemodeRemote` 在客户端超时后可能继续计算到下一个工具调用或中断预算耗尽；本设计必须靠 session 强杀验证“超时后无遗留计算”，不能只依赖基座行为。
- **journal 预算精度**：包装层的累计字节是估算值，单次越界可能保留一个超出上限的结果；验收应检查增长有界，而不是精确字节。
- **spill 与磁盘**：完整输出落在执行主机；需要保留期清理、单文件上限和推荐的文件系统配额。没有配额时必须监控磁盘。
- **版本一致性**：控制面与执行主机的 pi-codemode／QuickJS／runner 版本不一致会导致重放指纹失败；部署必须同步构建产物。

## 参考

- [ADR-0019：PTC 代码调用工具（codemode）](adr/codemode-ptc/0019-codemode-ptc.md)
- [ADR-0015：控制面与执行面分离](adr/0015-control-execution-split.md)
- [ADR-0009：同一回合工具顺序执行](adr/0009-sequential-tool-execution.md)
- [ADR-0008：外部工具调用不自动重放](adr/0008-unsafe-tool-replay.md)
- [远程工具执行阶段 1](execution-remote.md)
- [代码调用工具（PTC／codemode）](codemode.md)

# Memory 与 Context 实施方案

状态：方案已确认。MEM-01 已完成契约冻结与底座时序验证（结论见第 12 节），MEM-02 已实现 Working 状态与版本化更新（结论见第 13 节）；其余模块待实现。编制日期：2026-10-25。本文完整替换此前的记忆设计计划，是本轮架构、数据归属和模块 Interface 的权威来源；实施拆分与完成条件见 [实施 issues](memory-implementation-issues.md)。

本轮是当前 MVP 之后的增量工作，不表示这些能力已经上线。现有运行范围见 [mvp.md](mvp.md)，请求、工具和投递契约见 [contracts-and-lifecycle.md](contracts-and-lifecycle.md)。底座以已安装的 pi durable / pi-ai 1.3.0 为准。

## 1. 交付目标与范围

保留一个持续的 root Conversation，用三块上下文支持跨轮、跨日任务，同时控制输入规模和前缀变化：

| 块 | 内容 | 变化时机 |
| --- | --- | --- |
| A：稳定规则 | system prompt、核心工具声明、固定记忆使用协议 | 应用配置或工具集合变化 |
| B：周期快照 | 连续性摘要、压缩边界对应的 working 基线、适用偏好与必要配置快照 | 初次建立上下文；新的压缩或重置上下文正式生效 |
| C：追加流水 | 保留的近期原文、新输入、assistant、工具结果、working 修订与检索结果 | 新内容进入底座时追加 |

一个周期是两次有效压缩之间的区间。周期内保持 B 的原文，C 的已有部分保持不变：

```text
请求 n     A | B7 | T1 ... Tn
请求 n+1   A | B7 | T1 ... Tn | Tn+1
压缩生效   A | B8 | 保留的近期流水 ...
```

每次主 agent 模型调用都携带 system prompt，包含工具后续调用、重试、恢复及压缩后调用。system prompt 继续由应用的 `instructions` 提供，不引入职责说明文件。摘要模型使用专用系统提示。

本轮增加 working JSON、周期快照、每日 Markdown 归档和有界检索。移除独立的应用 history 记忆层；底座原始 Entries 继续保留为恢复记录和证据，通过来源定位读取。上下文压缩不删除持久化历史。

本轮不包含向量数据库、第二套 agent loop、后台自动用户画像、每日定时推送、多用户记忆、任意插件平台、磁盘历史清理，以及独立于模型窗口的严格 64K 输入上限。

## 2. 当前实现与需要新增的能力

当前应用通过 `root.configure({ instructions })` 设置系统提示，将原文提交给 root Conversation；底座派生消息、执行工具并自动压缩。`workspace/MEMORY.md` 仍由模型通过文件工具读取和按用户明确要求更新。

尚未实现：宿主记忆投影、working Document、应用 context planner、自定义周期快照、每日记忆及其归档和查询工具。数据契约（schema、文档定义、范围与日期规则、错误分类）已由 MEM-01 冻结在 `src/memory/contracts.ts`，其余名字仍是拟议应用接口，不是底座现有 API。

底座现有接入能力：

- generation 准备阶段渲染 sections、计划 `pi.system` 补丁，再固定请求 cutoff。
- `context()` 按 head marker、Entries 和 edits 派生有效消息，维护工具调用与结果关联。
- `CompactionTask.beforeCompact` 接收选定的旧范围、messages 和 `firstKept`，可拒绝压缩或提供摘要文本。
- `GenerationTask.beforeRequest` 可替换单次请求 messages，但替换不自动持久化。hook 的声明类型 `HookApi` 只保证读取和 memo；MEM-01 实测运行时传入的对象是该 Task 的完整 `TaskRuntime`，额外带有 `commit()`、`signal`、`snapshotAsOf`、`entry()` 等（第 12 节）。应用只使用声明类型中的成员和 `Harness.commit()` 完成持久化，不依赖未声明的成员。memo 在该 Task 尚未终结时保留且首次写入获胜；任务终结后不可读，因此不能充当长期操作回执。
- 普通 hook 异常会被报告后继续执行。`beforeRequest` 抛错不能保证阻止模型调用；`beforeCompact` 抛错可能回落到默认摘要。不能用抛错实现必需快照或硬预算的强制保证。
- 原生工具可通过 `api.commit()` 更新应用 Document；原生 write submission 在合法边界进入模型上下文。

原生 hook 不等于完整的 context builder。发布顺序、checkpoint、模型调用记账和恢复接入已由 MEM-01 用公开 API 验证，结论见第 12 节；仍未验证的部分在那里逐条标注。不能通过修改依赖包、私有导入或绕开 admission 补齐。

## 3. 数据归属

| 数据 | 权威来源 | 生命周期与用途 |
| --- | --- | --- |
| 助手职责、记忆使用协议 | 应用代码提供的 `instructions` | 稳定规则，每次主模型调用可见 |
| 当前业务状态 | `personal.working` Conversation Document，JSON | 随任务变化，支持按 Entry 读取历史版本 |
| 周期快照 B | 初始应用 Entry 或已发布的 `pi.compaction` Entry | 不可变投影，带 schema 版本、来源边界和 working revision |
| 原文、工具执行和恢复状态 | 底座原生 Entries、Tasks、Documents | 原样复用；应用不维护执行状态副本 |
| 每日事件记忆 | `DATA_DIR/memory/daily/YYYY-MM-DD.md` | 可增量写入、可检索，保存有价值事件及来源 |
| 用户明确要求保存的长期事实 | 既有 `workspace/MEMORY.md` | 兼容现有数据与写入语义，按需读取 |
| 归档覆盖位置与待发布结果 | 应用归档 Document／底座归档 Task checkpoint | 只表示应用拥有的归档进度 |

working、B 和每日记忆中可以出现同一事实，但各自回答不同问题：working 表示当前业务状态，B 表示某个上下文边界的投影，每日记忆表示过去发生的事件。历史中的旧值和摘要不能覆盖后续明确修订。

没有独立可写的 `working.json` 副本。若提供文件查看功能，它是带 revision 的只读导出。JSON 数据采用版本化 schema；`defineDoc.version` 管数据结构迁移，业务 `revision` 只在实际变化时递增。

## 4. 模块与解耦约束

这里的 Module 指拥有一个小 Interface 的实现集合；Adapter 负责接入具体底座或文件系统。Interface 包含类型、错误、顺序、副作用和预算约定。下表限定依赖方向，不要求一行对应一个 class。

| Module | 小 Interface 的职责 | 实现可以知道 | 调用方不应承担 |
| --- | --- | --- | --- |
| Working | 读取当前／指定边界状态；应用有来源的变更 | 业务 schema、revision、任务和偏好生命周期 | 文档迁移、冲突检查、操作去重 |
| Context | 根据已读取的事实制定加载、预算和压缩决策；稳定渲染 B | 应用快照、revision、预算、来源引用 | 文件扫描、模型调用、底座调度 |
| Daily Memory | 按稳定分段 ID 发布；有界 search/read | Markdown 格式、目录约束、原子替换、分页 | 拼文件、查重、遍历所有日记 |
| Archive | 推进有界来源范围的提取、发布、确认 | 归档协议、来源分页、提取器和 Daily Memory Interface | 重试窗口、跨日分组、连续覆盖检查 |
| Durable Adapter | 映射 native tools、hooks、Documents、Tasks 和来源读取 | pi durable / pi-ai 原生类型与公开接口 | SDK 内部阶段、消息排序和提交细节 |
| 应用组合入口 | 配置依赖并注册 Adapter | 已构造的 modules、配置和生命周期 | 记忆正文处理、摘要算法、文件协议 |

依赖方向：应用组合入口接入 Durable Adapter；Adapter 调用 Working、Context 和 Archive；Archive 调用 Daily Memory。Context 接收已固定的输入，不读取 Daily Memory，也不在组装时调用模型。查询工具通过 Daily Memory 读取，结果按原生工具路径进入 C。

实现尺度：

- 先使用普通函数和少量有状态 module，不为每个存储操作建立一层转发 class。
- 仅在真实变化点注入依赖：模型提取器、时钟、文件根目录以及底座接入。单一文件后端不预建通用存储插件协议。
- 应用只定义自己拥有的 `WorkingState`、`CycleSnapshot`、`MemorySegment`、`ArchiveBatch`、`ContextPlan` 等契约。原生 Message、Entry、Task 和 ID 使用 SDK 类型，不能复制等价定义。
- 纯业务与规划函数不依赖 Harness、Telegram、全局环境变量或文件系统；使用 SDK 的类型引用不等于依赖其运行时。
- `src/agent.ts` 只保留组合和原有请求生命周期；`src/telegram.ts`、inbox、投递实现无需理解三块上下文。
- modules 通过返回结果或显式调用合作，不互相监听和改写对方内部状态。持久化通知先有可恢复事实，再有处理动作。

建议代码归属：`src/memory/working.ts`、`context.ts`、`daily.ts`、`archive.ts`；SDK 接入放在 `src/memory/durable-*.ts`，模型提示与转换放在对应摘要／提取 Adapter。MEM-01 已建立 `src/memory/contracts.ts` 作为共享契约的唯一位置，并行 issue 在此基础上添加各自 module，不另建近似类型；这些路径不是要求增加空文件或包装层。

## 5. Working：当前任务与常驻偏好

working 保存当前目标、范围、约束、已确认进度、阻塞、下一步、简短近期说明和关键来源。成功状态须引用已提交的工具证据；工具是否执行、generation 是否运行、Telegram 是否送达仍由其原生记录决定。

跨任务偏好与当前任务分别建字段。偏好必须有明确用户来源、适用范围及必要的有效期；任务完成只清理任务状态，不清理有效偏好。自动事件归档不自动建立永久偏好。默认值、事实和授权保持原有语义，旧授权不能因检索被重新授予。

拟议工具名为 `working_read`、`working_update`。schema 与执行定义一起维护，更新要求 `expectedRevision`、明确 changes 和证据引用；身份、操作 ID、目录均由宿主提供。Interface 返回成功后的 revision 与有界修订，或明确的校验／冲突／证据错误。

MEM-02 已按本协议实现（`src/memory/working.ts`、`working-tools.ts`），实现结论与实测语义见第 13 节；本节仍是设计意图的表述。

更新协议：

1. 宿主以同一次原生工具调用生成稳定操作标识。
2. 在同一 commit 内先检查操作回执，再检查 revision，更新 Document 并保存应用变更回执。相同操作恢复返回原回执，不能再次递增 revision。
3. 必须有与变更同 commit 的应用 Entry 锚定可 rewind 的状态。该 Entry 可只含应用数据；模型可见修订由原生工具结果承载。
4. 若状态已提交但工具结果未保存，恢复必须重新取得同一回执并让原生调用完成。此窗口验收通过后才能声明安全重放。
5. 内容没有业务变化则不递增 revision；同文本的新调用仍按其操作标识和 revision 处理。

任务开始创建活跃状态；决定或进度变化时更新；完成时先有持久化完成事实和可恢复归档触发，再清理活跃事项。无需等待 Markdown 写入成功，但不能只在内存通知归档后就丢弃最后的完成信息。

## 6. Context builder：输入、输出和每轮行为

应用 Context Module 制定计划和渲染应用资料，最终原生消息组装继续使用底座。它不重建一个自有 messages 历史，也不按任意字符串顺序重排 SDK 消息。

拟议 Interface 的输入是：有效系统配置标识、当前 head/cutoff、已提交周期快照及来源版本、当前预算估算，以及明确缺失的记忆或修订。输出是：无需动作、一个有界待提交投影、压缩意图，或明确的超限／配置错误；同样输入必须产生同样输出。

### 首次与新用户请求

先用原 requestId 查已存在的执行；已存在则复用。对新输入，在空闲边界判断是否需要初始化 B 或补充资料，通过原生 write submission 保存固定内容，再提交未经改写的用户原文。派生 requestId 同时绑定载荷摘要；投影已写但输入未提交时复用旧投影，不能重算覆盖。

已有有效 B 时，不在每条用户输入前重建 B，也不每轮全文读取工作台和每日文件。应用配置检查拒绝空白 system prompt。规则和快照计入总预算。

### 每次模型调用及工具后续调用

由底座从 A、B 和 C 的持久化记录组装，固定 cutoff，再交给 pi-ai。working 更新和记忆检索结果直接追加到 C；只有活跃上下文缺少必需版本时才补投影。已固定请求的恢复沿用原投影，不能取最新文件悄悄替换。

普通变化保持 B 不变；对同一字段，后续明确修订覆盖旧基线。若一项撤销或配置变化无法安全地用尾部修订表达，显式提前建立新上下文周期并记录原因，正确性优先于缓存。

`beforeRequest` 可用于验证或观测，但本轮不以它做无记录的大量动态注入，也不从该 hook 等待一个必须在当前 generation 结束后才会发布的压缩。

### 压缩与重置后的初始化

压缩生成的新 B 自带必要 working 基线，长 run 无须等待下一条用户消息才恢复工作状态。显式重置会结束当前周期；下一次调用前须有新的必要快照，不能仅等待用户再发一条消息。已验证的接入顺序见第 12.4 节，不能以提示词代替顺序保证。

## 7. B 的生成：摘要与精确状态分别处理

B 使用版本化的应用格式保存：连续性摘要、结构化基线、来源边界、working revision、所用配置／事实版本。记录来源的 Entry ID 使用原生类型；序列化排序固定，不加入每次渲染都会变化的时间。

压缩过程：

1. 原生压缩选定 `firstKept`，保持完整工具关联；Adapter 固定被替换的原始范围。
2. 连续性摘要由旧 B 的叙事部分与 C 中较早部分生成，只保留继续任务需要的目标、决定、约束、进度和关键引用。
3. working 基线从切分边界的历史版本读取，并确定性渲染；配置与已载入事实也使用可定位的固定版本，不由摘要模型重新解释。
4. 原生 compaction 发布新的 B，C 保留 `firstKept` 起的原文及后续修订。只有结果正式进入当前活跃上下文，周期才切换。

已验证的发布语义：generation 拥有的阻塞压缩直接 append，结果 `{ entryId }`；conversation 拥有的压缩经 `admitSubmission` 以 `requestId = "compaction:<taskId>"` 入队，结果 `{ submissionId }`，在下一个合法边界才进入上下文。任务终结、入队成功与正式发布是三件不同的事实：只有 submission 落到 `done` 且 head 变为该 `pi.compaction` 时才切换周期；被 reset 越过而落为 `unanswered`／`stale` 的写入不切换。重启后按 `compaction:<taskId>` 重查该 submission 与任务终态即可补扫，无需重算摘要。详见第 12.3 节。

边界状态必须对应 `firstKept` 之前的可见来源 Entry，不能使用“当前最新 working”。不能用 `firstKept - 1` 或所有被压缩 Entries 的最大 ID 猜测边界：fork、head marker 和资料投影需要 Adapter 按实际可见历史定位。已验证的做法是写入 working 时在同一 commit 追加一个应用锚点 Entry，之后用 `snapshotAsOf(WorkingDoc, …, anchor)` 取该边界值；head marker 的 ID 大于保留原文时仍按锚点读取，不受其影响。锚点不在当前 conversation 的可见祖先内（未覆盖的 fork、锚点早于首条可见 Entry）时 `snapshotAsOf` 抛错，应用映射为 `not-covered` 并显式拒绝，不返回旧值或默认值。

结构化基线与摘要一起进入 `pi.compaction` 的模型可见正文，作为宿主资料而非新的用户命令；不能把 B 全部写入动态 system section。已有 compaction 提示包装与应用格式的解析由一个 Adapter 处理，并有版本及旧摘要兼容路径：正文缺少应用块视为原生／升级前摘要，按叙事处理；应用块存在但版本未知或内容不合法则显式失败，不静默降级。

自定义摘要通过 `beforeCompact` 返回，范围、发布、队列和恢复继续由底座拥有。hook 内产生的模型调用必须显式解决来源固定、结果复用、超时取消、usage 记账和预算；不能声称返回一个 summary 字符串就自动具备这些行为。已验证：hook 提供的摘要不会产生原生 usage 记账（`UsageDoc.models` 中不会出现该次调用），因此 Adapter 必须在同一次 hook 调用内自行把每次尝试（含失败和重试）累加到应用自己的归属键；取消方面，hook 收到的 `context.abortSignal` 与任务 `signal` 都能真正中断进行中的模型请求。

## 8. LTM：每日事件、提取范围和落盘

### 记录什么

每日 Markdown 保存值得回看的目标、重要决定及理由、已验证结果、问题与有效解决方法、明确用户要求和跨日未完成事项。每段保留稳定 ID、来源范围、日期／时区、关键引用和修订关系。观察事实、未确认推断、失败与结果未知必须区分。

不复制整份 B，也不归档 system prompt、tool schema、所有工具大输出或技术游标。凭据和不必要的敏感正文不进入记忆。已有摘要、检索结果和记忆投影作为派生资料被跳过，避免循环归档。

提取读取新增原始 Entries，必要时用旧 B 提供背景。工具长结果采用有界证据片段和原始引用，并明确未读取范围；不能直接复用底座为摘要截取的 2,000 字符片段宣称精确信息完整。

### 触发时间

- 新的 compaction 正式生效：推进已移出活跃上下文但尚未归档的来源范围。任务完成但 summary 尚在队列、或写入为 stale 时，不当作周期已经切换。
- 业务任务明确完成：归档该完成边界以前尚未覆盖的事件。每次 assistant 回复或工具 loop 完成不自动等于业务任务完成。
- 启动、跨日后的下一次请求：补齐已结束日期的遗漏范围。首版不要求无请求时午夜定时执行。

按来源事件的已知时间和显式配置的时区分组；默认 UTC，不能读取机器本地时区作为隐式规则。未知时间显式标记，不将归档生成时间伪造为发生时间。日期文件与续页命名已由 MEM-01 冻结：目录 `memory/daily`，首页 `YYYY-MM-DD.md`，续页 `YYYY-MM-DD-2.md` … `-9.md`，未知日期为 `unknown.md`；日期按事件时间在配置时区下计算，非法日历日期直接拒绝（见 `src/memory/contracts.ts` 的 `dailyFileName`／`eventDate`）。

### 独立游标和可恢复发布

活跃上下文起点从原生 head 派生；`archivedThrough` 只表示已经完成归档处理的连续来源前缀。即便某段没有值得写入的内容，也在有持久化空结果后推进，避免反复提取。来源范围统一为 `(after, through]`：下界开、上界闭，带 conversation 标识，`after: null` 表示从可见历史开头起；`after === through` 为空。不按文本去重。

例如，LTM 已覆盖至 150，本次压缩移出至 170，则只新增处理 151–170；即使新 B 用到了 121–170，也不重复归档 121–150。任务完成先归档至 200 时，稍后压缩到 170 不回退游标。

归档使用一个原生可恢复 Task，或由其拥有的有界子任务：

1. 固定连续来源范围、格式版本、稳定 batch ID 和分段 ID。
2. 分页读取并提取，校验后持久化待发布的实际正文及内容摘要；模型可能因中断重复调用，但已保存正文不再生成。
3. Daily Memory 单写者按分段 ID 发布，临时文件写完并同步后原子替换日期文件。同 ID 同正文返回原回执；同 ID 不同正文或文件异常修改报冲突。
4. 所有日期分段发布成功后，才确认批次并推进连续归档游标。失败的日期分段补写，已成功分段不追加第二次。

文件替换和 SQLite commit 不构成同一个事务；必须分别覆盖生成后未发布、发布后未确认、跨多个日期部分成功等恢复窗口。采用有界重试，耗尽后保留可恢复失败事实供诊断和重试。原始 Entries 保留，因此归档失败不会重新执行业务任务，也不必阻止下一次普通聊天。

所有触发合并为有界的持久化目标范围；单 conversation 单归档写者，不为每个事件积累内存 Promise。完成通知之外，启动和请求边界需要从持久化事实核对，补回漏通知。

## 9. 检索、纠正与既有记忆兼容

拟议 `memory_search` 返回日期／主题／关键词的有界命中及稳定引用，`memory_read` 按引用读取有界片段和分页游标。两者由原生工具暴露，结果进入 C，不每轮重新注入全部 LTM。零命中与读失败分开；可按日期浏览，必要时回读来源 Entry。

首版直接分页扫描 Markdown，给出明确的扫描范围、返回上限和继续游标。后续全文索引是可重建派生物，不能成为另一个可编辑事实库。

既有 `MEMORY.md` 保留为用户明确保存的事实来源，不自动把日记合并进去，也不未经确认把旧文本转换成结构化偏好。加载时记录内容摘要；纠正或忘记后，未来快照与检索不能继续把旧值当作当前约定。

本轮“忘记”默认表示停止作为有效记忆使用，并在需要时保留最小撤销标记以防旧记录复活；清除所有原始历史、备份或提供商缓存属于另行定义的数据删除操作。此差别要通过实际工具结果说明，不宣称删除了所有历史副本。

## 10. 压缩策略、预算和缓存

每个 generation 准备请求时检查输入 token；缓存 token 仍占上下文窗口。底座自动阈值为 `C - R - B`（后台）与 `C - R`（阻塞），`keepRecentTokens` 控制近似保留原文。

初始实验值：后台目标 48 Ki token，近期原文约 16 Ki token，B 合计目标不超过 6 Ki token，其中叙事摘要目标不超过 3 Ki；A 约 8 Ki 内。单次记忆检索返回约 4 Ki，一次用户请求新增检索约 8 Ki。这里 Ki = 1024，均为待测量的预算；最终参数由配置 schema 定义，不在多个模块复制常量。

适配时按真实模型窗口计算提前量并校验可用范围，保留回答预算；较小窗口须调整目标。48 Ki 是后台触发目标，不是硬上限。内置摘要没有独立的 3 Ki 硬限制，自定义摘要 Adapter 才能按约定限制其输出并拒绝不完整结果。

每完成约 20 个独立用户请求可额外评估压缩；只有存在足够可压缩内容时才执行，短问答无需凑轮次压缩。工具调用和 generation 重试不算新的用户轮次，已完成请求恢复不重复计数。token 触发优先，长 run 不等待轮数阈值。

结构化状态超预算时先清理已完成事项、选择相关范围；不能静默漏掉当前任务约束。单次不可再切分的大输入或工具关联须明确失败／给文件引用，不能通过反复压缩同一内容解决。更严格的工作窗口门禁须单独验证底座调度支持，再作为后续任务。

A、B、C 是逻辑分块，不假定所有提供商的线缆消息顺序相同。A+B 和已存在的 C 前缀均可能缓存命中；B 改变后通常仅更早前缀可复用。MCP 延迟加载会改变工具集合，记录为前缀变化；不为稳定缓存阻止必要工具，也不在未完成调用期间删实现。TTL、缓存粒度和收费须在目标提供商实测。

## 11. 失败、升级与可观测性

- 必需 system prompt 或必要状态不可读：明确失败，不能默认为空后继续。正常缺省状态与损坏分别处理。
- working 业务冲突：工具返回可修正结果；基础存储失败按 Session 契约处理。
- 必需记忆加载／预算失败：有独立请求错误语义，不能全部误标为底座 Session 永久损坏。
- 压缩失败：保留旧 B/C，遵循底座后台或阻塞失败语义；不切换周期。
- 归档失败：保存待重试批次，记录归档滞后；执行和投递不重跑。
- 检索失败：明确错误；无命中返回空结果和范围，不混淆两者。

B 格式、working schema、归档批次和已持久化工具参数均是跨版本契约。接入新版本时仍能读取原生旧摘要、继续未完成请求；不在已有 requestId 下改写输入。首次升级冻结当前来源尾部作为归档起点，旧的可见快照按需转成新 B；历史全量回填另行显式触发，避免部署即扫描全部历史。

观测只记录标识、版本、数量、时长和安全错误码：A/B/C 输入量、工具声明量、缓存读写、摘要大小、head/cutoff、working revision、归档覆盖与滞后、检索范围和分页、失败与重试。模型 usage 继续使用原生计量路径；自定义提取调用的归属和记账已由 MEM-01 定案：hook 内发起的调用不产生原生记账，Adapter 必须在同一 hook 调用内把每次尝试（含失败）写入应用归属键，原生生成的调用继续按原生键记账，两者不重叠（见第 12.5 节）。日志不输出记忆正文和凭据。

业务错误与应用错误的映射在 MEM-01 冻结为一张表（`MEMORY_ERROR_MAPPING`）：`invalid-input`、`revision-conflict`、`missing-evidence`、`not-covered`、`budget-exceeded`、`corrupt-state`、`unsupported-version`、`stale` 为不可重试；`cancelled`、`io-failure`、`model-failure` 可重试。这些错误都不表示 durable Session 损坏，因此不得映射为 `AGENT_SESSION_FAILED`；真正的存储失败仍走底座 Session 失败路径。

## 12. MEM-01 验证结论与冻结契约

本节是已实测的底座行为与冻结的应用契约，替代此前“待验证”的表述。所有结论都来自 `test/memory-contract.test.ts` 在真实 `Harness` + Node 内置 SQLite + faux provider 上的执行，未使用生产数据或外部凭据；测试使用临时目录。

### 12.1 冻结位置

| 内容 | 权威来源 |
| --- | --- |
| 应用 schema、文档定义、范围与日历规则、错误分类与映射 | `src/memory/contracts.ts`（schema 版本 1） |
| 底座时序验收 01-A～01-F 与接入顺序 | `test/memory-contract.test.ts` |
| 架构、归属和模块 Interface | 本文第 3～11 节 |

`contracts.ts` 导出的类型全部由 TypeBox schema 推导，运行时用同一 schema 校验（`assertSchema`）；SDK 的 `Message`、`EntryRecord`、`EntryId`、`ConversationId`、`UsageDoc` 直接引用，不复制等价定义。模块 Interface 的输入、输出、错误、副作用与顺序写在文件头的模块注释里，一处可查。

已冻结的具体约定：

- 范围统一为 `(after, through]`（`isEmptyRange`、`rangeCovers`）。
- 业务 `revision` 从 1 起，仅在业务变化时递增；`defineDoc.version` 管结构迁移，两者不混用。
- 快照编码：叙事在前，随后是 `<cycle-snapshot>` 包裹的规范 JSON；键排序固定，不含渲染时间。
- 日期文件：`memory/daily/YYYY-MM-DD.md` 与 `-2`…`-9` 续页，未知时间为 `unknown.md`。
- 错误：11 个业务码与 `MEMORY_ERROR_MAPPING` 的不可重试／可重试划分；均不映射为 `AGENT_SESSION_FAILED`。

### 12.2 已验证的原生行为（01-A、01-B、01-D、01-F）

- **01-A**：首次请求、工具后续请求和压缩后请求都携带 `instructions` section 与工具声明；摘要请求使用独立的纯文本系统提示，没有 section。压缩后主请求继续带 A。
- **01-B**：同一 `Harness.commit()` 内写 Document 并追加锚点 Entry，之后 `snapshotAsOf(WorkingDoc, conversationId, anchor)` 精确返回当时的 revision；后续更新不影响旧边界读取。head marker 的 ID 晚于保留原文时，按锚点（而非 marker ID）读取边界状态即可。锚点早于首条可见 Entry 或 fork 未覆盖锚点时，`snapshotAsOf` 抛出 “not visible”，`workingAtBoundary` 统一映射为 `not-covered`——显式拒绝，不返回默认值或最新值。
- **01-D**：无 `model`／`head`／`edits` 的展示写入在运行中立即 append，且贡献 0 条模型消息；带 `model` 的写入在 busy 时进入 `pi.inbox` 排队，在下一个边界落地。全部走公开 admission，未深导入内部路径。
- **01-F**：schema 拒绝额外字段、`undefined` 与越界值；日期必须是真实日历日期；快照解码对“无应用块”返回 `undefined`（旧摘要），对未知版本与损坏内容显式抛错。

家族文档（`WorkingReceiptDoc`）的实测约束：`defineDocFamily` 必须提供 `initial(seed)`，且 `tx.doc(token, conversationId, key, seed)` 必须传 seed；同一 key 的再次读取返回已存值，因此操作回执按 `operationId` 天然幂等，重放不触碰 Document。

### 12.3 发布、stale 与补扫（01-C）

三种事实必须分开观察：

| 事实 | 可观察证据 | 是否切换周期 |
| --- | --- | --- |
| 压缩任务终结 | `getTask()` 的 `state.status === "terminal"` | 否 |
| 摘要写入入队 | `submissionByRequest(conversationId, "compaction:<taskId>")` 的 `status === "queued"` | 否 |
| 正式发布 | 该 submission `status === "done"` 且 `context().head` 为该 `pi.compaction` | 是 |
| 被越过 | submission `status === "unanswered"`、`reason === "stale"` | 否 |

阻塞（generation 拥有）的压缩直接 append，终态结果是 `{ result: { entryId } }`（01-A 中已验证 `entryId` 就是新的 `pi.compaction` head）；conversation 拥有的压缩入队，结果是 `{ result: { submissionId } }`（01-C）。两者都不应被当作“已发布”的同义词。

重启补扫：按 `compaction:<taskId>` 重新查询 submission 即可找回已发布事实，测试在关闭并重新 `Harness.open` 后仍读到 `done` 与相同的 head。因此归档触发应以该 submission 的 `done` 为观察点，而不是任务终态或内存通知。

### 12.4 接入顺序（首次 B、重置后 B、长 run 压缩）

实测顺序，MEM-06／MEM-07 必须遵循：

1. **首次 B**：在空闲边界用 write submission 写入 B，`status` 立即 `done`，位于随后提交的用户输入之前；第一条模型请求因此是 `A | B | 用户输入`。应用复用同一 requestId 表示同一次投影，不重新计算覆盖已有投影（去重语义由底座 submission 提供，应用侧见 MEM-07 的 07-A）。
2. **重置后 B**：运行中调用 `reset` 后，紧接着写入的 B 为 `queued`；reset 落地后 B 才 append，新周期以 `pi.reset` 为 head，旧 B 不再出现在上下文中。因此接入顺序是先提交 reset、再写新 B；在 reset 之前提交的写入不保证属于新周期。写入是否被越过由原生判定：head 早于当前活跃范围时落为 `unanswered`/`stale`（见 12.3），应用据此决定是否重写 B。
3. **长 run 压缩**：阈值策略触发压缩后，新 head 为 `pi.compaction`，`head` 等于 `firstKept`，保留的 C 从 `firstKept` 起；压缩后的实际请求携带新摘要，原始 Entries 未被删除。

在 busy 状态直接向 conversation 追加模型消息不可行，也不应尝试：展示型写入可以立即落地，影响上下文的写入必须排队或等待边界。

### 12.5 自定义摘要的 usage 归属与取消（01-E）

- hook 内用 `models.completeSimple()` 发起的调用**不产生**原生 usage 记账：`UsageDoc.models` 中不会出现该次调用的键。Adapter 必须在同一次 hook 调用内，把每次尝试（成功与失败）累加到应用自己的归属键（例如 `app/summary`），否则用量缺失；底座自身的生成与原生摘要继续按原生键记账，两者不重叠，因此不会重复计量。
- 重试由 Adapter 自己负责；失败尝试同样消耗 token，必须计入。
- 取消：hook 的 `context.abortSignal` 与任务 `signal` 都能中断进行中的 `completeSimple` 调用，返回 `stopReason: "aborted"`；任务随后提交 `aborted` 终态。Adapter 不应吞掉取消后继续返回摘要。
- memo 可用于同一次任务内“只算一次”的中间结果，但首次写入获胜，且任务终结后不可读；不能当作跨任务回执。

### 12.6 仍未验证或受限的部分

- 自定义 `defineTask` 的 `abort` 阶段是必需的；本轮只验证了内置 `CompactionTask` 的取消路径，归档 Task 的取消与恢复留待 MEM-05 验证。
- hook 运行时对象虽然是完整 `TaskRuntime`，但声明类型 `HookApi` 只承诺读取与 memo。应用只用 `Harness.commit()` 持久化，不依赖未声明的 `commit()`，以免升级时静默失效。
- 真实模型窗口下的预算、缓存命中与摘要质量不在本轮范围（MEM-06、MEM-08）。
- 归档 Task、每日文件发布与检索的文件级恢复窗口未验证（MEM-04、MEM-05）。

## 13. MEM-02 实现结论与 Working 语义

本节记录 Working Module 的实测行为，是第 5 节更新协议的具体落实。证据为 `test/memory-working.test.ts`（02-A～02-G）在真实 `Harness` + SQLite + faux 上执行；02-B 使用 `test/fixtures/crash-working.ts` 在真实进程中被 `SIGKILL`。

### 13.1 冻结位置

| 内容 | 权威来源 |
| --- | --- |
| Working Interface（读当前／读边界／读回执／读完成事实／应用更新）、错误与副作用 | `src/memory/working.ts` 文件头 |
| 原生工具 `working_read`／`working_update` 的参数、模型可见结果与错误映射 | `src/memory/working-tools.ts` |
| 模型可见变更 schema（`*DraftSchema`）、完成事实 entry、锚点与回执字段 | `src/memory/contracts.ts` |
| 验收 02-A～02-G | `test/memory-working.test.ts` |

### 13.2 身份与幂等

- 模型参数只有 `expectedRevision`、`evidence`、`changes`；`conversationId`、`operationId`、时钟由宿主提供。证据在 `WorkingUpdateArgsSchema` 里是纯 `EntryId`，宿主在调用会话内解析为 `SourceRef`，因此模型无法把事实指向其他会话。
- `operationId = "tool:<taskId>"`：一次原生工具调用就是一个持久化工具任务，任务 ID 在重试与重启间不变，同时落在 identifier 字符集内。
- 回执按 `operationId` 存为家族文档成员；`Tx` 没有 `snapshot()`，首跑用哨兵 seed（`at: -1`）经 `tx.doc` 读取，命中已存值即重放。
- **事务内的值不能带出 commit**：`tx.doc` 返回的是受追踪 draft，commit 结束后即失效（读它会抛 “settled overlay”）。因此回执在返回前 `detach()`（JSON 复制）。同理，draft 不是普通对象，`structuredClone` 会抛 `DataCloneError`。

### 13.3 一次 commit 写什么

`applyWorkingUpdate` 的全部拒绝都发生在写入之前；接受时同一 commit 内写：状态 Document（仅在有业务变化时）、锚点 Entry、任务完成 Entry（仅当本次把 `active` 清为 `none`）、回执文档。`previousRevision` 在改写 Document 之前读取——Document draft 就是被写的那个对象。

- 无业务变化：返回 `changed: false`，不写 Document、不递增 revision，但仍写锚点与回执（该调用确实发生过）。
- 清理任务：写 `WorkingCompleted` entry（goal、scope、sources、operationId），回执与锚点的 `completedEntryId` 指向它；归档可按该 entry 重取完成事实，无需读实时状态。有效偏好不受影响。
- 上限：偏好数量、约束数量等由 schema 与模块共同拒绝；超过上限是显式 `invalid-input`，绝不截断已有内容。已过期偏好不落库。

### 13.4 崩溃窗口（02-B）

工具包装为 `replay: "safe"`。在“Document 已提交、工具结果未提交”处 kill 进程后重启：

- 工具任务被重跑一次（测试确认重跑真的发生），`operationId` 不变，命中回执后原样返回；
- revision 不再次递增，锚点 Entry 只有一个，工具结果报告的是原 revision；
- 只有该测试通过后，`working_update` 才声明 `replay: "safe"`。

### 13.5 错误与模型可见输出

- 业务错误（`invalid-input`、`revision-conflict`、`missing-evidence`、`corrupt-state`）返回 `isError: true` 的结果，模型可据后续有效调用修正；**非 `MemoryError`（存储或 Session 失败）直接抛出**，不伪装成参数问题。
- 参数级拒绝（未知字段、空 changes、超界）由底座 schema 校验在 `execute` 之前拦下，同样是可修正的错误结果。
- 工具结果只含 revision、任务与偏好的文本视图和有界 `structuredOutput`，不含 `conversationId`、锚点或来源 ID；这些只出现在应用内部契约里。

## 14. 实施入口与发布判定

按 [实施 issues](memory-implementation-issues.md) 的依赖顺序执行。先完成公开 API 可行性和 Interface 契约，再并行实现 Working、Context、Daily Memory；最后接入底座与应用并做故障恢复验收。

验收必须同时证明：实际请求含 A/B/C、周期内前缀稳定、压缩后状态正确、归档不重不漏、检索可追溯、既有请求与投递恢复保持有效。固定序列的离线模型验证机制，真实模型验证摘要质量和缓存行为，两者分别记录。仅修改文档不代表其中任何能力已实现。

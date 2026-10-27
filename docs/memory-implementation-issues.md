# Memory 与 Context：实施 issues 和验收

状态：MEM-01～MEM-05 的 module 已实现并通过各自本地验收；MEM-06 待领取，全部能力尚未接入运行中的 agent（MEM-07 负责组合）。编制日期：2026-10-25。架构与 Interface 语义以 [实施方案](memory-and-context-design.md) 为唯一来源；本文负责拆分任务、依赖、交接产物和完成条件。

## 接手方式

1. 先读根目录 `CLAUDE.md`、实施方案，以及领取 issue 指向的代码；涉及 SDK 时核对已安装的发布版。
2. MEM-01 完成后冻结应用契约和文件归属，再开始并行。后续需要变更公共 Interface 时，先更新契约及调用方说明；不由两个 agent 各建一份近似类型。
3. 每个 issue 交付一个可独立评审的改动，包含本项代码、针对真实失败行为的测试，以及契约发生变化时的对应文档。共享组合入口由 MEM-07 统一接入。
4. 测试遵循 `package.json` 的检查入口和既有 `test/*.test.ts` 发现方式。离线模型使用现有 faux provider；持久化路径使用临时目录和真实 SQLite，不能用生产数据或外部凭据代替测试夹具。
5. 交接记录列出已完成验收编号、执行命令与结果、未通过或未执行项、兼容性变化及后续依赖。测试文件存在不等于验收通过。

创建远端 issue 时可直接使用各节的标题、范围、依赖与验收；MEM 编号是本文任务标识，不能冒充 GitHub issue 编号。

远端 issues（2026-10-25 创建，标签 `enhancement`）：

| ID | GitHub issue |
| --- | --- |
| MEM-01 | [#8](https://github.com/NaoYUN77/personal-agent-base-durable/issues/8) |
| MEM-02 | [#9](https://github.com/NaoYUN77/personal-agent-base-durable/issues/9) |
| MEM-03 | [#10](https://github.com/NaoYUN77/personal-agent-base-durable/issues/10) |
| MEM-04 | [#11](https://github.com/NaoYUN77/personal-agent-base-durable/issues/11) |
| MEM-05 | [#12](https://github.com/NaoYUN77/personal-agent-base-durable/issues/12) |
| MEM-06 | [#13](https://github.com/NaoYUN77/personal-agent-base-durable/issues/13) |
| MEM-07 | [#14](https://github.com/NaoYUN77/personal-agent-base-durable/issues/14) |
| MEM-08 | [#15](https://github.com/NaoYUN77/personal-agent-base-durable/issues/15) |

只先领取 MEM-01。依赖未满足时不要提前实现下游 module 的接入部分；本表与各 issue 的「依赖」一节一致，改动时两处同步。MEM-01 已于 2026-10-25 完成（交接记录见本节末），MEM-02、MEM-03、MEM-04 同批完成（交接记录分别见其小节末）。MEM-05 已于 2026-10-26 认领并完成本地验收（交接记录见对应小节）；MEM-06 的两半依赖（MEM-02、MEM-03）已满足，可开始。

## 依赖与并行安排

| ID | 标题 | 依赖 | 主要修改归属 |
| --- | --- | --- | --- |
| MEM-01 | 验证原生接入并冻结最小契约 | 无 | SDK 契约验证测试、应用 schemas、本文与实施方案 |
| MEM-02 | Working 状态与版本化更新 | MEM-01 | Working Module、working Document／tools Adapter、对应测试 |
| MEM-03 | 纯 Context 规划与快照渲染 | MEM-01 | Context Module、稳定渲染与预算测试 |
| MEM-04 | 每日 Markdown 的发布与检索 | MEM-01 | Daily Memory Module、文件协议及对应测试 |
| MEM-05 | 可恢复的增量归档任务 | MEM-01、MEM-04 | Archive Module、归档 Task／提取 Adapter、对应测试 |
| MEM-06 | 原生压缩接入与周期快照切换 | MEM-02、MEM-03 | compaction Adapter、轮数评估与对应测试 |
| MEM-07 | 接入请求生命周期及记忆工具 | MEM-02～MEM-06 | `src/agent.ts`、配置、注册入口、原生检索工具、运行说明 |
| MEM-08 | 故障恢复、质量与资源验收 | MEM-07 | 综合验证、验收记录及目标环境结果 |

MEM-02、03、04 可并行；04 完成后可启动 05，02 与 03 完成后可启动 06，05 与 06 可并行。每项应使用最小 harness 或独立 Interface 完成测试，不等 MEM-07 接线后才证明自身正确。

MEM-01 验证失败的接入点必须有具体替代方案和对应验收后才能解锁依赖项；不能把未证实能力写成“后续补一个 hook”。不涉及该接入点的独立 module 可继续推进。

## MEM-01：验证原生接入并冻结最小契约

**目标**：用已安装公开 API 证明关键时序，给其他 agent 一个可信、足够小的 Interface。此项包含必要的离线测试代码，不实现完整记忆功能。

**阅读入口**：实施方案第 2、4、6、7、10、11 节及第 12 节；`test/durable.test.ts`、`test/recovery.test.ts`、`test/memory-contract.test.ts`；SDK 的 `harness/types.d.ts`、`compaction.js`、`context.js`、`generation.js`、Documents／Tasks 的公开类型。

**工作与交付**：

- 冻结 WorkingState、工作更新与回执、CycleSnapshot、MemorySegment、ArchiveBatch、ContextPlan 的最小版本化 schema；只定义本项目的数据，复用 SDK Message／Entry／ID。schema 是类型与校验的共同来源。
- 固定范围的开闭语义、来源标识、业务 revision、快照格式、错误类别、预算归属、文件命名与跨日规则。ID、身份、目录和幂等操作标识由宿主提供。
- 证明 working 更新的 commit 与 Entry checkpoint 对齐，能读取切分点之前的状态；定义 fork／旧 head 情况的来源定位方法。
- 验证 `beforeCompact`、memo 和原生提交组合；确定自定义摘要／提取的调用归属、取消、持久化结果及原生 usage 记账方法。
- 验证压缩任务终态、summary write 入队、正式发布、stale 的区别；确定可重放的发布观察与补扫方式。
- 冻结首次 B、重置后 B 和长 run 压缩的接入顺序，以及业务错误到应用错误的映射。文档与验证结论写回现有两份文档，避免另建重复计划。

**验收**：

- [x] 01-A：真实 Harness + SQLite + faux 模型中，首次请求、工具后续请求及压缩后的实际请求均有有效 system prompt。
- [x] 01-B：先在同 commit 写 working 与锚点，再做后续更新，验证 `snapshotAsOf` 得到切分边界的旧版本；覆盖 head marker ID 晚于保留原文的情况。未覆盖 fork 必须显式限制并拒绝，而非返回错误状态。
- [x] 01-C：后台摘要入队不切换应用周期；仅正式发布触发，stale 不触发。重启补扫不会漏掉已经发布的摘要。
- [x] 01-D：展示 hook 能力的最小实现，既不深导入 SDK 内部路径，也不向 busy conversation 直接追加模型消息。若需要 API 升级或底座变更，依赖项保持阻塞并记录具体缺口。
- [x] 01-E：自定义摘要／提取的模型调用有可核对的 usage 归属和失败／重试用量，不因只返回字符串漏计或重复计量；取消信号到达实际模型 I/O。
- [x] 01-F：新旧输入格式、旧 compaction、初始化和升级起点有明确兼容策略。每个 module 的输入、输出、错误、副作用及顺序约束可从一个 Interface 定义查到。

**交接记录（2026-10-25）**

交付物：

- `src/memory/contracts.ts`：schema 版本 1 的唯一来源——`WorkingState`／更新参数／回执／锚点、`CycleSnapshot` 及编解码、`MemorySegment`、`ArchiveBatch`、`ContextPlan`、`MemoryBudget`、`SourceRange` 与日期命名、`MEMORY_ERROR_CODES`／`MEMORY_ERROR_MAPPING`／`MemoryError`、`workingAtBoundary`。文件头按 module 写明输入、输出、错误、副作用与顺序。
- `test/memory-contract.test.ts`：01-A～01-F 加接入顺序测试，全部使用真实 `Harness` + `openNodeSqliteStorage` + faux provider，临时目录，不接触生产数据或外部凭据。
- `docs/memory-and-context-design.md`：第 12 节记录实测结论，第 2、4、6、7、8、11 节按结论修正。

执行命令与结果：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 通过，无输出 |
| `npx tsx --test test/memory-contract.test.ts` | 8/8 通过 |
| `npm test` | 95/95 通过（既有 durable、recovery、delivery、tool 测试无回归） |

各验收的实测结论：

- **01-A**：首次、工具后续、压缩后主请求都含 `instructions` section 与工具声明；摘要请求使用独立纯文本系统提示；阻塞压缩的终态结果为 `{ entryId }`，指向新的 `pi.compaction` head。
- **01-B**：同 commit 的 Document + 锚点 Entry 给出精确边界历史；marker ID 晚于保留原文仍按锚点读取；未覆盖 fork 与首条 Entry 之前的边界均抛 `not-covered`；家族文档重放返回原回执且不改 revision。
- **01-C**：入队（`queued`）与发布（`done` + head 变为 `pi.compaction`）分离；reset 越过后为 `unanswered`/`stale` 且周期不变；重开 Harness 后按 `compaction:<taskId>` 仍读到 `done`。
- **01-D**：展示写入运行中立即落地且 0 条模型消息；模型写入排队到边界。
- **01-E**：hook 内调用不产生原生 usage（`summary/summary-1` 缺失），应用归属键累计失败＋成功两次尝试；`ctx.abortSignal` 使调用返回 `aborted`，任务提交 `aborted` 终态。
- **01-F**：schema 拒绝额外字段、`undefined`、越界与非法日历日期；范围 `(after, through]` 语义；快照编解码对旧摘要返回 `undefined`、对损坏／未知版本抛错；错误映射不含 `AGENT_SESSION_FAILED`。

未通过或未执行项（均不属于本 issue 验收，已写入实施方案 12.6）：自定义归档 Task 的 `abort` 阶段与恢复（MEM-05）；hook 运行时对象上未声明的 `commit()` 未作为契约使用；真实模型窗口预算与缓存命中（MEM-06、MEM-08）；归档任务的文件级恢复窗口（MEM-05，每日文件替换本身已由 MEM-04 的 04-B 覆盖）。

对下游的解锁条件：MEM-02～MEM-05 可立即开始，共享 `src/memory/contracts.ts`，不得另建近似类型；MEM-06 在 MEM-02、MEM-03 完成后开始，接入顺序按实施方案 12.4 执行（先 reset 再写 B）。发布观察点有两条路径：经 submission 的压缩看 `done`，阻塞压缩看 `entryId` 是否成为活跃 head（详见 12.3、14.5）。

## MEM-02：Working 状态与版本化更新

**目标**：提供可恢复的当前任务状态和明确偏好，不承担执行恢复或消息投递状态。

**依赖**：MEM-01。**阅读入口**：实施方案第 3、5 节及第 12、13 节；`src/memory/contracts.ts`、`src/memory/working.ts`（已实现）；现有工具注册和参数验证测试。

**工作与交付**：

- 实现 task 与 preferences 分区的 Working Module，支持读取当前状态、指定边界状态及带 expectedRevision 的有来源变更。
- Durable Adapter 定义 rewindable Document 和原生 `working_read`／`working_update`；更新与应用操作回执、Entry 锚点按 MEM-01 的协议提交。
- 返回有界修订，让原生工具结果进入 C；模型参数不能设置宿主身份、执行状态或归档游标。
- 对来源、任务完成证据、偏好作用范围和有效期做执行边界检查。明确完成事件可供归档恢复处理，任务清理不清空有效偏好。

**验收**：

- [x] 02-A：非法参数、未知字段、无效来源和 revision 冲突不执行变更；显式错误可由后续有效工具调用修正。
- [x] 02-B：同一调用在“Document 已提交、工具结果未提交”处中断，恢复后状态只变一次，返回原回执，revision 不额外增加。通过后才声明安全重放。
- [x] 02-C：两个基于同一 revision 的更新不会静默覆盖；无业务变化不递增 revision。
- [x] 02-D：跨多次更新与重启，当前读取和边界读取均正确；B 使用旧版本时，C 中的修订能导出当前状态。
- [x] 02-E：任务完成后活跃事项可清理，持久化完成事实可重取，跨任务偏好仍在；一次性要求不自动成为永久偏好。
- [x] 02-F：超过状态上限时返回明确处理结果，不静默丢弃当前约束。module 测试无需 Telegram 或真实模型。

**交接记录（2026-10-25）**

交付物：

- `src/memory/working.ts`：Working Module Interface——`readWorking`、`readWorkingAt`、`readWorkingReceipt`、`readCompleted`、`applyWorkingUpdate`（输入 `Committer`，Session 与工具执行 API 都满足）、`activeTask`。文件头写明输入、错误（`invalid-input`／`revision-conflict`／`missing-evidence`／`not-covered`／`corrupt-state`）与副作用。
- `src/memory/working-tools.ts`：原生 `working_read`／`working_update`，`replay: "safe"`，有界文本视图与 `structuredOutput`；业务错误返回可修正结果，非 `MemoryError` 抛出；导出 `workingExtension` 供 MEM-07 组合。
- `src/memory/contracts.ts`（增量）：`WORKING_COMPLETED_KIND`／`WorkingCompletedSchema`／`WorkingCompletedEntry`；锚点与回执的 `completedEntryId`；模型可见 `ProgressItemDraftSchema`、`ActiveTaskDraftSchema`、`PreferenceDraftSchema`，使模型只传 `EntryId`，不传 `conversationId`。
- `test/memory-working.test.ts`：02-A～02-F，另加 02-G（存储值 schema 不符显式报错）。
- `test/fixtures/crash-working.ts`：真实子进程，在“已提交、未写工具结果”处阻塞，由父进程 `SIGKILL`。
- `docs/memory-and-context-design.md`：新增第 13 节（冻结位置、身份与幂等、一次 commit 写什么、崩溃窗口、错误与模型可见输出）；MEM-03 加入第 14 节后，原第 13 节之后的实施入口节顺延为第 15 节。

执行命令与结果：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 通过，无输出 |
| `npx tsx --test test/memory-working.test.ts` | 7/7 通过（含真实进程崩溃恢复） |
| `npm test` | 102/102 通过（MEM-01 基线 95 项未回归） |

逐项结论：

- 02-A：未知字段、空 `changes`、无证据的 `task.set`、未提交或属于其他会话的证据、旧 revision 全部被拒绝；参数级拒绝由底座在 `execute` 前拦下，业务级拒绝返回 `isError`。所有拒绝不写锚点、不改状态，随后一次有效调用成功并进入 revision 2。
- 02-B：工具为 `replay: "safe"`；kill 后重启，同一工具任务重跑一次（测试记录重跑次数），命中回执后原样返回。revision 未再递增，锚点只有一条，工具结果报告原 revision。
- 02-C：基于同一 revision 的第二个更新得到 `revision-conflict`，状态保持第一个更新的结果；同内容再次提交得到 `changed: false`、revision 与 `updatedAt` 均不变。
- 02-D：多次更新后按锚点读取边界状态，每个锚点读到的 revision 与锚点记录一致；最新锚点读到的状态等于当前状态；关闭并重开 Harness 后当前与边界读取都一致；首个更新之前的边界为 `not-covered`。
- 02-E：`task.clear` 写 `WorkingCompleted` entry，回执与锚点带 `completedEntryId`，重启后仍可 `readCompleted` 取回；有效偏好保留；一次性约束只留在任务里，不成为偏好；重复清理是 no-op，不产生第二个完成事实。
- 02-F：偏好达到上限时新增被拒；约束超过 schema 上限时整次更新被拒；拒绝后已存状态逐字段不变；移除一条偏好后可再添加；已过期偏好不落库。
- 02-G（补充）：回执版本不符时 `readWorkingReceipt` 报 `corrupt-state`，不按旧结构解释。

未覆盖／受限：

- 真实模型的工具选择与参数质量不在 module 范围（MEM-07／MEM-08）。
- 偏好作用范围目前只做存储与展示，尚无检索期的作用域过滤（MEM-06 之后接入）。
- 归档从 `completedEntryId` 取完成事实的消费方尚未实现（MEM-05）。
- 未接入运行中的 agent：`workingExtension` 已导出但未在 `src/agent.ts` 注册（MEM-07 负责组合）。

对下游的解锁条件：MEM-02 已完成，MEM-06 可与 MEM-03 并行开始；读取 Working 一律经 `src/memory/working.ts`，不直接读 `WorkingDoc`。模型可见 schema 的 `*Draft` 系列只用于工具参数，内部契约继续使用带 `SourceRef` 的类型。

## MEM-03：纯 Context 规划与快照渲染

**目标**：给定已固定输入，输出确定的加载／压缩计划与有界快照，保持 B 和既有 C 稳定。

**依赖**：MEM-01。**阅读入口**：实施方案第 1、4、6、7、10 节及第 12、14 节；`src/memory/contracts.ts`、`src/memory/context.ts`（已实现）。

**工作与交付**：

- 实现纯函数规划：初始化 B、无需动作、缺失资料投影、压缩意图、明确错误。
- 稳定渲染版本化 B，将叙事摘要与精确状态分开；保存来源边界及 revision，不混入每次调用变化的时间。
- 实现总输入和分项预算判定，区分后台阈值与硬限制；参数从唯一 schema 取得。
- 定义按来源／版本去重，及读取同一已提交投影时保持原文的行为；返回待提交材料，由 Durable Adapter 执行副作用。

**验收**：

- [x] 03-A：相同输入得到字节一致的渲染与计划；重复构建不会产生重复记忆投影。
- [x] 03-B：working revision 更新时，输出需要进入 C 的修订，不重渲染现有 B；下次周期才输出新 B。
- [x] 03-C：带旧快照、近期修订和新偏好撤销的样本，不把旧值重新当作当前约定。
- [x] 03-D：空白 system prompt、必要状态损坏、超预算且无可安全压缩内容时返回明确错误；所有输入块及缓存 token 均计入预算。
- [x] 03-E：测试无需启动 Harness、打开文件或调用模型；module 无这些运行时依赖。
- [x] 03-F：不创建 SDK 消息类型副本、不裁断工具关联、不生成新 agent loop。短对话达到轮数但无足够可压缩内容时不反复要求压缩。

**交接记录（2026-10-25，2026-10-25 复核后修订）**

初版把投影写成 `model: []` 的展示条目，与第 12.4 节“首次请求已含 B”冲突，也使 03-B／03-C 只证明了“能生成当前状态的数据”，没证明“能进入模型上下文”。复核后改为两种都带模型消息的写入，并补上分项预算与 facts 变化的判定。修订内容见本记录末尾。

交付物：

- `src/memory/context.ts`：Context Module Interface——`planRequest`、`boundaryWrite`（建立 B，携带原生摘要形状的模型消息）、`revisionWrite`（周期内补入 C，携带 `<working-revision>` 包裹的精确 baseline）、`reuseWrite`、`digestOf`、`sameFacts`、`blockUsage`、`buildSnapshot`、`renderSnapshot`、`snapshotFromHead`、`snapshotOfProjection`、`snapshotTextFor`、`measureRequest`、`validateWorking`、`isStale`、`initialBoundary`。文件头写明输入、输出、错误与“无 I/O／无 Harness／无模型”的约束。
- `src/memory/contracts.ts`（增量）：`WorkingBaselineSchema`／`baselineOf`／`renderBaseline`（去掉 `updatedAt` 的边界投影与确定性渲染）、`CycleBoundary` 类型与可为 `null` 的 initial 锚点、`sources` 可为 `null`、`SnapshotFacts` 类型导出、`Preference` 类型、`MEMORY_LIMITS.instructions`／`snapshotText`、`REVISION_BLOCK_OPEN`／`REVISION_BLOCK_CLOSE`、`ContextPlan` 的 `compact.reason` 增加 `facts`、`MemoryErrorCodeSchema` 改为 `Type.Unsafe`（`Type.Union` 推断为 `never`）、`MemoryError.toJSON()`。
- `test/memory-context.test.ts`：03-A～03-F 共 10 个用例，纯值测试；唯一一次文件读取用于断言模块的 import 列表，不启动 Harness、不打开数据库、不调用模型。
- `docs/memory-and-context-design.md`：新增第 14 节（冻结位置、输入输出与优先级、B/C 边界、预算、与 MEM-02／MEM-06 的接缝），原第 14 节改为第 15 节；第 2、6、7、10 节同步状态与实现结论。

执行命令与结果：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 通过，无输出 |
| `npx tsx --test test/memory-context.test.ts` | 10/10 通过 |
| `npm test` | 112/112 通过（MEM-02 基线 102 项未回归） |

逐项结论：

- 03-A：同输入的计划 `JSON.stringify` 完全一致；同一快照的重复渲染与键顺序重排后的渲染字节相同，且能解码回原值；只改 `updatedAt` 的两次渲染与 digest 相同。boundary 写入本身也逐字节一致，`snapshotOfProjection` 取回的就是它渲染的那份快照。同一 revision＋同一 facts 的重复写入 digest 相同，`reuseWrite` 原样返回已提交写入；C 已含该 revision 后计划为 `none`。
- 03-B：`workingInContext: false` 且 revision 落后时计划产出一个 `revision` 写入；该写入的 `model` 恰有 1 条 user 消息，含 `<working-revision>` 标记与 `renderBaseline` 的精确内容，因此不调用 `working_read` 也能读到当前值；写入不含旧叙事，也不被 `snapshotOfProjection` 当成 B；已提交 B 的渲染字节不变；换周期后 `snapshotTextFor` 返回新文本，活跃周期返回 `undefined`。
- 03-C：旧快照含 `lang` 偏好、当前 revision 撤销它时，`isStale` 为真，写入的 `baseline.preferences` 只有 `tone`，模型消息里也只有 `tone`、没有 `lang`；旧 B 不被改写；新周期的 B 不再含 `lang`；C 已含修订后不再逐轮投影。
- 03-D：空串与纯空白 A 返回 `invalid-input`，超长 A 返回 `budget-exceeded`；`revision: 0`、缺字段的 working 与结构不完整的 B 均返回 `corrupt-state`（且 schema 校验先于分项测量，损坏的 B 不会在计量时抛异常）；任一分项超过自己的额度返回 `budget-exceeded` 且 `detail.block` 指明块名，把该块额度放宽后同一输入即通过；超过阻塞阈值且 `compactableTokens === 0` 返回 `budget-exceeded`，有可压缩内容时改为 `compact`／`budget`；恰好等于阈值仍可放行。`measureRequest` 对 `input+output+cacheRead+cacheWrite` 求和，去掉缓存后差额恰为缓存量，尾随消息计入；用该实测值驱动计划时请求超限。
- 03-D（渲染上限）：结构合法但渲染文本超过 `MEMORY_LIMITS.snapshotText` 的 B 由 `renderSnapshot` 直接调用时抛 `budget-exceeded`，经 `planRequest` 时返回同码的错误计划，不截断、不以异常穿出。
- 03-D（写入额度）：在合法的 256 token 快照份额下，已提交 B 通过分项检查，但该计划将要生成的写入（首次 B 与修订写入）各为 392／276 token，均超出份额，`planRequest` 返回 `budget-exceeded` 且 `detail` 为 `{block: "snapshot", kind, tokens, limit}`；换成默认份额后同样输入返回 `project`，说明拒绝因素是份额而非其他条件。
- 03-D（facts 变化）：`facts` 一致走常规路径；`memoryDigest` 变化、revision 不变时返回 `compact`／`facts`，无可压缩内容时返回 `budget-exceeded`，周期内不重写前缀。
- 03-E：断言 `context.ts` 的 import 列表恰为 `./contracts.js`、`@earendil-works/chord`、`@earendil-works/pi-ai`、`@earendil-works/pi-ai/utils/estimate`、`@earendil-works/pi-durable`、`node:crypto`；pi-durable 与 chord 都只以 `import type` 出现；不含 `node:fs`／`node:child_process`／`node:sqlite`／`Harness`／`openNodeSqliteStorage`／`createModels`。`planRequest` 同步返回，两次调用互不共享对象，输入不被修改。
- 03-F：轮数超过阈值但 `compactableTokens === 0` 时连续三轮都是 `none`；有可压缩内容时返回 `compact`／`rounds`；少一轮不触发。`measureRequest` 不修改 transcript，工具调用与其结果的关联保持，工具参数计入大小。
- 变异检查：初版 7 个变异（去掉 `compactableTokens` 守卫、忽略 `workingInContext`、digest 不含 facts、阈值不含 `reserveTokens`、`snapshotTextFor` 不去重、baseline 保留 `updatedAt`、允许空白 A）全部被捕获。修订后新增 7 个（revision 写入改为空 model、boundary 写入改为空 model、去掉分项额度检查、忽略 facts 变化、把分项测量移到 schema 校验之前、去掉写入生成后的额度检查、去掉 `planRequest` 的异常转换），也全部被捕获；其中“boundary 写入改为空 model”在补上断言前未被捕获，说明该缺口原先确实没有证据。

未覆盖／受限：

- 真实模型窗口下的预算标定与缓存命中不在本 issue 范围（MEM-06、MEM-08）。
- `planRequest` 只做决策，不写任何东西；两种写入的持久化、submission 排队与周期切换由 MEM-06 的 Durable Adapter 完成。
- `measureRequest` 的数值依赖底座 usage 上报；faux provider 不产生真实缓存计量，本项只验证口径而非真实计费。
- 缺失资料投影未实现：模块不接收待补资料正文，因此“已有 B、revision 不变、只缺某份资料”时计划为 `none`。该输入需要由 MEM-04（检索）与 MEM-07（接线）定义，见实施方案第 6 节。
- 写入额度按快照份额检查，是“单次写入不超过该块容量”的上界；它与请求总预算的相互作用（写入后请求整体是否仍装得下）由 MEM-06 在真实请求上标定。
- `budget.narrativeTokens`、`searchResultTokens`、`requestSearchTokens` 当前不被本模块消费，对应的超额判定分别属于 MEM-06 的摘要调用与 MEM-05／MEM-07 的检索预算，本项没有假装已判定。
- 尚未在组合入口注册（MEM-07）。

对下游的解锁条件：MEM-06 可开始。压缩侧只通过 `buildSnapshot`／`renderSnapshot` 产出 B，边界状态一律由 `readWorkingAt` 按锚点读取后传入，不传最新状态。周期切换有两条确认路径，缺一不可：经 submission 发布的压缩看 `requestId = "compaction:<taskId>"` 落到 `done`；generation 拥有的阻塞压缩直接 append，只返回 `{ entryId }`、没有 submission，须以该 Entry 成为活跃 head 为判据（详见实施方案 14.5）。MEM-07 接线时 `workingInContext` 由活跃上下文的实际内容决定，不能默认 `true`；两种写入都用 `root.submit({type: "write", entry})` 提交，不得改回 `model: []`。

## MEM-04：每日 Markdown 的发布与检索

**目标**：提供一个可独立测试的文件存储 Interface，隐藏文件查重、原子替换和分页细节。

**依赖**：MEM-01。**阅读入口**：实施方案第 8、9 节及第 12 节；`src/memory/contracts.ts` 中的日期与分段规则。

**工作与交付**：

- 实现发布固定分段、按稳定引用读取、按日期／关键词／主题检索；接受目录、时钟和已校验数据，内部不调用模型或 Harness。
- 使用约定的日期文件、分段 ID、内容摘要和来源格式；单写者、临时文件、同步与原子替换保证可恢复。
- 为单段、单文件、一次扫描／返回设置明确上限；超限按已冻结的分页或续页规则处理，不静默截断。
- 读写失败、无命中、未扫描范围、游标失效和外部文件冲突分别报告；检索结果可定位到精确分段和原文来源。

**验收**：

- [x] 04-A：同 ID 同内容重复发布不重复追加；同 ID 不同内容报冲突。并发发布串行化且不丢分段。
- [x] 04-B：在临时文件写入、原子替换前后注入失败，读者看到完整旧版或完整新版；重启能核对原回执。
- [x] 04-C：路径越界、符号链接逃逸、无权限、损坏文件、未知引用分别有明确结果；数据目录由宿主控制。
- [x] 04-D：跨多个日期分页检索，零命中不等于历史不存在；返回扫描范围、继续游标和未读范围。文件在翻页间变化时不静默漏项。
- [x] 04-E：已撤销／被替代的记忆不会作为当前事实返回；历史视图明确标识旧状态。
- [x] 04-F：长文本和大量日期文件不会一次性读入全部历史；测试记录实际扫描／返回上限，且完全不依赖 agent 运行时。

### 交接记录（2026-10-25，含首轮评审修正）

**交付**：`src/memory/daily.ts`（Daily Memory Module）、`test/memory-daily.test.ts`（7 个用例覆盖 04-A～04-F）。模块只依赖 `./contracts.js` 与 Node 标准库，不引入 agent 运行时、数据库或模型。

**Interface**：`openDaily(root)`、`publishSegments(store, segments)`、`readSegment(store, ref)`、`searchDaily(store, query)`、`digestOfSegment(segment)`、`identityOfSegment(segment)`；`DAILY_LIMITS`、`SearchCursor`、`CoveredFile`、`DailySearch`、`SegmentLookup`、`PublishReceipt` 从同一文件导出。文件格式、顺序规则与错误语义写在文件头。

**评审提出的 12 个缺陷及本地修复记录如下，等待复验**。自动化证据按场景分别记录；缺陷 3、8 各有一个同调用内窗口尚无自动化覆盖，不能声称全部修正都有「回退即失败」的证据。

| # | 缺陷 | 修正 |
| --- | --- | --- |
| 1 | 块外内容被跳过，损坏标记后的记录对检索不可见，下次发布整体重写会删掉它 | `parseFile` 严格解析：块外内容、标题不符、空文件均报 `corrupt-state`，发布同样被拒 |
| 2 | 按文件刷新会提前写入同文件的其他替代记录，跨文件时不保证先撤销 | 分两阶段：先写完所有文件的替代标记，再写任何含新记录的文件 |
| 3 | 游标在签发时重新测量文件，读取后的追加被吸收进游标自身，续页静默漏项 | 游标携带**读取前一刻**观察到的 `covered`（size + mtime），续页逐个比对 |
| 4 | 只检查 `root/memory/daily` 与目标文件，`root/memory` 为 junction 时写穿根目录 | 检查 `root` 到文件之间的每一层；列目录前也检查 |
| 5 | 同一调用内两条记录可替代同一旧记录，两条都成为当前事实 | 落盘前检测批内重复替代，报 `revision-conflict` |
| 6 | 发布身份包含可变的 `supersededBy`，被替代后原始调用无法幂等重放 | 新增 `identityOfSegment`（`supersededBy: null` 的摘要）用于判重；存储摘要仍含它 |
| 7 | CRLF 正文按原文计算摘要，读回时规范化后必然不符 | 发布前统一换行再算摘要，读取时同样规范化 |
| 8 | 消失的文件被计入游标指纹，下一页必然 `stale` | 消失文件记为 `unread` 且不进入 `covered`；已在 `covered` 里的文件被删除也不报 `stale`（无记录可漏） |
| 9 | 命中／分段上限提前 `break` 时跳过 `scannedThrough` 赋值 | 文件读完即记录范围，早退时也已赋值 |
| 10 | 先整份 `readFile` 再检查大小，超限文件仍可占满内存 | 用文件句柄最多读到上限 +1 字节；测试同时断言模块不使用 `readFile` |
| 11 | 两页之间补写更早日期的文件：它排在游标之前、从未被读过，因此不在 `covered` 里，`stale` 比对发现不了它；续页从游标文件开始，直接跨过它并返回 `next: null` | `resumeAt` 把扫描起点回退到「游标之前第一个 `covered` 未记录的文件」；`covered` 中的文件已逐个校验未变，扫描时跳过，不重复返回 |
| 12 | 补写扫描再次分页时，原游标在文件中间的位置与摘要被丢弃，后续重复返回旧记录且文件变化未报 `stale` | 更早补写出现时，若原游标有 `index > 0` 或非空 `fileDigest`，立即报 `stale`，由调用方重新检索；只允许无位置／摘要负担的文件边界游标回退 |

**验收结论**：

- 04-A：同 ID 同发布身份返回 `duplicate` 且文件字节不变；同 ID 不同身份与同调用内 ID 冲突均报 `revision-conflict` 且不写任何文件。12 个并发 `publishSegments` 全部落盘，无丢失、无重复。记录被替代后重放其原始发布仍返回 `duplicate` 与原身份（缺陷 6）。
- 04-B：临时路径被目录占用 → `io-failure`，旧文件完整、无临时文件残留；目标只读导致 `rename` 失败 → `io-failure`，旧文件完整、临时文件已清理。两种失败后重试都返回 `published` 且摘要与内容一致；重新 `openDaily` 后按引用读回同一摘要，再次发布为 `duplicate`。
- 04-C：相对根目录与越界／非法日期 → `invalid-input`；`missing-file` 与 `missing-segment` 区分；符号链接（数据目录、文件、`root/memory` 层）在读、写、列目录、检索时均 → `corrupt-state`，且经 junction 未写出任何文件；目录占用文件名 → `io-failure`；非法 JSON、缺字段、摘要不符、正文被改、元数据重复携带正文、位置与文件名不符、块外内容、标题不符 → `corrupt-state`；损坏标记后读取、检索、发布三者都被拒且文件保持原样；CRLF 正文发布后可读回且摘要可复现；正文含块标记 → `invalid-input`。
- 04-D：空库 `available === 0`，无命中但有历史时 `available > 0`；按命中与按文件两种分页都能无重复、无遗漏地走完 5 个日期文件；`maxFiles` 分页返回 `unread`，且 `scanned.from`／`through` 只覆盖真正读到的两个文件；单文件 `limit: 1` 时 `through` 仍是该文件（缺陷 9）；已消费文件在下一页之前被追加后游标报 `stale`，且重扫能取回该记录（缺陷 3）；范围外文件游标报 `stale`；文件在列出前已消失时游标报 `stale`，不带游标仍能读到其余文件；已在 `covered` 中的文件随后被删除时续页照常返回剩余记录（缺陷 8）；**先扫 20 日、游标指向 22 日，再补写 21 日文件，续页返回 21 日与 22 日且 `next: null`（缺陷 11）**；多页之后补写（20、21 已返回、游标指向 23）时补写日期被返回且已返回文件不重复；补写日期本身填满一页时游标停在该文件内，`unread` 仍列出后续文件；补写日期排在两个已消费文件之前时，游标跳过中间已消费文件而不重复返回（缺陷 11）；**游标停在 22 日文件中间时补写含 X、Y 的 21 日文件，续页在返回补写页之前报 `stale`（缺陷 12）**；命中上限、文件上限及足够大的上限均拒绝该旧游标；拒绝不修改原游标，移除补写后仍能按原 index 续读 B，修改原文件后原摘要仍报 `stale`；index 为零但带摘要的游标同样拒绝更早补写，重新检索能读到全部记录（缺陷 12）；`limit`／`maxFiles` 越界报 `invalid-input`（不夹取）。
- 04-E：替代记录发布后旧记录不再作为当前事实返回，`historyExcluded` 计数；`includeHistory` 时旧记录带 `supersededBy`；按引用仍读出原值；重复替代、同调用内重复替代（缺陷 5）与悬空目标分别报 `revision-conflict`／`revision-conflict`／`not-covered`。跨文件两阶段写入：替换文件不可写时，成功阶段已标记的旧记录不再当前，失败阶段的那条保持当前且其替代记录未落盘——任何时刻都不会同时出现两个当前答案（缺陷 2）；重试后只剩两条新事实。同文件同时含标记与新记录时写两次，结果仍只有新记录当前。
- 04-F：`MEMORY_LIMITS.note` 长的正文可发布，多一个字符被 schema 拒绝；单文件 500 段上限触发 `budget-exceeded`，续页 `-2.md` 可用，页码 10 被命名规则拒绝；8 MiB 文件读、检索均报 `budget-exceeded`，恰好等于 1 MiB 的文件可读（缺陷 10）；27 个日期文件时单次只读 `DAILY_LIMITS.scanFiles` 个并列出 `unread`，`scanned.files + unread.length === available`；`unknown.md` 排在最后且 `scanned.through` 为 `unknown.md`；模块 import 列表精确等于 `["./contracts.js", "node:crypto", "node:fs/promises", "node:path"]`，且不使用 `readFile`。

**执行命令与结果**：`npm run check`（`tsc --noEmit`）通过；`npx tsx --test test/memory-daily.test.ts` 7/7 通过；`npm test` 119/119 通过（本项新增 7）；`git diff --check` 无问题。评审脚本 `mem04-cursor-acceptance-v3.mjs` 的文件边界补写场景通过；其余三个场景在首次补写续页时即报 `stale`，符合本轮选用的重新检索方案。原脚本要求继续分页，因此这三个场景的原始 `pass` 字段仍为 false；已另行断言它们均以预期的 `MemoryError`／`stale` 原因退出，不能将其描述为原脚本四项全部通过。

**变异验证**（逐个回退修正后重跑本模块测试）：10 项修正中 9 项有回退即失败的证据（1、2、4、5、6、7、8、9、10）。缺陷 8 有两条守卫：已删除的 `covered` 文件不报 `stale`（回退后被捕获），以及扫描中消失的文件不进入 `covered`（回退后未被捕获，原因见下）。缺陷 3 的同调用内窗口同样未被捕获。缺陷 11 的两条守卫（`resumeAt` 回退起点、跳过已消费文件）回退后均被捕获。缺陷 12 采用提前报 `stale` 的方案：关闭该守卫后，04-D 在文件中间游标场景以 `no-error`／`stale` 差异失败；仅保留 `index > 0` 检查后，index 为零但带摘要的场景同样失败。恢复完整守卫后通过。

**未通过或未执行项**：

- 与归档任务（MEM-05）的联调未做，文件级恢复窗口（生成后未发布、发布后未确认、跨多个日期部分成功）属于 MEM-05 验收。
- 两个窗口只有代码路径、没有自动化证据，因此不计入通过结论：**缺陷 3 的同调用内窗口**（文件在读取之后、游标签发之前被追加）与**缺陷 8 的扫描中窗口**（文件在 `listFiles` 之后、`observe`/读取之前消失，即「不进入 `covered`」那条守卫）。两者都要求在一次调用内部、两个 I/O 步骤之间改变文件，而模块没有在该窗口注入失败的接口，回退后测试仍通过。跨调用的追加与跨调用的删除（缺陷 3、8 的主要场景）都有测试，回退即失败。
- 缺陷 11 的修复只覆盖**排在游标之前**的补写。游标之后新增的文件本来就落在剩余范围内，正常扫描会读到，不需要额外处理；但如果调用方在续页之间把 `from`／`through` 改窄到排除掉该文件，它不会被报告为 `unread`——范围是调用方给的，本模块不推断两次调用的范围关系。
- 跨进程单写者不支持（只保证单进程内串行，需要锁文件才能扩展），当前部署为单进程。
- 检索上限的实际耗时未在目标机器（4 核／4 GB）上标定，留待 MEM-08。

**兼容性变化**：新增模块，未修改 MEM-01 冻结的 schema 与错误码；`MemorySegment`、`dailyFileName`、`DAILY_DIRECTORY`、`UNKNOWN_DATE` 原样复用。`SearchCursor` 是模块内 Interface，不写入磁盘，可随实现调整（本轮已把 `listing` 换成 `covered`）。文件格式新增一条读取约束：块外内容不再被容忍——本模块此前未发布过，不存在需要兼容的旧文件。

**对下游的解锁条件**：MEM-05 可开始。归档批次的分段 ID 必须在重试间稳定（`<batchId>#<index>`），本模块按 ID + 发布身份判重；只有全部回执为 `published`／`duplicate` 才能推进连续游标；替代关系要显式写进分段（`supersedes`），本模块不做语义推断，且一次只能有一条记录替代同一条旧记录。检索工具由 MEM-07 包装，游标与 `unread` 原样交给模型。实施方案新增第 15 节记录本项结论，原第 15 节顺延为第 16 节。

## MEM-05：可恢复的增量归档任务

**目标**：把尚未覆盖的原始事件整理到每日记忆，压缩和任务执行不依赖归档成功。

**依赖**：MEM-01、MEM-04。**阅读入口**：实施方案第 8、9、11 节及第 12 节；`src/memory/contracts.ts` 中的 `ArchiveBatch`、范围与错误映射。

**工作与交付**：

- Archive Module 实现固定范围、提取、持久化候选正文、发布、确认的协议；Durable Adapter 用原生 Task 和 checkpoint 承载恢复。
- 提取器接受有界来源与取消信号，返回校验后的分段；区分自动事件归档和明确的永久偏好。来源读取复用原生 Entries，不建立通用 history 库。
- 合并 compaction 生效、业务完成、启动／跨日补齐的归档目标。通知只触发工作，持久化事实和补扫才决定覆盖是否完整。
- 连续游标仅在全部分段确认或持久化空结果后推进。多个日期部分成功保留逐段确认，不因失败重新提取已发布正文。
- 实现有界重试与失败诊断，执行归档时不占用主 agent 的工具队列无限等待。

**验收**：

- [x] 05-A：覆盖至 150 后压缩至 170，只处理新增 151–170；任务结束先覆盖至 200 后，旧压缩事件不会回退或重复归档。
- [x] 05-B：已有 B、检索结果、记忆投影不被当作新事件再次归档；无价值内容形成空处理回执，重启不反复提取。
- [x] 05-C：在提取完成后、正文保存后、一个日期写入后、全部写入但游标未提交时分别中断，恢复无已确认正文重复和来源缺口。
- [x] 05-D：模型失败、无效提取输出、文件写失败、取消分别留有可恢复结果；业务执行和已保存回复不因此重跑。
- [x] 05-E：时区边界、跨午夜任务和未知发生时间有确定归档规则；使用事件时间而非后台生成时间。跨日无消息不承诺午夜运行，下一次启动／请求能补齐。
- [x] 05-F：压力触发合并为有界目标，单 conversation 单归档写者；重启可从持久化目标补回漏通知。usage 和超时遵循 MEM-01 的已验证路径。

### 交接记录（2026-10-26）

已认领远端 #12。交付 `src/memory/archive.ts`、`src/memory/archive-task.ts`、`test/memory-archive.test.ts` 和 `test/fixtures/crash-archive.ts`。Interface、ArchiveState／ArchiveBatch schema 归属、来源范围、游标与取消语义见实施方案第 16 节；未改 MEM-01 冻结的 ArchiveBatch schema。

| 验收 | 实测证据 |
| --- | --- |
| 05-A | 200 条来源先覆盖 150，再只提取 151～170，再覆盖至 200；旧 170 目标返回无任务且不新增模型调用 |
| 05-B | cycle／working 投影、原生 summary／system 和 memory_search 结果不进入提取；原始事件的空结果重启后也不重复调用 |
| 05-C | extracted／saved／published／confirmed／before-cursor 五个同步点关闭重开；另在 extracted／saved／published／before-cursor 四点真实 SIGKILL。两日期分段均完整、ID 唯一、保存后的正文逐字复用且模型调用为零 |
| 05-D | 模型 error、非法来源引用、非法 JSON 三次后终止；文件错误保留正文，显式重试不再提取；abort／timeout 到达实际 provider；业务 requestId 与已保存 answer 在归档失败后仍复用 |
| 05-E | UTC 与 Asia/Shanghai 午夜边界得到不同正确日期；跨日批次分为两日期；缺失时间为 unknown，非法时间拒绝；重启补扫过去日期、完成事实和已发布 compaction |
| 05-F | 30 个并发触发得到同一后台 Task；每批最多 64 条；持久化分页补扫恢复漏通知；普通 idle 不等后台归档；超大来源拒绝且不推进；usage 归 app/archive，失败与重试均累计；超时最多 3 次 |

执行：`npm run check` 通过；`npx tsx --test test/memory-archive.test.ts` 18/18 通过；`npm test` 137/137 通过；`npm run build` 通过；`git diff --check` 通过。全部测试使用临时文件／SQLite 和 faux provider，无生产凭据。

兼容性与未覆盖项：新增 version 1 Document／Task，不改既有工具调用参数；初始化必须显式指定升级起点，当前拒绝 fork。模型响应未提交时进程被杀／取消的远端用量未知，不承诺精确计费；保存后不重复调用。真实模型提取质量、脱敏效果、目标 Linux 资源验收留待 MEM-08。MEM-07 仍需注册 Task、在启动／请求边界调用补扫、在有效压缩发布后提交目标，并适配外部事件时间；本项未修改运行入口。MEM-06 可独立继续，MEM-07 还须等待 MEM-06 完成。

## MEM-06：原生压缩接入与周期快照切换

**目标**：用底座压缩发布 B，保留合法 C，并解决长 run 中的状态连续性。

**依赖**：MEM-02、MEM-03。**阅读入口**：实施方案第 6、7、10 节及第 12.3、12.4、12.5、13、14 节；`src/memory/contracts.ts` 的 `CycleSnapshot` 编解码与 `workingAtBoundary`，`src/memory/working.ts` 的边界读取，`src/memory/context.ts` 的 `buildSnapshot`／`renderSnapshot`／`snapshotTextFor`。

**工作与交付**：

- 接入 `beforeCompact` 生成新 B：模型总结旧叙事与选中的流水，精确状态由边界版本确定性渲染。
- 固定来源、模型结果和应用格式；恢复复用已保存结果，正确记录摘要调用的失败与成功用量。
- 按真实模型窗口配置后台阈值；补充约 20 个完成用户请求后的评估。token 判定覆盖长 run，轮数不按工具或重试计数。
- 只在新 head 正式生效时确认周期切换、产生可恢复归档触发；不以 Task completed 直接推断发布成功。

**验收**：

- [ ] 06-A：压缩前 A/B/C 与压缩后 A/新 B/保留 C 都能从持久化记录重建；system prompt 和工具关联完整，原始 Entries 未删除。
- [ ] 06-B：切分边界前后分别更新 working，B 精确取边界版本，保留 C 携带之后修订；不因 head marker 的较大 ID 读取未来状态。
- [ ] 06-C：一个长用户请求经历至少两次压缩，后续模型调用持续取得正确任务状态，无需下一条用户输入或模型主动补读。
- [ ] 06-D：后台摘要入队、stale、失败、阻塞失败、重置交错与重启均遵循原生语义，不发布半成品 B，不同步等待无法前进的边界。
- [ ] 06-E：叙事摘要超限／被截断时不作为完整 B 发布；精确状态超限不被静默概括。旧原生摘要有兼容读取路径。
- [ ] 06-F：20 个短请求只评估不强压；一次大工具回合可先触发 token 压缩；同 requestId 恢复和 generation 重试不重复计数。
- [ ] 06-G：实际适配请求比较表明周期内 A/B 稳定、C 仅追加；新 schema 加载明确记录为前缀变化，不能凭逻辑块相同宣称云端缓存已命中。

## MEM-07：接入请求生命周期及记忆工具

**目标**：把已验证 modules 接入应用，保持原请求、工具和投递生命周期。

**依赖**：MEM-02～MEM-06。**阅读入口**：实施方案第 4、6、9、11 节及第 12 节；`src/agent.ts`、`src/tools.ts`、`src/config.ts`、现有请求／恢复测试和 README。

**工作与交付**：

- 在组合入口构造 modules、注册 native tools 和 hooks；主应用只依赖统一接入入口，业务算法留在各 module。
- 接入原 requestId 检查、初始 B／必要投影、模型输入提交、重置后初始化、归档补扫及关闭生命周期。
- 暴露 `memory_search`／`memory_read`，绑定宿主根目录和来源身份；设置结果与一次请求累计检索预算，工具结果进入 C。
- 补充必要配置、错误映射及可观测性。普通记忆业务错误不伪装成 Session 永久失败；真正的底座状态失败继续退出恢复。
- 保留既有 `MEMORY.md` 语义；首次升级设置归档起点并保存迁移记录，原未完成请求继续原输入，旧摘要和长期事实可读取。更新 README 与现有 MVP 的范围说明时清楚标识新能力的实际状态。

**验收**：

- [ ] 07-A：同 requestId 恢复不新增投影／模型调用／归档触发；投影已写、输入未提交时找回原文。相同文本不同 requestId 仍是独立请求。
- [ ] 07-B：新用户请求、工具后续、重启恢复和显式重置后的首次模型调用都包含有效系统提示与必要 working；禁止靠无记录 hook 注入达标。
- [ ] 07-C：检索结果有来源、分页、未扫描范围和错误语义，累计预算生效；既有快照已包含同版内容时不重复加载整份工作台或日记。
- [ ] 07-D：归档失败时正常聊天仍可完成并保存回复；投递失败只重投原回复，不重做记忆更新或业务执行。
- [ ] 07-E：从已有 SQLite、旧 compaction、非空 MEMORY.md 和未完成工具调用升级，数据保留且恢复语义不变；首次启动不触发无限历史回填。
- [ ] 07-F：配置参数有 schema 和有效范围；缺失／损坏／超限与正常空状态分别处理。关闭会停止实际 I/O 并保留任务恢复状态。
- [ ] 07-G：`src/agent.ts` 不出现摘要提示、Markdown 拼接、归档游标算法或私有 SDK 导入；Telegram、inbox、投递 modules 不导入 memory 内部实现。

## MEM-08：故障恢复、质量与资源验收

**目标**：证明整套方案在持续线性对话和故障窗口中有效，区分机制验证与真实模型效果。

**依赖**：MEM-07。**交付**：`docs/memory-verification.md`，记录环境、场景编号、执行结果、脱敏证据和未覆盖项；无需复制架构定义。只有实现开始后才创建该验收记录。

**验收**：

- [ ] 08-A：使用确定的跨日 trace，至少 40 个完成用户请求、3 次有效压缩，包含任务暂停／继续、偏好纠正、工具失败与修正。每次模型请求的 A/B/C、head/cutoff、working revision 可核对。
- [ ] 08-B：依次注入请求投影、working commit、compaction 发布、Markdown 替换、归档确认和回复保存窗口的进程中断，恢复后的状态、文件和调用计数符合各 issue 的验收。采用同步点，不用任意 sleep 猜测崩溃时刻。
- [ ] 08-C：对于每个来源范围，能判定待处理、已归档或已确认无值得保留内容；不跨过失败缺口。文件分段可回到原始证据，摘要中的未知不会变成成功。
- [ ] 08-D：纠正／撤销跨多个压缩周期和重启后仍有效；每日旧记忆不会把已撤销偏好重新激活。
- [ ] 08-E：离线比较真实 provider Adapter 的请求体，确认未变化前缀；真实模型样本另测目标、约束、未完成状态的保留和关键词回忆质量。云端缓存验证使用独立授权测试环境，未知 usage 标未知。
- [ ] 08-F：测量典型、工具密集、跨日恢复下的输入量、摘要大小、归档滞后、扫描量、延迟、内存及磁盘增长。对 4 核／4 GB Linux 环境给出实际峰值和明确配置上限，不能仅以 Windows 离线测试宣称部署通过。
- [ ] 08-G：全量类型检查、测试和构建通过，既有请求去重、取消、工具重放与逐段投递测试无回归；真实服务／目标主机未验收时明确保留状态。
- [ ] 08-H：依赖审查确认 Context 无 I/O、Daily Memory 无 Harness、Working 不管理底座执行状态，SDK 接入集中在 Adapter；不为解耦额外建立事件总线、数据库服务或通用插件框架。

## 发布与交接门槛

本地交付要求 MEM-01～07 的本地条件和 MEM-08 的离线故障场景全部通过。真实摘要质量、目标提供商缓存与 Linux 资源测量分别标记“通过／失败／待验证”；缺少环境不伪造通过。

每个 agent 的交接必须提供：修改的 Interface 与文件、已通过的验收编号、测试结果、恢复或升级限制、下一项可开始的依赖。业务行为仍有未验证的关键顺序时，issue 保持未完成，不以“代码已提交”代替验收。

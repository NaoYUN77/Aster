# ADR-0023：主动 Run 使用独立 ownerless 会话，由宿主持久化并在投递前校验

- **状态**：Accepted
- **日期**：2026-11-05
- **功能**：proactive-loop

## 上下文

Aster 之前只在收到 Telegram 消息时运行。需要一种“用户没有发消息时，也能主动发现信息并决定是否打扰”的能力，同时不引入常驻模型循环、事件总线或额外进程。

已安装的 pi-durable 1.3.0 提供了本轮依赖的事实：

- `harness.createConversation({ ownership: { kind: "ownerless" }, agent })` 可以创建与主对话并列、可持久化的会话；会话级 `agent` 可指定模型、指令、cwd、Extension 与 `modelTools`。
- `Conversation.submit` / `Submission.wait` / `Conversation.abort` 提供持久化执行身份与恢复入口；`harness.submission(id)` 可在重启后重新等待同一 Submission。
- Harness 的 models、Tool Registry、Trace 与执行环境对所有会话共享；会话级 `UsageDoc` 与 generation hook 的 `message.usage` 可用于宿主侧预算。
- 主对话的 `WorkingState` 可由宿主通过 `readWorking(harness, rootId)` 读取；Daily Memory 通过 `openDaily` / `searchDaily` 读取。
- 现有 Inbox 已经提供 requestId 幂等、分段确认与 `pending / ready / sending / sent / failed / uncertain / missing` 投递状态。

约束来自 [ADR-0013](../0013-pi-durable-agent-loop.md)：应用层不另建模型循环。部署基线是单台 4 核 / 4 GB 服务器，只运行一个应用容器；单 Owner 私有 Telegram 会话是唯一投递目标。外部发送不保证恰好一次，结果未知必须显式记录。

## 决策驱动因素

- 主动 Run 必须与主 Telegram 对话解耦：不能在主会话里写入伪造的用户消息，也不能复制主对话历史造成上下文污染与无界 token 成本。
- 个人记忆属于敏感数据。后台 Run 只能看到宿主挑选的有界快照，不能通过 Memory 工具自行扩大读取范围，更不能修改偏好。
- 信息发现只允许走既有 Web 工具；来源 URL 必须取自本次真实工具结果，宿主必须能拒绝模型编造的链接。
- 模型不能绕过推送限制。每日上限、URL 去重、同一 Run 的并发与预算都必须由宿主执行。
- 中断恢复必须保守：声明可安全重放的只有“尚未发生模型或 Web 副作用”的 Run；投递未知不得当作未执行，也不得自动重发。
- 不为 V1 引入 RSS、邮件、GitHub 事件、长期计划、Web UI、自定义 Cron 框架或第二个常驻进程。

## 备选方案

- **在主 Telegram 会话注入一条伪用户消息来触发**：实现最少，但会污染用户可见历史、改变主对话上下文与 Durable Replay 语义，并让“用户说过”和“宿主发起”无法区分。未采纳。
- **自建 ReAct 循环或独立 agent 框架**：可以完全定制，但违反 ADR-0013，重复实现工具校验、恢复与观测，且无法复用底座已验收的执行路径。未采纳。
- **fork / 复制主对话上下文作为后台会话**：看似保留上下文，实际复制全部个人历史、放大 token 成本，并让后台输出与主对话相互影响。未采纳。
- **外部 cron、消息队列或事件总线**：多一个进程与共享状态，部署和恢复都更复杂，超出单机单容器基线。未采纳。
- **每次 Run 新建 ownerless 会话 + 宿主读取记忆 + 宿主校验 + Inbox 投递**：复用底座循环、持久化与恢复；后台会话只拿到宿主生成的快照和两个 Web 工具；代价是每次 Run 没有聊天历史，需要宿主自行构造上下文。采纳。

## 决策

- **触发与 Run 分离**：`proactive_triggers` 以唯一 `triggerKey` 记录每日（`daily:<localDate>`）或手工触发；一个触发最多对应一个 `proactive_runs` 行。唤醒只创建一次后台 Run，Run 终态结束后不再重复。
- **独立会话**：每个 Run 调用 `harness.createConversation({ ownership: { kind: "ownerless" }, agent })`，使用主动研究专用 `instructions`；`modelTools` 精确为 `web_search` 与 `web_fetch`，Extension 只保留 Web、Trace、Loop Guard 与 Proactive Guard。Memory、提醒、codemode、bash、文件与 MCP 工具不提供。
- **有界只读上下文**：宿主从主对话 `WorkingState` 与最近 Daily Memory 生成 JSON 快照，保留 `version`、`revision`、当前 task、未过期 preferences（含来源与 `expiresAt`）、profile（含 evidence）与最近片段。超出 `PROACTIVE_CONTEXT_MAX_CHARS` 时按最近片段 → profile → preferences → task 细节的顺序裁剪并记录摘要；没有内容时保持显式空值，不推断、不补造。后台会话不获得 Memory 工具，不能写回。
- **结构化决策**：模型最终只能输出一个严格 JSON：`notify`（1～3 条 `{title,url,summary,relevance}`）或 `skip`。未知字段、空文本、超长字段、空 `items`、Markdown 围栏外的散文均拒绝；解析或 Schema 失败时 Run 记失败，不发送任何模型原文。
- **宿主校验先于投递**：URL 必须是绝对 http(s)、无 userinfo，按去掉 fragment 的规范形式去重；条目必须出现在本 Run 的 `web_search` 结果或成功的 `web_fetch` 中，否则丢弃；已投递过的 URL 从 SQLite 读取并跳过；当日 `notify` 达到 `PROACTIVE_MAX_PER_DAY` 时强制转 `skip`。全部被丢弃时以显式原因跳过。通过后先持久化决策与已见 URL，再入队 Inbox。
- **投递复用 Inbox**：`requestId = proactive:<runId>`，同一 Run 的重试入队幂等；目标会话固定为宿主配置的 Owner 私聊，模型参数中没有任何 chat id。调度器对 `delivering` 行轮询 Inbox：`sent → delivered`，`failed → delivery_failed`，`uncertain / missing → delivery_uncertain`；未知终态不自动重发，只能由操作员用 `npm run proactive -- resolve` 在核对 Telegram 后收敛。
- **持久化状态**：`<DATA_DIR>/proactive.sqlite` 保存触发、Run、上下文摘要、决策、观察到的 URL、已投递 URL、工具调用与 token 进度、投递请求与错误码。所有迁移在 `BEGIN IMMEDIATE` 事务中做条件更新；`claimNext` 的 `queued → running` 只允许一个执行者。
- **恢复语义**：启动时 `running` 且没有 `submissionId` 的 Run 回到 `queued`（此前没有模型或 Web 副作用）；有 `submissionId` 的 Run 重新等待同一 Submission，并恢复工具调用数与 token 预算；`decided` 只补投递；`delivering` 只对账。会话或 Submission 丢失时记 `PROACTIVE_CONVERSATION_MISSING` / `PROACTIVE_SUBMISSION_MISSING`，不伪造成功。
- **预算与并发**：`beforeTool` 在超过工具调用上限后阻断后续调用；`afterResponse` 累计 token，超过上限中止会话；单 Run 超时中止并记失败；同一进程一次只执行一个主动 Run，调度器的 `busy` 与 Runner 的串行链共同保证。Loop Guard 按会话隔离，主动 Run 的停止只作用于自己的会话。
- **观测**：Trace 请求以 `proactive:<runId>` 为 requestId，子 Span 覆盖 `proactive.trigger → proactive.context → agent.loop → web_search / web_fetch → proactive.decision → telegram.delivery`。字段只包含计数、状态、短原因与错误码，不上传完整记忆、Web 原文或凭据。

## 后果

- 主对话的消息历史与 Memory 不被后台 Run 写入；后台失败不会阻塞 Telegram 长轮询或用户请求。
- 每次 Run 没有聊天历史，只有宿主快照；跨 Run 的“记住上次讨论”依赖 Memory 与已投递 URL 列表，而不是会话上下文。
- 每日上限、去重与 URL 来源校验由宿主执行，模型无法绕过；代价是模型的有效发现可能被丢弃并显示为 `skip`，需要从 SQLite 与 Trace 排查。
- 底座没有“单会话最大 token”的硬配置，token 预算由宿主 hook 执行，属于软限制；工具调用上限以阻断方式执行，模型仍须输出最终决策。
- 主动消息仍走 Inbox 的普通投递队列，实际发送可能排在当前用户请求之后；V1 接受这份延迟。
- Inbox 只保留最近 100 条已发送请求，关联行被清理后主动投递按 `missing` 记为未知；Proactive SQLite 自行保存终态，不依赖 Inbox 行永久存在。
- Web 内容本身无法保证真实；宿主只保证 URL 来自本次工具结果，并保留可追溯状态。

## 分阶段决策与缺陷历史

### 2026-11-05：Proactive Loop V1

- 相关 spec：`docs/spec-20261105-proactive-loop.md`（临时 spec，功能完成后删除）。
- 决策与取舍：交付手工触发与每日一次自动触发、独立 ownerless 会话、有界只读 Memory 快照、仅 `web_search` / `web_fetch` 的发现渠道、严格决策 Schema、宿主 URL／去重／每日上限校验、SQLite 状态机、Inbox 投递与人工收敛、Trace 链路。不实现 RSS／邮件／GitHub 监控、多步计划、偏好自动修改与 Web UI。
- 验证证据：`test/proactive.test.ts` 覆盖配置、决策解析、URL 规范化、上下文边界、状态迁移、每日触发、恢复与调度；`test/proactive-runner.test.ts` 覆盖真实 Harness 会话与 Submission、Memory revision 变化、空记忆、主对话并发、decided 恢复与 Submission 续跑。全量 `npm test` 通过（427 pass / 19 skip / 0 fail），`npm run check` 与 `npm run build` 通过。真实部署与 Telegram 投递验收待上线后按 `docs/proactive-loop.md` 执行。
- 初始实现的已知限制：token 预算是宿主软限制；每日触发只在应用运行期间补建；`delivery_uncertain` 需人工收敛；后台 Run 没有聊天历史。

### 2026-11-05：交付前恢复与资源边界修正

- 相关 spec：`docs/spec-20261105-proactive-loop.md`（仍待真实环境验收）。本节修正初版决策中对配额日、无本地 Submission ID 及上下文裁剪的描述。
- **Submission 跨库窗口**：底座接纳提交与 `proactive.sqlite` 写入 `submissionId` 不是同一事务，不能把本地 ID 缺失视为未执行。只有会话与 Submission 身份都不存在的 Run 才直接回队；已保存会话时，以 `proactive:<runId>` 在原会话查询底座 Submission，找到则补回本地身份并继续等待。只有确认底座未接纳时才重新启动。
- **恢复预算**：共享 Harness 的任意 submit / wait 都可能唤醒其全部任务。启动时先装好可恢复后台会话各自的预算与持久化进度，再向调用者暴露普通回复入口；恢复等待不重置已开始累计的预算。最终决策前再次校验 token，避免已提交的答案抢在异步取消前获准投递。禁用主动能力但底座仍有未完成主动任务时，启动显式拒绝，要求先启用并收敛任务。
- **每日接受配额**：Trigger 的 `localDate` 是触发日期，不能代表积压任务实际获准通知的日期。新增 `quotaDate`，在接受决策的事务内按当前时间和配置时区计算，并与 `decidedAt` 一起保存；既有 notify 行按其 `decidedAt` 回填。投递失败不释放配额。选择按接受日计额，是为了让本地事务能原子执行上限；Inbox 排队、停机与外部 Telegram 发送不组成事务，因此本版不承诺实际送达日的硬上限。
- **上下文硬上限**：初版未裁剪 blockers / nextStep，可能在清空 goal 后仍超限。改为省略完整条目或字段，在快照的 `omittedFields` 中明确记录；不生成空 goal，也不把 active task 改成 none；最终强制检查 JSON 字符长度。初始 20 条 recent 上限也记录为裁剪，Runner 不再提前静默丢弃片段。
- **幂等与投递**：Trigger 重放查询补回关联元数据，保证与首次返回契约一致；新增真实 Inbox 分段确认、未知投递与幂等入队回归。禁用后的 CLI trigger 在打开数据库前拒绝，避免意外创建状态文件。
- 验证：新增跨日积压与时区边界、旧库配额迁移、最大合法 task、条数裁剪、Trigger 重放、Submission 本地身份丢失、最终回复超预算、部分发送后未知结果的回归。`npm test` 为 437 pass / 19 skip / 0 fail；随后新增 CLI 进程测试 2 / 2 通过；最终 `npm run check`、`npm run build` 及 proactive / loop-guard / trace 相关回归 54 / 54 通过。真实模型、Telegram 与 Langfuse 部署验收仍待执行，不能用自动化替代。

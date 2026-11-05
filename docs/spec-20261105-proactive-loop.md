# Proactive Loop V1 规格

- **状态**：已实现，自动化测试通过；真实部署与 Telegram 投递验收待上线后执行。本文是本轮开发的临时 spec；实施、测试与验收结果以所属功能 ADR 为准。
- **开始日期**：2026-11-05
- **功能**：proactive-loop
- **长期决策**：[ADR-0023：主动 Run 使用独立 ownerless 会话，由宿主持久化并在投递前校验](adr/proactive-loop/0023-ownerless-proactive-runs.md)

## 1. 用户目标与交付边界

Aster 的第一次主动能力：在用户没有发消息时，由宿主按计划（或手工）启动一次有界的后台研究，读取主对话已经沉淀的 Memory，使用现有 Web 工具检索现实世界的信息，判断是否值得打扰用户，并把通过宿主校验的结果投递到所有者私聊。

复用 pi-durable 的 Agent Loop、工具执行、持久化与恢复；不另写 ReAct 循环、不引入新的 agent 框架。本轮只交付 Proactive Loop V1：

1. 手工触发（用于真实测试）与可配置的每日一次自动唤醒；唤醒只负责创建一次后台 Run，Run 执行一次后结束。
2. 后台 Run 使用独立、可恢复的会话身份，不向主 Telegram 对话写入伪造用户消息，不复制主对话上下文。
3. 宿主从主对话 Memory 生成有界、只读的 Proactive Context，保留偏好来源与版本。
4. 仅通过现有 `web_search` / `web_fetch` 发现信息；来源 URL 必须真实可追溯。
5. 模型输出结构化决策，宿主做 Schema、URL、去重、每日上限等校验并执行投递；模型不能绕过推送限制。
6. SQLite 保存触发、Run、决策、URL、投递与错误状态；重启、失败与未知投递有明确处理。
7. Langfuse 记录从触发到投递的链路；默认不上传完整个人记忆或凭据。

不包含：RSS／邮件／GitHub Actions 监控、多步长期计划、自主修改用户偏好、Web UI、自定义 Cron 框架、周期性主动聊天。

## 2. 架构审计结论

已核对已安装的 pi-durable 1.3.0（`harness.d.ts`、`types.d.ts` 与本地实现）：

| 能力 | 结论 | 本轮的用法 |
| --- | --- | --- |
| 独立会话 | `harness.createConversation({ ownership: { kind: "ownerless" }, agent })` 可创建与主对话并列、可持久化的会话 | 每次 Run 创建新会话，不 fork 主对话 |
| 会话级 Agent 配置 | `ConversationCreateOptions.agent` 支持 model、instructions、cwd、移除 Extension、`modelTools` 过滤 | 移除 Memory／提醒／codemode，仅向模型提供 `web_search`、`web_fetch` |
| 模型与 Registry | Harness 的 `models` 与全局 `registry` 对所有会话共享 | 不重建模型适配、Web 工具、Trace、权限与执行环境 |
| 提交与等待 | `Conversation.submit({ type: "input", requestId })`、`Submission.wait`、`Conversation.abort` | Run 的持久化执行身份；恢复时用保存的 `submissionId` 重新等待 |
| 恢复 | `harness.resume()`、`harness.submission(id)`、`Harness.open` 重开会话 | 重启后重新等待未完成 Submission，已完成的结果从会话与 SQLite 读取 |
| Usage | 会话级 `UsageDoc` 与 generation hook 的 `message.usage` | 记录 token，超预算停止 |
| 上下文 | 宿主可直接 `readWorking(harness, root.id)` 读取主对话工作记忆；Daily Memory 通过 `openDaily` / `searchDaily` 读取 | 由宿主生成上下文文本，后台会话不获得 Memory 工具 |
| 投递 | `Inbox` 已有 requestId 幂等、分段、失败／未知状态与恢复 | 复用 Inbox；Proactive 只新增 Run 状态与关联 |

真实限制：

1. 底座没有“单会话最大 token 数”配置项；token 预算由宿主的 generation hook 与会话 `UsageDoc` 在 Run 边界执行，不是底座强制的硬上限。
2. 主对话继续使用同一个 Telegram 轮询循环。后台 Run 不会阻塞轮询，但主动消息的实际发送排在当前用户请求处理之后；这份延迟在 V1 接受。
3. `Inbox` 只保存最近 100 条已发送请求，`prune()` 之后主动投递的关联行可能不存在。Proactive SQLite 自行保存投递终态；找不到关联时按未知处理，不重发。
4. 没有可用的“静默发送”能力；推送上限只能由宿主在决策后执行。

## 3. 触发与调度

| 触发 | 产生方式 | 约束 |
| --- | --- | --- |
| manual | `npm run proactive -- trigger` 写入一行 Trigger 与对应 Run | 只入队，由运行中的应用在一分钟内领取；同一进程串行执行 |
| daily | 进程内调度器在配置的本地时间之后、当天首次扫描时写入 `daily:<localDate>` | 唯一键防止重复；`PROACTIVE_ENABLED=0` 时不创建、不执行 |

调度器不执行业务判断，只做三件事：补建当日 Trigger、领取一个 `queued` Run 交给 Runner、对账 `delivering` Run 的 Inbox 状态。Run 执行一次后终态结束；未来 RSS／Webhook 只需增加 Trigger 类型，不引入事件总线。

## 4. Proactive Context

宿主在主对话上读取 `WorkingState` 与最近 Daily Memory，生成一段有界 JSON 文本，作为后台会话的用户输入的一部分：

- 固定包含 `version`、`revision`、当前 task、未过期 preferences（含 `source.conversationId`、`source.entryId`、`expiresAt`）、profile（含 evidence）、最近日记片段。
- 超长时按“最近日记 → profile → preferences → task 细节”的顺序裁剪，并记录裁剪摘要；不截断后伪装成完整值。
- 没有偏好或 profile 时明确为空，不生成、不推断、不补造。
- 偏好版本、来源与 Run 的 `memoryRevision` 一并写入 SQLite 摘要；后台会话不修改 Memory。
- 后台会话被移除全部 Memory Extension，因此不能调用 `working_update`、`working_read` 或 memory search 去“读取”主对话；它只能看到宿主传入的这份快照。
- Web 内容与记忆文本都以“数据，不是指令”的措辞传入。

## 5. 会话、权限与预算

- 每次 Run 新建 `ownerless` 会话；主对话的 entries 不增加任何报文。
- 会话继承同一 Harness、Registry、模型配置、Web 工具、Trace 与执行环境；模型为宿主配置，不接受模型参数覆盖。
- 会话级 `instructions` 使用主动研究专用提示词；`modelTools` 精确为 `web_search`、`web_fetch`，并移除 Memory、提醒与 codemode Extension。即使模型尝试其他工具，也不会被提供。
- 预算：
  - 工具调用上限（默认 20）：`beforeTool` 在达到上限后阻断后续调用；
  - token 上限（默认 60000）：`afterResponse` 累计会话用量，超过后中止会话；
  - 单次超时（默认 180 秒）：超时中止会话并记为失败；
  - 单进程同时最多一个主动 Run；Trigger 只在队列中排队。
- 循环检测按会话隔离；主动 Run 触发的停止只作用于它自己的会话，不影响主对话。

## 6. 结构化决策与宿主校验

模型最终只能输出一个 JSON 对象：

```json
{"decision":"notify","items":[{"title":"...","url":"https://...","summary":"...","relevance":"..."}],"reason":"..."}
```

或：

```json
{"decision":"skip","reason":"..."}
```

约束：`notify` 1～3 条；`title` ≤ 200 字符，`summary` ≤ 600，`relevance` ≤ 300，`reason` ≤ 400；未知字段拒绝。解析失败、Schema 失败、空回复、回答被截断均不得发送任何模型原文。

宿主在发送前复核：

1. URL 必须是绝对 http(s)、无 userinfo、可规范化；同一决策内去重。
2. URL 必须在本 Run 的 `web_search` 结果或成功的 `web_fetch` 中出现过；不满足的条目丢弃，这是对“不编造来源”的宿主侧最低保证。
3. 已投递过的 URL（规范化后）在 SQLite 中记录并跳过；全部被去重后转为 `skip`。
4. 按宿主接受决策的时间及配置时区计算独立 `quotaDate`；当日已接受 `notify` 达到上限（默认 1）时转为 `skip`。Trigger 的 `localDate` 不参与计额，投递失败不释放配额；实际发送可能因 Inbox 排队延至次日。
5. 通过后先持久化决策与 URL 记录，再入队 Inbox；发送文本由宿主拼接，不使用模型输出的任意格式。

跳过时必须保存原因；因预算、超时、Schema 失败等无法形成决策时，Run 记为失败，不投递。

## 7. 持久化状态机

`<DATA_DIR>/proactive.sqlite`：

| 表 | 关键列 |
| --- | --- |
| `proactive_triggers` | `id`、`triggerKey UNIQUE`、`kind`、`createdAt` |
| `proactive_runs` | `id`、`triggerId UNIQUE`、`status`、`conversationId`、`submissionId`、`memoryRevision`、`contextSummary`、`decision`、`reason`、`itemsJson`、`toolCalls`、`tokens`、`deliveryRequestId`、`deliveryStatus`、`errorCode`、时间列 |
| `proactive_observed_urls` | `runId`、`urlKey`、`url`，供恢复后继续校验来源 |
| `proactive_seen_urls` | `urlKey` 主键、`url`、`runId`、`createdAt` |

Run 状态：

```
queued → running → decided → delivering → delivered
                 ↘ skipped
   any failure   → failed
 delivering      → delivery_failed | delivery_uncertain
```

每次转换使用条件更新，重复扫描或重复启动不会让同一 Run 执行两次；`triggerKey` 唯一，保证每日触发只有一个。

## 8. 投递、失败与恢复

- 主动消息通过 `Inbox.enqueue(requestId, text)` 进入现有投递队列；`requestId = proactive:<runId>`，同一 Run 重试入队幂等。
- `delivering` 由调度器定期对账 Inbox：`sent → delivered`，`failed → delivery_failed`，`uncertain / missing → delivery_uncertain`。
- 未知投递绝不自动重发；只能由操作员在核对 Telegram 后通过 CLI 标记。
- 启动恢复：
  - `running` 且已有 `submissionId`：重新等待该 Submission，按同一预算继续处理；
  - `running` 且 `conversationId` / `submissionId` 均为空：安全地回到 `queued`；已有 `conversationId` 而本地 `submissionId` 为空时，先按稳定 requestId 从底座找回原 Submission，只有确认不存在才重新启动；
  - 共享 Harness 恢复调度前，先装好所有可恢复后台会话的预算。禁用功能时若仍存在底座未完成主动任务，显式拒绝启动，要求先启用并收敛原任务；
  - `decided`：只补投递，不重新执行；
  - `delivering`：只对账，不重新执行；
  - 会话或 Submission 已不可恢复时记 `failed`（`PROACTIVE_CONVERSATION_MISSING` / `PROACTIVE_SUBMISSION_MISSING`），不把未知结果当作未执行。
- 用户反馈仍走主对话现有 Memory 工具；后台 Run 不写偏好、不改任务。

## 9. 观测

启用 Langfuse 时，主动 Run 使用独立 request 观测，子 Span 顺序为：

`proactive.trigger → proactive.context → agent.loop → web_search / web_fetch → proactive.decision → telegram.delivery`

记录字段：触发类型、Run ID、Memory revision、偏好／profile／最近片段计数、上下文字节数、工具调用数、模型 token 与可用成本、`notify`／`skip`、相关性理由摘要、投递状态、错误码。默认只记录计数、状态与短原因；不上传完整记忆、Web 原文或凭据。

## 10. 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PROACTIVE_ENABLED` | `0` | 总开关；关闭时不创建调度器与数据库 |
| `PROACTIVE_DAILY_AT` | `09:00` | 本地 `HH:MM` |
| `PROACTIVE_TIMEZONE` | `MEMORY_TIMEZONE` 或 `UTC` | IANA 时区 |
| `PROACTIVE_MAX_PER_DAY` | `1` | 每日最多 `notify` 次数，1～10 |
| `PROACTIVE_MAX_TOOL_CALLS` | `20` | 单 Run 工具调用上限，1～100 |
| `PROACTIVE_MAX_TOKENS` | `60000` | 单 Run token 上限，1000～500000 |
| `PROACTIVE_TIMEOUT_MS` | `180000` | 单 Run 超时，10000～600000 |
| `PROACTIVE_CONTEXT_MAX_CHARS` | `12000` | Proactive Context 字符上限，1000～50000 |
| `PROACTIVE_RECENT_DAYS` | `3` | 读取最近几天 Daily Memory，0～30 |

启用时若没有 `DEEPSEEK_WEB_API_KEY`（Web 工具未注册），启动失败：主动能力没有发现渠道不静默降级。

## 11. 实施步骤

1. 新增 `src/proactive.ts`：配置类型、决策 Schema、URL 规范化、上下文渲染、SQLite Store、调度器、CLI 共用入口。
2. 新增 `src/proactive-runner.ts`：独立会话、预算 hook、结构化决策解析、宿主校验、上下文读取、Trace。
3. 扩展 `src/config.ts`、`.env.example` 与 `package.json`（`proactive` 脚本）。
4. `openAgent` 暴露 `proactive` Runner；`main.ts` 打开 Store、启动与停止调度器。
5. `Inbox` 增加宿主动入队与状态查询；`Telegram` 现有投递路径不变。
6. 循环检测按会话隔离，避免主动 Run 影响主对话。
7. 文档：功能 ADR、`docs/proactive-loop.md`、文档索引、部署验收步骤。

## 12. 测试与验收

自动化测试覆盖：

1. 偏好被带入上下文，且保留 `revision` 与来源；
2. 主对话任务目标变化后，下一次 Run 读到新版本；
3. 无偏好／无 profile 时明确为空，不生成内容；
4. 模型选择 `skip` 时不入队投递；
5. 已投递 URL 与同决策重复 URL 被去重；
6. 主动 Run 不向主对话追加用户或助手 entry；
7. 后台 Run 不阻塞主对话的 `reply` 路径（独立会话、独立 Submission）；
8. 第二次 Run 重新读取 Memory revision；
9. 重启后 `running + submissionId` 恢复、`running` 无 Submission 回到队列、`decided` 只补投递；
10. `delivery_uncertain` 不被自动重发；
11. 主动 Run 确实使用 pi-durable 会话与 Submission，未另建模型循环；
12. 真实环境验收：手工触发后实际执行 `web_search`／`web_fetch`，结果经校验后到达 Telegram；核对 Langfuse 链路与 SQLite 状态。

验收记录、真实证据与遗留缺陷写入功能 ADR，不写进本 spec。

## 13. 非目标

- 不做周期性主动聊天、RSS／邮件／GitHub 事件监控、复杂计划或多步长期任务；
- 不让模型自行修改偏好、任务或 Memory；
- 不让主动 Run 使用 bash、文件、MCP、codemode 或提醒工具；
- 不保证外部 Web 内容真实；只保证来源 URL 来自本次工具结果，并记录可追溯状态。

# 主动发现（Proactive Loop V1）

主动发现是宿主按计划或手工触发的一次有界后台研究：读取主对话已经沉淀的 Memory，使用现有 Web 工具检索现实世界的信息，判断是否值得打扰 Owner，并把通过宿主校验的结果投递到 Owner 私聊。它不向主 Telegram 对话写入伪造消息，也不另建模型循环；取舍见 [ADR-0023](adr/proactive-loop/0023-ownerless-proactive-runs.md)。

## 范围与模块边界

V1 只支持手工触发与每日一次自动触发。不做 RSS／邮件／GitHub 事件监控、多步长期计划、偏好自动修改、Web UI、自定义 Cron 框架或周期性主动聊天。

| 模块 | 职责 |
| --- | --- |
| `src/proactive.ts` | 决策 Schema、URL 规范化、有界上下文渲染、SQLite 状态存储、进程内调度器 |
| `src/proactive-runner.ts` | 独立 ownerless 会话、预算 hook、Memory 快照读取、决策解析、宿主校验与投递交接 |
| `src/proactive-cli.ts` | 手工触发、查看 Run、收敛未知投递；只改持久状态，不执行 Run |
| `src/config.ts` | `PROACTIVE_*` 配置与边界校验；启用时要求 `DEEPSEEK_WEB_API_KEY` |
| `src/agent.ts` | 向主动 Runner 提供同一 Harness、模型、Registry、Web Extension、Trace 与 Loop Guard |
| `src/main.ts` | 打开 `proactive.sqlite`、启动前 `recover()`、启停调度器、把投递交给 Inbox |
| `src/inbox.ts` | 宿主动入队（`enqueue`）与投递状态查询（`deliveryStatus`） |

## 调用链

```text
手工: npm run proactive -- trigger
每日: ProactiveScheduler 每 30 秒一轮，达到 PROACTIVE_DAILY_AT 后创建 daily:<localDate>

Trigger -> Run (queued)
  -> claimNext()                  queued -> running（条件更新，只有一个执行者）
  -> 宿主读取主对话 WorkingState + 最近 Daily Memory
  -> proactive.context            有界 JSON 快照，记录 revision 与裁剪摘要
  -> harness.createConversation({ ownership: "ownerless", agent })
  -> conversation.submit()        持久化 Submission，requestId = proactive:<runId>
  -> agent loop（模型只能看到 web_search / web_fetch）
  -> 严格 JSON decision -> 宿主校验 URL / 去重 / 每日上限
  -> decided -> Inbox.enqueue()   requestId = proactive:<runId>
  -> scheduled reconcile          sent -> delivered
                                  failed -> delivery_failed
                                  uncertain / missing -> delivery_uncertain
```

调度器与 Telegram 长轮询在同一进程内并行。计时器只决定何时查看数据库；SQLite 是唯一事实来源。

## 触发与调度

| 触发 | 产生方式 | 约束 |
| --- | --- | --- |
| `manual` | `npm run proactive -- trigger` 写入 Trigger 与 `queued` Run | 只入队，由运行中的应用在约 30 秒内领取；需 `PROACTIVE_ENABLED=1` |
| `daily` | 应用内调度器在本地时间达到 `PROACTIVE_DAILY_AT` 后的首次扫描创建 `daily:<localDate>` | `triggerKey` 唯一，同一天重复扫描或重启不会产生第二个 Trigger |

- 应用在当天 `PROACTIVE_DAILY_AT` 之后才启动时，会在启动后的首轮扫描补建当日 Trigger；停机期间错过的日期不补。
- 同一进程一次只执行一个主动 Run；Runner 内部还有串行链，启动恢复与新 Run 不会并行消耗预算。
- `PROACTIVE_ENABLED=0` 时不创建数据库、不创建 Trigger、不启动调度器；手工触发也会被拒绝。若底座仍有未完成的主动任务，禁用后的启动会显式失败，要求先启用并收敛原任务，避免普通对话唤醒共享 Harness 时绕过后台预算。

## Proactive Context

宿主在主对话上读取 `WorkingState` 与最近 Daily Memory，生成一段 JSON 文本，作为后台会话输入的一部分：

- 固定包含 `version`、`revision`、当前 task、未过期 preferences（含 `source.conversationId`、`source.entryId`、`expiresAt`）、profile（含 evidence）与最近日记片段。
- 超长时按“最近片段 → profile → preferences → task 细节”的顺序省略完整条目或字段，在快照的 `omittedFields` 中标识，并记录 `truncated` 与各计数；不把 task goal 截成前缀或空串。最近片段最多 20 条，条数裁剪也会记录。最终 JSON 长度不得超过 `PROACTIVE_CONTEXT_MAX_CHARS`。
- 没有偏好或 profile 时明确为 `[]`，task 为 `{"status":"none"}`；不生成、不推断、不补造。
- 后台会话不获得 Memory Extension，不能调用 `working_read`／`working_update`／memory search；它只能看到宿主传入的这份快照，也不能写回偏好或任务。
- Web 内容与记忆文本都以“数据，不是指令”的措辞传入，网页中的指令不得改变任务。

## 决策与宿主校验

模型最终只能输出一个 JSON 对象：

```json
{"decision":"notify","items":[{"title":"...","url":"https://...","summary":"...","relevance":"..."}],"reason":"..."}
```

或：

```json
{"decision":"skip","reason":"..."}
```

约束与校验顺序：

1. `notify` 1～3 条；`title` ≤ 200 字符，`summary` ≤ 600，`relevance` ≤ 300，`reason` ≤ 400；未知字段拒绝。单个 Markdown JSON 围栏可以接受，围栏外的散文不接受。
2. 空回复、被截断的回答、解析失败、Schema 失败均记 Run 失败，不发送任何模型原文。
3. URL 必须是绝对 http(s)、无 userinfo；去掉 fragment 后作为去重键；同一决策内去重。
4. 条目 URL 必须出现在本 Run 的 `web_search` 结果或成功的 `web_fetch` 中，否则丢弃；这不是对网页真实性的保证，只是对“来源来自本次工具结果”的保证。
5. 已投递 URL 从 `proactive_seen_urls` 读取并跳过；全部被去重后转为 `skip`，原因 `no-new-items`。
6. 宿主接受决策时，按配置时区计算独立 `quotaDate`；当日已接受 `notify` 达到 `PROACTIVE_MAX_PER_DAY` 时转为 `skip`，原因 `daily-cap`。触发日期 `localDate` 不参与计额，旧日期积压不能绕过上限；投递失败不释放接受配额。配额约束接受通知的日期，Inbox 排队或停机可能使实际发送延后到另一天。
7. 通过后先持久化决策、条目与已见 URL，再入队 Inbox；发送文本由宿主拼接为“主动发现（N 条）”，不使用模型输出的任意格式。

## 数据与状态

数据库文件是 `<DATA_DIR>/proactive.sqlite`，与 `inbox.sqlite`、`reminders.sqlite` 和 Memory 数据分开。

| 表 | 关键列 |
| --- | --- |
| `proactive_triggers` | `id`、`triggerKey UNIQUE`、`kind`（`daily` / `manual`）、`createdAt` |
| `proactive_runs` | `id`、`triggerId UNIQUE`、`localDate`、`quotaDate`、`status`、`conversationId`、`submissionId`、`memoryRevision`、`contextSummary`、`decision`、`reason`、`itemsJson`、`toolCalls`、`tokens`、`deliveryRequestId`、`deliveryStatus`、`deliveryError`、`errorCode`、时间列 |
| `proactive_observed_urls` | `runId`、`urlKey`、`url`；本 Run 工具结果中出现过的 URL，供恢复后继续校验 |
| `proactive_seen_urls` | `urlKey` 主键、`url`、`runId`、`createdAt`；已接受投递的 URL，跨 Run 去重 |

Run 状态机：

```text
queued --claimNext--> running --决策通过--> decided --入队 Inbox--> delivering --sent--> delivered
                            |                                        |--failed--> delivery_failed
                            |--skip / 全部被去重--> skipped           |--uncertain / missing--> delivery_uncertain
                            |--预算/超时/Schema/异常--> failed
```

所有迁移都在 `BEGIN IMMEDIATE` 事务中做条件更新：`claimNext` 只让一个执行者把 `queued` 改为 `running`；`acceptNotify` 在同一事务内复核每日上限、URL 去重并写入已见 URL；`reconcileDelivery` 只作用于 `delivering`。重复扫描、重启或两个 CLI 调用都不会让同一 Trigger 执行两次。

## 失败与恢复

| 情形 | 记录 | 是否自动重试 |
| --- | --- | --- |
| 工具调用超过 `PROACTIVE_MAX_TOOL_CALLS` | 阻断后续工具，要求模型立即输出决策；若无法完成则 `failed` + `PROACTIVE_UNANSWERED` / `PROACTIVE_BUDGET_TOOL_CALLS` | 否 |
| token 超过 `PROACTIVE_MAX_TOKENS` | 中止会话，`failed` + `PROACTIVE_BUDGET_TOKENS` | 否 |
| 单 Run 超时 | 中止会话，`failed` + `PROACTIVE_TIMEOUT` | 否 |
| 模型回复为空或 `stopReason=length` | `failed` + `PROACTIVE_EMPTY_DECISION` / `PROACTIVE_DECISION_TRUNCATED` | 否 |
| 决策不是合法 JSON 或 Schema 不符 | `failed` + `PROACTIVE_DECISION_INVALID_JSON` / `PROACTIVE_DECISION_SCHEMA` | 否 |
| 会话或 Submission 丢失 | `failed` + `PROACTIVE_CONVERSATION_MISSING` / `PROACTIVE_SUBMISSION_MISSING` | 否 |
| 入队 Inbox 失败 | `failed` + `PROACTIVE_DELIVERY_ENQUEUE_FAILED` | 否 |
| 进程在会话创建前崩溃（`conversationId` / `submissionId` 均为空） | 启动时回到 `queued` | 是；此前没有模型或 Web 副作用 |
| 已保存 `conversationId`、尚未保存 `submissionId` | 保留会话身份；以稳定 requestId 查询底座已提交的 Submission | 找到则继续等待原调用；只有确认不存在时才允许重新启动 |
| 进程在运行中崩溃（有 `submissionId`） | 保持 `running`，启动时重新等待同一 Submission | 是；在共享 Harness 恢复调度前装好各会话预算，按保存的调用数及持久化用量继续 |
| 进程在决策后、入队前崩溃（`decided`） | 启动时只补投递，不重新执行 | 是；同一 requestId 幂等 |
| 投递结果未知（`delivering` 对账为 `uncertain` / `missing`） | `delivery_uncertain` + 错误码 | 否，必须人工核对 |
| 投递明确失败（`failed`） | `delivery_failed` + `DELIVERY_FAILED` | 否 |

“结果未知”一律记为 `delivery_uncertain`，不当作未执行，也不自动重发。停机顺序是先停调度器，再关闭 agent 与数据库；被停止信号打断的 Run 保留 Submission，下次启动继续。

## 操作与核查

```sh
npm run proactive -- trigger          # 手工入队一次 Run（需 PROACTIVE_ENABLED=1）
npm run proactive -- list             # 按待处理优先级列出 Run
npm run proactive -- resolve 12 delivered   # 核对 Telegram 后确认已送达
npm run proactive -- resolve 12 failed      # 核对后确认未送达
```

- CLI 从 `DATA_DIR` 读取 `proactive.sqlite`；`trigger` 在数据库不存在时会创建，其他命令要求先有数据库。
- CLI 只修改持久状态，不执行 Run，也不调用 `recover()`；运行中的应用会在下一轮扫描领取。停服时手工 Trigger 会在下次启动时执行。
- `resolve` 只接受 `delivery_uncertain` 行；已终态的行不会被改写。
- 常用排查字段：`status`、`decision`、`reason`、`errorCode`、`deliveryStatus`、`deliveryError`、`memoryRevision`、`contextSummary`、`toolCalls`、`tokens`。

## 安全与资源边界

- 目标会话固定为宿主配置 `TELEGRAM_OWNER_ID` 的私有会话；模型参数中没有 chat id，无法指定其他会话。
- 后台会话的 `modelTools` 精确为 `web_search`、`web_fetch`；Memory、提醒、codemode、bash、文件与 MCP 工具都不提供。即使模型尝试其他工具，`beforeTool` 也会阻断。
- 模型、凭据、cwd 与执行环境由宿主配置提供，不能由 Run 参数覆盖。
- 主对话只被宿主读取；主动 Run 不向主对话追加 entry，也不修改 Memory。
- 上下文最多 `PROACTIVE_CONTEXT_MAX_CHARS` 字符，读取最近 `PROACTIVE_RECENT_DAYS` 天 Daily Memory；决策条目最多 3 条，字段长度受限。
- 单 Run 的工具调用、token、超时与并发都有上限；`notify` 的每日上限在持久化事务内复核，模型不能绕过。
- 日志与默认 Trace 只记录 Run id、状态、计数、短原因与错误码，不记录完整记忆、Web 原文或凭据。开发环境开启 `LANGFUSE_CAPTURE_CONTENT=1` 时，Web 工具参数与结果可能出现在 Trace 中，该开关只用于个人开发环境。
- `trigger` 使用随机 `manual:<uuid>` 键，每次调用都是新 Trigger；相同内容的手工触发仍是不同的 Run。

## 配置

| 变量 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| `PROACTIVE_ENABLED` | `0` | `0` / `1` | 总开关；`1` 时要求 `DEEPSEEK_WEB_API_KEY` |
| `PROACTIVE_DAILY_AT` | `09:00` | `HH:MM`，00:00～23:59 | 本地时间，之后的首轮扫描补建当日 Trigger |
| `PROACTIVE_TIMEZONE` | `MEMORY_TIMEZONE` 或 `UTC` | 有效 IANA 时区 | 每日触发与推送日边界 |
| `PROACTIVE_MAX_PER_DAY` | `1` | 1..10 | 每个本地日最多接受几次 `notify`，以决策接受时间计额 |
| `PROACTIVE_MAX_TOOL_CALLS` | `20` | 1..100 | 单 Run 工具调用上限 |
| `PROACTIVE_MAX_TOKENS` | `60000` | 1000..500000 | 单 Run token 预算（宿主 hook 执行） |
| `PROACTIVE_TIMEOUT_MS` | `180000` | 10000..600000 | 单 Run 等待上限 |
| `PROACTIVE_CONTEXT_MAX_CHARS` | `12000` | 1000..50000 | 上下文 JSON 字符上限 |
| `PROACTIVE_RECENT_DAYS` | `3` | 0..30 | 读取最近几天 Daily Memory；`0` 表示不读 |

非法值使启动失败，不会静默回退；即使 `PROACTIVE_ENABLED=0` 也会校验，避免错误配置在启用时才暴露。

## 部署与真实环境验收

上线前按 [部署指南](deployment-test-guide.md) 构建并发布包含本功能的镜像，然后执行：

1. 在容器或宿主的应用环境中设置：`PROACTIVE_ENABLED=1`、`DEEPSEEK_WEB_API_KEY`、有效模型配置、`DATA_DIR` 指向持久化卷；确认 `dist/src/proactive.js`、`dist/src/proactive-runner.js` 与 `dist/src/proactive-cli.js` 存在。
2. 启动后确认日志无 `Proactive` 配置错误；`DATA_DIR` 下出现 `proactive.sqlite`，表为 `proactive_triggers`、`proactive_runs`、`proactive_observed_urls`、`proactive_seen_urls`。
3. 执行 `npm run proactive -- trigger`，确认返回 `created: true` 与 `queued`；约 30 秒内 `list` 中该行进入 `running`，并出现 `conversationId`、`submissionId`、`memoryRevision` 与 `contextSummary`。
4. 若 Memory 中有偏好或当前任务，确认 Run 的上下文摘要计数与之一致；新建或更新偏好后再次触发，确认下一次 `memoryRevision` 变化，且旧值未被当作新值。
5. 确认真实执行了 `web_search`，重要结论另有 `web_fetch`；`proactive_observed_urls` 中出现对应 URL。若模型选择 `skip`，确认 `reason` 已保存且 Telegram 没有消息。
6. 决策为 `notify` 时，确认 Owner 私聊收到“主动发现（N 条）”，每条带真实 URL；`list` 中状态为 `delivered`，`deliveryRequestId = proactive:<id>`。
7. 确认主 Telegram 对话的历史没有新增主动消息，也没有伪造的用户消息；主动 Run 期间继续向主对话发消息，回复路径不被阻塞。
8. 重复触发并返回相同 URL，确认第二次为 `skipped`、原因 `no-new-items`，且没有第二次投递。
9. 在同一天再触发一次 `notify`（临时将 `PROACTIVE_MAX_PER_DAY` 保持为 1），确认转为 `skipped`、原因 `daily-cap`。
10. 重启场景：在 Run 刚进入 `running`、尚未写入 `conversationId` 时重启，确认回到 `queued`；在底座已接纳 Submission、应用尚未写入 `submissionId` 时重启，确认按 requestId 找回原 Submission；在已有 `submissionId` 时重启，确认复用同一会话与 Submission、预算仍生效；在 `decided` 时重启，确认只补投递，不重新执行。
11. 故障场景：临时使用无效模型或阻断 Web 工具，确认 Run 进入 `failed` 并带错误码，Telegram 没有消息；恢复配置后再触发可正常完成。
12. 投递未知：模拟 Telegram 投递超时或断线，确认该行为 `delivery_uncertain`，重启后仍不被自动重发；核对 Telegram 后用 `npm run proactive -- resolve <id> delivered|failed` 收敛。
13. 观测：在 Langfuse 中确认一次 Run 的 Span 顺序为 `proactive.trigger → proactive.context → agent.loop → web_search / web_fetch → proactive.decision → telegram.delivery`，且没有完整记忆或凭据。
14. 关闭开关：先收敛底座未完成的主动任务，再设置 `PROACTIVE_ENABLED=0` 重启，确认没有主动 Run，普通对话、Inbox、提醒与 Durable Replay 均不受影响；若仍有未完成主动任务，启动必须显式拒绝，不能无预算恢复。禁用后的手工 trigger 不得创建数据库。

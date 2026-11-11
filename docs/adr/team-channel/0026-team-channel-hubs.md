# ADR-0026：频道里的团队助手——一人一个 Hub，线程追问 fork 子会话

- **状态**：Accepted（代码与离线测试已完成；真实 Slack workspace 的频道链路未验收）
- **日期**：2026-11-10
- **功能**：team-channel
- **取代**：[ADR-0025](../slack-channel/0025-slack-channel.md) 中「明确不做」里的频道/群聊与线程回复两项；其余（单进程单渠道、出站接入、投递契约）仍然有效

## 上下文

ADR-0025 把 Slack 接成了一个**单聊渠道**：只接受 `channel_type === "im"` 且 `user === owner` 的消息，频道消息、群聊、线程回复都在「明确不做」清单里。

2026-11-10 所有者要求把它变成**真正的团队助手**：在频道里 @bot 提问，bot 回复后在他那条回复下继续追问要能接着聊，且不能把整个频道的人混进同一个会话。要求逐条为：

1. **@bot 起会话，线程追问接上下文**：用户在该回复下追问时，应以那条 bot 回复为父，开一个子会话继续。
2. **一轮话题最多 5 个回合**，到顶就直接结束子会话（避免一个话题无限长），本轮内容摘要归到父会话，作为父会话的 memory／long-term memory，并提示「该问题循环过多，请不要再回复」。
3. **接入白名单**：谁可以驱动这个 bot、在哪些频道，由配置决定。
4. **一人一个 Hub，天然隔离**：每个成员一个 Hub，对话历史独立，各自有自己的喜好与长期记忆；Hub 粒度必须是「一个人」，否则按人维度的历史与个性化记忆就不成立。
5. **成员权限**：取消 bash 命令（根 conversation hub 的拥有者除外，即所有者本人）；能读写本对话历史（例如问 bot「我之前问过什么」）、能调用定时提醒与其他工具。
6. **成员不能读取所有者的 profile**；guest 先不做（进入会话的都是自己人）；成本上限暂时不做。
7. **身份必须来自 Slack 的用户参数**（唯一标识），不能由提示词声明——防止提示词注入冒充他人。
8. 本轮只做 MVP：**身份校验 + 工具分配的抽象层**、以及基于 Hub 的工具调度器，之后再做。

现状约束（读代码确认）：`src/slack.ts` 的 `toRequest` 只接受 owner 单聊，其余事件**静默丢弃**；`inbox` 表没有线程锚点；`src/agent.ts` 只有一个会话（harness root）；`registry.setDisabled` 是**进程级**的 `Set`（`src/tools.ts` 的 `createToolRegistry`），一个进程一个 registry 无法表达「owner 有 bash、成员没有」；`MemoryIntegration` 绑定**一个**会话与**一个** daily store（`attach` 只能调用一次），其检索工具在构造时就把 store 捕获了——共享一个 store 等于把所有人的长期记忆混在一起。

## 决策驱动因素

- **身份只能来自传输层**：`event.user` 是 Slack 自己给的标识，消息正文永远不能改变「我是谁」。白名单也在配置里，事件不能给自己扩权。
- **隔离必须是「不可能」而不是「被要求」**：成员读不到所有者的东西，靠的是不同的会话、不同的 store、不同的工作目录，而不是靠提示词嘱咐模型别乱看。
- **不改底座**：Hub 用 pi-durable 已有的原语拼——`harness.createConversation` 建 Hub，`Conversation.fork` 开子会话；不新增依赖、不新写模型循环。
- **一次只改一件事**：ADR-0025 的投递契约、先落盘再确认、单写者、不承诺恰好一次，全部保留。
- **失败要看得见**：频道消息被丢弃以前是静默的；现在每条丢弃都带固定的原因码，只有"传输噪声"（别的 bot、消息编辑、非法信封）才不记。
- **给不出去的能力要明说**：提醒工具的目标 chat 是宿主写死的所有者单聊（`createReminderExtension({ chatId })`），成员用它只会把提醒发到所有者那里——所以 MVP 直接不给成员这个工具，而不是给一个会发错人的工具。

## 备选方案

- **一个成员一个 Harness（进程内多 Session）**：隔离最彻底——各自 registry、各自 MCP、各自记忆。但要在同一个 sqlite 上开多个 Session（底座的设计是「一个 storage 一个 Session」），并把 MCP 连接、pin、工具账本按 Hub 复制一遍。改动面远超一次 MVP，不采纳。
- **共享一个 memory store，靠 prompt 让成员"别读"**：所有者的 profile 与长期记录就在同一个 daily store 里，`memory_search` 一搜就能读到。不采纳。
- **用 `registry.setDisabled` 表达成员权限**：它是进程级状态，一个进程一个 registry。不采纳。
- **靠模型自报身份（"我是张三"）**：提示词注入即可冒充。不采纳。
- **线程追问继续在原 Hub 会话里聊，不 fork**：省一次 fork，但一个话题会把 Hub 的历史撑长，且「最多 5 轮 + 结尾摘要」无处安放。不采纳。
- **成员 Hub 只给对话历史，不放长期记忆**：成员之间的历史隔离了，但「各自有自己的喜好」不成立。不采纳；改为一人一个 store（见决策）。
- **成员完全不给工具**：最安全，但「读写本对话历史 / 定时提醒 / 其他工具」都不成立。不采纳。

## 决策

**入向白名单（`src/config.ts`）**：新增 `SLACK_ALLOWED_USERS`（成员 ID，逗号分隔）与 `SLACK_ALLOWED_CHANNELS`（频道 ID，逗号分隔），形如 `U0MEMBER123`／`C0CHANNEL12`，形状不对启动失败；空列表表示"只服务所有者单聊"。`CHANNEL=telegram` 时这两个变量不读取。

**入向策略（`src/slack.ts` 的 `SlackInboundPolicy` + `toRequest`）**：策略对象 `{ ownerId, botId, allowedUsers, allowedChannels, log }` 只由配置构造。规则：

- 身份取自 `event.user`；单聊仍**只**接受所有者（`DM_NOT_OWNER`）。
- 频道/群聊要求：频道在白名单（`CHANNEL_NOT_ALLOWED`）、发送者在白名单或就是所有者（`SENDER_NOT_ALLOWED`）。
- **起会话必须 @bot**（`<@botId>` 出现在正文里）；**零散消息不算**（`NOT_A_MENTION`）。但在**线程内**的回复不需要再次 @（这正是「在 bot 回复下追问」的形状）。
- `app_mention` 与 `message` 都是合法事件类型；`thread_broadcast`（在回复里勾选"也发到频道"）仍算追问；别的 bot（`bot_id`）、消息编辑/删除（其他 `subtype`）、非频道/单聊的 `channel_type` 一律静默丢弃；`mpim` 不支持。
- 正文里去掉 `<@botId>` 这一段再进会话——`<@…>` 是 Slack 的称呼方式，不是请求内容。
- 丢弃都带原因码写到日志（不记正文）；只有传输噪声不记。

**线程锚点落到 `inbox`（`src/messages.ts` + `src/inbox.ts`）**：`TextRequest.threadTs` 可选；`inbox` 新增 `threadTs` 列（迁移对老库是 no-op，NULL 表示平铺回复），`accept()` 在锚点变化时拒绝复用请求 id，`next()` 把 NULL 还原成「平铺」。投递契约（`DeliveryChannel.send`）增加可选的 `threadTs`：一条回复的每一段都带同一个锚点，分段回答留在同一个线程里。**平铺的 @ 提问回复也保持平铺**——用户在 bot 那条消息下的回复才会形成线程。

**Hub 记账（`src/hubs.ts`，`hubs.sqlite`）**：三张表，只存标识与计数，不存正文。

- `hubs(memberId, conversationId, adoptedAt)`：成员的 Hub 会话。第一次有请求时创建，幂等；同一个成员被"改嫁"到另一个会话会抛错（不是迁移）。`memberOf()` 用于反查。
- `threads(channel, threadTs, conversationId, forkId, closedAt, updatedAt)`：一个线程属于哪个 Hub、它的 fork 是谁、是否已关闭。
- `threadRounds(channel, threadTs, requestId)`：**按请求 id 去重**的回合数——Slack 重投未确认的信封、恢复重放未完成的请求都不会多吃一个回合。

**路由（`src/agent.ts` 的 `route()`）**：回答哪个会话，在开 trace 之前决定。

- 发送者是所有者（或没有配置 Hub 层）→ **root 会话**，即所有者自己的 Hub，不动、不 fork、不设上限（所有者要求自己的 Hub 可以无限循环）。
- 其他成员 → 第一次接触时创建 Hub：`harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, cwd, instructions, tools: { remove } } })`。工作目录 `<DATA_DIR>/workspace/members/<memberId>`，记忆根 `<DATA_DIR>/memory/members/<memberId>`，两者都按**成员 id** 派生（会话重建后记忆与文件仍跟着这个成员），成员 id 先按 Slack 的形状校验，不合格直接拒绝而不是拼进路径。
- 线程追问 → 该线程的 fork：`hub.fork(最新一条 entry 的 id, …)`，即从"bot 那条回复"接着聊；fork 逐字继承 Hub 的 `pi.agent`，所以工具策略、指令、工作目录自动一致。同一条线程只 fork 一次，之后复用。
- **已关闭的线程**：不再进模型，由宿主直接答复固定文案（`FORK_CLOSED_NOTICE`），请求仍进 trace（带 `hostReply: "FORK_CLOSED"`），因此"每个入向请求都看得到"成立。

**成员工具策略**：在**创建会话时**用 `tools.remove` 去掉 `bash`、`powershell`（同一种能力，两个宿主）与 `reminder_create`／`reminder_list`／`reminder_cancel`。创建即固定，之后的请求无法放宽；未声明的工具模型根本调不到（记录为不可用，走 `TOOL_NOT_EXPOSED` 观测）。指令换成成员版本（`buildInstructions({ audience: "member" })`）：说明这是共享频道、这个 Hub 只属于他一个人、不能提及他人的会话与所有者的私下内容。

**回合上限与摘要归父**：`MAX_FORK_ROUNDS = 5`。第 5 个回合的回答**由宿主在末尾追加**「该问题循环过多，请不要再回复。」，然后按顺序做两件事，再做第三件：

1. **把线程自己的回合写回 Hub**：`hub.submit({ type: "write", entry: { kind: "personal.hub.thread-summary", data: {threadTs, rounds, fork}, model: [UserMessage] } })`，正文由宿主从子会话自己的 entry 摘录（只取 `conversationId === fork.id` 的那些，每段截断 400 字符、整条不超过 2000 字符），请求 id 是 `hub-thread-summary:<channel>:<threadTs>` 所以重投幂等。**不调用模型**，也不写入任何新的存储位置：这条 entry 进的是 Hub 自己的历史，于是 Hub 下一次提问就看得到，Hub 自己的归档管线之后会把它照常摘进长期记忆。自定义 kind 带 `model` 消息对模型可见，这一点与记忆投影 entry 同理。
2. **结束子会话**：`memory.resetConversationIn(fork)`（没有记忆时 `fork.reset()`），避免话题继续拖长。先写摘要再 reset——reset 开的是新上下文，之后再读就空了。两步失败都只记一行日志：回答已经落盘，不能因为归档动作丢掉用户等着的那句话。
3. 之后同一线程的追问只得到这句文案（不进模型）。**新话题**（同频道新的 @ 提问、新线程）从 Hub 重新 fork，靠 Hub 的历史与长期记忆续上。

**一人一个记忆 store**：`MemoryIntegration` 仍只有一个实例（一个 registry 装不下第二套同名工具），但它改成**按会话解析 store**：宿主通过 `registerConversationStore(conversationId, root)` 把 Hub 与它的每个 fork 登记到该成员的 store 根（fork 登记到 Hub 的根，于是子会话检索得到 Hub 的长期记忆），检索工具用 `api.conversationId`、归档任务用 `runtime.conversationId` 去取；**未登记的会话直接报错，绝不回落到别人的或所有者的 store**——这是隔离的硬保证。所有者的 root 会话保持原来的 `<DATA_DIR>/memory/daily`（零迁移）。成员之间、成员与所有者之间的 daily 记录与 profile 证据因此互不可见。请求层的 `initialize`／`prepareRequest`／`afterRequest`／`resetConversation` 增加按会话执行的版本（原方法保留，等价于对 root 会话执行）。

**fork 没有自己的归档状态**：fork 继承的尾巴属于 Hub，所以 `initializeArchive` 会拒绝以它为归档起点。`initializeConversation` 因此对 fork 只标记"本进程已初始化"，不建归档状态，边界扫描（`#rescanIn`）读到未初始化就干净跳过。也就是说**fork 自己不产出 daily 记录**：线程内容进 Hub 长期记忆的路径是上面第 1 步写回 Hub 的那条摘要 entry，再由 Hub 自己的归档管线处理。

**明确不做**（本轮）：guest 与任意 Slack 用户（进频道即自己人）、成员单聊（`im` 仍只服务所有者）、**按人维度的提醒目标**（所以成员暂时没有 reminder 工具）、**按 Hub 的并行调度**（仍是一条请求一条请求地跑，`src/channel.ts` 的 `deliverNext` 不变；因此 loop guard 与 300 秒超时也仍是进程级）、成本上限、按 Hub 的文件沙箱（`read`／`write`／`edit` 仍能按绝对路径访问 `DATA_DIR`）、成员使用 box 的电脑操作工具、身份/工具分配的抽象层与基于 Hub 的工具调度器（所有者明确排到下一阶段）。

## 后果

- 频道里的 @ 提问、线程追问、最多 5 轮与结尾摘要成为可验收的行为；单聊与所有者自己的用法完全不变（root 会话、无限循环、全套工具）。
- **代价：一人一个 Hub 会占用更多会话与磁盘**。每个成员一个会话、一个 workspace、一个 daily store；这是"按人隔离"的必然代价。
- **代价：fork 的回合上限是"线程级"的**。同一个 Hub 的不同线程各自计 5 轮，话题之间不再共享上下文（这正是想要的效果，但要知道它是刻意的）。
- **代价：线程摘要是有损的截断，不是模型写的摘要**。写回 Hub 的是子会话自己回合的摘录（每段 400 字符封顶、整条 2000 字符封顶），因此很长的回答只会留下开头；要模型级摘要就得让 fork 也能进归档管线，那是后续的事。
- **代价：Hub 与 fork 的检索面不同**。fork 读得到 Hub 的长期记忆（同 store），Hub 读不到 fork 的对话（fork 的内容只以那条摘要 entry 的形式回到 Hub）。这是刻意的方向：信息向上汇聚，不向下泄漏。
- **已知风险（本轮保留）**：成员 Hub 仍有 `read`／`write`／`edit`，绝对路径可读到 `DATA_DIR` 下的其他成员记录与 sqlite 文件；成员仍可用 box 的电脑操作工具（所有者要求先留着）；成员仍能用网络工具。这些要靠后续的身份/工具分配抽象层与按 Hub 的沙箱解决，本轮以"成员集合是自己人"为前提接受。
- **已知边界**：`powershell` 在 Linux 容器里通常装不成，但作为工具仍在清单里，所以按能力一起移除；将来加入新的 shell 类工具必须同步更新 `MEMBER_DENIED_TOOLS`。
- Slack 侧要新增 scope 与事件订阅（`app_mentions:read`、`channels:history`、`groups:history`；订阅 `app_mention`、`message.channels`、`message.groups`）并重新安装应用；详见 [Slack 通道](../../slack.md)。

## 分阶段决策与缺陷历史

### 2026-11-10：本次开发部分

- 相关 spec：无独立 spec；所有者逐条给出要求（见「上下文」1–8），方案先经两个 subagent 各出一版、再经两个对抗性方案评审，最后按所有者确认的「一人一个 Hub」收敛，取舍记在本 ADR。
- 所有者的追问与已确认项：轮次上限 5 且到顶直接结束子会话；摘要归父会话；bash 只给 root hub 的拥有者；成员不能读所有者 profile；成本上限暂不做；guest 暂不做；box 与现有工具先留着；身份/工具分配抽象层排到下一阶段。
- 已知未决：所有者的追问是否也要 fork（本轮定为不 fork，直接在 root 会话里继续，也就是"无限循环"）；成员是否保留 box 的电脑操作工具（本轮保留）；非白名单发送者一律丢弃并记原因码（本轮如此）。
- 实现状态：`src/config.ts`（白名单变量与形状校验）、`src/messages.ts` + `src/inbox.ts`（线程锚点）、`src/slack.ts`（策略化 `toRequest`、@/线程/白名单、投递带锚点）、`src/hubs.ts`（Hub 与线程记账）、`src/agent.ts`（路由、Hub 创建、fork、回合上限、摘要回父、结束）、`src/main.ts`（`hubs.sqlite` 接线）、记忆模块（按会话解析 store）均已落地并有测试（`test/hubs.test.ts`、`test/hub-routing.test.ts`、`test/hub-memory.test.ts`、`test/memory-hubs.test.ts`）；真实 Slack workspace 的频道链路**未验收**。
- 本轮不做的一项后来确认了理由：**按 Hub 的并行调度**没做，所以 `deliverNext` 仍是"一条一条跑"，loop guard 与 300 秒超时也仍是进程级；要做并行，先要给 `inbox` 加"认领"语义（把 pending 原子地标成 running）并给每个 Hub 一份 loop guard。

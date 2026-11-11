# ADR-0027：Slack 表情回应——自动回执 + 模型自选的表态

- **状态**：Accepted（代码、配置校验与本地测试已完成；真实 workspace 尚未授予 `reactions:write`，链路未验收）
- **日期**：2026-11-11
- **功能**：slack-channel

## 上下文

[ADR-0025](0025-slack-channel.md) 把投递契约定成纯文本：`DeliveryChannel` 只有 `send`，`inbox` 随请求记住回答落点 `threadTs`。2026-11-11 所有者提出「我现在想要让 aster 接入 slack 的表情包系统，当我回复他的时候，他能够用表情包反馈我」——他要的是 bot 对**收到的那条消息**贴表情，不是把表情当消息发出去。

当时的事实：

- Slack 的 `reactions.add` / `reactions.remove` 需要 `reactions:write`。2026-11-11 从容器里用那把 live token 读 `x-oauth-scopes` 实测回报的是 `im:history,chat:write,im:write,channels:history,groups:history,app_mentions:read`——**没有 `reactions:write`**，所以应用侧还要改一次并 Reinstall（按 [0025 的附记](0025-slack-channel.md)，重装不轮换 bot token，scope 变更也不需要重启进程）。
- Slack 一条消息可以同时挂多个不同表情；重复贴同一个返回 `already_reacted`，撤一个不存在的返回 `no_reaction`——两者都是**已经达到想要的状态**，不是失败。
- 收到的消息自身有一个 id（`event.ts`），回答落点是另一个（`event.thread_ts`）。线程里追问时这两个值指向不同的消息。

## 决策驱动因素

- **目标只能来自宿主**。表情必须贴在「正在回答的那条消息」上，模型参数不得指定频道或消息 id——与提醒工具「目标聊天由宿主固定」([ADR-0022](../reminders/0022-reminders-in-process-scheduler.md)) 是同一取舍。
- **表情是回执，不是投递**。它的失败不得影响回复是否送出、也不得进入投递状态机：`deliveries`／`failed`／`uncertain` 的语义是「这条消息到底发出去没有」，表情不承担这个承诺。
- **渠道二选一，不能为此改变 Telegram**。Telegram 没有对应的表态概念，所以这条能力从接口到工具都必须是可选的、缺席即关闭。
- **不新增入向端点、不新增依赖**。沿用既有 `fetch` 与 Socket Mode，表情走同一把 bot token。

## 备选方案

- **只让模型决定贴不贴**：长任务（一次 box 调用就两三分钟）期间用户看不到任何反馈，而且模型并不保证会调——正因为这个窗口才有自动回执的价值。
- **只做自动回执**：表达不了「同意／庆祝／这题我想想」这类语义，等于把表情降级成一个 LED 灯。
- **把表情塞进投递状态机**（当第二种 `deliveries` 行）：表情不需要分段、重投与人工对账，把它混进「投递不承诺恰好一次」的状态机会让那套语义失去意义。
- **采纳**：自动回执 + 模型工具两条都要，各自独立可关。

## 决策

**自动回执（默认开）**：`deliverNext` 取出请求后、跑模型之前贴 `SLACK_ACK_EMOJI`（默认 `eyes`）；回复的每一段都投递成功后先 `reactions.remove` 再贴 `SLACK_DONE_EMOJI`（默认 `white_check_mark`）。回复没送出去、或这一轮以错误文案收场时**保留回执、不贴完成表情**。变量写空或 `none` 即关闭该项，两项都关则完全不出表情。校验在启动时做（形状不对直接拒绝启动），因为「表情名写错」与「scope 没给」都会表现为「用户永远看不到表情」。

**模型工具 `react_to_message(emoji)`**：模型只提供表情名（大小写与两端冒号归一化，形状不符以 `INVALID_EMOJI_NAME` 在调用前拒绝，不发出请求）。贴哪条消息来自宿主持有的锚点 `ReactionAnchor`：投递循环在整条请求期间持有它（`try/finally`），而请求是串行处理的，所以锚点只有一个写者，也不可能贴到别的会话的消息上。没有锚点时返回 `NO_REACTION_TARGET`（提醒等主动发送就是这种情况）。工具注册为 `authz: write`；因为重贴同一表情在 Slack 上是幂等的，`replay: safe`。

**数据**：`inbox` 新增可空列 `messageTs`（迁移方式与 `threadTs` 相同：`ALTER TABLE ADD COLUMN`，旧库照读，NULL 表示「这条请求的渠道无法寻址自己收到的消息」，那批请求不贴表情）。

**契约**：`DeliveryChannel` 增加两个可选的 `react`／`unreact`；`deliverNext` 多一个可选的 `reactions`（回执表情 + 锚点）。不实现它们的渠道（Telegram）行为完全不变，模型工具也不会被注册。

## 后果

- **代价：每条请求多两次 Slack 调用**（贴 + 撤/换）。失败只记一行 `Slack reaction failed: <CODE>`，不进 `deliveries`、不改变请求状态、不阻断回复。
- **代价：默认开会把缺 scope 暴露成日志噪声**。没给 `reactions:write` 时每条消息都会打印 `Slack reaction failed: SLACK_MISSING_SCOPE`——这是有意的：宁可吵，也不要「bot 看起来在收消息但永远不表态」这种查不出来的状态。嫌吵就用 `SLACK_ACK_EMOJI=` 关掉。
- **代价：一次请求结束就不再贴**。表情只能贴「触发这次运行的那条消息」，跨请求（例如事后补一个表情）在工具层面是做不到的；要做到得让模型指定消息 id，而那正是本决策拒绝的东西。
- **成员 Hub 也能贴表情**。`react_to_message` 是写工具，但成员 Hub 的 authority 仍是 owner（只有按名字收回的工具被剥夺），所以成员在那个频道里也会收到表情——这正是团队频道想要的。
- **回执与回复是两件事**。用户看到 👀 就知道「收到了，还在做」；看到 ✅ 才知道「回复已发出」。两者都不代表模型答得好，也都不进投递对账。

## 附记

- 2026-11-11：实现与本地测试（`test/reactions.test.ts`、`test/slack.test.ts`）完成。验收项见 [Slack 通道](../../slack.md#验收) 第 12、13 条；生效前必须先给应用加 `reactions:write` 并 Reinstall。
- 2026-11-11（同日追加）：所有者看过第一版后问「只有一个表情包吗？其他表情呢？做得比较生动的话要怎么搞」——第一版把工具描述里写死了一串九个名字，模型会照着用，这是「单调」的主因。同日追加四项：
  1. **放开词表**：描述改成「workspace 里任何表情都能用」＋按语义选（同意/反对/庆祝/犯难/道谢）＋「一到三个比一整面墙更生动」。
  2. **回执按结果分级**：`done` / `failed`（答复是错误文案）/ `lost`（一个字都没送出去）三种，替换原先的「一律 ✅／失败就什么都不贴」。回执看客观状态，模型选的看语义，两者互补。
  3. **自定义表情的名字**：新增 `emoji_search` 工具，清单来自 `emoji.list`（**需要新 scope `emoji:read`**），进程内缓存 6 小时，未授权时明确回报 `SLACK_MISSING_SCOPE` 而不影响其余功能——「表情包」用不起来的唯一原因是模型不知道名字。它只读列表，所以治理上记为 `read`（`react_to_message` 仍是 `write`）。
  4. **每条消息的反应上限** `SLACK_MAX_REACTIONS`（默认 3）：上限在锚点上按请求计数（`claim()`），所以一个请求最多花掉 3 个，下一个请求重新满额；回执不占这个额度。**注意：计数在调用前发生**，所以失败的贴法也会占用额度——这是刻意的，上限的目的是约束对 Slack 的调用次数。
  5. 系统提示加一句（仅在注册了反应工具的部署里）：表情是语气不是答复；正文里用 emoji 也可以，别每行都装饰；有自定义表情就先用 `emoji_search` 查名字。

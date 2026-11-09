# ADR-0025：Slack 作为可切换的第二个渠道，用 Socket Mode 出站接入

- **状态**：Accepted（代码、配置校验与本地测试已完成；真实 Slack workspace 的链路未验收）
- **日期**：2026-11-09
- **功能**：slack-channel

## 上下文

仓库只有一个消息入口：Telegram 长轮询（[ADR-0011](../../0011-telegram-long-polling.md)）。渠道相关的假设写在多处——`src/config.ts` 要求 `TELEGRAM_BOT_TOKEN` 与数值 `TELEGRAM_OWNER_ID`，`src/telegram.ts` 同时负责收件与投递，`src/reminders.ts` 的类型直接引用 `TelegramClient`，`src/inbox.ts` 的 `identity` 表只有一行（bot id + owner id），投递失败分类读 `GrammyError.error_code`。

2026-11-09 所有者要求「加一个新的接口 slack」。他没有要求两个渠道同时在线，选择的接入方式是**配置切换**（二选一），并确认环境是内网、凭据泄露风险可接受（因此不强制 OpenBao）。

已知事实：本机与目标 VPS 都能直连 `slack.com` 与 Socket Mode 的 `wss-primary.slack.com`；Telegram 那台机器要靠自建 Cloudflare Worker 反代才能出站（`TELEGRAM_API_ROOT`）。Slack 侧提供了两种接入：Events API（需要公网可达的 HTTPS 端点）与 **Socket Mode**（应用主动建立的 WebSocket，天然穿 NAT，不需要入向可达）。

## 决策驱动因素

- **不引入第二个常驻入口**：部署是"一台小机器 + 一个容器"，为 Slack 开公网入向端点会新增一张证书、一个反代和一条防火墙规则，而这些机器本来就不适合暴露入向端口。
- **渠道不能改变会话语义**：owner 私有、单会话、先落盘再确认、投递不承诺恰好一次、失败人工收敛——这些是既有契约，换渠道不应改变。
- **不新增依赖**：Node 24 自带全局 `fetch` 与 `WebSocket`，Socket Mode 与 Web API 都不需要 SDK。
- **失败要早**：token 填错、owner id 填错、scope 缺失都必须在启动阶段失败，而不是表现为"bot 不理人"。
- **一次只服务一个渠道**：`inbox.sqlite` 只有一个 offset 检查点、一行身份绑定；投递路径按会话 id 回复。要让两个渠道同时在线，需要给请求与投递都加上"来源"并迁移表结构。

## 备选方案

- **Events API + 公网 HTTPS 端点**：官方推荐、延迟低，但需要入向可达与签名校验（`X-Slack-Signature`），且与「单容器、内网机器」的部署形态冲突。不采纳。
- **Telegram 与 Slack 同时在线（多来源收件箱）**：功能最强，但要给 `inbox` 与 `reminders` 加来源列、把单行检查点改成按来源分行、并让投递按来源选择客户端；在一次改动里同时做"新增渠道 + 改已有状态机"会把回归面放大到记忆与恢复路径。所有者选择了二选一，故不采纳（未来要做时按新 ADR 追加）。
- **引入 `@slack/bolt`／`@slack/web-api`**：省下手写的信封与错误处理，但为一个渠道新增两个依赖（含其传递依赖），而需要的 API 只有 `auth.test`、`conversations.open`、`apps.connections.open`、`chat.postMessage` 与一个 WebSocket 循环。不采纳。
- **把渠道抽象成插件注册表**：当下只有两个实现，抽象层只会增加间接层次。改为抽出**投递**这一段共享契约（`src/channel.ts`），收件侧仍各自成模块。采纳。
- **渠道由变量自动推断**（有 Slack token 就用 Slack）：隐式且容易在残留变量下切换，错误信息也说不清。改为显式 `CHANNEL`，非法值启动失败。采纳。

## 决策

**渠道选择**：`CHANNEL=telegram`（默认）或 `slack`，其他值启动失败。只读取所选渠道自己的变量；凭据做形状校验（`xoxb-`／`xapp-` 前缀与长度），`SLACK_OWNER_ID` 必须是 member ID（`U…`），MITM 占位符照常接受。

**共享投递契约**（`src/channel.ts`）：`DeliveryChannel = { label, send(target, text, signal), classifyFailure(error), failureCode(error) }`。`deliverNext()` 承担原来内嵌在 `serveTelegram` 里的那段工作——取一条待处理请求、跑 agent、分段投递、记录失败——两个收件循环都调用它。收件语义仍是各自的：Telegram 长轮询，Slack 监听 socket 帧。

**Slack 适配层**（`src/slack.ts`）：Socket Mode 信封先落盘再确认，落盘失败按致命处理（进程退出、信封不确认，重启后由 Slack 重投），与轮询渠道一致；`events_api` 只接受 owner 的单聊文本（`channel_type === "im"`、无 `subtype`／`bot_id`、`user === owner`），请求 id 为 `slack:<team>:<event_id>`，因此 Slack 的重投天然幂等；`disconnect` 帧触发换 URL 重连，退避上限 30 秒；信封缓冲有上限，溢出时断开重连而不是无界增长或静默丢弃。

**启动校验**：`identity()` 依次调 `auth.test`（bot token）、`conversations.open`（owner 可达，并缓存这条单聊）、`apps.connections.open`（app token），三者之一失败即启动失败。提醒直接发往缓存的那条单聊，所以错 owner id 在启动就暴露。

**身份表迁移**：`inbox.sqlite` 的 `identity`（单行）改为 `identities`（按渠道一行），旧行迁移为 `telegram` 并删除旧表。守卫仍是"同一渠道的 bot 或 owner 变了就拒绝启动"，但**换渠道不再算冲突**——这正是二选一需要的行为，也让同一 `DATA_DIR` 的历史与记忆在换渠道后继续可用。

**错误分类**：Slack 的应用错误是 HTTP 200 + `error` 字段，因此 `SLACK_<CODE>`（`channel_not_found`、`not_in_channel`、`msg_too_long`、`invalid_auth`、`account_inactive`…）判为 `failed`，其余（网络、超时、`SLACK_HTTP_*`）判为 `uncertain`。共用 `errorCode()` 生成通用码，Telegram 的 `TELEGRAM_<status>` 保持原样。

**明确不做**：Slack 的频道/群聊、线程回复、文件与图片、斜杠命令与交互回调（收到就确认再丢弃）、多 owner、多 workspace 同时在线、渠道自动切换、把两个渠道同时接到一个进程。

## 后果

- 换渠道只改 `.env`（`CHANNEL` 加对应凭据），不改代码；Telegram 部署完全不受影响（默认值不变，`TELEGRAM_*` 仍是必填）。
- **代价：投递分类按渠道各写一份**。`DeliveryChannel` 让调度器与投递循环与平台无关，但"什么算明确拒绝"这类判断每个平台不同，不能共享。
- **代价：一次只有一个渠道**。owner 在 Slack 说话时 Telegram 那条线不工作，反之亦然；两个渠道不能同时收件。
- **代价：状态机多了一次迁移**。`identity` → `identities` 会在启动时执行一次，旧表被删除；迁移后同一渠道换 bot 仍会拒绝启动。
- 提醒、分段、对账 CLI（`npm run deliveries`）与"未知结果不重发"的行为在两个渠道下一致。
- MITM allowlist 新增 `SLACK_BOT_TOKEN`／`SLACK_APP_TOKEN` → `slack.com`；Socket Mode 的 WebSocket 主机不需要条目。

## 分阶段决策与缺陷历史

### 2026-11-09：本次开发部分

- 相关 spec：无独立 spec；所有者直接要求「加一个新的接口 slack」，接入方式（二选一）与凭据存放（内网、不强制 OpenBao）经确认，决策与取舍记在本 ADR。
- 决策与取舍：如上。相对 ADR-0011 的变化只有一条——**入口不再只有 Telegram 一种**；长轮询、webhook 拒绝、owner 过滤等结论继续有效。
- 相关缺陷：开发中自查发现一处（未进入真实环境）：最初 `serveSlack` 在落盘失败时仍回 `envelope_id`，会把一条没存下来的消息静默丢掉；已改为与轮询渠道一致——落盘失败向上抛出，进程退出且不确认，重启后由 Slack 重投，并加了 `a store failure is fatal and the envelope stays unacknowledged` 用例锁定该行为。已知但未验证的两点：① 真实 workspace 的 scope 组合（`chat:write` + `im:history` + `im:write`）与 `message.im` 订阅只在文档里给出，没有跑过真实应用；② Socket Mode 的 `disconnect`／缓冲溢出重连只在本地假 socket 上测过，没有经历真实 Slack 的连接回收。
- 覆盖方式：`test/slack.test.ts` 用假 fetch 与假 socket 覆盖渠道选择与校验、信封过滤与幂等落盘、确认顺序、落盘失败不确认、分段投递、断线重连与错误分类；`deploy/openbao-mitm/addon/test_vault_placeholders.py` 覆盖 `slack.com` 的占位符替换边界（邻居域名与 `wss-primary.slack.com` 都被拒绝）。

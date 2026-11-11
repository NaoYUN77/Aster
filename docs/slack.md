# Slack 通道

部署可以把渠道从 Telegram 换成 Slack：`CHANNEL=slack` 时，应用用 **Socket Mode** 接收与回复 bot 的单聊（DM），并可以在**白名单频道**里当团队助手——@ 它提问、在它的回复下追问。取舍与代价见 [ADR-0025](adr/slack-channel/0025-slack-channel.md)（单聊渠道）与 [ADR-0026](adr/team-channel/0026-team-channel-hubs.md)（团队频道）。

同一进程只服务一个渠道。渠道层（`src/channel.ts`）把投递、失败分类与分段规则与具体平台分开，Telegram 与 Slack 两个适配层都实现同一份 `DeliveryChannel` 契约；切换渠道不换会话，历史、记忆与提醒都留在同一个 `DATA_DIR` 里。

## 生效方式

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `CHANNEL` | 否 | `telegram`（默认）或 `slack`；其他值启动失败。值会去掉首尾空白并转小写 |
| `SLACK_BOT_TOKEN` | `CHANNEL=slack` 时 | 应用的 bot token，`xoxb-` 开头 |
| `SLACK_APP_TOKEN` | `CHANNEL=slack` 时 | 应用级 token，`xapp-` 开头，需要 `connections:write` |
| `SLACK_OWNER_ID` | `CHANNEL=slack` 时 | 所有者的 Slack member ID（`U…`），同时是提醒的收件目标 |
| `SLACK_ALLOWED_USERS` | 否 | 除所有者外可以驱动 bot 的成员 ID，逗号分隔、不写空格（如 `U0AAA1111,U0BBB2222`）；形状不对启动失败 |
| `SLACK_ALLOWED_CHANNELS` | 否 | bot 可以回话的频道 ID，逗号分隔、不写空格（如 `C0AAA1111`）；形状不对启动失败 |

未选中的那个渠道的变量不会被读取：`CHANNEL=slack` 时不要求 `TELEGRAM_*`，`CHANNEL=telegram` 时不要求 `SLACK_*`。凭据形状会检查（前缀 + 长度），把 bot token 填进 `SLACK_APP_TOKEN` 这类错位会在启动时报错；MITM 模式下 `__vault_<NAME>__` 占位符照常接受。

## 需要一个什么样的 Slack 应用

bot 不是从 Slack 客户端里"添加成员"加进来的：只有发布到 App Directory 的应用能在 workspace 里直接装，自建应用要由你在 Slack 开发者后台 <https://api.slack.com/apps> 创建，再安装进 workspace。App 装进来后它的 bot user 就是 workspace 里的一个成员实体，在侧边栏 Apps／DM 列表里可以像人一样对话。

**推荐：用 App Manifest 一次建好**（Build → **Create New App** → **From an app manifest** → 选 workspace → 粘贴 → Create）。这段已经包含单聊所需的全部 scope、`message.im` 订阅、Socket Mode 与 Messages 标签页，省掉逐项点击：

```json
{
  "_metadata": { "major_version": 2, "minor_version": 1 },
  "display_information": {
    "name": "Aster",
    "description": "个人 agent：单聊收发消息，回复分段投递",
    "background_color": "#1f2937"
  },
  "features": {
    "app_home": {
      "home_tab_enabled": false,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": { "display_name": "Aster", "always_online": true }
  },
  "oauth_config": { "scopes": { "bot": ["chat:write", "im:history", "im:write", "app_mentions:read", "channels:history", "groups:history", "reactions:write", "emoji:read"] } },
  "settings": {
    "event_subscriptions": { "bot_events": ["message.im", "app_mention", "message.channels", "message.groups"] },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false,
    "app_level_token_rotation_enabled": false
  }
}
```

⚠️ **两个 rotation 开关都必须是关的**（`token_rotation_enabled` 是 bot／user token，`app_level_token_rotation_enabled` 是 app-level token，后者在 App-Level Tokens 区域还有一个独立的绿开关）。开了之后 Slack 只在创建时显示一次值，而且**access token 12 小时就过期、refresh token 一次性**——本服务不实现刷新，通道会在 12 小时内失效，重启也起不来（启动时的 `apps.connections.open` 会以 `invalid_auth` 失败）。这个开关 Slack 标为不可撤销，一旦开了只能**删掉应用重建**（应用没装、没数据时没有损失）。开了 rotation 的 app-level token 形如 `xoxe.xapp-…`，随附的 refresh token 形如 `xoxe-…`；**两个值长得像，要的是前者**。

建好之后只有两步取凭据：

1. **Install to Workspace** → 允许 → 复制 **Bot User OAuth Token**（`xoxb-…`）→ `SLACK_BOT_TOKEN`。
2. **Basic Information → App-Level Tokens → Generate Token and Scopes**，名字随取（如 `aster-socket`），加 `connections:write` → Generate → 复制 `xapp-…`（**只显示一次**；若这一区下面的 Token rotation 是开的，会同时显示一个 `xoxe-…` refresh token，**要的是 `xapp-…` 那个**，并且先把 rotation 关掉）→ `SLACK_APP_TOKEN`。

已经建过空白应用的话，**Basic Information → App Manifest → Edit** 粘同一段保存即可。

**手动点的话**（等价路径）：

1. **Create New App → From scratch**，选中要用的 workspace。
2. **Socket Mode** 打开，生成一个带 `connections:write` 的 app-level token → 填 `SLACK_APP_TOKEN`。
3. **OAuth & Permissions → Bot Token Scopes** 至少给三个：`chat:write`（发消息）、`im:history`（读单聊消息）、`im:write`（打开/复用与所有者的单聊）。要用频道再加 `app_mentions:read`（接收 @），公开频道加 `channels:history`、私有频道加 `groups:history`（读频道里的消息与线程回复）。要用表情回馈（见「表情回应」）再加 `reactions:write`（贴/撤表情）与 `emoji:read`（列出 workspace 自定义表情的名字，模型才用得上你的表情包）。
4. **Event Subscriptions → Subscribe to bot events** 订阅 `message.im`；要用频道再加 `app_mention`、`message.channels`（公开）与 `message.groups`（私有）。`message.im` 与频道事件都要走同一个 Socket Mode 连接，不需要公网端点。
5. 把 bot 邀请进频道（频道里 `/invite @Aster`，或频道设置 → Integrations → Add apps）——没有被邀请的频道收不到事件。
6. **App Home → Show Tabs → Messages Tab** 勾上 "Allow users to send Slash commands and messages from the messages tab"；不勾的话单聊输入框是只读的，你发不出消息。
7. **Install App** 后取 Bot User OAuth Token → 填 `SLACK_BOT_TOKEN`。
8. 在 Slack 里打开自己 profile 的 **Copy member ID**（`U…`）→ 填 `SLACK_OWNER_ID`。填错不会报错，但 bot 会安静地忽略所有消息，所以启动时会用这个 ID 打开一次单聊来验证。
9. 要用频道：频道 → 关于 → 复制 **频道 ID**（`C…`）→ 填 `SLACK_ALLOWED_CHANNELS`；要允许的同事的 member ID → 填 `SLACK_ALLOWED_USERS`。

改动 scope 或事件订阅之后需要重新 **Install to Workspace**（Slack 会提示 Reinstall），否则新权限不生效。workspace 若开了 app approval，安装按钮会变成"请求管理员批准"，这一步只能由管理员放行。

## 行为

- **谁的话会被处理**：所有者的单聊永远算；频道/群聊要求在 `SLACK_ALLOWED_CHANNELS` 里、发送者在 `SLACK_ALLOWED_USERS` 里（或就是所有者），并且**@ 了 bot**。别的 bot、消息编辑/删除、非频道事件、非 Slack 成员发的噪声一律丢弃。
- **身份只来自 Slack 参数**：发送者是 Slack 报的 `event.user`，白名单来自配置。消息正文里写「我是所有人」不会改变任何东西；正文里的 `<@bot>` 会在进入会话前去掉。
- **丢弃会记原因码**：`DM_NOT_OWNER`、`CHANNEL_NOT_ALLOWED`、`SENDER_NOT_ALLOWED`、`NOT_A_MENTION`、`EMPTY_TEXT` 各一行日志（不含正文）；只有传输噪声静默。
- **先落盘再确认**。收到 `events_api` 信封后，先把请求写进 `inbox.sqlite`，再回 `envelope_id` 确认。Slack 会对未确认的信封重投，请求 id 是 `slack:<team>:<event_id>`，重复投递只会命中同一条记录，不会重复执行。落盘失败按致命处理（进程退出，信封保持未确认），避免确认一条没存下来的消息。
- **线程锚点跟着请求走**：请求在线程里到达时，`thread_ts` 与请求一起落盘（`inbox.threadTs`），投递时每一段都带同一个锚点，所以分段回答留在同一个线程里，重启后也不会甩出线程。平铺的 @ 提问仍平铺回复——用户在 bot 那条消息下的回复才形成线程。
- **回复按 4000 字符分段**，与 Telegram 共用同一套分段与投递记录（`deliveries` 表、`npm run deliveries -- list` 对账）。Slack 的 `text` 走 mrkdwn 渲染，所以回复里的 `&`、`<`、`>` 会被转义，其余字符保持原样。
- **收到的那条消息自己也是锚点**：除了回答落点 `threadTs`，请求还会记住消息自身的 id（`inbox.messageTs`，来自 `event.ts`）。表情贴在后者上——线程里这两者是不同的消息，回答回线程、表情贴用户问的那一句。
- **失败分类**：Slack 的应用错误是 HTTP 200 + `error` 字段；`channel_not_found`、`not_in_channel`、`msg_too_long`、`invalid_auth` 等明确拒绝判为 `failed`（未送出），其余（网络、超时、429）判为 `uncertain`，两类都不会自动重发。
- **提醒**走同一渠道：到点直接向 `SLACK_OWNER_ID` 的单聊发送，不经过模型。成员的 Hub 暂时拿不到提醒工具（提醒目标写死所有者单聊），见 [ADR-0026](adr/team-channel/0026-team-channel-hubs.md)。
- **断线重连**：Socket Mode 连接由 Slack 主动回收（`disconnect` 帧），应用会取一个新的单次 URL 重连，退避上限 30 秒；读取缓冲区溢出时同样断开重连，未确认的信封会被 Slack 重投。

## 表情回应

bot 可以对**收到的那条消息**贴表情——它是对请求本身的表态，不是第二种消息类型，因此不进 `deliveries`、不分段、不重投、不影响回复是否送达。需要 `reactions:write`（贴/撤），要让模型用上**你上传的自定义表情**还需要 `emoji:read`（列出名字）；改完 scope 要 Reinstall，重装不轮换 token、也不需要重启进程。两条路可以同时用。

**① 自动回执（默认开）**：请求被取出、模型开跑之前贴 `SLACK_ACK_EMOJI`（默认 `eyes`）；这一轮结束后**按客观结果**换成对应表情，而不是一律 ✅：

| 结果 | 变量（默认值） | 含义 |
| --- | --- | --- |
| 回复全部分段投递成功 | `SLACK_DONE_EMOJI`（`white_check_mark`） | 答复已发出 |
| 回复发出去了，但这一轮以错误文案收场 | `SLACK_FAIL_EMOJI`（`warning`） | 送达了，但事情没成（超时/循环/被截断等） |
| 回复压根没送出去 | `SLACK_LOST_EMOJI`（`x`） | 一个字都没到，只能靠表情提示你 |

任一变量设为空或 `none` 即关闭该项（例如 `SLACK_ACK_EMOJI=`），四项都关就完全不出表情。回执只看**客观状态**，不看模型心情——所以它和模型自选的表情互补。

**② 模型自选（`react_to_message`）**：模型只给表情名（`tada`、`+1`、`raised_hands`，或自定义表情的名字，带不带冒号都行），**贴哪条消息由宿主决定**——投递循环在整条请求期间持有这个锚点，而一次只处理一条请求，所以它不可能贴到别人的消息上。没有正在回答的请求时（提醒等主动发送）返回 `NO_REACTION_TARGET`；名字形状不对在调用前就拒绝（`INVALID_EMOJI_NAME`）；**一条消息最多 `SLACK_MAX_REACTIONS` 个**（默认 3，1..10），超了返回 `REACTION_LIMIT_REACHED`——鼓励生动，不鼓励刷屏。它是写工具；Telegram 部署下根本不注册。

**③ 自定义表情的名字（`emoji_search`）**：模型不知道你上传了哪些表情，所以配了 `emoji:read` 时会注册这个查询工具（无参数列一批、给词就按名字匹配），清单取自 `emoji.list`、进程内缓存 6 小时。**没给 `emoji:read` 时它照样存在但会明确回报 `SLACK_MISSING_SCOPE`**：标准表情照常可用，只是自定义的用不上——不会因为这个把整轮跑失败。

表情调用失败只记一行 `Slack reaction failed: <CODE>`，不会挡住回复，也不会把请求标成 `failed`。生效前记得：**scope 没给时看到的就是 `SLACK_MISSING_SCOPE`**。

## 频道里的团队助手（Hub）

在频道里 @ bot 提问，回答由**这个成员自己的 Hub** 给出；在他那条回复下继续追问，会开一个该 Hub 的**子会话（fork）**接着聊。

- **一人一个 Hub**：Hub 是这个成员自己的会话，有自己的对话历史、自己的工作目录（`DATA_DIR/workspace/members/<memberId>`）与自己的长期记忆（`DATA_DIR/memory/members/<memberId>`）。不同成员之间、成员与所有者之间互相看不到对方的历史与记忆；所有者本人的 Hub 就是原来那个会话，用法完全不变。
- **一轮话题最多 5 个回合**：第 5 个回答末尾由宿主追加「该问题循环过多，请不要再回复。」，然后把该线程自己的往来摘录成一条摘要写回 Hub（**不调用模型**；每条摘录截断 400 字符、整条不超过 2000 字符），最后结束该子会话。之后同一线程再回复只会得到这句文案，**不再调用模型**。想继续就开新的话题（新的 @ 提问 = 新线程 = 从 Hub 重新 fork），Hub 已经通过那条摘要记住了刚才那轮谈了什么。
- **成员的工具**：没有 `bash` 与 `powershell`（所有者除外），也没有提醒工具；读写文件、网络搜索、记忆与其余工具照常。工具策略在 Hub 创建时就固定，之后的请求无法放宽。
- **"我之前问过什么"**：成员问自己的历史时，答的是他自己 Hub 的对话与长期记忆。
- 记账在 `DATA_DIR/hubs.sqlite`（成员 ↔ 会话、线程 ↔ fork、每线程的回合数，按请求 id 去重），只存标识与计数，不存正文。

## MITM 模式

占位符与 OpenBao 路径和 Telegram 一致（`secret/aster/<NAME>`，见 [OpenBao + MITM 部署](deploy/openbao-mitm/README.md)）。allowlist 需要：

```json
"SLACK_BOT_TOKEN": ["slack.com"],
"SLACK_APP_TOKEN": ["slack.com"]
```

Socket Mode 的 WebSocket 主机 `wss-primary.slack.com` 只在 URL 里带一次性票据、不带凭据头，因此不需要列出，也不需要替换。

## 排查

| 现象 | 可能原因 |
| --- | --- |
| 在 Slack 里找不到"添加 bot" | bot 要从 <https://api.slack.com/apps> 建应用后安装进 workspace，不能在成员页添加；App Directory 里只有已发布的应用 |
| 安装按钮变成"请求管理员批准" | workspace 开了 app approval；需要管理员放行 |
| OAuth & Permissions 页面上找不到任何 token | 应用还没安装：点 **Install to Workspace** 并允许，"OAuth Tokens for Your Workspace" 下才会出现 Bot User OAuth Token |
| 复制到 `xoxe-` 开头的值 | 那是 refresh token（例如开了 app-level rotation 时与 `xoxe.xapp-…` 一起显示的那个），只能用来换新 access token，不能连 Socket Mode；要的是 `xapp-…`（或 `xoxb-…`） |
| App-Level Tokens 里的 Token rotation 是开的 | access token 12 小时过期、refresh token 一次性，本服务不刷新 → 通道必然失效；关掉它，关不掉就删掉应用用关掉 rotation 的 manifest 重建 |
| 日志出现 `SLACK_INVALID_AUTH` / 启动 `apps.connections.open was refused (INVALID_AUTH)` | app-level token 写错、被 rotation 过期、或 scope 缺 `connections:write` |
| 与 bot 的单聊输入框是只读的 | App Home 的 Messages Tab 没打开 |
| 启动报 `ConfigurationError: SLACK_BOT_TOKEN is not shaped like a Slack token` | 把 app-level token（`xapp-`）填进了 bot token，或反之 |
| 启动报 `Slack conversations.open was refused (INVALID_AUTH)` / `auth.test` 失败 | bot token 写错、应用未安装到该 workspace，或 scope 缺失 |
| 启动报 `Slack apps.connections.open was refused (MISSING_SCOPE)` | app-level token 没有 `connections:write` |
| 启动报 `Data directory belongs to another slack bot or owner` | 同一个 `DATA_DIR` 换成了另一个 Slack bot／owner；换目录或改回原值 |
| bot 收到消息但不回复 | `SLACK_OWNER_ID` 不是发消息那个成员；或消息不是与 bot 的单聊；看日志里的原因码（下面两条） |
| 频道里 @ 了 bot 但没反应，日志是 `CHANNEL_NOT_ALLOWED` | 频道 ID 不在 `SLACK_ALLOWED_CHANNELS`，或 bot 没被邀请进这个频道 |
| 日志是 `SENDER_NOT_ALLOWED` / `NOT_A_MENTION` | 发送者的 member ID 不在 `SLACK_ALLOWED_USERS`；或这是线程外的普通消息——起会话必须 @ bot |
| 在频道里某个线程下追问，只回「该问题循环过多，请不要再回复。」 | 该线程已经用满 5 个回合，子会话已关闭；开一个新话题（新的 @ 提问）会重新开始 |
| 成员问 bot「帮我跑个命令」时 bot 说没有 bash | 设计如此：成员 Hub 不给 `bash`／`powershell`（所有者不受影响） |
| 同一个成员换了 `DATA_DIR` 后历史没了 | 历史与记忆都按 `DATA_DIR` 保存：换目录等于换一套数据 |
| 日志出现 `Hub opened for member U…: conversation N` | 首次为该成员建 Hub，正常；同一成员只会出现一次（重启后不再出现） |
| 日志持续出现 `Slack socket retry in Ns` | 出站到 `slack.com` 不可达（代理、DNS 或出口网络） |
| 日志出现 `Slack asked for a reconnect` | Slack 正在回收连接，正常重连；短时间反复出现才需要看网络 |

## 验收

1. `node dist/src/check-config.js` 打印 `Configuration OK: CHANNEL=slack …`。
2. 启动日志出现 `Personal agent starting; the owner's DM and N allowed member(s) in M allowed channel(s) enabled.`，之后没有持续的 socket 重连。
3. 与 bot 单聊发一条普通请求，确认回复分段回到同一个单聊；`npm run deliveries -- list` 没有 `failed`／`uncertain` 行。
4. 在频道里 @ bot 提问，确认回复出现在频道里；日志出现一次 `Hub opened for member …`，`DATA_DIR/hubs.sqlite` 里出现该成员的 `hubs` 行，`DATA_DIR/workspace/members/<memberId>` 被创建。
5. **在该回复下**（线程里）追问，确认：回答接着上文；`threads` 里出现这条线程的 `forkId`（与该成员的 Hub 会话不同）；追问到第 5 轮时最后一句是「该问题循环过多，请不要再回复。」；再回复时立刻得到同一句文案，日志里没有新的模型调用。
6. 让另一名白名单成员在同一个频道里问一件私事，然后问 bot「我之前说过什么」：确认只答他自己的内容，看不到第 4 步那位成员或所有者的历史；成员让 bot 执行 shell 命令被拒绝，所有者单聊里同样的请求可以执行。
7. 第 5 轮结束后，在**同一个频道**里重新 @ bot 问一句「接着刚才那个话题」，确认 Hub 答得出上一个线程谈了什么（摘要已写回 Hub）；此时 `memory/members/<memberId>/` 下才可能开始出现归档文件（线程本身不产出 daily 记录）。
8. 不在白名单的成员 @ bot，或在未列入 `SLACK_ALLOWED_CHANNELS` 的频道里 @ bot：确认没有任何回复，日志里各有一行原因码。
9. 建一条 1 分钟后的提醒（`reminder_create` 或直接用模型对话），确认到点在所有者单聊收到 `提醒：…`。
10. 重启容器：未完成的请求按原契约恢复，已确认的投递不重复发送；已在进行的线程仍把回复发回原线程（`inbox.threadTs` 生效）。
11. 把 `CHANNEL` 改回 `telegram` 重启，确认对话历史仍在、也可继续用 Telegram 说话（同一 `DATA_DIR` 下两个渠道各自记录自己的 bot 身份）。
12. 表情回执：给 bot 发一条会跑上一会儿的请求，确认你的那条消息先出现 👀、回复送达后变成 ✅。把 `SLACK_ACK_EMOJI=` 写进 `.env` 重启，确认不再自动贴表情、模型工具仍然可用。回执分级另测一次：故意让它超时（或断网让投递失败），确认得到的是 ⚠️ / ❌ 而不是 ✅。
13. 表情失败不挡回复：在没给 `reactions:write` 的情况下（或临时把 token 的 scope 收回）发一条消息，确认回复照常到达、日志里只有 `Slack reaction failed: SLACK_MISSING_SCOPE`。
14. 自定义表情：问「你能用哪些表情」或直接让它用你的表情包，确认它先调 `emoji_search`（日志 `tool.execution` 的名字里能看到）再 `react_to_message`；没给 `emoji:read` 时确认它明确回报 `SLACK_MISSING_SCOPE`、而标准表情仍然贴得出来。
15. 上限：让它对同一条消息连贴表情，确认第 4 个被拒绝（`REACTION_LIMIT_REACHED`），且下一条消息又能贴。

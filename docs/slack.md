# Slack 通道

部署可以把渠道从 Telegram 换成 Slack：`CHANNEL=slack` 时，应用用 **Socket Mode** 接收与回复 bot 的单聊（DM）。取舍与代价见 [ADR-0025](adr/slack-channel/0025-slack-channel.md)。

同一进程只服务一个渠道。渠道层（`src/channel.ts`）把投递、失败分类与分段规则与具体平台分开，Telegram 与 Slack 两个适配层都实现同一份 `DeliveryChannel` 契约；切换渠道不换会话，历史、记忆与提醒都留在同一个 `DATA_DIR` 里。

## 生效方式

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `CHANNEL` | 否 | `telegram`（默认）或 `slack`；其他值启动失败。值会去掉首尾空白并转小写 |
| `SLACK_BOT_TOKEN` | `CHANNEL=slack` 时 | 应用的 bot token，`xoxb-` 开头 |
| `SLACK_APP_TOKEN` | `CHANNEL=slack` 时 | 应用级 token，`xapp-` 开头，需要 `connections:write` |
| `SLACK_OWNER_ID` | `CHANNEL=slack` 时 | 所有者的 Slack member ID（`U…`），同时是提醒的收件目标 |

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
  "oauth_config": { "scopes": { "bot": ["chat:write", "im:history", "im:write"] } },
  "settings": {
    "event_subscriptions": { "bot_events": ["message.im"] },
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
3. **OAuth & Permissions → Bot Token Scopes** 至少给三个：`chat:write`（发消息）、`im:history`（读单聊消息）、`im:write`（打开/复用与所有者的单聊）。
4. **Event Subscriptions → Subscribe to bot events** 订阅 `message.im`。
5. **App Home → Show Tabs → Messages Tab** 勾上 "Allow users to send Slash commands and messages from the messages tab"；不勾的话单聊输入框是只读的，你发不出消息。
6. **Install App** 后取 Bot User OAuth Token → 填 `SLACK_BOT_TOKEN`。
7. 在 Slack 里打开自己 profile 的 **Copy member ID**（`U…`）→ 填 `SLACK_OWNER_ID`。填错不会报错，但 bot 会安静地忽略所有消息，所以启动时会用这个 ID 打开一次单聊来验证。

改动 scope 或事件订阅之后需要重新 **Install to Workspace**（Slack 会提示 Reinstall），否则新权限不生效。workspace 若开了 app approval，安装按钮会变成"请求管理员批准"，这一步只能由管理员放行。

## 行为

- **只处理所有者的单聊**。频道消息、群聊、别的 bot、消息编辑/删除（都带 `subtype` 或 `bot_id`）一律忽略；与 Telegram 端一样，非所有者发来的内容永远不会进入会话。
- **先落盘再确认**。收到 `events_api` 信封后，先把请求写进 `inbox.sqlite`，再回 `envelope_id` 确认。Slack 会对未确认的信封重投，请求 id 是 `slack:<team>:<event_id>`，重复投递只会命中同一条记录，不会重复执行。落盘失败按致命处理（进程退出，信封保持未确认），避免确认一条没存下来的消息。
- **回复按 4000 字符分段**，与 Telegram 共用同一套分段与投递记录（`deliveries` 表、`npm run deliveries -- list` 对账）。Slack 的 `text` 走 mrkdwn 渲染，所以回复里的 `&`、`<`、`>` 会被转义，其余字符保持原样。
- **失败分类**：Slack 的应用错误是 HTTP 200 + `error` 字段；`channel_not_found`、`not_in_channel`、`msg_too_long`、`invalid_auth` 等明确拒绝判为 `failed`（未送出），其余（网络、超时、429）判为 `uncertain`，两类都不会自动重发。
- **提醒**走同一渠道：到点直接向 `SLACK_OWNER_ID` 的单聊发送，不经过模型。
- **断线重连**：Socket Mode 连接由 Slack 主动回收（`disconnect` 帧），应用会取一个新的单次 URL 重连，退避上限 30 秒；读取缓冲区溢出时同样断开重连，未确认的信封会被 Slack 重投。

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
| bot 收到消息但不回复 | `SLACK_OWNER_ID` 不是发消息那个成员；或消息不是与 bot 的单聊 |
| 日志持续出现 `Slack socket retry in Ns` | 出站到 `slack.com` 不可达（代理、DNS 或出口网络） |
| 日志出现 `Slack asked for a reconnect` | Slack 正在回收连接，正常重连；短时间反复出现才需要看网络 |

## 验收

1. `node dist/src/check-config.js` 打印 `Configuration OK: CHANNEL=slack …`。
2. 启动日志出现 `Personal agent starting; single-owner private Slack messages enabled.`，之后没有持续的 socket 重连。
3. 与 bot 单聊发一条普通请求，确认回复分段回到同一个单聊；`npm run deliveries -- list` 没有 `failed`／`uncertain` 行。
4. 让另一名成员给 bot 发消息，确认没有任何回复，也没有新增会话记录。
5. 建一条 1 分钟后的提醒（`reminder_create` 或直接用模型对话），确认到点在同一个单聊收到 `提醒：…`。
6. 重启容器：未完成的请求按原契约恢复，已确认的投递不重复发送。
7. 把 `CHANNEL` 改回 `telegram` 重启，确认对话历史仍在、也可继续用 Telegram 说话（同一 `DATA_DIR` 下两个渠道各自记录自己的 bot 身份）。

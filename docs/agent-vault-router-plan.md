# Agent Vault 多 vault 出口路由层（规划）

状态：阶段 1（CONNECT 路由核心）已实现，包含 Go 模块、配置校验、CONNECT 路由、双层认证、错误透传、半关闭、空闲超时、连接上限、结构化日志、`SIGHUP` 重载、systemd 单元和示例配置。假上游测试通过；真实 Agent Vault 的 Telegram/DeepSeek 验收仍需在目标服务器执行。阶段 2 的明文 HTTP、指标和错误日志限速尚未实现。

## 1. 要解决的问题

Agent Vault 的代理身份在每次请求中只能选择一个 vault：

```text
Proxy-Authorization: Basic base64(<agent-token>:<vault>)
```

服务规则（host/path → 凭据）只在同一个 vault 内生效，0.40.0 不提供跨 vault 的 host 路由，也不会递归聚合 Infisical 子目录。应用当前只有一个全局 `HTTP_PROXY`/`HTTPS_PROXY`，因此直接接 Agent Vault 时只能使用一个 vault。

本层在应用和 Agent Vault 之间增加一个本地出口路由器：

```text
应用
  HTTP_PROXY/HTTPS_PROXY = http://app:<router-password>@127.0.0.1:14323
        │
        │ CONNECT api.deepseek.com:443
        ▼
agent-egress-router :14323
  host:port → vault + agent token
        │
        │ CONNECT api.deepseek.com:443
        │ Proxy-Authorization: Basic base64(<agent-token>:deepseek)
        ▼
Agent Vault :14322
  vault deepseek → service deepseek
        ▼
目标 API（Agent Vault 注入真实凭据）
```

结果：

- Infisical 继续按基础设施分文件夹，每个文件夹一个 vault。
- 应用仍然只配一个 proxy URL。
- 应用不再持有 Agent Vault 的 agent token；路由器按 host 选择 vault。
- 不需要合并文件夹，也不需要复制 key。

## 2. 目标与非目标

### 目标

- 精确 `host:port` → `vault` 的静态路由表，默认拒绝。
- 代理 HTTP/1.1 `CONNECT`（HTTPS、WebSocket over TLS）。
- 透传 Agent Vault 的 `407`、`403`、`404`、`400` 和 `5xx`。
- 正确的超时、半关闭、双向流式转发和连接上限。
- 结构化访问日志；日志字段可审计，但不包含凭据、请求头、查询串或正文。
- systemd 守护，进程只允许 loopback 出网，不能直连外部。
- 配置和 token 文件可通过 `SIGHUP` 原子重载。
- 单静态二进制，Go 标准库，无第三方依赖。

### 非目标

- 不做 TLS 中间人，不生成或管理 CA。
- 不读取、缓存或轮换真实 API key；真实凭据仍由 Agent Vault/Infisical 管理。
- 不替代 Agent Vault 的 service rule；路由器只选 vault。
- 不支持 SOCKS、UDP、原生 TCP、SSH、数据库协议。
- 不支持 HTTP/2 代理协议；HTTP/2 可以作为 CONNECT 隧道内的流量。
- 不对 HTTPS 正文或路径做脱敏；路由器看不到它们。
- 不做通用开放代理；不是给其他主机共享的出网点。

## 3. 协议行为

### 3.1 CONNECT

1. 读取并限制请求头大小。
2. 校验客户端 `Proxy-Authorization`。
3. 解析 `host:port`，拒绝 IP 字面量、通配符、非 ASCII host 和未授权端口。
4. 精确匹配路由表；未匹配返回 `403`。
5. 以 `dial_timeout` 连接 Agent Vault。
6. 发送：

```http
CONNECT api.deepseek.com:443 HTTP/1.1
Host: api.deepseek.com:443
Proxy-Authorization: Basic base64(<agent-token>:<vault>)
```

7. 读取上游响应头，限制大小和等待时间。
8. `200`：向客户端返回 `HTTP/1.1 200 Connection Established`，清空读写 deadline，进入双向隧道。
9. 非 `200`：把状态行、必要响应头和最多 4 KiB 响应体透传给客户端，然后关闭。
10. 隧道结束后记录一条访问日志。

### 3.2 HTTP absolute-form（第二阶段）

只接受代理形式的明文 HTTP：

```http
GET http://api.example.com/path HTTP/1.1
```

- 拒绝 origin-form（没有 scheme）。
- 拒绝 `https` absolute-form；HTTPS 必须使用 CONNECT。
- 删除客户端的 `Proxy-Authorization`、`Proxy-Connection` 和 hop-by-hop headers。
- 用路由对应的 agent token 重新生成 `Proxy-Authorization`。
- 流式转发请求体和响应体，不整包缓冲。
- 默认不记录 path/query；如确需记录，必须经过脱敏。

### 3.3 拒绝的请求

- `CONNECT` 携带 `Content-Length` 或 `Transfer-Encoding`。
- 目标为 IP 字面量、`localhost`、链路本地或云 metadata 地址。
- 目标端口不在 `allowed_ports`。
- 主机名包含 `*`、空格、控制字符、`@`、`/`、`?`、`#`。
- 未配置的 host，或重复配置的 `(host, port)`。
- 非 `CONNECT` 且非 absolute-form 的请求。
- HTTP/2 代理前言、SOCKS 请求、PROXY protocol。

## 4. 错误语义

| 场景 | 返回 |
| --- | --- |
| 缺少/错误的 router 客户端凭据 | `407`，`Proxy-Authenticate: Basic realm="agent-egress-router"` |
| 路由不存在 | `403`，固定短正文，不暴露其他路由 |
| 请求格式错误 | `400` |
| 上游连接失败 | `502` |
| 拨号/上游响应头超时 | `504` |
| 并发上限或正在关闭 | `503`，可带 `Retry-After` |
| Agent Vault 返回 `407`/`403`/`404`/`400`/`5xx` | 原状态、必要响应头、最多 4 KiB 正文透传 |
| 隧道正常结束 | 不额外写响应；记录 `200` 和字节数 |
| 隧道异常断开 | 关闭两端，记录固定错误类别 |

上游 `407` 表示 agent token 或 vault 选择有误；router 自己的 `407` 表示应用没有通过本地客户端认证。两者通过 `Proxy-Authenticate` 的 realm 和日志字段区分。

## 5. 安全边界

### 5.1 进程和网络

- 只监听 `127.0.0.1:14323`（可配置为 `::1`），拒绝 `0.0.0.0` 和公网地址。
- 上游只允许 loopback 的 Agent Vault 代理端口 `127.0.0.1:14322`。
- systemd 使用 `IPAddressDeny=any`、`IPAddressAllow=127.0.0.1 ::1`，进程没有 DNS 和直连能力。
- 路由器不解析目标域名；域名解析仍由 Agent Vault 完成。
- 不共享 Docker socket，不挂载应用数据目录，不读取 `/var/lib/personal-agent`。

### 5.2 认证

- 应用 → 路由器：`Basic app:<router-password>`，密码从文件读取，常量时间比较。
- 路由器 → Agent Vault：`Basic <agent-token>:<vault>`，token 从按路由配置的文件读取。
- 每个 vault 推荐独立 agent token，只授予该 vault 的 `proxy` 角色；不使用 member/admin。
- 应用只持有 router 密码，不持有 Agent Vault agent token。
- 路由器持有所有路由的 agent token，因此它是高价值进程；systemd 加固和最小二进制是必要边界。

### 5.3 文件权限

建议布局：

```text
/etc/personal-agent/
├── egress-router.json                 root:agent-router 0640
├── egress-router/
│   ├── client-password                root:agent-router 0640
│   ├── client-password.next           root:agent-router 0640（轮换用）
│   ├── agent-token-telegram           root:agent-router 0640
│   ├── agent-token-deepseek           root:agent-router 0640
│   └── agent-token-tools              root:agent-router 0640
└── ...
```

应用侧的 router 密码放在 `/etc/personal-agent.env`（root:root `0600`），由 systemd 在降权前读取。

### 5.4 威胁模型

| 被攻破的对象 | 影响 |
| --- | --- |
| 应用进程 | 只能使用路由表中允许的 host；不能读真实 key，不能访问未授权 host |
| 路由器进程 | 能使用所有路由的 agent token 代理请求；不能直接读 Infisical 或真实 key |
| 应用和路由器同 uid | 上述边界消失；必须使用不同服务用户 |
| 主机 root | 全部失守；本层不提供跨主机隔离 |

## 6. 日志与脱敏

### 6.1 能做什么、不能做什么

路由器对 HTTPS 只看到 `CONNECT host:port`，看不到 path、header、body。因此：

- 能保证自己的访问日志不包含凭据、请求头、查询串、正文。
- 能记录路由决策：host、vault、上游状态、耗时、字节数。
- 不能脱敏 HTTPS 正文或应用日志。
- 不能在隧道内识别“使用了哪个 credential key”；只能记录 vault，除非读取 Agent Vault 的审计日志。
- 如需集中脱敏应用日志，应单独做日志管道；本二进制可提供 `redact` 子命令作为过滤器，但不会自动接入 journald。

### 6.2 访问日志字段

JSON Lines，输出到 stderr，由 journald 收集：

```json
{
  "ts": "2026-10-23T12:00:00.000Z",
  "level": "info",
  "event": "proxy",
  "conn_id": "7f3c2a1b9d4e",
  "kind": "connect",
  "route": "deepseek",
  "vault": "deepseek",
  "target_host": "api.deepseek.com",
  "target_port": 443,
  "status": 200,
  "duration_ms": 842,
  "bytes_in": 1200,
  "bytes_out": 8400,
  "error_class": ""
}
```

允许记录的字段：

- `ts`、`level`、`event`、`conn_id`
- `kind`（`connect` / `http`）
- `route`、`vault`
- `target_host`、`target_port`
- `method`（仅 absolute-form HTTP）
- `status`
- `duration_ms`
- `bytes_in`、`bytes_out`
- `error_class`
- `client_addr`（可选，仅 loopback）

默认禁止：

- `Proxy-Authorization`、`Authorization`、`Cookie`、`Set-Cookie`、`X-Api-Key`
- 查询串、完整 URL、path
- 请求/响应正文
- token、密码、URL userinfo
- 原始 `err.Error()`（除非先经过脱敏）

### 6.3 错误类别

固定枚举，便于告警和统计：

```text
client_auth_missing
client_auth_invalid
route_not_found
target_invalid
target_port_denied
upstream_dial_failed
upstream_dial_timeout
upstream_header_timeout
upstream_status
tunnel_client_closed
tunnel_upstream_closed
tunnel_error
shutdown
overloaded
config_reload_failed
```

### 6.4 脱敏函数

提供 `internal/redact`，至少覆盖：

- `Proxy-Authorization` / `Authorization` / `x-api-key` / `cookie` 的值
- `Bearer ...` / `Basic ...`
- `sk-...` API key 形态
- `av_agt_...` Agent Vault token 形态
- Telegram bot token 形态 `123456789:AA...`
- URL userinfo `https://user:pass@host`
- 常见 query 参数 `token|key|secret|password|signature|access_token`
- JWT 形态

所有非固定字段在写入日志前都经过 `redact.String`。`agent-egress-router redact` 子命令复用同一实现，可从 stdin 读取并输出脱敏文本。

## 7. 配置

使用 JSON，避免为一个安全组件引入 YAML 解析依赖。配置只放文件路径，不直接放 token。

```json
{
  "listen": "127.0.0.1:14323",
  "upstream_proxy": "127.0.0.1:14322",
  "client_auth": {
    "username": "app",
    "password_files": [
      "/etc/personal-agent/egress-router/client-password"
    ]
  },
  "routes": [
    {
      "name": "telegram",
      "host": "api.telegram.org",
      "port": 443,
      "vault": "telegram",
      "agent_token_file": "/etc/personal-agent/egress-router/agent-token-telegram"
    },
    {
      "name": "deepseek",
      "host": "api.deepseek.com",
      "port": 443,
      "vault": "deepseek",
      "agent_token_file": "/etc/personal-agent/egress-router/agent-token-deepseek"
    },
    {
      "name": "github",
      "host": "api.github.com",
      "port": 443,
      "vault": "tools",
      "agent_token_file": "/etc/personal-agent/egress-router/agent-token-tools"
    }
  ],
  "allowed_ports": [443],
  "timeouts": {
    "client_header": "10s",
    "dial": "5s",
    "upstream_header": "15s",
    "idle": "10m",
    "shutdown": "15s"
  },
  "limits": {
    "max_connections": 256,
    "max_connections_per_route": 64,
    "max_header_bytes": 16384,
    "max_error_body_bytes": 4096
  },
  "log": {
    "level": "info",
    "format": "json",
    "access": true
  },
  "health_listen": "127.0.0.1:14324"
}
```

校验规则：

- `listen`、`upstream_proxy`、`health_listen` 必须是 loopback。
- 路由 host 必须是小写 DNS 名，不能是 IP、通配符、空串或带端口。
- `(host, port)` 唯一；`port` 必须在 `allowed_ports` 中。
- `vault` 使用 Agent Vault 接受的 vault 名。
- token 文件和密码文件必须是绝对路径、可读、非空；权限不得对 other 可读。
- 所有 timeout 为正；`idle` 必须大于 `dial`。
- 未知 JSON 字段拒绝，避免拼写错误被静默忽略。
- `check` 子命令只做离线校验，打印路由数量，不打印任何 token。

## 8. 代码结构

```text
router/
├── go.mod
├── cmd/agent-egress-router/
│   └── main.go
├── internal/
│   ├── config/
│   │   ├── config.go
│   │   └── config_test.go
│   ├── proxy/
│   │   ├── server.go
│   │   ├── connect.go
│   │   ├── upstream.go
│   │   ├── tunnel.go
│   │   └── server_test.go
│   ├── redact/
│   │   ├── redact.go
│   │   └── redact_test.go
│   └── version/
│       └── version.go
└── README.md
```

模块路径：

```text
github.com/NaoYUN77/personal-agent-base-durable/router
```

Go 版本：`1.25.6`，`CGO_ENABLED=0`，标准库优先。`go.sum` 只在确实引入依赖时存在；目标是不引入第三方依赖。

主要实现选择：

- `net/http.Server` 负责请求解析、header 上限和 keep-alive。
- `CONNECT` 使用 `http.Hijacker` 接管连接，处理 hijack 后缓冲区中的提前数据。
- 隧道使用 `io.CopyBuffer` + `CloseWrite` 实现半关闭；共享活动计时器实现空闲超时。
- 路由表用 `atomic.Pointer` 支持 `SIGHUP` 原子替换。
- 日志用 `log/slog`，输出 JSON。
- 健康检查用独立的 loopback `http.Server`，不与代理监听混用。

## 9. systemd

单元文件草案：

```ini
[Unit]
Description=Agent egress router for Agent Vault
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=agent-router
Group=agent-router
ExecStart=/usr/local/bin/agent-egress-router serve -config /etc/personal-agent/egress-router.json
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=2
TimeoutStopSec=20
UMask=0077
Environment=GOMAXPROCS=2

NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
ProtectProc=invisible
ProcSubset=pid
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM

IPAddressDeny=any
IPAddressAllow=127.0.0.1 ::1

LimitNOFILE=8192
MemoryMax=128M
TasksMax=64

[Install]
WantedBy=multi-user.target
```

`IPAddressDeny` 让路由器只能访问 loopback；它不需要 DNS，也不需要直连上游。若 Agent Vault 不在本机，必须显式调整该限制并重新验收，默认不支持远程 broker。

`MemoryDenyWriteExecute` 暂不启用，先验证 Go 运行时和 `SystemCallFilter` 组合；如果确认无影响再加。

应用单元增加：

```ini
[Unit]
After=agent-egress-router.service
Wants=agent-egress-router.service
```

不使用 `Requires`，避免路由器重启时把应用一起停掉；代理不可达时应用请求失败，不会直连。

## 10. 部署与迁移

### 10.1 Agent Vault 侧

每个 Infisical 文件夹一个 vault，例如：

| vault | Infisical path | 服务规则 |
| --- | --- | --- |
| `telegram` | `/personal-agent/telegram` | `api.telegram.org:443/bot__vault_TELEGRAM_BOT_TOKEN__/*` |
| `deepseek` | `/personal-agent/deepseek` | `api.deepseek.com:443/*` |
| `tools` | `/personal-agent/tools` | `api.github.com:443/*` 等 |

每个 vault 设置 `unmatched_host_policy=deny`。为每个 vault 创建只读 `proxy` 角色的 agent token，或创建一个拥有多个 vault `proxy` 权限的 token；推荐前者。

### 10.2 应用侧

只改 proxy：

```env
AGENT_VAULT_ENABLED=1
HTTP_PROXY=http://app:<URL编码的router密码>@127.0.0.1:14323
HTTPS_PROXY=http://app:<URL编码的router密码>@127.0.0.1:14323
NO_PROXY=localhost,127.0.0.1,::1
NODE_USE_ENV_PROXY=1
NODE_EXTRA_CA_CERTS=/etc/personal-agent/ca.pem
```

不再把 Agent Vault 的 `av_agt_...` token 放进应用环境。`TELEGRAM_BOT_TOKEN`、provider key 仍使用占位值；CA 不变。

应用代码不需要改：现有校验只要求 `HTTP_PROXY`/`HTTPS_PROXY` 相同、是 HTTP(S) origin、无 path/query，并接受 `user:password@host` 形式。

### 10.3 启动顺序

```text
1. Agent Vault 容器（broker）健康
2. agent-egress-router
3. personal-agent
```

路由器启动时只校验配置和文件，不强制要求 broker 已就绪；broker 未就绪时请求返回 `502/504`，不会直连。

### 10.4 回滚

- 停用路由器，把应用的 proxy URL 改回原 Agent Vault 单 vault 地址，重启应用。
- 不需要迁移数据。
- 如果暂时只想用一个 vault，可以保留路由器但不配置其他路由；默认拒绝仍然生效。

## 11. 测试与验收

### 11.1 Go 单元/集成测试

使用假上游代理，不需要真实 Agent Vault：

- 路由匹配：大小写、端口、未知 host、IP 字面量、重复路由。
- 客户端认证：缺失、错误、正确；407 realm。
- 上游认证：`base64(token:vault)` 正确，token 不出现在日志。
- CONNECT 透传：假上游返回 200 后双向回显；大流不整包缓冲。
- 半关闭：客户端 `CloseWrite` 后仍能收到上游响应；反之亦然。
- 超时：上游不响应时返回 504；空闲连接被关闭；活动流不被误杀。
- 错误透传：上游 407/403/404/500 的状态和正文（截断）到达客户端。
- hijack 缓冲：客户端在 CONNECT 后立即发送 TLS/应用字节，不丢失。
- 并发上限：超过 `max_connections` 返回 503。
- SIGHUP：有效配置热替换；无效配置保留旧表；token 文件缺失时拒绝重载。
- 关闭：SIGTERM 停止 accept，活动连接在 `shutdown` 内排空后关闭。
- 日志：捕获输出，断言不含 token、密码、Authorization、query、path。
- 脱敏：所有模式的正反例。
- fuzz：CONNECT 请求行、authority、header、脱敏输入。

### 11.2 真实 Agent Vault 验收

先绕过路由器逐个 vault 验证，再通过路由器验证：

```sh
# 1. 直接验证某个 vault
curl --proxy "http://<agent-token>:deepseek@127.0.0.1:14322" \
  --cacert /etc/personal-agent/ca.pem \
  https://api.deepseek.com/...

# 2. 通过路由器验证
curl --proxy "http://app:<router-password>@127.0.0.1:14323" \
  --cacert /etc/personal-agent/ca.pem \
  -H "Authorization: Bearer fake-key" \
  https://api.deepseek.com/...

# 3. Telegram 路径替换
curl --proxy "http://app:<router-password>@127.0.0.1:14323" \
  --cacert /etc/personal-agent/ca.pem \
  "https://api.telegram.org/bot__vault_TELEGRAM_BOT_TOKEN__/getMe"

# 4. 未授权 host
curl --proxy "http://app:<router-password>@127.0.0.1:14323" \
  --cacert /etc/personal-agent/ca.pem \
  https://example.com/   # 预期 403
```

验收矩阵：

| 用例 | 预期 |
| --- | --- |
| Telegram `getMe` | 200，返回 bot 信息 |
| DeepSeek 假 key | 200，证明 Vault 替换了认证 |
| GitHub 工具 token | 200，日志显示 `vault=tools` |
| 未配置 host | 403，日志 `route_not_found` |
| 错误 router 密码 | 407，realm 为 `agent-egress-router` |
| 错误 agent token | 上游 407 透传 |
| vault 名不匹配 | 上游 403 透传 |
| CONNECT 22 端口 | 403，`target_port_denied` |
| 超大 header | 400/431，连接关闭 |
| 上游超时 | 504 |
| 半关闭 | 响应完整，无挂起 |
| `systemctl stop` | 活动连接按 `shutdown` 排空 |
| 日志扫描 | 无真实 token、密码、Authorization |

### 11.3 上线前安全动作

- 轮换任何曾在聊天、终端或日志中出现过的真实 API key 和 Agent Vault agent token。
- 确认 `vault.env`、token 文件、`/etc/personal-agent.env` 权限正确。
- 确认路由器监听端口只绑定 loopback，公网安全组不开放 14321/14322/14323/14324。
- 确认应用以独立 uid 运行，路由器以独立 uid 运行。

## 12. 分阶段实施

### 阶段 0：设计确认

- 本文评审。
- 确认 JSON 配置、每 vault 独立 agent token、客户端密码文件方案。
- 确认第一阶段只做 CONNECT，明文 HTTP 放到第二阶段。

### 阶段 1：CONNECT 路由核心

- Go module、配置加载、`check`、`version`。
- CONNECT 路由、客户端认证、上游认证、错误透传。
- 半关闭、空闲超时、连接上限。
- 结构化日志和 `redact`。
- systemd 单元、示例配置。
- 假上游测试 + 真实 Agent Vault 的 Telegram/DeepSeek 验收。

完成标准：Telegram 和 DeepSeek 通过路由器工作；未知 host 被拒绝；407/403 透传；半关闭和超时测试通过；日志无秘密。

### 阶段 2：运维能力

- absolute-form 明文 HTTP。
- SIGHUP 热重载（若阶段 1 未做）。
- `/healthz`、`/readyz`、`/metrics`。
- 按路由并发限制、错误日志限速。
- 客户端密码双文件轮换。

完成标准：配置和 token 轮换不需要重启；健康/指标可观测；明文 HTTP 可选启用。

### 阶段 3：交付

- `deploy/install-egress-router.sh`：构建/安装静态二进制、创建用户、安装 unit、`-check`。
- `docs/agent-vault-router.md`：完整部署、配置、验收、回滚。
- 更新 `docs/agent-vault-systemd.md`、`docs/agent-vault.md`、`deploy/README-systemd.md`、`README.md`。
- 更新 `CLAUDE.md` 技术基线表，加入 Go 1.25.6 和该组件的职责/边界。
- PR 包含测试结果、真实 Agent Vault 验收记录和日志脱敏样例。

## 13. 资源评估

### 13.1 先区分三件事

| 对象 | 是什么 | 是否常驻 | 资源影响 |
| --- | --- | --- | --- |
| Agent Vault agent | 代理身份/token，只授予某个 vault 的 `proxy` 角色 | 否 | 一条数据库记录；每请求一次认证查找，资源可忽略 |
| Agent Vault broker | 一个进程/容器，承载所有 vault、同步、MITM 和代理 | 是 | 主要内存/CPU 来源 |
| egress router | 一个 Go 进程，承载所有 host 路由 | 是 | 与并发隧道数相关，与 vault 数基本无关 |

每个 vault 配一个 agent token 是合理的，但它不会增加一个 worker 进程。真正需要评估的是：

```text
1 个 Agent Vault broker + N 个 vault
1 个 egress router + M 条 host 路由
```

不要把“每个 vault 一个 agent”理解成“每个 vault 一个 broker”。一个 broker 可以承载多个 vault；只有需要独立故障域或独立信任边界时，才考虑多个 broker。多个 broker 会各自拥有 master password、数据卷、CA、管理端口和代理端口，资源和运维成本近似线性增加。

### 13.2 资源模型

Agent Vault broker：

```text
RSS ≈ Go 运行时和 Web/管理面基线
    + vault 数量 × 同步状态
    + 缓存 secret 总大小（通常很小）
    + 并发 MITM 连接 × TLS/HTTP 缓冲
```

- 同步是每个 vault 一个周期任务，不是每个 agent 一个；60 秒周期、3 个 vault 约 3 次 Infisical 请求/分钟。
- secret 数量增加主要影响缓存和同步时间，不按连接复制。
- 每个 HTTPS 请求有一次 TLS 握手和 MITM 开销；流式模型响应主要是 I/O，不是持续 CPU。
- Telegram 长轮询通常只有少量长连接。

egress router：

```text
RSS ≈ Go 运行时基线
    + 活动隧道 × (2 个 goroutine 栈 + 2 个 32 KiB copy buffer + bufio)
```

- 路由器不做 TLS，不解析正文，CPU 主要是字节复制和 syscall。
- 每条活动隧道约 64–100 KiB 缓冲；64 条约 4–6 MiB，256 条约 16–25 MiB。
- 非活动时几乎没有 CPU；日志是每连接一行，不是每块数据一行。

### 13.3 量级估算

以下是容量规划用的量级，不是实测承诺。目标环境为 4 核 / 4 GB，3 个 vault、几十个 secret、单用户、低并发（Telegram + 模型流式调用）：

| 组件 | 数量 | 低载 RSS | 64 条活动隧道 RSS | CPU | 备注 |
| --- | --- | --- | --- | --- | --- |
| Agent Vault broker | 1 | 约 100–200 MiB | 约 150–300 MiB | 平均 < 2%，握手/同步时短时上升 | 现有 `mem_limit: 512m` 足够，需实测 |
| egress router | 1 | 约 15–30 MiB | 约 30–60 MiB | 通常 < 1% | 建议 `MemoryMax=128M` |
| agent token | 3 | 0 | 0 | 0 | 仅配置和轮换开销 |
| 应用 | 1 | 100–300 MiB | — | 取决于模型和工具 | 现有 1G 上限不变 |

总量级：新增常驻内存约 150–300 MiB；4 GB 机器仍有充足余量。真正的风险不是稳态内存，而是：

- Agent Vault 的 TLS 握手或同步突发导致 CPU 短时升高；
- 大量并发长连接导致路由器和 broker 的缓冲增长；
- `pids_limit` / `TasksMax` 过紧导致无法创建线程；
- 日志或审计写入放大。

### 13.4 实测方法

不要只凭估算上线。至少测以下场景：

```sh
# broker 当前 CPU / 内存 / PIDs
docker stats --no-stream --format \
  'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}' \
  personal-agent-src-agent-vault-1

# router 当前内存 / CPU / 线程
systemctl show -p MemoryCurrent -p CPUUsageNSec agent-egress-router
ps -o pid,rss,vsz,pcpu,pmem,nlwp,cmd -C agent-egress-router

# 当前隧道数
ss -tnp 'sport = :14323'

# 容器 OOM / 退出记录
docker events --filter container=personal-agent-src-agent-vault-1 \
  --filter event=oom --filter event=die
journalctl -k | grep -i -E 'oom|killed process'
```

测量场景：

1. **空载 24 小时**：只保留 Telegram 轮询，观察 broker 和 router 的 RSS 是否持续增长。
2. **同步突发**：手动触发或等待 3 个 vault 同时同步，记录 broker CPU 峰值。
3. **并发握手**：用本地测试 vault/测试主机发起 10、50、100 个并发 HTTPS CONNECT，记录 broker RSS、CPU、PIDs。
4. **长流**：发起一次长时间的模型流式响应，观察 router 和 broker 的内存是否随流长度增长；正常应保持平稳。
5. **连接抖动**：反复建立/关闭 CONNECT，观察 goroutine、FD 和 RSS 是否回落。
6. **故障注入**：停掉 broker、改错 token、触发 407/403，确认 router 不堆积连接、不泄漏 token、不 OOM。

建议记录：

```text
timestamp, component, rss_mib, cpu_pct, pids, active_conns, sync_errors, oom
```

### 13.5 初始资源限制

| 组件 | 建议 | 说明 |
| --- | --- | --- |
| Agent Vault broker | `mem_limit: 512m`，`pids_limit: 64` | 先保留现有值；若 `PIDs` 持续接近 64，升到 128 |
| egress router | `MemoryMax=128M`，`TasksMax=64`，`LimitNOFILE=8192` | 预期 30–60 MiB；Go 网络 I/O 不会按连接创建大量线程 |
| 应用 | 现有 `MemoryMax=1G` | 不变 |
| 主机 | 保留至少 512 MiB 空闲内存 | 给内核、Docker、QQ bot 和突发握手留余量 |

如果实测 broker 长时间超过 400 MiB，或 CPU 持续超过单核 50%，再考虑：

- 降低同步频率（例如从 60 秒调到 120 秒）；
- 减少单个 vault 的 secret 数量；
- 限制并发模型请求；
- 最后才考虑拆多个 broker，而不是默认按 vault 拆。

## 14. 默认决策


| 决策 | 默认 |
| --- | --- |
| 配置格式 | JSON，Go 标准库解析 |
| 第一阶段协议 | CONNECT only |
| 明文 HTTP | 第二阶段 |
| agent token | 每个 vault 一个，文件读取 |
| 客户端认证 | Basic `app:<password>`，支持双密码轮换 |
| 监听 | 仅 loopback |
| 上游 | 仅 loopback Agent Vault |
| 日志 | JSON，默认不记录 path/query/headers/body |
| 指标 | 第二阶段，Prometheus 文本格式，无第三方库 |
| 应用改动 | 无；只改 proxy URL |
| 回滚 | 改回直连 Agent Vault，无数据迁移 |

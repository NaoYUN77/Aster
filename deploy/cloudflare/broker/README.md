# Aster 连接器密钥 broker（Cloudflare Worker）

把连接器的静态凭据与用户 OAuth token 托管到 Cloudflare：主机只保留一个 Access service token，
运行期从 broker 取密钥，token 只在内存中使用。

- 入口：`secrets.naiwa.asia`（`wrangler.toml` 中的 `custom_domain` 路由）。
- 鉴权：Cloudflare Access 前置校验 service token；Worker 内再校验 `Cf-Access-Jwt-Assertion`。
- 静态密钥（master key、OAuth client 凭据、搜索 key）存 Workers Secrets，只通过白名单接口读取。
- 用户 refresh/access token 存 Durable Object（SQLite storage），AES-256-GCM 加密后落盘。

> 当前仅为代码与本地测试，**没有部署，也没有创建任何 Cloudflare 资源**。

## 目录

```
deploy/cloudflare/broker/
├── src/
│   ├── index.ts      Worker 入口（只导出 Vault 与 default handler）
│   ├── handler.ts    路由、鉴权后的业务逻辑、错误封装
│   ├── auth.ts       Access JWT 校验、JWKS 缓存、dev bypass
│   ├── crypto.ts     AES-256-GCM（与 src/connectors/crypto.ts 字节兼容）、master key 解析
│   ├── durable.ts    每 owner 一个 Durable Object（SQLite）的 RPC
│   ├── refresh.ts    GitHub / Google refresh token 刷新
│   ├── validate.ts   slug / provider / body / secret 白名单校验
│   ├── errors.ts     统一错误信封与响应头
│   ├── types.ts      共享类型
│   └── version.ts    /v1/health 的版本号
├── test/
│   ├── unit.test.ts        AES 互通、master key、白名单、slug/provider、body 校验
│   ├── jwt.test.ts         JWT 签名/iss/aud/exp/nbf、JWKS 缓存、dev bypass
│   ├── refresh.test.ts     GitHub/Google 刷新、过期判定、失败不外泄上游内容
│   └── integration.test.ts `wrangler dev --local` 端到端
├── wrangler.toml
├── tsconfig.json / tsconfig.test.json
└── package.json
```

## API（v1）

除 `/v1/health` 外，所有请求都必须带 Access 签发的 `Cf-Access-Jwt-Assertion`（由 Access 在
service token 校验通过后注入），否则 401 `BROKER_UNAUTHORIZED`。

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/v1/health` | `{ok:true, version}`，不需要鉴权，仅用于探活 |
| GET | `/v1/secrets/:name` | 白名单内的名字返回 `{name, value}`；否则 404 `SECRET_NOT_ALLOWED` |
| GET | `/v1/connections` | `{connections:[{slug, provider, accountLabel, scopes, expiresAt, updatedAt}]}`，仅元数据 |
| PUT | `/v1/connections/:slug` | body `{provider, accountLabel, scopes, refreshToken?, accessToken?, expiresAt?}`，两者至少一个 → 204 |
| POST | `/v1/connections/:slug/token` | `{accessToken, expiresAt}`；无 refresh token 时直接返回已存 access token，有 refresh token 且 access token 缺失/过期时才刷新并写回 |
| DELETE | `/v1/connections/:slug` | 删除记录 → 204（幂等，不存在也返回 204） |

约定：

- slug：`[a-z0-9][a-z0-9_-]{0,47}`；provider：`github` | `gmail`；违反时 400 `INVALID_SLUG` /
  `INVALID_PROVIDER`。
- 所有错误都是 `{error:{code,message}}`；上游（GitHub/Google）的响应体一律不透传、不记录。
- token 刷新失败统一 401 `CONNECTOR_AUTH_EXPIRED`，调用方应提示用户重新授权。
- 响应带 `cache-control: no-store`；`wrangler.toml` 关闭了 observability，Worker 也不打印请求或密钥内容。
- 刷新返回新的 refresh token（GitHub 会轮换）时会写回 DO；Google 不返回则不覆盖。
- 普通 GitHub OAuth App 不返回 refresh token：PUT 时省略该字段，broker 存 `null`，`POST /token`
  直接返回已存 access token，不会尝试刷新（无 access token 时 503 `CONNECTOR_NOT_CONFIGURED`）。

## 需要配置的 Workers Secrets

以 `wrangler secret` 或 `wrangler deploy --secrets-file` 写入（**不要提交任何文件到仓库**）：

| 名字 | 说明 |
|---|---|
| `credential_master_key` | AES-256-GCM 主密钥；64 位 hex、32 字节 base64/base64url 或正好 32 字节原文 |
| `github_client_id` / `github_client_secret` | GitHub OAuth App 凭据，用于 refresh |
| `google_client_id` / `google_client_secret` | Google OAuth 客户端凭据，用于 refresh |
| `deepseek_web_api_key` | 搜索/网页能力 key |
| `exa_api_key` | Exa 搜索 key |

非密钥变量写在 `wrangler.toml` 的 `[vars]`（或部署时 `--var` 覆盖）：

| 名字 | 说明 |
|---|---|
| `ACCESS_TEAM_DOMAIN` | Access team 域，如 `your-team.cloudflareaccess.com`；issuer 为 `https://<这个值>` |
| `ACCESS_AUD` | Access 应用（Application）的 Audience Tag |
| `BROKER_OWNER_ID` | Durable Object 的 owner 名，默认 `default`；`idFromName(owner)` 决定用哪个对象 |
| `BROKER_DEV_BYPASS` | 仅本地用；部署值必须是 `0` |

仓库里的 `routes`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD` 等都是占位；`account_id` 故意不写，
由 `CLOUDFLARE_ACCOUNT_ID` 环境变量提供，避免把真实 id 提交进仓库。

## Cloudflare Access 配置

1. Zero Trust → Access → Applications → Add an application → Self-hosted。
2. 域名填 `secrets.naiwa.asia`（与 `routes` 一致），路径留空。
3. 策略只允许 Service Auth：`Action = Service Auth`，包含要允许的 service token；不要添加
   “Allow everyone” 或邮箱策略。
4. 建 service token（Access → Service Auth → Create Service Token），把 **Client ID / Client
   Secret** 只放在主机侧（例如 `/etc/aster/connectors/` 下 0440 的文件），不要贴到聊天、日志、
   截图或仓库。
5. 从应用详情页复制 **Audience Tag** 填到 `ACCESS_AUD`。
6. 调用方请求带上 `CF-Access-Client-Id` / `CF-Access-Client-Secret`；Access 校验通过后会注入
   `Cf-Access-Jwt-Assertion`，Worker 再用 team 的 `https://<team>/cdn-cgi/access/certs`
   按 `kid` 取公钥验签（公钥缓存 1 小时，未知 `kid` 触发一次重取以支持轮换）。

主机侧只需要这一个 service token；它不持有 master key 或任何 OAuth token。

## 部署（由 Operation 执行，本任务不部署）

```bash
cd deploy/cloudflare/broker
npm install
export CLOUDFLARE_ACCOUNT_ID=<account-id>      # 不要写进 wrangler.toml
# 先把真实变量填进 wrangler.toml 的 [vars]，或：
npx wrangler deploy \
  --secrets-file ./secrets.json \
  --var ACCESS_TEAM_DOMAIN:your-team.cloudflareaccess.com \
  --var ACCESS_AUD:<audience-tag>
```

`secrets.json` 形如：

```json
{
  "credential_master_key": "<64 hex>",
  "github_client_id": "<id>",
  "github_client_secret": "<secret>",
  "google_client_id": "<id>",
  "google_client_secret": "<secret>",
  "deepseek_web_api_key": "<key>",
  "exa_api_key": "<key>"
}
```

注意：

- `--secrets-file` 也接受 `.env`，但 dotenv 会展开 `$VAR` 并可能把进程环境变量上传；优先用 JSON，
  文件权限 0600，用完即删，不要提交。
- 部署不会删除已有 secrets；换 key 时用 `wrangler secret put <name>` 或重新带文件部署。
- 首次部署会应用 `[[migrations]] new_sqlite_classes = ["Vault"]`。
- 回滚：`wrangler rollback [version-id]`；DO 数据仍在该版本兼容的存储中。
- 轮换 `credential_master_key` 目前**不会**自动重加密历史记录：需要重新 `PUT` 每个连接（或用旧 key
  解密后再写回）。这一步尚未实现，见“未实现项”。

## 本地开发

`BROKER_DEV_BYPASS=1` 会跳过 Access 校验，但只在请求 URL 的主机是 `127.0.0.1` / `localhost` /
`::1` 时生效；其他主机返回 403 `DEV_BYPASS_FORBIDDEN`。`wrangler dev` 默认会按 `routes` 改写请求
origin，本地调试时要加 `--infer-origin-from-routes=false`，否则 bypass 会被拒绝。

```bash
cd deploy/cloudflare/broker
npm install
npx wrangler dev --local --ip 127.0.0.1 --port 8787 \
  --infer-origin-from-routes=false \
  --var BROKER_DEV_BYPASS:1 \
  --var credential_master_key:<随机的 64 位 hex> \
  --var github_client_id:test --var github_client_secret:test \
  --var google_client_id:test --var google_client_secret:test
```

本地只允许用假的 key / token，不要用真实凭据跑 `wrangler dev`。也可以用 `.dev.vars`（已在
`.gitignore` 覆盖范围内，但同样不要提交）。

## 加密与互通

- 算法 AES-256-GCM，IV 12 字节，tag 16 字节，AAD = `connection:<slug>:oauth`。
- 密文格式与 `src/connectors/crypto.ts` 完全一致：`v1.<iv>.<tag>.<ciphertext>`，base64url 无填充。
  互通性由 `test/unit.test.ts` 用 Node `createCipheriv/createDecipheriv` 双向验证。
- master key 解析沿用主机规则：64 位 hex、32 字节 base64/base64url、或正好 32 字节原文；不合法时
  500 `CONNECTOR_MASTER_KEY_INVALID`，错误信息不含 key 本身。
- DO 只存密文；解密在 Worker 内存中完成。GET `/v1/connections` 不含密文，也不含任何 token。

## 安全约束（务必保持）

- **不落日志**：Worker 不打印请求头、body、token、密钥；未知异常只记录一句固定文案。
  `observability.enabled = false`。不要为了调试打开请求体日志。
- **不返回给非白名单调用者**：只有通过 Access（或本地 loopback bypass）的调用方能访问业务接口；
  `/v1/secrets/:name` 只认 7 个白名单名字，其他一律 404（不是 403，避免泄露“存在但无权”）。
- **不外泄上游内容**：GitHub/Google 的错误响应体、状态文本不进入响应或日志，只映射为
  `CONNECTOR_AUTH_EXPIRED`。
- service token、master key、OAuth client secret、用户 refresh token 都不应出现在聊天、issue、
  截图、日志或仓库中。

## 测试

```bash
cd deploy/cloudflare/broker
npm run check            # tsc 两个 project
npm test                 # 纯函数 + JWT + refresh（node --test，经 tsx）
npm run test:integration # wrangler dev --local 端到端（需要本地 workerd，约 10s）
```

`test:integration` 自己生成假的 master key / OAuth 凭据，只调用缓存命中路径（access token 未过期），
不会访问 GitHub/Google。若本机没有安装依赖（`node_modules/wrangler` 不存在），该测试会 skip。

## 未实现项

- 没有实际部署或创建 CF 资源（按任务要求）。
- master key 轮换时的历史数据重加密 / 迁移。
- 按连接粒度的权限控制（当前一个 owner 一个 DO，凡持有 service token 的调用方可见该 owner 的全部
  连接元数据与 token）。
- 速率限制、审计日志（有意不记录请求内容；若需要审计，只记录 slug/操作/结果码）。
- 主机侧客户端（把现有 `FileSecretProvider` / connector 存储切到 broker）不在本次范围。

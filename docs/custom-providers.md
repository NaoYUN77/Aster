# 自定义模型提供商

除了编译进 `src/providers.ts` 的 12 家提供商，部署还可以用一份声明文件描述自己的 OpenAI 兼容网关。声明是**部署数据**：它属于数据目录，随数据一起备份，不进仓库（本文件的示例只保留占位地址）。取舍与代价见 [ADR-0024](adr/custom-providers/0024-custom-provider-declarations.md)。

## 生效方式

| 变量 | 含义 |
| --- | --- |
| `PROVIDERS_CONFIG` | 声明文件路径；默认 `<DATA_DIR>/providers.json` |
| `MODEL_PROVIDER` | 内置提供商 id，或声明里某个 provider 的 `id` |
| `MODEL_ID` | 该 provider 的模型 id（内置取自 pi-ai 目录，声明取自声明或它的 `/models`） |

默认文件不存在等于「没有自定义提供商」，是合法状态。显式给了 `PROVIDERS_CONFIG` 却读不到或不是合法 JSON，是启动错误。`MODEL_PROVIDER` 写了未声明的 id，错误信息会列出内置 id 并说明声明来自配置文件。

## 声明文件形状

```json
{
  "providers": [
    {
      "id": "my-gateway",
      "label": "My Gateway",
      "baseUrl": "http://10.0.0.9:3425/v1",
      "apiBaseUrls": { "anthropic-messages": "http://10.0.0.9:3425" },
      "apiKeyEnv": "MY_GATEWAY_API_KEY",
      "catalog": { "path": "/models" },
      "modelDefaults": {
        "api": "openai-completions",
        "contextWindow": 128000,
        "maxTokens": 16384,
        "cost": { "input": 1, "output": 2, "cacheRead": 0, "cacheWrite": 0 },
        "compat": { "supportsDeveloperRole": false }
      }
    }
  ]
}
```

字段（每层都拒绝未知键；键名像凭据的会明确提示凭据只从环境读）：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | `[a-z][a-z0-9-]{0,23}`，不得与内置 12 家重名，同一文件内唯一 |
| `label` | 否 | 显示名，默认等于 `id` |
| `baseUrl` | 是 | 网关地址。`http:` 只允许回环、`10/172.16-31/192.168`、`169.254`、`100.64-127`（含 Tailscale）、IPv6 ULA；不得内嵌凭据、不得带 query 或 fragment |
| `apiBaseUrls` | 否 | 按协议覆盖地址，键为 `openai-completions`／`openai-responses`／`anthropic-messages`／`google-generative-ai` 之一，值同 `baseUrl` 规则 |
| `apiKeyEnv` | 是 | 环境变量名（`[A-Z][A-Z0-9_]{0,63}`）。**只写名字**；这个名字必须与 MITM 占位符和 OpenBao 路径里的 `<NAME>` 一致 |
| `catalog` | 否 | 见下；与 `models` 至少要有一个 |
| `modelDefaults` | 否 | 目录条目缺字段时的回退值（`api`／`contextWindow`／`maxTokens`／`reasoning`／`input`／`cost`／`compat`） |
| `models` | 否 | 静态模型清单，每条自带 `id`、`api`、`contextWindow`、`maxTokens`、`cost`，可选 `name`／`reasoning`／`input`／`compat`；网关没有 `/models` 时用它 |

`catalog` 字段：`path`（默认 `/models`）、`timeoutMs`（1000–60000，默认 10000）、`apiPreference`（默认 `anthropic-messages` → `openai-completions` → `openai-responses`）、`defaultApi`（默认 `openai-completions`）。

### 为什么版本段要分协议声明

四个协议的客户端对 base URL 的预期不一致：

| 协议 | 客户端实际请求的路径 | base URL 应写成 |
| --- | --- | --- |
| `openai-completions` / `openai-responses` | `<baseUrl>/chat/completions`、`<baseUrl>/responses` | 含版本段，如 `http://10.0.0.9:3425/v1` |
| `anthropic-messages` | `<baseUrl>/v1/messages` | 服务根，如 `http://10.0.0.9:3425` |
| `google-generative-ai` | `<baseUrl>/models/<id>:generateContent` | 含版本段，如 `.../v1beta` |

一个网关同时提供多个协议时，用 `apiBaseUrls` 把需要不同前缀的协议单独写出来；不写的协议用 `baseUrl`。漏写会表现为该协议的模型一律 404（回复为空），见 ADR-0024 的 CUST-01。

## 模型目录

启动时（以及 `npm run build && node dist/src/check-config.js` 这个配置检查入口）对**所选** provider 请求一次 `GET <baseUrl><catalog.path>`，`redirect` 不跟随，解析出凭据时带 `Authorization: Bearer <凭据>`。响应限 512 KiB、最多 500 条、严格 JSON。

单条目录条目缺上下文窗口、缺输出上限、缺 `prompt`／`completion` 价格、没有任何受支持的聊天端点、id 不可用或与前面重复时，**只跳过这一条**并把本地原因写进日志（例如 `Provider my-gateway ignored a catalog entry: <id>: catalog entry has no output token limit`）。价格从每 token 字符串换算成美元／百万 token；`input_cache_read`／`input_cache_write` 缺失记 0。

**目录拉不到就是启动错误**：此时 `MODEL_ID` 无法校验，带着未验证的模型 id 运行只会在第一次对话时失败。部署预检因此对声明的 provider 需要网络可达；内置提供商的预检仍然完全离线。

## 凭据

凭据仍只经部署环境注入，声明文件里不能出现 key。MITM 模式下 `.env` 写占位符，OpenBao 里存真值：

```bash
PROVIDERS_CONFIG=/data/providers.json
MODEL_PROVIDER=my-gateway
MODEL_ID=<catalog 里的模型 id>
MY_GATEWAY_API_KEY=__vault_MY_GATEWAY_API_KEY__
```

```bash
# 在该主机的 OpenBao/MITM 栈目录里写入密钥（值走隐藏输入，不进 argv、不进日志）
cd <该主机的 MITM 栈目录>
ASTER_OPENBAO_SECRETS=$HOME/Aster/secrets/openbao ./bootstrap.sh MY_GATEWAY_API_KEY
```

同时在该主机的 MITM `addon/allowlist.json` 加入映射，允许这个占位符只发往网关主机：

```json
"MY_GATEWAY_API_KEY": ["10.0.0.9"]
```

匹配按**主机（不含端口）**精确进行，所以同一台机器的 VPC 地址与 Tailscale 地址是两个主机条目，各自都要列。改完 allowlist 需要重启 `aster-mitm` 容器（`docker compose ... up -d --force-recreate aster-mitm` 或该栈的等价命令），并复核 `/data/providers.json` 已随数据目录一起备份。

## 排查

| 现象 | 可能原因 |
| --- | --- |
| 启动报 `Model catalog for provider <id> could not be read: model catalog endpoint answered with status 4xx` | 目录路径不对、缺少 API key（经 MITM 时应是 403 替换失败）或网关未就绪 |
| 启动报 `Unknown MODEL_ID "..."` 并列出示例 | `MODEL_ID` 与目录里的 id 不一致（网关的 id 常带前缀，如 `vendor/model`） |
| `MODEL_PROVIDER must be one of: ...; declared providers come from the provider config file` | 该 id 没有在 `PROVIDERS_CONFIG` 指向的文件里声明 |
| 日志出现 `ignored a catalog entry: ...` | 该条目不完整，已被跳过；其余模型正常 |
| 某一族模型回复为空、该协议路径 404（例如 `/v1/v1/messages`：版本段重复） | 该协议的地址与 `baseUrl` 的版本段约定不同，用 `apiBaseUrls` 单独声明 |

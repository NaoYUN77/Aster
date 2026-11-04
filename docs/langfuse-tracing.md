# Langfuse Cloud Tracing

第一阶段把一次 Agent 请求及其内部执行导出到 Langfuse Cloud，用于查看耗时、调用层级、模型用量和失败原因。Trace 是诊断数据，不参与会话状态、工具执行、Loop Guard 或 Durable 恢复；关闭或导出失败都不改变 Aster 的业务结果。

实现集中在 [`src/trace.ts`](../src/trace.ts)，使用 Langfuse 官方 SDK 的 OpenTelemetry 处理器，不再写本地 JSONL 文件。

## 追踪范围

一次请求共用同一个 `traceId`，父子关系如下：

```text
agent.request                 agent  （根 span，session = 会话 id）
├── llm.generation            generation（每次模型响应一条）
├── codemode                  tool（一次 codemode 工具调用）
│   ├── nested.tool           tool（脚本内的嵌套工具调用）
│   │   └── rpc.<method>      span（远程执行 RPC；本地模式没有）
│   ├── runner.vm             span（远程 QuickJS VM；本地模式没有）
│   └── runner.message        event（有上限）
├── registry.decision         event（工具授权 allow/deny）
└── loop_guard.warning/halt   event（Loop Guard 证据）
```

- `agent.request` 以 durable 会话 id（`root.id`）为 `session.id`，以 `requestId` 区分同一会话的不同请求。
- `codemode` 在工具授权之前创建，因此被拒绝的调用同样可见。
- `llm.generation` 关联提供商、模型、stop reason 和 token 用量。
- 远端 RPC 请求帧携带 `<traceId>.<spanId>` 形式的 `correlationId`（49 字节），供执行端未来接入同一 Trace；第一阶段所有 span 都由控制面创建。

单个 trace 内的活跃请求和 codemode span 各限 256 个，单个 codemode span 的 event 限 256 条；超限时结束最旧 span（标记 `unknown`）或写一条 `events.truncated`，不静默丢弃。

## 配置

所有配置都来自环境变量。未配置时 tracing 完全关闭，不加载处理器、不产生网络请求。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `LANGFUSE_PUBLIC_KEY` | 启用时必填 | Langfuse 项目公钥，`pk-lf-...`。 |
| `LANGFUSE_SECRET_KEY` | 启用时必填 | Langfuse 项目密钥。 |
| `LANGFUSE_BASE_URL` | 否 | Langfuse 地址，默认 `https://cloud.langfuse.com`。兼容旧别名 `LANGFUSE_HOST`；两者都设置时以 `LANGFUSE_BASE_URL` 为准。自建或 US 区域时填写实际地址。 |
| `LANGFUSE_TRACING_ENABLED` | 否 | `1`/`true` 强制请求启用；`0`/`false` 在保留密钥的情况下关闭。其他值启动失败。 |
| `LANGFUSE_TRACING_ENVIRONMENT` | 否 | SDK 透传的环境标签（如 `production`、`test`）。 |

启用规则：

- 公钥和密钥都非空即启用；只配一个视为未配置。
- `LANGFUSE_TRACING_ENABLED=0` 优先级最高，用于临时停用而不删除密钥。
- `LANGFUSE_TRACING_ENABLED=1` 但密钥缺失时，启动日志写一行说明并保持关闭。
- 其余取值（如 `yes`）是配置错误，按现有严格配置约定在启动前失败。

SDK 还会自行读取 `LANGFUSE_FLUSH_AT`、`LANGFUSE_FLUSH_INTERVAL`、`LANGFUSE_TIMEOUT`、`LANGFUSE_OTEL_COMPRESSION` 等批量与超时变量，默认值即可用于当前单机规模。

## 隐私边界

默认不上传：

- 用户消息、模型回复、thinking、工具参数、脚本体、命令、文件内容、路径字符串、错误消息原文；
- 任何凭据或认证头。

只上传宿主已知的边界信息：

- 会话 id、请求 id、task/call/session/job id；
- 字节长度（`textBytes`、`scriptBytes`、`argsBytes`、`contentBytes` 等）、条目数、token 用量、耗时；
- 工具名、模型/provider 名称、stop reason、错误码、授权决定；
- span 结果（`ok`/`error`/`aborted`/`halted`/`unknown`）。

实现上不设置 `input`/`output` 字段，媒体上传显式关闭（`mediaUploadEnabled: false`）；metadata 只从固定字段构造，不序列化消息或参数对象。

## 失败隔离

- 处理器或 provider 构造失败：写一行日志，tracing 关闭，进程继续。
- span 创建、更新、结束或导出失败：写一行固定前缀的日志（只含错误类型名），不向工具、hook、RPC 或关闭路径抛错。
- 关闭时先结束遗留 span，再在 5 秒超时内 flush；超时或异常都只记日志。

因此 Langfuse 不可达、密钥失效或账号限流时，Telegram 消息仍正常回复，durable 状态不受影响。

## 部署

### 直接使用密钥（非 MITM 模式）

在部署目录的 `.env` 增加：

```sh
LANGFUSE_PUBLIC_KEY=<langfuse-public-key>
LANGFUSE_SECRET_KEY=<langfuse-secret-key>
# 可选
# LANGFUSE_BASE_URL=https://us.cloud.langfuse.com
# LANGFUSE_TRACING_ENVIRONMENT=production
```

```sh
docker compose up -d --force-recreate personal-agent
docker compose logs --tail=50 personal-agent
```

日志应无 `Langfuse tracing disabled`。若出现该行，按提示检查密钥或地址。

### MITM（OpenBao 占位符）模式

生产部署的 `.env` 只保留占位符，真实密钥由 OpenBao 提供。Langfuse SDK 在发出 OTLP 请求前把 `publicKey:secretKey` 编码进 `Authorization: Basic`；`aster-mitm` 的占位符策略会先解码 Basic 凭据，按 allowlist 替换其中的占位符，再重新编码后转发。因此 Langfuse 密钥与其他密钥一样走 OpenBao，不需要明文写入 `.env`。

OTLP 导出使用自建的 keep-alive agent，不会自动继承 Node 的全局代理配置。`src/trace.ts` 在检测到 `HTTP(S)_PROXY` 时用同一组 Langfuse 地址和认证头构造支持 `proxyEnv` 的导出器，使 Langfuse 请求和其他出站请求一样经过 `aster-mitm`；`NO_PROXY` 仍按 Node 的规则生效。

`.env`：

```dotenv
# 公钥不是秘密，可明文保留；要统一由 OpenBao 管理也可写成 __vault_LANGFUSE_PUBLIC_KEY__
LANGFUSE_PUBLIC_KEY=<langfuse-public-key>
LANGFUSE_SECRET_KEY=__vault_LANGFUSE_SECRET_KEY__
```

部署顺序：

1. 更新并重启 MITM，使 Basic 解码生效（`vault_placeholders.py` 已包含该逻辑）：
   ```bash
   cd ~/Aster/deploy/openbao-mitm
   docker compose up -d --force-recreate mitm
   ```
2. 把真实 secret key 写入 OpenBao；已有条目会保持不变，可重复执行：
   ```bash
   ASTER_OPENBAO_SECRETS=$HOME/Aster/secrets/openbao ./bootstrap.sh LANGFUSE_SECRET_KEY
   ```
3. 按 MITM 迁移步骤把 `.env` 改为上面的占位符，再重建应用容器。

边界：

- `allowlist.json` 已为 `LANGFUSE_PUBLIC_KEY` 与 `LANGFUSE_SECRET_KEY` 列出 `cloud.langfuse.com` 和 `us.cloud.langfuse.com`。使用自建 Langfuse 或其他区域时，加入实际 host 的精确匹配；不做后缀或通配匹配。
- 代理模式使用自建 OTLP 导出器，`LANGFUSE_OTEL_COMPRESSION` 不再生效（请求默认不压缩）；批量条数、flush 间隔和 `LANGFUSE_TIMEOUT` 仍按 Langfuse SDK 的变量处理。
- 只有当解码后的凭据里出现占位符时才改写 `Authorization`；普通 Basic 凭据原样转发。
- 未知占位符或 host 不匹配仍使整条请求返回 403，且不会部分替换。
- MITM 只解码 `Basic`；其他认证方案中的编码值不会尝试识别。

### 关闭与轮换

- 临时关闭：设置 `LANGFUSE_TRACING_ENABLED=0` 并重启。
- 彻底关闭：删除两个密钥变量并重启。
- 轮换：在 Langfuse 控制台创建新密钥，更新 `.env`（MITM 模式则更新 OpenBao 条目）后重启；旧密钥可立即吊销。轮换期间丢失的 trace 不影响业务。

数据写入 Langfuse Cloud，不进入 `DATA_DIR`，备份与恢复流程不涉及 Trace。

## 第一条真实 Trace 验收

前置：已完成上面的部署，密钥有效，容器可以访问 Langfuse 主机。

1. **确认启动未降级**

   ```sh
   docker compose logs personal-agent | grep -i langfuse
   ```

   预期没有输出，或只有你主动设置的启用/关闭说明；不应出现 `Langfuse tracing disabled`。

2. **产生一次包含工具调用的请求**

   用 owner 的 Telegram 账号私聊 bot，发送需要读取或计算的消息，例如：

   ```text
   用 codemode 执行：读取当前工作目录下的 package.json，返回 name 字段。
   ```

   等待 bot 正常回复。回复本身应与未开启 tracing 时一致。

3. **在 Langfuse 找到该 Trace**

   打开 Langfuse 项目的 Tracing 页面，按最近时间排序；根 observation 名为 `agent.request`，`Session` 等于该 Telegram 会话对应的 durable 会话数字 id。

4. **核对层级**

   - `agent.request` 下至少有 1 条 `llm.generation`；
   - 触发 codemode 时存在 `codemode` 子 span，其下为 `nested.tool`；
   - 远程执行模式下继续出现 `rpc.*` 和 `runner.vm`，且与调用方共用同一 `traceId`；
   - `registry.decision`、`loop_guard.*` 作为 event 出现在对应父 span 下。

5. **核对隐私**

   打开根 span 和 `codemode` span 的 Input/Output：应为空。Metadata 中只应看到 id、长度、计数、工具名、模型名、错误码等边界字段；不应出现消息原文、脚本体、命令或文件内容。

6. **核对失败隔离**

   临时把 `LANGFUSE_SECRET_KEY` 改成无效值并重启，再发送一条消息。预期：

   - bot 仍正常回复；
   - 日志最多出现 `Langfuse tracing failed: ...`（或 SDK 的导出告警），进程不退出；
   - 恢复正确密钥并重启后，新请求重新出现在 Langfuse。

7. **核对正常结束**

   等待一次请求完成后刷新 Langfuse：根 span 应已结束并带 `outcome`、`durationMs`；不应长期停留在进行中。进程正常退出时，未结束的 span 会以 `unknown` + `abandoned` 结束，而不是丢失。

## 已知限制

- 第一阶段只覆盖控制面；执行端（远端 VPS）不独立产生 span，跨机关联依赖 RPC 帧里的 `correlationId`。
- 没有采样配置和本地缓冲；导出失败即丢弃该批 span，后续请求继续尝试。
- `LANGFUSE_TRACING_ENABLED` 之外的新变量沿用 SDK 默认解析；需要调整批量行为时参考 SDK 文档。

# CLAUDE.md

## 技术栈

以 pi-durable 为 agent 底座，复用其 agent loop、工具执行与持久化；应用层不另建模型循环，底座 API 以已安装发布版为准。

| 组件 | 版本 | 职责 |
| --- | --- | --- |
| Node.js | 24.19.0（`.node-version`；`engines: >=24.19.0 <25`） | 运行时，含内置 `node:sqlite` |
| @earendil-works/pi-durable | 1.5.0 | agent loop、工具执行、持久化 |
| @earendil-works/pi-ai | 1.5.0 | 模型适配 |
| @earendil-works/chord | 1.5.0 | 执行上下文 |
| @earendil-works/pi-mcp | 1.5.0 | MCP 客户端、传输与 OAuth |
| @earendil-works/pi-schema | 1.5.0 | 内置工具的参数 schema 与静态参数类型推导 |
| TypeBox | 1.3.27 | 记忆、文档、部署配置与 MCP 远端 schema 的校验 |
| grammY | 1.46.0 | Telegram 协议适配 |
| abort-controller | 3.0.0 | Telegram 侧使用的取消信号实现 |
| @langfuse/otel / @langfuse/tracing | 6.1.1 | 可选 Langfuse Cloud Trace 的 span 处理器与观测 API |
| @opentelemetry/api | 1.9.0 | Trace API |
| @opentelemetry/sdk-trace-node | 2.12.0 | Trace provider |
| @opentelemetry/exporter-trace-otlp-http | 0.223.0 | OTLP 导出（MITM 模式使用支持代理的 agent） |
| TypeScript / tsx | 7.0.2 / 4.23.15 | 类型检查与构建 / 开发执行 |

直接依赖使用精确版本（无 `^` / `~`），传递依赖由提交的 lockfile 固定，运行时版本写入对应版本文件；升级时同步依赖清单、lockfile、版本文件与本表。

模型提供商：`src/providers.ts` 的 `PROVIDERS` 是编译期内置名单，共 12 家——`anthropic`、`openai`、`deepseek`、`google`、`xai`、`mistral`、`groq`、`moonshotai`、`moonshotai-cn`、`minimax`、`zai`、`openrouter`；每家用 `apiKeyEnv` 指向单个显式 API key。自建 OpenAI 兼容网关由 `DATA_DIR/providers.json` 声明，底层用 pi-ai 的 `createProvider()`／`envApiKeyAuth()`。

消息渠道：`CHANNEL` 二选一（默认 `telegram`），同一进程只服务一个渠道。投递契约在 `src/channel.ts`，两个适配层 `src/telegram.ts`（长轮询）与 `src/slack.ts`（Socket Mode）各自实现。Slack 侧不新增依赖：只用 Node 内置的 `fetch` 与 `WebSocket`。

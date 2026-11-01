# Telegram STT（Whisper-compatible）

状态：draft PR 实现规格，保留至功能验收完成。开始日期：2026-11-01。长期取舍见 [ADR-0017](adr/telegram-stt/0017-whisper-transcription-before-agent.md)。

## 只读梳理

- `src/telegram.ts` 使用 grammY Api 长轮询，`allowed_updates: ["message"]` 会包含 voice/audio；`toRequest` 当前只接纳 owner 私聊非空 text。没有下载逻辑。
- `Inbox.accept` 在同一 SQLite 事务保存请求和 offset；先处理本地 pending/ready 再轮询，每批最多 10 条。
- `serveTelegram` 调用 `agent.reply(TextRequest, signal)`；底座按 requestId 恢复、去重。保存回复后按段投递，发送结果未知须人工对账。
- remote 为旧仓库地址，GitHub API 确认其当前 canonical repo 是 `NaoYUN77/Aster`。
- 参考 `grinev/opencode-telegram-bot` 的 `stt-service.ts` / `voice-handler.ts`，仅复用下载 → multipart 转写 → 普通 prompt 的流程形状，不引入其 SDK、代理依赖、TTS 或本地听写。

## 设计与边界

1. 身份过滤先于下载或 STT。接纳 Telegram `voice` / `audio`；字幕不拼接到 transcript。将文件引用与消费位置一起持久化，原始音频仅在内存中有界保留，不写临时目录。
2. `STT_API_URL` 是完整 HTTPS transcription endpoint（例如 `https://api.openai.com/v1/audio/transcriptions`）；`STT_API_KEY` 为独立宿主凭据，MITM 使用 `__vault_STT_API_KEY__`；`STT_MODEL` 显式指定。三个变量全空禁用，部分配置或非法配置启动失败。与 `MODEL_PROVIDER` 独立，agent 仍可使用 DeepSeek。
3. 使用 Node 内置 fetch/FormData，POST Bearer + multipart `file` / `model` / `response_format=json`，响应必须为有界 JSON 对象且含非空、合法 Unicode text。禁止重定向；不记录上游响应正文、文件 URL、token 或 key。不自动重试收费 STT 调用。
4. Telegram getFile 与 `/file/bot<token>/<file_path>` 下载使用同一个 `TELEGRAM_API_ROOT` 前缀；代理须支持文件路由。下载前复核元数据，下载流也复核字节上限。`voice` 的 oga 后缀映射为 ogg；拒绝不支持的 audio 扩展名，不伪装格式、不转码。
5. 固定上限：音频 20 MiB、时长 600 秒；下载（含 getFile）30 秒，STT 60 秒；响应 128 KiB、transcript 16,000 UTF-16 code units。请求串行，至多一个音频下载/STT。超限明确回复。
6. 下载是只读操作，可在重启后再取。STT POST 前先持久化 running；成功先保存 transcript，再进入原 `agent.reply`。中断或关闭后未保存结果的 STT 保守记为结果未知，不自动重放（供应商可能已处理/计费），提示重新发送将创建新请求，可能再次计费。
7. 未配置、元数据非法、格式不支持、超限、下载失败、STT HTTP/协议/空文本/超时失败均落为明确中文通知，agent 不执行。成功时 transcript 随最终 agent 回复一并保存、分段发送；没有额外临时状态消息。投递失败只重投已保存回复，不能重做 STT 或 agent。
8. 只增量迁移 inbox 列；旧文本请求继续恢复。旧版本不识别待转写音频，回滚前须排空音频待办。

## 计划文件

- `src/telegram.ts`、`src/inbox.ts`、`src/messages.ts`：接收、下载、持久化转写状态与原 agent 接线。
- 新 `src/stt.ts`：Whisper-compatible HTTP 客户端与边界。
- `src/config.ts`、`.env.example`：可选配置。已确认现有 Compose `env_file` 可透传，部署环境渲染与拓扑无需改动。
- OpenBao MITM allowlist、部署说明、README：占位符与网络路由说明。
- STT 客户端、Telegram 与 inbox 的离线测试；不使用真实凭据或收费接口。

## 验收

覆盖 owner/private 边界、voice/audio、multipart 契约、路径/格式/体积/时长验证、HTTP/空文本/非法 JSON、重定向、超时与实际 I/O 取消、SQLite 重启恢复、同内容独立消息、投递重试不重做 STT/agent。运行类型检查、全量离线测试与构建。真实 Telegram + STT 联调由配置好部署环境后的验收完成；本任务只提交 draft PR，不 merge、不 deploy。

## 2026-11-01 验证记录

- `npm run check`、`npm run build`：通过，Node v24.19.0。
- `npm test`：291 项，283 通过、0 失败、8 跳过（既有 Linux/root/Docker 条件用例），约 258 秒。首次运行被 120 秒工具时限终止；延长时限后的完整运行退出 0。
- 增强实际 HTTP parent cancellation 并补充失败通知重启窗口后，`npx tsx --test test/stt.test.ts test/telegram-stt.test.ts`：14/14 通过，再次 check/build 通过。
- `npx tsx --test test/stt.test.ts test/telegram-stt.test.ts test/mitm-proxy.test.ts`：补充恢复用例前 21/21 通过，其中本地 TLS CONNECT 代理实际覆盖 Telegram 文件下载和 STT multipart；MITM 测试同时运行 Python 占位符策略用例。
- 核心代码独立只读复核未发现已确认缺陷；`git diff --check` 通过。
- 未调用真实 Telegram/STT API、未使用真实 key，未构建 Docker 镜像或部署服务；Linux 容器检查交由 PR CI。

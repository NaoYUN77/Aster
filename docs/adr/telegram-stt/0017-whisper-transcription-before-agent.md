# ADR-0017：Telegram 音频先持久化转写，再进入原 agent

- **状态**：Proposed（draft PR，待真实服务验收）
- **日期**：2026-11-01
- **功能**：telegram-stt

## 上下文

Telegram 已长轮询所有 message 更新，但只接纳 owner 私聊文本。文本接收与 offset 在 inbox 事务落盘，agent 由 pi-durable 恢复，投递则独立保存并逐段确认。语音需要远端转写，既涉及收费请求，也有不同于 agent 的中断窗口。

## 决策

在 Telegram 协议边界保存 voice/audio 文件引用，限制大小与时长，下载后调用独立的 Whisper-compatible multipart endpoint。transcript 先落盘，再作为普通用户文本以原 requestId 调用同一个 `agent.reply`。STT 凭据、endpoint 与模型属于宿主配置，与聊天 provider 独立；使用 Node 内置 HTTP 能力，不引入 SDK 或本地音频转码进程。

音频文件引用、转写状态和 transcript 归接入收件箱；底座继续独占 agent 执行恢复状态。音频字节仅在有界内存暂存。成功时识别文本与最终回复一起保存和分段投递；失败只保存明确通知，不调用 agent。

STT POST 前持久化 running。没有保存结果的在途转写在恢复时标记 uncertain，不自动重放。供应商可能已处理或计费，本应用无法由连接失败推断未执行，也不能假定通用 Whisper 接口支持幂等键。用户重新发送为新的请求，可能再次计费。

## 备选方案与代价

- 轮询中先转写后保存：代码更短，但容易在 offset 已确认或进程退出时丢失输入/重复计费；拒绝。
- 作为模型工具执行 STT：会让模型决定如何处理渠道输入，且音频输入仍需要转写后才成为 prompt；拒绝。
- 进程重启自动再次转写：可提高完成率，但通用接口不保证幂等，不能接受静默重复计费；拒绝。
- 本地转码：扩大格式兼容但增加运行依赖、CPU/内存和取消责任；当前拒绝，不支持的格式明确提示。

付出的代价：中断窗口内有的音频需要用户重新发送；回复只在 agent 完成后附 transcript，不发送临时“识别中”消息；回滚至不识别音频列的旧版本前须排空待办。转写结果与普通文字享有相同 owner 权限，识别错误可能影响任务，因此回复展示实际交给 agent 的文本；目前没有额外确认回合。

## 分阶段决策与缺陷历史

### 2026-11-01：Whisper-compatible 接入

- 相关 spec：`docs/spec-20261101-telegram-stt.md`，draft 验收期间保留。
- 参考：`grinev/opencode-telegram-bot` 的 STT service 与 voice handler，仅参考流程形状；未移植依赖或 TTS/本地听写逻辑。
- 边界测试发现 owner 消息带非法 `voice: null` 会被 nullish fallback 跳过；已改为显式区分字段缺失与非法元数据，保存拒绝通知。
- 验证：离线测试覆盖 multipart、边界、取消、迁移与转写/投递恢复。真实 Telegram、供应商格式支持与 OpenBao 联调尚待部署者验收；未部署。

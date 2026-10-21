# 修复代码审查问题 F1–F7，并补充回归用例

基线：`57ef390`。执行范围与要求见 [docs/review-fix-plan.md](docs/review-fix-plan.md)，逐项记录见 [docs/mvp-verification.md](docs/mvp-verification.md)。

## 已完成

### F1（P1）底座 Session 失效后停止接收

- `src/agent.ts`：`reply()` 区分请求级失败与 Session 失效。宿主关闭信号原样透传；`AGENT_TIMEOUT`／`AGENT_UNANSWERED`／`AGENT_TRUNCATED`／`EMPTY_REPLY` 原样返回；其余持久化调用异常统一包装为 `AGENT_SESSION_FAILED`，`cause` 为 `SessionFailed`。首个 Storage 错误在 Session 锁存前会以原始错误抛出（已核对 pi-durable 1.3.0 `SessionImpl.#call`），因此不能只判断 `instanceof SessionFailed`。
- `src/telegram.ts`：致命错误不写失败回复、不投递，直接向上抛出，请求保持 `pending`；`main.ts` 顶层捕获在未收到关闭信号时置退出码 1，交给进程管理器重启。
- `confirmPart` 移出发送 `try`：本地写入失败不再被误记为 Telegram 投递失败。

### F2（P1）长度截断不按完整成功处理

- 最后一条 assistant 消息 `stopReason === "length"` 时抛出 `AGENT_TRUNCATED` 并携带 `partialReply`。
- 投递层发送部分文本 + “回复因长度限制被截断，内容不完整”，错误码写入 `failures`；不自动续写或重试；空回复仍为 `EMPTY_REPLY`。

### F3（P1）Docker 备份卷名

- `docker-compose.yml` 顶层卷显式 `name: personal-agent-data`，不随项目目录名变化。
- README 写明卷名来源、旧前缀卷的迁移提示、备份后归档内容核对（`inbox.sqlite`、`agent.sqlite`、`workspace/MEMORY.md` 及 WAL/SHM）、以及完整还原步骤；明确退出码 0 不算备份成功。

### F4（P2）恢复执行纳入请求超时

- 移除 `openAgent` 中的 `harness.resume()`，改在 `reply()` 创建 300 秒等待信号后、提交请求前调用。打开时不派发恢复任务（已核对 `Harness.open` → `scheduler.open` 只把 `running` 改回 `pending`）。
- 超时仍调用 `root.abort()`；关闭仍只停止等待并保留可恢复状态。

### F5（P2）投递 CLI 先执行恢复

- `src/deliveries.ts` 在 `list`／`retry`／`sent` 前调用 `inbox.recover()`，遗留 `sending` 以 `uncertain` 出现在列表，`retry`／`sent` 可执行。
- README 与 `docs/contracts-and-lifecycle.md` 同步说明。

### F6（P3）复用底座文本提取

- 用 pi-ai 的 `contentText` 替换手工 `flatMap`，行为与断言不变。

### F7（P3）Telegram 输入边界校验

- `update_id` 必须为非负安全整数；`chat.id`、`from.id` 接受安全整数或数字字符串并统一为字符串；`text` 必须为非空字符串。
- `serveTelegram` 只在 `update_id` 合法时推进消费位置，非法 update 记录不含内容的安全诊断后跳过，不写入 `NaN`、不阻塞轮询。

### 验证

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 38 项通过，0 失败 |
| `npm run build` | 通过 |

测试由 27 项增至 38 项，原 27 项全部保留且断言未放宽。新增用例：

- F1：`a failed agent session stops polling and leaves the request pending`、`a local storage failure while saving a reply is fatal`、`a failed agent session is fatal and the same request recovers after restart`、`a model failure is delivered as a notice and later requests still run`
- F2：`a length-limited answer is reported as truncated with its partial text`、`a truncated agent answer is delivered with an explicit incompleteness notice`
- F4：`reopening does not start recovered work until a reply is waiting`、`a recovered task is bounded by the waiting reply's timeout`
- F5：`delivery CLI recovers an interrupted send before listing and resolving it`
- F7：`malformed Telegram updates are rejected at the boundary`、`invalid updates are skipped without writing an unusable checkpoint`

### 附带改动

- `Dockerfile`：删除 `# syntax=docker/dockerfile:1`（本地构建环境无法拉取该前端镜像）。
- `src/deliveries.ts`：数据库不存在时给出明确的 `DATA_DIR` 提示并以 1 退出。

## 待做

1. **F3 的 Docker 备份／还原演练未执行。** `docker compose config` 确认卷名、以及按 README 执行一次归档、内容核对与还原，都还没有实际跑过；文档已按“待补做”标注。需要 Docker 环境与可用镜像源（README 命令使用 `alpine`）。
2. **阶段 E：真实联调仍阻塞。** 缺少测试 bot 的 `TELEGRAM_BOT_TOKEN`／`TELEGRAM_OWNER_ID`、受支持提供商的 `MODEL_PROVIDER`／`MODEL_ID`／API key 及联调授权。真实 Telegram 与真实模型路径、真实记忆文件、真实“发送已到达但确认丢失”窗口都还没有证据。
3. **阶段 F：Linux 部署验收仍阻塞。** 缺少 4 核／4 GB 目标主机。需补测 Node 版本与权限、单实例约束、SIGTERM 与 45 秒停止宽限期配合、强杀恢复、Linux 进程组取消、内存与磁盘峰值、日志脱敏、卷备份还原、容器内 bash 可用性。本地取消测试只证明 Windows 进程树终止，不能代替 Linux 复测。
4. **推送与合并需人工执行。** 本会话 auto 模式不允许 `git push`。

# BAD-2026-11-18-02 运行中的用户消息一直显示「排队中」

| 字段 | 内容 |
| --- | --- |
| 编号 | BAD-2026-11-18-02 |
| 日期 | 2026-11-18 |
| 严重级别 | P2 |
| 状态 | Fixed |
| 归属 | Dev 2 |
| 关联分支 | `feat/connectors-ui`（PR #83） |

## 现象

消息进入运行状态后，输入框提示已经变成「正在回复，Enter 插话」，但该条用户气泡
下方仍一直显示「排队中」，直到 `request.done` 才消失。非插话专属：普通发送一条
会运行 60 秒工具的消息同样复现。

## 复现环境

- 服务端：`3b084c9`（`feat/三端联通-server`，PR #84）
- 客户端：`47137b7`（`feat/connectors-ui`，PR #83）
- 测试机真实浏览器 + fake model（`bash sleep 60` 制造工具窗口）
- 证据：`/home/ubuntu/aster-web-verify/artifacts/steer-e2e-20261118/`
  （`01-steer-sent-running.png`、`sse-events-raw.log`）

## 最小复现

1. 普通发送一条会触发长工具调用的消息，不插话。
2. run 开始约 6 秒时检查 DOM：同时存在「排队中」与「正在回复」。
3. 等待 `request.done` 后「排队中」才消失。

## 根因

`use-chat-events.ts` 的 `request.queued` / `request.running` 与
`use-chat-actions.ts` 的 POST `/api/v1/messages` 响应几乎同时到达。

1. SSE 先把本地 outgoing 更新为 `running`，并设置 `activeStatus="running"`；
2. POST 响应随后无条件执行
   `updateOutgoing(clientMessageId, { status: "queued" })`；
3. 之后没有事件再刷新这一行，状态停留在 `queued`，直到 `request.done`。

## 修复

`use-chat-actions.ts` 在 POST 响应落地时读取 store 当前状态：

- 本地已是 `done` / `failed` / `aborted`：保留最终状态；
- 本地已是 `running`，或 active 请求已是同一 `requestId` 的 `running`：写回 `running`；
- 否则才写 `queued`；
- 只有 `queued` / `running` 才允许在无 active 时设置 active，避免晚到的响应
  把已完成请求重新激活。

## 验收标准

- SSE `running` 先于 POST 响应到达时，用户气泡最终显示「正在回复」，不再残留「排队中」。
- SSE `done` 先于 POST 响应到达时，状态保持完成，且不会被重新设为 active。
- 正常时序（POST 响应先到）仍显示「排队中」，随后由 SSE 推进。
- `npm test`、`npm run typecheck`、`npm run build` 通过。

## 证据

- 回归测试：`web/src/features/chat/use-chat-actions.test.tsx`
  - `POST 响应晚于 running 事件时不把状态覆盖回排队中`
  - `POST 响应晚于 done 事件时保留最终状态`
- 修复前两条测试均失败（实际为 `queued`），修复后通过。

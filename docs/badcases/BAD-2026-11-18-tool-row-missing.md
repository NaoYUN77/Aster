# BAD-2026-11-18 工具调用成功后 Web 端不显示工具行

| 字段 | 内容 |
| --- | --- |
| 编号 | BAD-2026-11-18-01 |
| 日期 | 2026-11-18 |
| 严重级别 | P1（功能不可见，不崩溃、不影响工具执行） |
| 状态 | Fixed |
| 归属 | Web 客户端（Dev 2） |
| 关联分支 | `feat/connectors-ui`（PR #83） |
| 发现方式 | 真实后端 + 本地 fake OpenAI-compatible 模型的工具调用 E2E |

## 1. 现象

在 Web 聊天里让模型调用内置工具 `current_time`：

- 后端真实执行了工具，日志为 `decision:"allow"`、`code:"TOOL_ALLOWED"`；
- 模型收到 `tool` 角色结果后生成了最终回答；
- 页面上能看到用户消息、调用前的说明、最终回答；
- **但看不到任何工具调用行**（预期是 `工具：current_time · 完成` 的胶囊/折叠行）。

页面 DOM 检查：

```json
{ "hasToolRowText": false, "detailsCount": 0 }
```

截图：`/home/ubuntu/aster-e2e-shots/tool-01-success-no-tool-row.png`

## 2. 复现环境

- Web：`feat/connectors-ui`，提交 `d443985`
- 后端：同仓库真实 Aster web adapter，临时 `DATA_DIR`，端口 `8788`
- 模型：本地 fake OpenAI-compatible 模型，provider `e2e/fake-tool`，端口 `8790`
- 工具：内置 `current_time`，无需凭据
- 复现脚本仍保留在 `/home/ubuntu/aster-e2e-tool/`（`fake-model.mjs`、`providers.json`）
- 证据：`/home/ubuntu/aster-e2e-shots/tool-e2e-evidence.txt`

> 复现不需要生产环境、不需要真实 token，也不要连接生产后端。

## 3. 最小复现（推荐先写成失败测试）

### 3.1 数据层复现

构造一条后端真实返回形态的历史消息：

```ts
{
  id: "tool-1",
  role: "assistant",
  text: "",
  status: "complete",
  requestId: null,
  clientMessageId: null,
  model: null,
  errorCode: null,
  tool: { name: "current_time", status: "done" }
}
```

调用：

```ts
buildDisplayMessages([toolMessage], { live: {}, outgoing: [], usage: {}, failures: {} })
```

**实际结果**：返回空数组，工具消息在进入渲染前被丢弃。

**期望结果**：返回 1 条消息，且 `tool` 元数据保留。

### 3.2 渲染层复现

把上面的消息直接传给 `MessageItem`：

**实际结果**：渲染出普通 assistant 空气泡「（无文本内容）」，没有 `ToolRow`。

**期望结果**：渲染 `ToolRow`，文本包含 `工具：current_time`。

### 3.3 端到端复现

1. 启动后端（临时数据目录）与 `/home/ubuntu/aster-e2e-tool/fake-model.mjs`；
2. 用 `providers.json` 配置自定义 provider，选择 `e2e/fake-tool`；
3. 发送「请调用 current_time 工具查一下服务器时间」；
4. 等最终回答出现后检查页面和 DOM。

结果同第 1 节。

## 4. 根因

两处客户端逻辑，任意一处单独存在都足以让工具行不显示。

### 4.1 空文本 assistant 被过滤

`web/src/features/chat/display-messages.ts:87`

```ts
if (
  message.role === "assistant" &&
  message.text.trim() === "" &&
  message.status !== "failed"
) {
  continue;
}
```

后端 `src/http/projection.ts` 的 `projectTool()` 把工具结果投影为：

```ts
{
  id: String(entry.id),
  role: "assistant",
  text: "",
  status: "complete",
  tool: { name: message.toolName, status: message.isError ? "failed" : "done" },
}
```

因此工具消息正好命中「空文本 assistant」，在渲染前被 `continue` 掉。

### 4.2 ToolRow 只对 system 渲染

`web/src/features/chat/MessageItem.tsx:44`

```tsx
if (message.role === "system") {
  if (message.tool) {
    return <ToolRow name={message.tool.name} status={message.tool.status} />;
  }
  ...
}
```

工具消息的 role 是 `assistant`，永远进不到这个分支。即使修好 4.1，这里仍会把它当普通 assistant 渲染。

### 4.3 附带事实

当前 SSE 只有 `request.*` 事件，没有 `tool.start` / `tool.end`。所以即使修复，工具行也只在 `request.done` 后重新拉历史时出现，长耗时工具没有实时「运行中」状态。这属于后续增强，不是本 badcase 的修复范围。

## 5. 修复建议

只改客户端，不改后端 API 契约：

1. `display-messages.ts`：空文本 assistant 只有在 `tool === null` 时才过滤。
2. `MessageItem.tsx`：把 `message.tool` 的判断提到 role 分支之前，有工具元数据就直接渲染 `ToolRow`。
3. 补回归测试：
   - `buildDisplayMessages` 保留带 `tool` 的空 assistant 消息；
   - `MessageItem` 对 assistant + tool 渲染出 `工具：<name>`；
   - 不带 `tool` 的空 assistant 仍被过滤，避免空气泡回归。
4. 回归确认：普通文本消息、失败消息、停止/中断占位的行为不变。

## 6. 验收标准

- [x] 修复前新增测试为红，并保留失败输出（证明 badcase 可复现）。
- [x] 修复后新增测试为绿。
- [x] `cd web && npm test`、`npm run typecheck`、`npm run build` 全部通过。
- [x] 用第 3.3 节重新跑一次 E2E：工具行出现，显示 `完成`；最终回答正常；没有重复空气泡。
- [x] 工具失败时显示 `失败`，样式与 `ToolRow` 现有语义一致。
- [x] 不修改后端投影、不修改数据库、不合并 `main`、不部署。

## 7. 证据

- 后端工具授权日志：

```json
{"event":"tool_review","conversationId":1,"taskId":14,"callId":"call_e2e_current_time_1","tool":"current_time","authority":"owner","authz":"read","state":"available","decision":"allow","code":"TOOL_ALLOWED"}
```

- 模型第二轮请求 roles：`["system","user","assistant","tool"]`
- API 返回的工具消息：`role:"assistant", text:"", status:"complete", tool:{name:"current_time",status:"done"}`
- DOM：`hasToolRowText:false, detailsCount:0`

## 8. 修复记录

- 修复 commit：`dbbde27`（`feat/connectors-ui`）
- `web/src/features/chat/display-messages.ts`：空文本 assistant 仅在 `tool === null`
  时过滤；带工具元数据的投影消息保留。
- `web/src/features/chat/MessageItem.tsx`：`message.tool` 判断提到 role 分支之前，
  直接渲染 `ToolRow`，不再输出「（无文本内容）」。
- 回归测试：
  - `display-messages.test.ts`：保留带 `tool` 的空 assistant，仍过滤无 `tool` 的空 assistant。
  - `MessageItem.test.tsx`：assistant + `tool` 渲染 `工具：current_time`，成功/失败两态。
- 验证结果：
  - 修复前：3 个新增用例失败（数据层返回 0 条；组件渲染「（无文本内容）」）。
  - 修复后：`npm test` 4 个文件 / 19 个用例全绿；typecheck、build 通过。
  - 真实后端 + fake model E2E 重跑：DOM `hasToolRowText: true`、`detailsCount: 1`、
    `emptyBubbleCount: 0`；刷新后从历史重载仍显示工具行与最终回答。
- 未修改 `src/**`、未改 API 契约、未合并 `main`、未部署。

## 9. 备注

同一轮 E2E 还观察到：第一轮模型请求直接带了 18 个工具，没有体现 `tool_search` 按需延迟加载。该问题与本 badcase 独立，需要 Dev 1 另行确认，不纳入本次修复。

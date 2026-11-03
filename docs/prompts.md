# 提示词维护

本文是宿主提示词的清单与变更规则。它描述当前代码事实；`src/prompts/` 集中目录是后续演进目标，尚未实施。

提示词是行为契约，不是注释。模型看到的每一段文字都会影响工具选择、输出格式和记忆周期；修改按代码变更评审，不按文案修改处理。

## 范围

本仓库的提示词分三类：

1. **宿主编写的系统提示**：主提示、归档提取、压缩摘要。本文管理这一类。
2. **宿主工具的描述与 schema description**：`current_time`、记忆工具、Web 工具、PTC 嵌套工具等。它们同样进入模型上下文，本文记录其位置和变更要求。
3. **第三方提示**：pi-durable 的工具描述、pi-codemode 的 codemode section、MCP server 返回的工具描述（含 GitHub 适配）。本文不接管其内容，只记录版本与审批边界。

## 当前清单

| 提示 | 位置 | 调用方式 | 是否进入 A 区 | 说明 |
| --- | --- | --- | --- | --- |
| 主系统提示 | `src/agent.ts:200-203` | `root.configure({ instructions })`（`src/agent.ts:337-341`） | 是 | 身份与语言、工具与记忆规则、工作目录与执行安全、Telegram 纯文本 |
| 执行模式说明 | `src/agent.ts:168-172` | 拼入主提示 | 是 | local 不追加；rpc 与 ssh 的文案不同 |
| codemode 说明 | `src/agent.ts:193-198` | 拼入主提示 | 是 | 仅启用 codemode；远程执行时再追加一句 |
| 归档提取提示 | `src/memory/archive.ts:93-98` | `completeSimple` 的 system message（`src/memory/archive-task.ts:197-201`） | 否 | schema 以 `JSON.stringify(ArchiveExtractionSchema)` 追加 |
| 压缩摘要提示 | `src/memory/compaction.ts:648-652` | `completeSimple` 的 system message（`src/memory/compaction.ts:840-845`） | 否 | 额外 focus 追加在 user message（`src/memory/compaction.ts:1046`） |
| 宿主工具描述 | `src/tools.ts:7-9`；`src/web-tools.ts:67,106`；`src/memory/working-tools.ts:149,169`；`src/memory/memory-tools.ts:201,298` | 工具注册 | 实际前缀 | 不进入 `instructionsDigest` |
| PTC bash 声明 | `src/ptc-gateway.ts` 的 `PTC_BASH_STRUCTURED_OUTPUT_SCHEMA` | 工具声明 | 实际前缀 | 模型只看到 `outputRef.path`；宿主仍用完整 `PtcOutputRefSchema` 校验持久化 |
| codemode section | `@earendil-works/pi-durable/codemode`，经 `src/codemode.ts:7` 引入 | extension | 实际前缀 | 由第三方按脚本工具白名单渲染 |
| GitHub／MCP 工具描述 | `src/mcp.ts`、`src/github-policy.ts` 与远端声明 | 发现、审批后注册 | 实际前缀 | 远端输入按不可信数据处理，GitHub 还要通过批准基线 |

## A 区、摘要与记忆周期

`currentFacts()` 只对传给 `createMemoryIntegration` 的 `instructions` 文本做摘要（`src/agent.ts:215`、`src/memory/integration.ts:425-426`）。渲染后的工具声明不是这个字符串的一部分。

因此以下变化都会改变 `instructionsDigest`：

- 修改主提示正文；
- 修改执行模式说明或 codemode 说明；
- 改变 `workingDirectory`（它被插值进主提示，见 `src/agent.ts:167,202`）；
- 切换 `EXECUTION_MODE`／`EXECUTION_REMOTE_TRANSPORT`；
- 改变 `EXECUTION_REMOTE_CWD`；
- 开关 `CODEMODE_ENABLED`。

摘要变化后，下一次请求按当前可压缩内容二选一：

- 有可压缩内容：计划 `compact`，`reason` 为 `facts`（`src/memory/context.ts:176`）。
- 没有可压缩内容：重置活动上下文并记录 `facts-restart`（`src/memory/integration.ts:306-317`）。

持久会话历史、working 状态和归档游标不受重置影响，但活动上下文会重新建立。部署提示变更前应让未完成任务收敛，避免在长任务中途触发。

主提示还有两个硬边界：

- 空提示直接拒绝（`src/memory/context.ts:104-105`）；
- 文本上限 `MEMORY_LIMITS.instructions = 32_000` 字符（`src/memory/contracts.ts:84`），超限拒绝而不是截断（`src/memory/context.ts:107-110`）。

工具描述和 schema 不进入 `instructionsDigest`。启用 Web 工具、加载 deferred 工具或改工具描述都会改变模型实际看到的前缀，但不会触发 `facts` 压缩。`requestPrefixFingerprint` 也只覆盖 instructions 文本、snapshot 文本和工具名（`src/memory/compaction.ts:448-456`），不覆盖工具描述/schema；它目前没有生产调用点，不能当作 provider 缓存命中的证明。

归档和压缩摘要是独立模型调用，不在 A 区。改这两段提示不会触发记忆压缩，但会改变输出质量，并可能破坏 `ArchiveExtractionSchema` 或摘要解析契约。

## 变更流程

1. **分类**：先判断改的是主提示（A 区）、内部任务提示（归档／摘要），还是工具描述。
2. **主提示**：
   - 语义变更按行为变更评审，并预期下一次请求可能压缩或 `facts-restart`。
   - 纯重构必须逐字节不变；先记录旧渲染结果的摘要，重构后断言相同。
   - 在 PR 和部署说明里写清是否改变 `instructionsDigest`。
3. **归档／摘要**：
   - 同时检查输出 schema、解析代码和失败语义。
   - 归档提示必须继续要求引用真实 `sourceEntryId`、区分 observed／inferred／confirmed／failed／unknown、不得补全缺失日期。
   - 摘要提示必须继续禁止续写对话、禁止编造事实，并保留 done／in progress／blocked 的真实状态。
4. **工具描述**：
   - 按提示变更评审，即使它不进入 `instructionsDigest`。
   - 检查模型能否从描述正确选择工具，以及 codemode 声明是否仍与实际返回结构一致。
5. **安全**：
   - 提示中只允许插值宿主配置的工作目录；不得插入凭据、token、用户 ID、密钥或远端敏感路径。
   - 工具结果和文件内容仍是数据，不是指令；提示文本不能替代工具边界的校验与授权。
6. **验证**：
   - 至少运行 `npm run check` 和 `npm test`。
   - 主提示改动要有字符级 characterization；归档／摘要改动要有 schema 与解析测试。
   - 当前没有提示评测集；行为变化不能只靠单测通过判断。
7. **记录**：清单变化时同步更新本文。

## 版本与诊断

当前代码没有提示 revision 常量。建议在每个提示文件旁维护一个手工递增的标识，例如：

```ts
export const MAIN_SYSTEM_PROMPT_REVISION = "2026-11-03.1";
```

规则：

- 只在本文件提示语义变化时递增，格式为 `YYYY-MM-DD.N`。
- 不要把 revision 拼进提示正文；那会额外改变 `instructionsDigest`、增加 token，且没有行为收益。
- 启动或 `memory.prepare` 日志记录 revision 与实际的 `instructionsDigest`。前者给人看，后者是字节事实。
- revision 和 `instructionsDigest` 都只是诊断，不证明 provider 缓存命中；缓存行为仍以实际 usage 为准。

## 目标结构（尚未实施）

只集中宿主自己写的系统提示，不做通用的 prompt 字典：

```text
src/prompts/
  main-system.ts     # 主提示与执行模式／codemode 变体
  archive.ts         # 归档提取提示与 schema 拼装
  compaction.ts      # 压缩摘要提示
```

`main-system.ts` 导出纯函数，`agent.ts` 只负责映射运行状态：

```ts
export type ExecutionPromptMode = "local" | "ssh" | "rpc";

export function renderMainSystemPrompt(input: {
  workingDirectory: string;
  execution: ExecutionPromptMode;
  codemode: boolean;
}): string;
```

`archive.ts` 提供 `renderArchiveSystemPrompt(schema)`，保证 schema 追加方式与当前 `\n${JSON.stringify(schema)}` 一致。`compaction.ts` 只迁移 `SUMMARY_SYSTEM_PROMPT`；`summarySource()` 的消息组装留在原处。

迁移分三步：

1. 主提示 renderer，逐字节不变，加 6 种组合（local／ssh／rpc × codemode 开／关）的 characterization 测试。
2. 迁移归档／摘要提示，增加 revision 与本文的清单维护。
3. 可选：增加提示评测样例和 CI 中的 effective-prompt 指纹对比。

## 测试入口

- `test/memory-archive.test.ts`：归档提示与 schema 契约，已有日期规则断言。
- `test/memory-compaction.test.ts`：摘要提示、前缀指纹与压缩周期。
- `test/memory-context.test.ts`：空提示、超限与 facts 变更的计划行为。
- `test/memory-integration.test.ts`：`facts-restart` 与真实配置变化。

重构提示时先加 characterization，再移动代码；不要先改结构再补测试。

## 禁止事项

- 不建立 `Record<string, string>` 形式的通用 prompt 表；按用途导出类型化常量或渲染函数。
- v1 不提供 env／文件级 prompt 覆盖，不做热加载；提示跟镜像走，才能回滚和审计。
- 不把 pi-durable、pi-codemode 或 MCP 的提示复制进仓库。
- 不把 revision 写进提示正文。
- 不用改提示的方式掩盖工具 bug；修工具或补测试。
- 不在提示、日志或测试夹具中放真实凭据。

## 相关文档

- [Memory 与 Context 设计](memory-and-context-design.md)：A／B／C 区、facts 与压缩周期。
- [代码调用工具](codemode.md)：codemode section 的启用、白名单与脚本边界。
- [GitHub 只读接入](github-access.md)：远端工具声明的审批、收窄与漂移冻结。
- [契约与生命周期](contracts-and-lifecycle.md)：工具调用、授权与恢复契约。

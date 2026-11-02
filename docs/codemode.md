# 代码调用工具（PTC／codemode）

`codemode` 让模型写一段 JavaScript，在 QuickJS WASM sandbox 中依次调用白名单工具；只有脚本结果回到模型上下文，嵌套工具的结果不进入 transcript。设计取舍见 [ADR-0019](adr/codemode-ptc/0019-codemode-ptc.md)。

## 启用

默认关闭。设置 `CODEMODE_ENABLED=1` 后重启应用；工具和 `codemode` 提示 section 才会出现。未启用时工具面、系统提示和配置返回值都保持原样。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CODEMODE_ENABLED` | `0` | `1` 启用；其他非空值启动失败 |
| `CODEMODE_TIMEOUT_MS` | `240000` | 单次脚本期限，含嵌套工具时间；范围 1000–300000 |
| `CODEMODE_MEMORY_LIMIT_BYTES` | `134217728` | QuickJS 内存上限；范围 16 MiB–512 MiB |

脚本期限应小于单次请求的 300 秒等待上限；否则请求可能先被整体取消，模型收不到脚本自己的超时结果。

## 脚本能做什么

工具名 `codemode`，参数是 `{ code: string }`。`code` 是 async function body：

```js
const files = await tools.bash({ command: "printf '%s\\n' a b c" });
return files.output;
```

脚本可以使用：

- `await tools.<name>(args)`：调用宿主白名单工具；参数和结果做 JSON 往返。
- `text()`、`image()`、`exit()`、`console.*`、`return`：产生模型可见结果。
- `store()`／`load()`：在同一个会话的多次 codemode 调用之间保存 JSON。
- `ALL_TOOLS`、`searchTools()`、`describeTool()`、`describeNamespace()`：发现脚本可调用的工具。

沙箱不提供文件系统、网络、`process`、`require`、计时器或模块加载。脚本只能通过注入的工具产生副作用。

## 脚本工具白名单

| 执行模式 | 脚本可调用 |
| --- | --- |
| 本地（默认） | `read`、`write`、`edit`、`bash` |
| 远程（`EXECUTION_MODE=remote`） | 仅 `bash` |

限制通过工具注册的 `callers` 实现。模型仍能看到全部工具；白名单只决定哪些工具进入 `agent.callable`，也就是脚本的 `tools.*` 和 codemode section。每次嵌套调用仍经过注册表的名称、状态、authz 和参数校验。

MCP、记忆、`web_search`／`web_fetch` 和 `tool_search` 不进入 v1 脚本面，继续由模型直接调用。脚本不能用 `codemode` 调用自身。

## 输出与资源

- 模型可见的 codemode 结果上限为 32 KiB／1000 行，保留尾部；底座默认的 4 MiB／100000 行被覆盖。
- 脚本可用首行 `// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}` 请求更小的预算或更短的期限；最终仍受宿主上限和请求等待约束。
- 每个脚本使用独立的 QuickJS worker；脚本结束或 sandbox 关闭后 worker 退出。
- 嵌套工具调用在宿主侧串行执行；脚本里的 `Promise.all` 不会让多个工具真正并发。
- codemode 调用结束（完成、失败或超时）或取消时，仍在运行的嵌套调用被取消；尚未开始的排队调用不会再启动。

## 远程执行

远程执行阶段 1 只有 `bash`，脚本面因此只有 `bash`。大输出不能依赖 codemode 的自动完整输出落盘：该路径需要控制面的文件环境，而模型的文件工具在执行主机上。正确做法是让脚本把大输出写到执行主机文件，再用后续 `bash` 读取：

```js
await tools.bash({ command: "some-command > /home/<execution-user>/workspace/out.txt" });
return "written to out.txt";
```

结果被截断时会附带说明；这只是提示，不代表控制面保存了完整内容。

## 失败语义

| 现象 | 含义 |
| --- | --- |
| 脚本语法错误或抛异常 | codemode 返回错误结果，不执行后续调用；已执行的嵌套调用保持其真实状态 |
| 嵌套工具失败 | 脚本收到 reject 或结构化错误；由脚本决定是否继续 |
| 脚本超时 | 到 `CODEMODE_TIMEOUT_MS` 或脚本书写的 `timeout_ms` 后终止；正在运行的嵌套调用被取消 |
| 输出被截断 | 结果尾部保留，附截断说明；远程模式不会生成可读的完整输出文件 |
| 结果上限拒绝 | 脚本本身失败或输出被宿主截断；错误不伪装成成功 |
| 进程在脚本中途退出 | 底座按 codemode 日志恢复已完成调用；`bash` 等 unsafe 嵌套调用不会自动重跑，未完成结果按未知处理 |

## 恢复边界

codemode 的脚本启动数据、调用日志和输出目录是底座文档，按会话／任务持久化。恢复时脚本从已有日志继续，已完成的嵌套调用返回原结果；重新执行的判断仍遵循每个嵌套工具自己的 replay 策略。

不要把 codemode 当作恰好一次外部副作用：`bash` 仍是 unsafe 工具，崩溃或恢复时未完成的命令可能已经产生副作用。需要幂等的操作由宿主或脚本自行提供稳定标识与核对方式。

## 安全边界

- QuickJS 限制的是脚本运行时的能力，不是操作系统安全沙箱。
- `bash` 与模型直接调用 `bash` 具有相同的宿主权限；生产环境仍应使用独立低权限用户或容器。
- 脚本由模型生成，属于不可信输入；不能把凭据、宿主路径或服务客户端放进脚本参数。
- 脚本源码和命令会进入 durable 会话记录；敏感值不应出现在其中。

## 非目标

- 脚本内 MCP／Web／记忆工具。
- 并行嵌套调用、脚本递归。
- 远程文件 API 或控制面读取远程文件。
- 用 codemode 替代 OS 级隔离或命令审计。

# 浏览器操控 v1

开始日期：2026-10-30。任务：GitHub issue #46。功能决策：[ADR-0015](adr/browser-control/0015-browser-control.md)。

## 目标与范围

Telegram owner 可以用当前配置的模型操控独立 Chromium，并收到网页截图。浏览器运行于 `aster-browser`，Aster 仅运行 Playwright MCP stdio 客户端与 CDP 协议库，不安装浏览器。

- 可选 Compose overlay，CDP 不映射宿主机端口；浏览器可访问公网。
- 浏览器 headless，shm 1 GiB、内存 2 GiB、pids 512、自动重启；BROWSER_PROXY 只影响浏览器。
- BROWSER_CDP_URL 由宿主配置，工具参数不能修改端点、凭据、工作目录或输出路径。
- pi-durable 原生注册 `pw.` 工具；工具参数经过底座校验与宿主执行边界复核，外部调用均不可自动重放。
- 一条持久化请求对应独立 context；正常结束、取消、失败时清理。连接丢失后本轮不继续依赖旧页面；后续请求自动建立新连接。应用重启恢复未完成浏览器任务时明确状态丢失，不能假装原 context 仍在。
- `/browser_health` 不调用模型：打开 about:blank、截图并通过 Telegram 返回，展示容器内存和进程计数；探测超时有界。
- 文件位于宿主 `~/Aster/data/browser/{shots,pages,traces}`，先保存再投递。照片沿用 inbox 的逐段确认、未知结果隔离与人工重投；投递失败不重跑浏览器。

## 边界

请求沿用 5 分钟上限，浏览器导航 20 秒、动作 5 秒、CDP 连接 10 秒；失败显示明确状态。每请求最多 3 张 PNG 截图，每张最大 8 MiB；工具输出沿用 MCP 有界文本契约。文件路径由宿主生成。浏览器内容和页面文本是数据，不提升权限。

本部分只验收公开网页；学习通不登录、不输入身份凭据。百度与谷歌出现安全验证时截图停止，不尝试绕过；谷歌不可达时明确回复“无法访问”。模型仍由 MODEL_PROVIDER / MODEL_ID 配置，不新增模型循环。

## 实施与验收

1. 容器与内部 CDP/metrics，验证网络、资源、代理和共享目录配置。
2. MCP 工具接线、请求隔离、故障后后续请求恢复、持久化截图投递；用本地协议替身覆盖断连、超时、取消、旧数据迁移与未知发送结果。
3. 离线类型检查、测试、构建；Docker 可用后验证镜像内无 Chromium、独立 context、容器重启与 /browser_health Telegram 照片。
4. DeepSeek 与 DeepSeek Flash 各执行百度搜索摘要截图、谷歌搜索摘要截图、学习通公开入口检查；记录模型 id、成功/失败、工具步数、耗时、模型 usage/费用、代理流量及 CPU/内存。费用仅模型与代理，服务器资源不计费。不能执行的验收必须说明阻塞，不编造结果。

完成功能后删除本 spec，将配置与实际验收证据保留于运行文档及 ADR；尚未通过环境验收时保留 spec。

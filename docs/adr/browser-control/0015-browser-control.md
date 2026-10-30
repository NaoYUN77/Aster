# ADR-0015：独立 Chromium 与按请求隔离的 Playwright MCP

- **状态**：Proposed
- **日期**：2026-10-30
- **功能**：browser-control

## 上下文

Issue #46 要求在 4 核、4 GB 部署基线上增加浏览器操控。现有 pi-durable 管理模型循环与执行恢复，通用 MCP 连接中断后永久关闭；Telegram inbox 已实现文本分段落盘、发送确认与未知结果隔离。

## 决策驱动因素

浏览器进程独立限额；请求之间隔离站点状态；应用不随浏览器崩溃退出；不重放结果未知的网页操作；截图投递失败不能重新执行任务。

## 备选方案

- Aster 内安装 Chromium：部署简单，但扩大应用镜像并共享进程/内存故障边界，未采用。
- 共享一个浏览器默认 context：连接开销低，但 cookie、页面引用跨请求污染，未采用。
- 每请求启动 MCP stdio 并通过 CDP 创建 isolated context：存在 MCP 启动开销，但生命周期明确，复用常驻浏览器，采用。
- 中断后自动重试原操作：可能重复提交网页副作用，未采用；下个请求重新连接，本轮明确失去页面状态。
- 直接在工具内发送 Telegram 照片：发送与业务执行耦合，恢复可能重复发送，未采用；继续由 inbox 保存与确认投递。

## 决策

可选 browser Compose overlay；仅 Docker 网络暴露 CDP，宿主不映射端口，代理只配置浏览器进程。内部 metrics 端点读取 cgroup 计数，不挂载 Docker socket。

Playwright MCP 通过 Node stdio 启动，端点、目录和取消信号来自宿主；每请求 `--isolated`，结束关闭 MCP context/连接。注册经过筛选的 `pw.` 工具，保留 schema 验证、治理与 unsafe replay。文件名由宿主生成。失败后不在同一请求重建空 context 伪装为原状态。

截图保存后进入 SQLite 投递记录；旧文本记录通过兼容迁移保留。文本与图片逐段确认，网络结果未知保留 uncertain，补发仅使用已有文件。

## 后果

浏览器重启后的下一请求可重新连接；进行中的请求需要明确失败并由用户决定是否重做。应用关闭时尽力清理 context；进程被强杀的孤立 context 清理由浏览器容器重启处理，不能声称已清理。浏览器隔离不是网站或文件系统安全沙箱。

## 分阶段决策与缺陷历史

### 2026-10-30：浏览器操控 v1

- 相关 spec：`docs/spec-20261030-browser-control.md`。
- 依赖：Playwright MCP 0.0.83 自带 Playwright 1.64 alpha，直接 CDP 库与 sidecar 采用稳定 1.64.1；已用真实容器验证连接、截图、context 清理和重启恢复，后续升级仍需重新检查协议兼容性。
- 工具名称：issue 要求 `pw.` 前缀；不同模型提供商可能限制工具名字符，必须记录真实模型验收，不能假设所有提供商接受点号。
- 初始验证阻塞：开发机 Docker Linux daemon 未运行。随后启动 Docker Desktop 并完成镜像、真实 CDP、context 隔离与清理、同进程重启重连验证；详细证据见 [运行与验收记录](../../browser-control.md)。百度验证页与 Google 429 均截图停止，超星首页可达；尚无模型摘要质量证据。
- 已修复缺陷：CDP 客户端请求 `/json/version/` 时代理返回 404，规范化尾斜杠并补测试；容器重启后首次请求早于就绪，增加操作发送前最多 15 秒的只读就绪探测，网页操作不重试。
- 尚未解决/验收：真实 DeepSeek 与 Flash 的 `pw.` 工具名兼容性、摘要质量、usage 成本、Telegram 图片往返，以及代理流量费用。开发环境无相应凭据；ADR 保持 Proposed，spec 保留。强杀应用后的孤立 context 和历史产物需运维清理，不能当作已实现自动回收。

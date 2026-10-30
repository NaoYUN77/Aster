# 文档索引与阅读边界

产品范围以 [当前目标与开放范围](mvp.md) 为准；配置与运行入口见 [README](../README.md)，仓库工程规则见 [CLAUDE.md](../CLAUDE.md)。历史任务中未纳入的功能，可以按当前目标继续开发。

## 当前参考

| 文档 | 用途与权威范围 |
| --- | --- |
| [当前目标与开放范围](mvp.md) | 产品目标、当前基础与可继续开发的方向；原 MVP 路径保留 |
| [契约与生命周期](contracts-and-lifecycle.md) | 工具、权限、请求、执行恢复与投递契约，以及当前实现限制 |
| [Memory 与 Context 设计](memory-and-context-design.md) | 记忆架构与数据归属；模块实施结论按章节保留，验收状态链接到验收记录 |
| [工具与 MCP](mcp.md) | MCP 配置、工具发现、pin、授权与 OAuth 操作 |
| [ADR 索引](adr/README.md) | 已接受的工程取舍；正文中的早期范围描述是决策上下文 |
| [Web 提供商调研](web-search-provider-research.md) | Web 接入依据、适配契约及该任务的选型边界 |

## 运行与交付

- [部署指南](deployment-test-guide.md)：当前部署、备份、更新与上线验证。
- [部署环境](deployment-environments.md)、[主机备份](host-backup.md)、[投递核查与补发](deliveries.md)：对应操作边界。
- [CI 运行入口](ci-entrypoint.md)：现行检查入口与发布材料契约。
- [CI/CD 设计与实施计划](ci-cd-implementation-plan.md)：当前工作流事实、后续交付设计和按日期保留的历史验收；任务待办不代表生产部署状态。

## 任务、调研与验收记录

| 文档 | 阅读边界 |
| --- | --- |
| [Memory 实施 issues](memory-implementation-issues.md) | MEM-01～08 的任务拆分与交接，不是新任务的领取顺序或全项目功能排除清单 |
| [Memory 验收](memory-verification.md) | 指定环境中的场景结果、缺陷与补测证据，不代替生产部署记录 |
| [工具注册调研](tool-registration-research.md) | 2026-10-22 的比较与分期建议；当前接入方式以 MCP 文档和有效 ADR 为准 |
| [早期 MVP 执行规划](mvp-execution-plan.md) | 2026-10-21 的历史执行步骤、原验收标准及范围，不作为新任务指令 |
| [早期 MVP 验收](mvp-verification.md) | 原阶段的环境与结果；其中的阻塞、测试数量和旧部署路径仅属于当时 |
| [早期代码审查修复规划](review-fix-plan.md) | 特定基线的 F1～F7 修复要求，任务范围限制不延伸到后续开发 |
| [早期 PR 正文草稿](pr-body.md) | F1～F7 当时的交付说明，不是当前待办或运行手册 |
| [历史 Docker 验证](docker-verification.md) | 2026-10-26 的镜像迁移证据，包含已移除的 Vault／router 拓扑 |

## 2026-10-30 清理结果

本次盘点覆盖仓库受管 Markdown（根目录、`docs/` 与脚本说明），处理方式如下：

- **重写产品范围**：`mvp.md` 从封闭的 MVP 清单改为当前目标与开放范围，明确开放计划任务、主动服务、多模态、记忆增强、工具扩展、多会话及入口演进。
- **修正当前入口与契约**：README、CLAUDE.md、契约和记忆设计不再用旧 MVP 决定当前开发范围；当前未实现与未验证项仍明确保留。
- **保留历史证据并解除误用**：旧 MVP 规划、修复规划、验收和 PR 草稿标记为历史；原七条验收留在历史规划内，解除对当前产品范围文件的反向依赖。
- **保留有效工程取舍**：不改写已接受 ADR 的历史正文；ADR 索引及引用旧 MVP 范围的三篇 ADR 增加阅读说明，区分历史上下文与当前产品范围。
- **保留有效操作与专项边界**：部署、投递、备份、CI 与 Web 专项文档中的资源、权限、验证及版本边界继续适用；专项任务的排除项不扩展成全项目禁令。

此次不删除 Markdown 文件。历史记录仍可追溯，新增功能以当前目标、有效契约和相关 ADR 为起点。

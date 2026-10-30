# 文档索引与阅读边界

新功能按各自的临时 spec 推进；配置与运行入口见 [README](../README.md)，仓库工程规则见 [CLAUDE.md](../CLAUDE.md)。历史任务中未纳入的功能，可以在新 spec 中定义并继续开发。

## 按功能的临时规格

新功能使用 `docs/spec-00-<feature-name>.md` 临时规格，文件名中的 `00` 是约定前缀，`<feature-name>` 使用英文小写、单词以连字符分隔。例如 `docs/spec-00-scheduled-tasks.md`；这个示例不是已存在的任务或能力。

每份 spec 聚焦一个功能，写清用户目标、本次范围、相关接口与状态、副作用和授权、资源与失败恢复边界，以及可检查的验收条件。实施中的决定与调整在对应 spec 中维护，不把某个功能的排除项提升为全项目禁令。

功能完成后，将仍需长期维护的配置、接口和运行说明更新到对应文档；架构取舍写入 ADR。临时 spec 可以归档或删除，收尾时同步更新所有引用，保留必要的验收证据。归档 spec 仅用于追溯，不再作为当前任务指令。

仓库不维护总的 MVP 产品边界文档，不新增或恢复 `mvp.md`，也不在本索引重建一份总功能范围清单。

## 当前参考

| 文档 | 用途与权威范围 |
| --- | --- |
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

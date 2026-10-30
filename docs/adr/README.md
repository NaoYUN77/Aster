# 架构决策记录（ADR）

本目录只放决策记录：选了什么、放弃了什么、代价是什么。部署步骤、接口契约和验收记录放在 `docs/` 的其他文件里。

一篇只记一个决策。文件名 `NNNN-标题.md`，编号不复用。已接受的正文不改成另一个决策；决定变了就新写一篇，并在旧篇状态里注明被哪篇取代。错别字可以直接修正。

仓库没有记录的价格、工期或损失不补数字。决策证据放在附录或对应的验收记录里，正文只保留支撑结论所需的摘要。

上下文和备选方案中的 MVP 范围、实现数量与未完成项描述的是决策当时的情况；产品功能是否可以继续开发，以 [当前目标与开放范围](../mvp.md) 为准。已接受决策的具体取舍仍然有效，改变取舍时按上述规则记录后继 ADR。

## 模板

```markdown
# ADR-NNNN：标题

- **状态**：Proposed | Accepted | Deprecated | Superseded by ADR-NNNN
- **日期**：YYYY-MM-DD

## 上下文

发生了什么，当时哪些事实已经写在仓库或提交说明里。

## 决策驱动因素

影响取舍的长期约束。

## 备选方案

每个选项的优缺点，以及没有采纳的原因。

## 决策

选定的做法。

## 后果

得到什么，接受什么成本，之后哪些行为以此为准。
```

## 索引

| 编号 | 标题 | 状态 | 位置 |
| --- | --- | --- | --- |
| 0001 | 生产环境 MCP 以 stdio + token 为主，OAuth 走带外授权 | Accepted，2026-10-28 | [0001-mcp-access-stdio-first-oauth-out-of-band.md](0001-mcp-access-stdio-first-oauth-out-of-band.md) |
| 0002 | 工具检索先用 BM25，语义检索按信号延后 | Accepted，2026-10-28 | [0002-tool-search-bm25-before-semantic.md](0002-tool-search-bm25-before-semantic.md) |
| 0003 | 工具体系 v0.1：统一治理先行，按瘦身清单分期 | Accepted，2026-10-28 | [0003-tool-governance-v01-scope.md](0003-tool-governance-v01-scope.md) |
| 0004 | 退役 `workspace/MEMORY.md` | Accepted，2026-10-28 | [0004-retire-workspace-memory-md.md](0004-retire-workspace-memory-md.md) |
| 0005 | 删除 Agent Vault，改为单服务 | Accepted，2026-10-28 | [0005-remove-agent-vault-single-service.md](0005-remove-agent-vault-single-service.md) |
| 0006 | 提供商只登记显式 API key | Accepted，2026-10-21 | [0006-explicit-api-key-providers.md](0006-explicit-api-key-providers.md) |
| 0007 | 投递不承诺恰好一次 | Accepted，2026-10-21 | [0007-delivery-not-exactly-once.md](0007-delivery-not-exactly-once.md) |
| 0008 | 外部工具调用不自动重放 | Accepted，2026-10-21 | [0008-unsafe-tool-replay.md](0008-unsafe-tool-replay.md) |
| 0009 | 同一回合的工具顺序执行 | Accepted，2026-10-21 | [0009-sequential-tool-execution.md](0009-sequential-tool-execution.md) |
| 0010 | 状态用内置 SQLite，不另起数据服务 | Accepted，2026-10-21 | [0010-sqlite-no-extra-data-services.md](0010-sqlite-no-extra-data-services.md) |
| 0011 | Telegram 长轮询，不开公网 webhook | Accepted，2026-10-21 | [0011-telegram-long-polling.md](0011-telegram-long-polling.md) |
| 0012 | 安装方式改为 Docker，systemd 只留迁移 | Accepted，2026-10-27 | [0012-docker-replaces-systemd.md](0012-docker-replaces-systemd.md) |
| 0013 | agent loop 只用 pi-durable | Accepted，2026-10-21 | [0013-pi-durable-agent-loop.md](0013-pi-durable-agent-loop.md) |
| 0014 | 工具由人注册 | Accepted，2026-10-22 | [0014-humans-register-tools.md](0014-humans-register-tools.md) |

# 架构决策记录（ADR）

本目录存放 Aster 的架构决策记录。凡是**在多个策略之间做过比较、且结论会影响后续实现**的决策，都应在这里留一篇，而不是只存在于对话或提交信息里。

## 约定

- 一篇只记一个决策，文件名 `NNNN-标题.md`，编号递增、不复用。
- 模板（MADR 精简版）：状态与日期 → 上下文 → 决策驱动因素 → 备选方案（逐项优缺点与落选理由）→ 决策 → 后果（正面与负面成本都要写）→ 必要时附录放证据。
- 状态取值：Proposed / Accepted / Deprecated / Superseded by ADR-NNNN。
- **已接受的 ADR 不修改原文**；决策变了就写新的一篇取代它，并在旧篇状态里注明被哪篇取代。错别字修正除外。
- 决策的证据（测试报告、数据）放附录或外部文件，ADR 正文只保留支撑结论所需的摘要。

## 索引

- [ADR-0001：生产环境 MCP 接入以 stdio + token 型为主，OAuth 型走带外授权](0001-mcp-access-stdio-first-oauth-out-of-band.md) — Accepted，2026-10-28
- [ADR-0004：退役 `workspace/MEMORY.md`，长期事实只走分层记忆](0004-retire-workspace-memory-md.md) — Accepted，2026-10-28

ADR-0002 与 ADR-0003 尚未写入本分支。编号 0004 与提交 `b59e0cf` 的说明一致，不为了连续编号而改掉已有引用。

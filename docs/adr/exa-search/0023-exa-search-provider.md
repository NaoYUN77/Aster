# ADR-0023：新增 Exa 作为可选第二搜索提供商

- **状态**：Accepted
- **日期**：2026-11-09
- **功能**：exa-search

## 上下文

Aster 的内置 Web 工具原先只有一组 DeepSeek 工具：`web_search` 与 `web_fetch`，由 `DEEPSEEK_WEB_API_KEY` 一个凭据一起启用，选型依据与契约写在 [内置 Web 工具提供商调研](../../web-search-provider-research.md)。那份调研明确「本期不做多提供商切换或自动降级」，并且当时把 Tavily／TinyFish 作为需要专用域名列表、更长 query 或参数化过滤时的候补，考核维度是接口与运维成本，不是检索质量排名。

2026-11-09 所有者要求新增一个 Exa 搜索工具，并先确认它的免费额度。Exa 公开的免费 Starter 层是每月 $10 credits、另有一次 $10 开户奖励、不要求绑卡、可用全部端点，10 Search QPS。

## 决策驱动因素

- **成本落点**：个人助手的搜索量应能在免费额度内跑，超出时的单价必须是公开、可预测的按次价，而不是套餐或席位。
- **契约边界**：新提供商不得改变既有 DeepSeek 工具的输入、输出、错误码、治理或预算；DeepSeek 侧已有测试与缺陷记录（WEB-01／WEB-02）。
- **凭据与治理**：凭据只经部署环境注入，模型参数不得包含 key、endpoint、header 或身份；新工具与既有内置 Web 工具同属只读、不可自动重放。
- **不做自动降级**：两个搜索提供商之间的自动切换会把「哪家回答了这次提问」变成隐式行为，无法用凭据独立开关，也会让成本归因和失败语义混乱。

## 备选方案

- **换成 Exa，替换 DeepSeek 工具**：改动最小，但会作废既有 DeepSeek 契约、测试与 `schemaHash` 记录，并在没有真实 Exa 验证的情况下放弃一条已工作的检索路径。不采纳。
- **只挂官方 hosted MCP（`mcp.exa.ai/mcp`）**：不需要写 provider 代码，但会把搜索能力绑在 MCP 子进程／远端会话的生命周期、pin 与授权路径上，与「内置 Web 工具直接走工具注册表、不额外进程」的既有边界冲突，且首次使用需 OAuth。不采纳。
- **接入 Tavily 或 TinyFish 作为第二提供商**：Tavily 需要付费套餐才有生产 key（PAYGO $0.008／credit）；TinyFish 的价格页与 API 文档当时互相矛盾，超额单价也没在 Search 参考里给出。都不如 Exa 的免费额度与公开按次价清晰。不采纳，保留为候补。
- **新增 `exa_search`，与 DeepSeek 工具并存**（采纳）。

## 决策

新增内置工具 `exa_search`，直接调 Exa REST `POST https://api.exa.ai/search`，由独立凭据 `EXA_API_KEY` 控制注册；`web_search`／`web_fetch` 保持由 `DEEPSEEK_WEB_API_KEY` 控制。两者可同时启用，模型会同时看到两个搜索工具，不做自动降级或切换。

工具契约（完整表见 [调研 §7](../../web-search-provider-research.md#7-exa-search内置-exa_search-的契约调研)）：

- 参数只有 `query`（1–128 Unicode code point）与 `maxResults`（1–10，省略时 5）；固定 `type:"auto"` 与 `contents:{highlights:true}`，不发域名／日期过滤、`moderation`、`additionalQueries`。
- `maxResults` 上限 10 与固定 `auto` 是**价格约束**，不是厂商限制：Exa 的基础价只含 10 条结果，`lite`／`deep` 分别更便宜与更贵。
- 结果形状按 Exa 自己的字段声明（`rank`／`title`／`url`／`snippet`／`publishedAt` 加顶层 `notices`），不是 DeepSeek 形状去掉字段后的版本：Exa 不返回站点名与摘要，也不要求 provider 之外的信息。
- 错误码沿用内置 Web 工具的既有集合，不新增码：403 归入 `UPSTREAM_HTTP_ERROR`（厂商语义是团队被禁或功能未启用，模型无法自行修复），402 归入 `PROVIDER_BALANCE_REQUIRED`——这条对免费额度用尽尤其重要，不能被当成空结果。
- 三项内置 Web 工具共享 2 路并发、20 秒本地 deadline、256 KiB 上游响应预算与 24 KiB 模型输出预算；不排队、不自动重试、不缓存。

## 后果

- 需要 `EXA_API_KEY` 才会注册 `exa_search`；未设置时模型完全看不到它，README、`.env.example` 与 MITM allowlist 都按「可选凭据」登记。
- Exa 的额度与价格成为运行成本的一部分：免费层每月 $10 credits，超出后按次计费。README 记录量级，不承诺具体次数——在 `/search` 内联请求 `contents.highlights` 是否另按 Contents／摘要行目计费，官方文档没有说明（见调研 §7 待确认项）。
- 两个搜索工具并存会增加一次模型选择：描述里写明 `exa_search` 走 Exa 自己的索引，模型据描述与工具名区分。
- 新增一处外部依赖面：出站需可达 `api.exa.ai`（MITM 占位符模式的 allowlist 已加入精确匹配）。
- **未验证**：全部结论来自公开文档与规范，没有用真实 Exa key 发起过请求；免费层 QPS、计费行目、`query` 长度上限、取消后是否仍计费都未实测。真实 key 的脱敏 smoke test 需要单独授权，可能产生费用。

## 分阶段决策与缺陷历史

### 2026-11-09：本次开发部分

- 相关 spec：本次未另建临时 spec。改动是单提供商接入并沿用既有 `web-tools` extension 模式，契约与取舍直接记在本 ADR 与调研 §7，实现与测试见 `src/exa-search.ts`、`src/web-tools.ts`、`test/exa-search.test.ts`。
- 决策与取舍：按上面的四个备选方案取舍；`web_search`／`web_fetch` 的输入、输出、错误码与治理不变，只把 Web extension 的构造参数从单一 `apiKey` 改为按提供商的 `deepseekApiKey`／`exaApiKey`，并让没有任何凭据时直接抛错而不是注册空 extension。Exa 的响应适配沿用 WEB-01 的教训：只有 `title`／`url` 是必需字段，空的 title、空的 highlights 是合法结果；`notices` 里缺省或为空的 `code`／`message` 归一为 `""`（只有类型错误才失败），因为只带 code 的 notice 依然要交给模型；未消费字段与未知字段忽略；非法日期／URL 仍整批失败，不用默认值伪造。
- 相关缺陷：**尚未发现**（未做真实调用）。已知缺口一项，不是缺陷而是本期的取舍：规范要求 provider 的 `warnings[]` 由维护者记录日志、不交给模型，本工具既不透传也不写日志——该模块没有宿主日志通道。若之后需要，应由宿主在工具边界注入日志端口，而不是让 provider 客户端直接写 stderr。

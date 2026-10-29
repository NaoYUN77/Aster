# web_search 提供商调研与接入建议

状态：调研与实施依据。核对日期：2026-10-29。范围：Aster 的本地 stdio MCP server，只暴露 `web_search`。本文核对公开官方文档／规范，未使用 API key 发起真实搜索，也未验证生产服务器的网络与搜索质量；在线文档可能继续变化。实现与实际配置以代码、schema 和 README 为准。

## 1. 建议

首选 **DeepSeek Search**，直接调用独立 REST Search API，不调用聊天模型。它现在已有正式的 Search／Fetch 文档，不能再沿用“DeepSeek API 不提供搜索”的旧结论。其请求小、结构化结果明确、错误与空结果计费规则清楚，适合只返回来源及摘要的窄工具。[D1][D2]

这是基于接口和运维成本的选择，并非检索质量排名：DeepSeek 的公开价格为 **$0.75／1,000 次成功且非空搜索**；Tavily PAYGO 的 basic 搜索折算为 **$8／1,000 次**（1 credit／次，$0.008／credit），另有每月 1,000 免费 credits；TinyFish 免费额度更大，但其价格页与 API 文档当前不一致，超额收费单价未在所查 Search 参考中给出。[D2][T1][T2][F1][F3]

关键限制：DeepSeek `query` 最多 **128 个 Unicode 字符**，需要明确拒绝过长输入，不能静默截断。若后续确需专用域名列表、较多参数化过滤或更长查询，应重新评估 Tavily；本期不做多提供商切换或自动降级。[D1][T1] 部署地并未提供，不能以“中国／海外提供商”推断可达性或性能；生产容器验证通过后才启用。

## 2. 官方能力与线缆契约

| 项目 | TinyFish Search | Tavily Search | DeepSeek Search |
| --- | --- | --- | --- |
| 实际搜索能力 | 独立排名搜索；`web`、`news`、`research_paper`。Search 找 URL，Fetch 取正文，Agent 执行网页工作流，三者不同。[F1][F2] | 独立 Search；`general`、`news`、`finance`，返回相关内容片段；可选生成答案与原文。[T1] | 自有搜索引擎，独立 Search 返回排名结果；Fetch 是另一端点，不需要使用 DeepSeek 聊天模型。[D1][D2] |
| HTTP／认证 | `GET https://api.search.tinyfish.ai`；`X-API-Key` header。其官方远程 MCP 使用 OAuth 2.1；自建本地包装 REST 不需要该 OAuth 流程。[F2][F4] | `POST https://api.tavily.com/search`；`Authorization: Bearer <key>`，JSON body。[T1] | `POST https://api.deepseek.com/v1/tools/search`；`Authorization: Bearer <key>`，`Content-Type: application/json`。[D1][D2] |
| 最小输入 | URL query 参数 `query`。`page` 从 0 开始、最大 10；当前参数表未列出每页条数控制，也未明确 `query` 长度上限，不据示例推导保证。[F2] | 必填 `query`；`max_results` 0–20、默认 10；`search_depth` 默认 basic，可选 advanced／fast／ultra-fast。[T1] | `query` 1–128 Unicode 字符、不能全空白；`count` 1–50、默认 10；可选 `ori_question`（1–128 字符，null 等同省略）、`localization`（IP 地址）、`need_content`（默认 false）。未知 body 字段被忽略。[D1][D2] |
| 过滤与上下文 | `include_domains`／`exclude_domains` 为逗号分隔字符串；`location`／`language` 自动配对，均省略时 US／en；`purpose` 最多 2,000 字符；日期、相对新鲜度及论文年份过滤。[F2] | 域名数组分别最多 300／150 项；日期／时间窗口、国家、语言等控制；`auto_parameters` 可能选择 advanced 并增加 credit 消耗。[T1] | 查询保留搜索语法，支持 `site:`、`-site:`、`-`、引号、`lang:`、`after:`、`before:`，多个站点可用 OR；不另造未记录的 JSON 域名参数。[D2] |
| 成功响应 | `{query,results,total_results,page}`；每项含 `position,site_name,title,snippet,url`，按类别附带日期、publisher 或论文信息。`total_results` 是返回数量，不是全网命中总数。[F2] | 顶层 `query,results,images,response_time` 等；每项含 `title,url,content,score`，可选 `raw_content,published_date` 等。`answer` 为可选生成答案；`usage` 需请求。内容片段长度为目标值，不是硬上限。[T1] | `{results:[...]}`，空匹配为 `[]`。每项字段见下节；`need_content:false` 时 `content` 始终为空字符串。[D1][D2] |

TinyFish 新鲜度参数：`recency_minutes` 为 1–5,256,000 整数，不可与 `after_date`／`before_date` 混用；日期格式 YYYY-MM-DD，起始不得晚于结束；论文搜索不支持这些日期参数，应使用 0–9999 的 `pub_year_min/max`。[F2]

Tavily 的日期是估计的发布或最后更新时间；默认日期窗口仍可能保留未知日期结果，严格剔除需 `filter_by_published_date:true`。其参考的 OpenAPI 仍把 `answer` 列入 required，而字段说明说只在 `include_answer` 开启时返回；不应依赖该 required 列表强制读取可选答案。[T1]

## 3. 价格、额度与错误

| 提供商 | 官方价格／限制 | 错误契约与取舍 |
| --- | --- | --- |
| TinyFish | **存在官方冲突**：Search 参考写每日 12,000 次免费、00:00 UTC 重置，之后需钱包余额为正；个人默认 30 requests/min，组织按合同。价格页却写 Search $0／次、任意钱包余额免费，30/min 且 500/hour。不能据此承诺无限免费；超过免费额的精确单价与实际生效限额应向账户后台／厂商确认。[F2][F3] | Search 参考列 400、401、402、403、404、429、500、503。402 为 `INSUFFICIENT_CREDITS`，不扣钱包的 beta 产品可能为 `FREE_ALLOWANCE_EXHAUSTED`；503 建议退避。不要把它的 Agent 运行错误当 Search 错误。[F2] |
| Tavily | 每月 1,000 free credits、无需信用卡；basic／fast／ultra-fast 1 credit，advanced 2。PAYGO $0.008／credit；月套餐例如 $30／4,000、$100／15,000、$220／38,000、$500／100,000。Development 100 RPM，Production 1,000 RPM；生产 key 需付费套餐或开通 PAYGO。[T1][T2][T3] | 400 请求错误，401 key 错误，422 字段校验；429 限流（有 `Retry-After` 时遵守）；432 key／plan limit，433 PAYGO limit，434 免费方案的实时抓取容量不足，500 服务错误。通常为 `{detail:{error:...}}`，422 的 detail 是数组；按状态分类，不匹配错误文本。[T1][T3] |
| DeepSeek | Search **$0.75／1,000 次**；仅 HTTP 200 且 `results` 非空计费，失败、空结果、超时不收费，count 不影响单价。每账户 Search 100 QPS、Fetch 25 QPS，互不占用，与模型并发额度独立。[D2] | OpenAI 风格 `{error:{message,type,param:null,code}}`。400、401、402、408、413、429、500、504；403／404 在指南中针对 Fetch，不能把搜索无结果解释成 404。官方建议 408／429／5xx 等待重试，402 充值后再试，其余 4xx 改正后再试。[D2] |

DeepSeek 的临时免费说明特指通过 DeepSeek Harness／Claude Code／Codex 的服务端工具调用，文档宣布 **2026-11-01 00:00 北京时间**开始按次计费；不能把这段说明外推为自建 Aster REST 调用永久免费或当前必然免费。预算按公开单价计算。[D2]

## 4. 本地工具契约

以下是本次实现采用的项目契约，不是厂商承诺。只实现一个提供商、一个工具，不增加第二套 agent loop。[R1]

### 输入与宿主配置

MCP 原始名称 `web_search`，server 名为 `web`，Aster 注册名为 `mcp__web__web_search`。[R2]

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["query"],
  "properties": {
    "query": { "type": "string", "minLength": 1, "maxLength": 128 },
    "maxResults": { "type": "integer", "minimum": 1, "maximum": 10, "default": 5 }
  }
}
```

schema 的 default 只是声明；执行边界仍显式应用省略时的 5。双方都校验，server 不能依赖某个客户端已经校验。query 拒绝全空白、孤立 Unicode surrogate 及超限，按 Unicode code point 数计数；首尾空白在边界清理，其余原样转发，不静默裁剪，不自动改写搜索语法。模型参数不包含 key、endpoint、header、代理、IP 定位或身份。[R1][D1][D2]

server 仅从自己的环境读取 `SEARCH_DEEPSEEK_API_KEY`；标准宿主配置的环境引用缺失时，该 server 在 Aster 连接前即被禁用；执行边界也拒绝空 key，不把凭证问题伪装成空搜索。固定 HTTPS 端点，拒绝跟随重定向，避免把 Authorization 转发到别处。镜像内宿主配置示意：

```json
{
  "servers": [{
    "name": "web",
    "transport": "stdio",
    "command": "/usr/local/bin/node",
    "args": ["/app/dist/src/web-search-mcp.js"],
    "inheritEnv": false,
    "env": { "SEARCH_DEEPSEEK_API_KEY": "${SEARCH_DEEPSEEK_API_KEY}" },
    "timeoutMs": 30000,
    "connectTimeoutMs": 10000
  }],
  "tools": { "mcp__web__web_search": { "authz": "read" } }
}
```

这是凭证不进入模型参数的部署方式，**不是对 agent 的秘密隔离保证**：Aster 现行 `${ENV}` 由宿主解析，同 uid 的 bash 可读取进程环境和文件。需要防止模型经 bash 读取 key 时，改用独立用户／容器／受控凭证代理；仅另开 stdio 进程不构成隔离。[R2][R3]

### 上游请求与结果转换

一次调用只发一个请求：

```http
POST /v1/tools/search HTTP/1.1
Host: api.deepseek.com
Authorization: Bearer <宿主环境中的 key>
Content-Type: application/json
Accept: application/json

{"query":"用户 query 原文","count":5,"need_content":false}
```

`count` 取已验证的 maxResults。省略 `ori_question`、`localization`；不额外发送完整聊天记录或用户 IP。不调用 Fetch，不生成 answer。[D1][D2]

上游每个 result 的正式字段：`rerank_score`（文档语义 0–3）、`title`、`url`、`snippet`、`summary`、`content`、`site_name`（string/null）、`site_icon`（string/null）、`date`（UTC RFC 3339/null）、`authority`（整数 -1–4，-1 为未知）。snippet 通常 100–200 字符，summary 通常 600–800；“通常”不是可安全分配内存的上限。[D1][D2]

成功的项目结果对象：

```ts
{
  ok: true,
  provider: "deepseek",
  query: string,
  results: Array<{
    rank: number,                 // 按上游数组顺序，从 1 开始
    title: string,
    url: string,
    snippet: string,
    summary: string,
    siteName: string | null,
    publishedAt: string | null   // 有效日期归一为 UTC ISO 8601
  }>
}
```

在适配边界校验上游正式字段类型、score／authority 范围、日期及绝对 HTTP(S) URL（拒绝含用户名／密码的 URL）；未知新增字段忽略。缺字段或非法字段返回 `UPSTREAM_PROTOCOL_ERROR`，不把 null 变成编造的站点／时间，不丢掉坏结果伪装完整成功。保留上游排序，结果数不得超过请求 count；score 与 authority 留在供应商边界内，不包装成跨提供商通用可信度。`results:[]` 是 `ok:true`，表示没有匹配。[R1][D1][D2]

MCP 返回 `structuredContent` 为上述对象，同时在单个 `content:[{type:"text",text:JSON.stringify(对象)}]` 中给出同一对象，`isError:false`；发布的 outputSchema 涵盖成功与失败两种对象。MCP 2025-11-25 明确建议向后兼容的 JSON 文本副本；2026-07-28 允许任意 JSON structuredContent，本实现仍使用对象兼容两代。协议版本按 Aster 已装 pi-mcp 1.3.0 使用 2025-11-25，并由 stdio 集成测试验证初始化、列举和调用。Aster 当前适配器经 `toLlmContent` 输出，并未把 server 的 structuredContent 保存成应用自有结构化 details，因而不能只返回 structuredContent。[M1][M2][R1][R4]

### 失败、取消与资源上限

预期执行失败返回 `isError:true`，文本与 structuredContent 同含：

```ts
{ ok: false, error: { code: string, message: string, retryable: boolean } }
```

message 使用本地固定安全文案，可说明修改 query／检查 key／余额等恢复动作；不透传响应 body、headers、URL 查询串、key、环境或底层异常。错误码如下；retryable 仅表示后续重新调用可能成功，**本期不自动重试**。

| 条件 | code | retryable |
| --- | --- | --- |
| 工具参数不合法；不发 HTTP | `INVALID_ARGUMENT` | false |
| 达到本地并发上限；不发 HTTP | `BUSY` | true |
| HTTP 400／413 | `UPSTREAM_REQUEST_REJECTED` | false |
| HTTP 401 | `PROVIDER_AUTH_FAILED` | false |
| HTTP 402 | `PROVIDER_BALANCE_REQUIRED` | false |
| HTTP 429 | `RATE_LIMITED` | true |
| HTTP 408／5xx（包括 504） | `PROVIDER_UNAVAILABLE` | true |
| 其他非 200／重定向 | `UPSTREAM_HTTP_ERROR` | false |
| DNS／连接／TLS 等网络失败 | `NETWORK_ERROR` | true |
| 本地 20 秒上游总超时 | `TIMEOUT` | true |
| HTTP 200 但 JSON／字段／日期／URL 不合法 | `UPSTREAM_PROTOCOL_ERROR` | false |
| 上游 body 或最终模型文本超过预算 | `RESULT_TOO_LARGE` | false |

厂商状态含义依据 [D2]；错误码、总超时、并发和输出预算是本项目策略。一次请求的实际 I/O 使用取消信号，覆盖建连及 body 读取，20 秒后 abort；stdio 的取消通知也 abort 对应 HTTP。客户端已取消时遵守所协商版本的 MCP 取消语义，不发送迟到成功；本地超时但调用尚有效时才返回 TIMEOUT。[M3][R1] 中断连接不能证明远端未搜索／未计费；若远端已经返回成功但响应丢失，客户端无法断言其是否收费，不承诺“取消必不计费”。

资源边界：每 server 最多 2 个正在执行的搜索，无内存等待队列，超额立即 BUSY；上游响应按解压后的实际读取字节限 **256 KiB**，超过即取消读取；序列化后的模型文本限 **24 KiB**，超过显式失败，不静默截断／删结果。使用紧凑 JSON 保持低于 Aster 的 32 KiB／1,000 行文本上限；请求最多 10 项。没有自动重试、分页追取、结果缓存或 durable 重放，避免重复查询费用与恢复状态混淆；现有 Aster MCP 工具仍为 `replay:"unsafe"`，宿主 read 授权不改变重放策略。[R1][R2]

JSON-RPC 结构损坏／未知方法等协议错误由本地 stdio 协议边界处理；参数语义、上游 API 与业务失败用工具 `isError`，不能用成功空数组吞掉失败。Search 结果属于不可信外部内容，不把标题／摘要作为宿主指令或授权来源。[M1][R1][R2]

## 5. 网络与部署验收

三者的上述路径都是远端 HTTPS API，本地 stdio 只负责 MCP 传输；仍需出站 DNS／TLS／443。建议本期只允许固定 `api.deepseek.com` 出站，server 不主动访问结果 URL；该方案无需本地浏览器、GPU、入站端口或 OAuth 回调。stdio 使用与当前 pi-mcp 客户端一致的换行 JSON-RPC framing，stdout 仅协议消息，固定诊断写 stderr。[D1][F2][T1][M4]

Aster 子进程默认环境允许列表**不包含代理和 CA 变量**，不能认为宿主可联网即子进程可联网。需要代理／企业 CA 时，在经审计的 server 配置中显式传递所需变量，并确认选用的 HTTP 客户端实际采用它们；不默认承诺 Node fetch 自动读取 HTTP_PROXY。Docker 中 command／args 必须指向镜像内程序，stdio server 及依赖需预装到派生镜像，固定直接依赖版本，不在运行时通过未固定的 npx 下载。[R3][R5][R1]

实施前验收：从实际生产镜像与网络测试 key 的权限、DNS／TLS／代理路径、中文／英文查询及操作符、空结果、128 字符边界、401／402／429／504 映射、取消及超时是否终止读取、并发与输出预算、stdout 协议纯净度、日志无秘密。用固定样本比较检索质量与延迟后再决定是否调整提供商；本调研没有给出中国大陆可达性、全球数据驻留或 SLA 的保证。

## 6. 一手来源

- [D1] DeepSeek [Search API Reference](https://api-docs.deepseek.com/api/search/)：端点、认证示例、完整输入／结果 schema。
- [D2] DeepSeek [Search & Fetch guide](https://api-docs.deepseek.com/guides/search/)：搜索能力、操作符、空结果、错误、收费条件、限流与 2026-11-01 计费说明。
- [F1] TinyFish [Search overview](https://docs.tinyfish.ai/search-api)：搜索用途及与 Fetch／Agent／Browser 的区分。
- [F2] TinyFish [Search API Reference](https://docs.tinyfish.ai/search-api/reference)：参数、结果、状态码、每日额度和 RPM。
- [F3] TinyFish [Pricing](https://www.tinyfish.ai/pricing)：Search 免费、30/min／500/hour，与参考文档的差异。
- [F4] TinyFish [Authentication](https://docs.tinyfish.ai/authentication)：REST API key 与官方远程 MCP OAuth 的区别。
- [T1] Tavily [Search API Reference](https://docs.tavily.com/documentation/api-reference/endpoint/search)，[同页原始 OpenAPI](https://docs.tavily.com/documentation/api-reference/endpoint/search.md)：端点、认证、参数、结果、状态码与 schema 差异。
- [T2] Tavily [Credits & Pricing](https://docs.tavily.com/documentation/api-credits)：免费 credits、套餐和 PAYGO 单价。
- [T3] Tavily [Rate Limits](https://docs.tavily.com/documentation/rate-limits)：开发／生产 key、429／Retry-After、434。
- [M1] MCP [2025-11-25 Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)：输入、structuredContent 文本副本、outputSchema、协议与执行错误。
- [M2] MCP [2026-07-28 Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)：当前结构化结果规范。
- [M3] MCP [2026-07-28 Cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation)：stdio 通知、超时与迟到响应处理。
- [M4] MCP [2025-11-25 Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)：stdio framing、stdout／stderr 边界。
- [R1] 仓库 [CLAUDE.md](../CLAUDE.md)：技术基线、数据／凭据／副作用与资源边界。
- [R2] 仓库 [contracts-and-lifecycle.md](contracts-and-lifecycle.md)：工具注册、宿主授权、静态凭证、MCP 输出与重放契约。
- [R3] 仓库 [src/mcp-config.ts](../src/mcp-config.ts)、[src/mcp.ts](../src/mcp.ts)：环境引用、inheritEnv、子进程允许列表。
- [R4] 仓库 [src/mcp.ts](../src/mcp.ts)：工具执行经 toLlmContent 转换，应用 details 只含 server／tool。
- [R5] 仓库 [deployment-test-guide.md](deployment-test-guide.md)：Docker 内绝对路径、stdio 依赖安装与部署要求。

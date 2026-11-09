# ADR-0024：自定义模型提供商由声明文件描述，底层用底座原语

- **状态**：Accepted（真实网关的目录与推理已跑通；经 MITM 出站替换的链路待 live 部署验证）
- **日期**：2026-11-09
- **功能**：custom-providers

## 上下文

模型层原先只有 `src/providers.ts` 里 12 家编译进代码的提供商，且明确不支持自定义 base URL 的 OpenAI 兼容端点（[ADR-0006](../../adr/0006-explicit-api-key-providers.md)）。这份名单与启动校验都写死在同一处，新增一家要改代码并重新发版。

2026-11-09 所有者给出一个新的 OpenAI 兼容网关（管理页仅本机；VPC 地址、Tailscale 地址、key 走 OpenBao），并提出「把 aster 底层改成底座提供的原语，密钥还是进 openbao」。

底座 pi-ai 1.5.0 已经把这件事做成原语：`createModels()`、`createProvider()`、`envApiKeyAuth()`，以及四个协议实现 `openAICompletionsApi` / `openAIResponsesApi` / `anthropicMessagesApi` / `googleGenerativeAIApi`（`@earendil-works/pi-ai/api/<name>.lazy`）。内置 provider 就是用它们写的，所以自定义 provider 可以走**同一份契约**：provider 拥有身份、base URL、认证方法与模型目录；`Models` 负责解析凭据并把请求交给拥有该模型的 provider。凭据在**请求时**解析，因此部署里的 `__vault_<NAME>__` 占位符会原样上线，由既有 MITM addon 在出站时替换。

所有者同时确认了三项设计选择：声明放在 `DATA_DIR/providers.json`；模型目录在启动时从网关 `/v1/models` 动态拉取；协议按模型选择。

## 决策驱动因素

- **凭据边界不变**：key 只经部署环境注入，声明文件不得承载凭据；这也是 ADR-0006 保留下来的部分。
- **失败要早**：目录拉不到、`MODEL_ID` 不在目录里，都必须在启动阶段失败，不能留一个空模型列表等第一次对话才报错。
- **元数据必须真实**：价格、上下文窗口与输出上限直接进入记忆预算与成本记账，声明与目录里缺失的字段不能被默认值掩盖。
- **不新增依赖、不新增进程**：复用 pi-ai 原语与既有 MITM／OpenBao 路径；不引入第二个配置服务或模型代理。
- **模型只表达意图**：模型参数不能指定 provider、base URL、header 或凭据（沿用 `CLAUDE.md` 的安全审计边界）。

## 备选方案

- **继续改注册表代码加一家固定提供商**：每次换网关都要改代码、发版，而所有者已经有同一台机器的两个入口（VPC 与 Tailscale），还会有下一个网关。不采纳。
- **只支持 `openai-completions` 一种协议**：实现最小，但网关同时提供 `/v1/messages` 等原生端点，Anthropic 模型走原生协议才有 thinking 与缓存字段，所有者选择了按模型选协议。不采纳。
- **把网关当成「再来一家内置提供商」写死 base URL 与模型清单**：等于把部署地址写进仓库，与「声明是部署数据」冲突。不采纳。
- **目录里无法描述的条目导致整个 provider 不可用**：一条异常条目会掩盖其余可用模型，且失败面与原因不成比例。改为逐条跳过并记录本地原因，只要 `MODEL_ID` 命中即可启动。
- **只支持在文件里写静态模型清单**：61 个模型手抄容易漂移；但静态清单在网关没有 `/v1/models` 时是唯一途径，因此保留为并列选项，两者可同时声明（静态清单在前，目录刷新替换）。
- **声明文件与模型目录二选一 + 目录动态拉取 + 按模型选协议**（采纳）。

## 决策

**声明文件**：`PROVIDERS_CONFIG` 覆盖，默认 `<DATA_DIR>/providers.json`。默认文件不存在等于「没有自定义提供商」（合法状态）；显式给出路径却读不到或不是合法 JSON 是启动错误。文件上限 8 家提供商、每家 256 条静态模型。

**严格校验**：任何未知键报错；键名像凭据的（`api_key`、`token`、`secret`…）报「凭据从环境读取，不从这个文件读」；id 必须匹配 `[a-z][a-z0-9-]{0,23}` 且不得与内置 12 家重名；`baseUrl` 必须能解析为绝对 URL，不得内嵌凭据、不得带 query／fragment，`http:` 只允许回环、RFC1918、link-local、CGNAT（Tailscale）与 IPv6 ULA 地址。

**provider 契约**：`createProvider({ id, name, baseUrl, auth: { apiKey: envApiKeyAuth(label, [apiKeyEnv]) }, models, fetchModels, api: {四个协议实现} })`。`MODEL_PROVIDER=<声明 id>` 时，`readConfig` 用声明里的 `apiKeyEnv` 做同一套必填与占位符形状校验，所以「声明了 provider 但没给 key」仍是缺项错误。

**模型目录**：启动时只对所选 provider 调 `models.refresh({ providers: [id] })`，由 provider 自己的 `fetchModels` 发请求：`GET <baseUrl><catalog.path>`（默认 `/models`，超时默认 10 秒、上限 60 秒），固定 `redirect: "manual"`（凭据不得被重定向带走，目录搬家属于要手工修配置的事），解析出凭据时带 `Authorization: Bearer <凭据>`。响应限 512 KiB、最多 500 条、严格 JSON（重复键报错）；本地错误码为 `CANCELLED`／`TIMEOUT`／`NETWORK`／`REDIRECT`／`HTTP`／`TOO_LARGE`／`PROTOCOL`，消息里不含 URL query、header、凭据或响应体。条目缺上下文窗口／输出上限／完整定价、没有任何受支持的聊天端点、id 不可用或重复时**单条跳过**，原因写进进程日志。

**协议选择**：条目自报的 `native_endpoints` 按声明的偏好顺序匹配（默认 `anthropic-messages` → `openai-completions` → `openai-responses`）；无提示用 `defaultApi`（默认 `openai-completions`）；`modelDefaults.api` 可强制全部条目走一个协议。

**地址按协议声明**：`baseUrl` 之外可给 `apiBaseUrls`。四个协议对版本段的约定不同——OpenAI 与 Gemini 客户端把路径接在已含版本段的 base 之后（`/v1`、`/v1beta`），Anthropic 客户端自己加 `/v1/messages`，需要服务根地址。一个网关同时服务多协议时必须分别声明；见缺陷 CUST-01。

**单位换算**：目录按每 token 给字符串价，转成 pi-ai 的**美元／百万 token**；`input_cache_read`／`input_cache_write` 缺失记 0（端点不单独计费），`prompt`／`completion` 缺失视为定价不完整并跳过该条目。

**明确不做**：按模型声明 base URL（协议级已足够）、图像／embedding／rerank 模型、跨 provider 负载均衡或降级、自动重试、目录缓存与后台刷新（每次启动拉一次）。

## 后果

- 新增或更换网关只改 `DATA_DIR/providers.json` 与 `.env`，不改代码、不发版；内置 12 家与声明 provider 并存，由 `MODEL_PROVIDER` 选择本次用哪家。
- **代价：配置预检不再离线**。声明 provider 的模型清单只存在于它自己的端点，因此 `node dist/src/check-config.js`（以及容器启动）会真的请求该端点；端点不可达时启动失败，而不是等到第一次对话。内置 provider 的预检仍完全离线。
- **代价：声明文件是部署数据**。仓库只放示例（[自定义提供商](../../custom-providers.md)），真实地址与凭据变量名落在主机上，随数据目录一起备份。
- 凭据仍只进 OpenBao：新增 `secret/aster/<NAME>`，并在 MITM `addon/allowlist.json` 为该变量列出允许的目标主机；占位符按**主机（不含端口）**精确匹配，因此同一台机器的多个入口共用一个主机名条目。
- 声明的 provider 与内置 provider 共享同一套 `MODEL_ID` 校验与错误信息；未知模型 id 的错误里带上该 provider 现有模型的前 5 个示例。
- 内置清单不再需要新增代码路径：以后新网关是否进编译期注册表，取决于它是否需要一个显式 key 之外的东西（OAuth、云厂商凭据、额外端点参数）。

## 分阶段决策与缺陷历史

### 2026-11-09：本次开发部分

- 相关 spec：无独立 spec；本次由所有者直接要求实现（「把 aster 底层改成底座提供的原语，密钥还是进 openbao」），三项设计选择在开工前经确认，决策与取舍记在本 ADR。
- 决策与取舍：如上。相对 ADR-0006 的变化只有一条——**「不支持自定义 base URL 的 OpenAI 兼容端点」被本次决策取代**，凭据仍然只走一个显式 API key；ADR-0006 的其余结论（只用显式 key、不在部署脚本里另写名单、错误不回显密钥）继续有效。ADR-0006 的状态已就地注明后继关系。
- 相关缺陷：
  - **CUST-01（已确认，已修）**：`anthropic-messages` 的 base 语义与其他三个协议不同。最初按单一 `baseUrl` 构造模型时，Claude 模型会请求 `<baseUrl>/v1/messages`（即 `/v1/v1/messages`）而 404，现象是回复为空而不是报错。原因：把版本段当成了 provider 级属性。处理：新增 `apiBaseUrls`，模型按自己的协议取地址；用本地网关做端到端测试固定（`test/custom-provider.test.ts` 断言两个协议各自的路径与地址）。
  - 尚未发现其他缺陷。目录价格的两种缺项语义（缓存率缺失记 0、prompt／completion 缺失即跳过）是本次直接采纳的取舍，不是修复，测试固定了这两种情形。
- 真实链路验收（2026-11-09，用该网关自己的 key，值只经 OpenBao 与临时文件传递）：
  - 两个入口的目录都能拉到：VPC `http://10.1.4.9:3425` 与 Tailscale `http://100.66.135.123:3425` 各 52 条可用，10 条被跳过（1 条无输出上限、9 条无完整定价），协议分布 `anthropic-messages` 2 / `openai-completions` 50，拉取约 50ms。
  - CUST-01 的修复在真实网关上是活的：Claude 模型拿到的是服务根地址，实测请求打到 `/v1/messages` 并正常返回。
  - 真实推理各跑通一次：`commandcode/deepseek/deepseek-v4-pro`（`openai-completions`）与 `commandcode/claude-sonnet-5-5`（`anthropic-messages`），正文、stop reason、usage 与按美元/百万 token 的成本记账都正常。
  - 仍未验收：占位符经 MITM 出站替换的真实链路。这需要先把这一层发到运行中的线路，并在该线路生效的 allowlist 里加 `MAGPIE_API_KEY`、重启 `aster-mitm`；addon 的替换语义（私网主机条目、按主机不含端口、拒绝邻居地址）已由 `deploy/openbao-mitm/addon/test_vault_placeholders.py` 的单元测试覆盖。
  - 观察（未复现，非本层缺陷）：连续两次推理时，`anthropic-messages` 那一次曾以 912ms 立即返回 `stopReason: "error"` 且正文为空；单独重试与整轮重跑都成功。判断为网关侧瞬时错误。本层按设计不自动重试，因此这类失败会以「失败的回合」而不是「空回复」向上传递，调用方不得把空正文当作有效回答。

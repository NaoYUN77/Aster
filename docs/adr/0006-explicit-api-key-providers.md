# ADR-0006：模型提供商只登记显式 API key

- **状态**：Accepted（「不支持自定义 base URL 的 OpenAI 兼容端点」一项由 [ADR-0024](custom-providers/0024-custom-provider-declarations.md) 取代，2026-11-09）
- **日期**：2026-10-21

## 上下文

提交 `0e241fa` 把原先的两家提供商分支换成 `src/providers.ts` 注册表。`CLAUDE.md` 规定：只登记能用一个显式 API key 配好的提供商，不包含 OAuth／订阅登录、云厂商环境凭据，或还要额外端点参数的提供商。启动前用 pi-ai 1.3.0 自带目录校验 `MODEL_ID`，错误只列出 id，不回显密钥。

## 决策

支持范围以 `src/providers.ts` 为唯一名单。配置只要求当前所选提供商的那一个 key。未知提供商或未知模型 id 在联网前失败。

## 备选方案

- **继续在代码里写死两家提供商。** 提交说明写的是用注册表替换这个分支，让 shell 安装脚本和 TypeScript 不再各维护一份名单。
- **支持 OAuth、订阅登录、Bedrock／Vertex 或自定义 base URL。** `CLAUDE.md`、README 和 `src/providers.ts` 的注释写明这些不进注册表，因为当前 env 校验只能表达一个显式 key。仓库没有记录各家模型的价格对比，本决策不依据价格。

## 后果

- 新增提供商要改注册表并同步文档，不能在部署脚本里另写一份。
- 只用订阅账号、云厂商角色或自建兼容端点的人不能靠现有配置启动。
- 真实摘要和归档质量目前只有 DeepSeek 的补测记录（见 `docs/memory-verification.md`）。这不是「生产只允许 DeepSeek」的决定。

## 附记

- **2026-11-09**：ADR-0024 让自建兼容端点（以及任何额外网关）可以由 `DATA_DIR/providers.json` 声明，不再改注册表代码。本 ADR 关于「凭据只经部署环境注入、错误只列变量名不回显密钥、新增名单不在部署脚本里另写一份」的结论继续有效；被取代的只有「不支持自定义 base URL」这一句。`apiKeyEnv` 由声明给出，校验路径与内置提供商相同。

# CI 运行入口

镜像与拓扑验收的正文在 [docs/ci-entrypoint.md](../../docs/ci-entrypoint.md)。

## 合并门禁

`gate-policy.mjs` 是"改动进 main 之前"的策略检查器,规则表是同目录的 `policy-rules.json`
(唯一事实源,受 [.github/CODEOWNERS](../../.github/CODEOWNERS) 保护)。它扫 diff,挡住
coding agent 的典型翻车:给 CI 加 `continue-on-error`、删/跳过测试、放宽 `cap_drop` 或端口、
依赖不钉版本、往提交里塞密钥、改文档掩盖坏掉的代码。

在本地跑(等价于 CI 里那一步):

```sh
node scripts/ci/gate-policy.mjs --base origin/main --allow-protected   # 本地自查
node scripts/ci/gate-policy.mjs --base origin/main                     # 算上 protected 检查
node scripts/ci/gate-policy.mjs --staged --allow-protected             # 只看已暂存的改动
```

失败时只输出固定错误码、文件与位置,不回显值 —— 门禁本身不能变成外泄通道。

它由 `.github/workflows/gate-policy.yml` 在 `pull_request_target` 下运行,用的是 **base 分支**
的这份脚本:PR 改不动自己的门禁。代价是改动 `.github/**`、`scripts/ci/**`、`package.json`、
compose 等路径需要 PR 带 `gate-change-approved` 标签(见 `policy-rules.json` 的 `protectedPaths`)。

注意两条落地前提:

- `gate-policy.yml` **必须先在 main 上存在**才会被触发,所以它是"先合并、后生效";引入它的
  那个 PR 自己需要带 `gate-change-approved` 标签。
- `.github/CODEOWNERS` 只有在分支保护里开了 **Require review from Code Owners** 才有强制力,
  否则它只是一份声明。

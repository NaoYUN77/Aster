# 历史部署：systemd 应用 + 容器 broker（仅迁移）

状态：**已停止支持**。本文件只记录旧的混合部署形态和迁移到 Docker 的路径。仓库不再提供 systemd 安装脚本、unit 或 broker 端口 overlay；不要按本文新装实例。当前生产部署见 [Docker 部署运行手册](deployment-test-guide.md)，Agent Vault 配置见 [Agent Vault 运行说明](agent-vault.md)。

## 旧形态

```text
systemd: node /opt/personal-agent/dist/src/main.js
  HTTP_PROXY/HTTPS_PROXY → 127.0.0.1:14322
    → agent-vault 容器（deploy/agent-vault/compose.systemd.yml 发布端口）
    → 目标 API
```

| 内容 | 旧位置 |
| --- | --- |
| 代码 | `/opt/personal-agent` |
| 应用数据 | `/var/lib/personal-agent`（`agent.sqlite`、`inbox.sqlite`、`workspace/`、`mcp.json`、`mcp-oauth/`） |
| 应用配置 | `/etc/personal-agent.env`（root，`600`） |
| CA 与 owner ID | `/etc/personal-agent/ca.pem`、`/etc/personal-agent/telegram-owner-id` |
| 路由器配置与凭据 | `/etc/personal-agent/egress-router.json`、`/etc/personal-agent/egress-router/` |
| broker 卷 | `personal-agent-vault-data` |

该形态没有 `tool-network`，应用可绕过代理直连；应用、stdio MCP 和 bash 工具同 uid，也不构成安全边界。这些限制正是迁移到 Compose 的原因。

## 迁移步骤

1. 停止旧应用和旧 broker，禁用 unit：

   ```sh
   sudo systemctl stop personal-agent
   sudo systemctl disable personal-agent
   docker compose -f docker-compose.agent-vault.yml \
     -f deploy/agent-vault/compose.systemd.yml stop agent-vault
   ```

   旧 checkout 中可能已没有这些文件；缺失时按容器名停止 broker：`docker stop <broker-container>`。

2. 备份整个应用数据目录和配置：

   ```sh
   sudo tar czf /root/aster-legacy-data.tgz -C /var/lib/personal-agent .
   sudo tar czf /root/aster-legacy-config.tgz -C /etc personal-agent.env personal-agent
   ```

3. 按 [Docker 部署运行手册](deployment-test-guide.md#9-从-systemd-迁移) 把 `aster-legacy-data.tgz` 导入命名卷 `personal-agent-data`，并执行 `chown -R 1000:1000 /data`。保留 SQLite 的 WAL/SHM、`workspace/`、`mcp.json` 和 `mcp-oauth/`。

4. 重新创建应用配置：

   - 基础 Docker 部署：把 `/etc/personal-agent.env` 中的 bot token、owner ID、`MODEL_PROVIDER`、`MODEL_ID` 和对应 API key 写入 `.env`；不要保留 `DATA_DIR=/var/lib/personal-agent`。
   - Vault 模式：按 [Agent Vault 运行说明](agent-vault.md) 创建 `deploy/agent-vault/private/app.env`、`vault.env`、`telegram-owner-id` 和 `ca.pem`。owner 文件权限为 `644`，`private/` 为 `700`。

5. broker 数据卷继续使用 `personal-agent-vault-data`，不要重建空卷。`vault.env` 的 `AGENT_VAULT_MASTER_PASSWORD` 必须与旧卷一致，否则无法解密。已有实例不要只改环境变量来换主密码。

6. 路由器：把 `/etc/personal-agent/egress-router.json` 和 `egress-router/` 下的密码、agent token 移到 `deploy/agent-vault/private/router/`，属主改为 `1001:1001`、文件 `600`、目录 `700`；JSON 内的路径改为 `/etc/aster-router/...`，`upstream_proxy` 改为 `172.30.82.2:14322`。旧 `client_auth.password_files` 中若有第二个轮换文件，一并迁移。

7. 启动并验收：

   ```sh
   docker compose -f docker-compose.agent-vault.yml up -d tool-network agent-vault
   docker compose -f docker-compose.agent-vault.yml run --rm --no-deps \
     personal-agent node dist/src/check-config.js
   docker compose -f docker-compose.agent-vault.yml up -d personal-agent
   ```

   用 owner 私聊验证 Telegram、模型和工具调用；检查卷内 OAuth token 属主仍为 1000、`600`。确认恢复行为与投递记录正常后，再删除旧 unit、`/opt/personal-agent`、`/var/lib/personal-agent` 和 `/etc/personal-agent*`。回滚窗口内保留备份。

## 边界

- 旧路径不再接收修复；`ProtectHome`、`ReadWritePaths`、`MemoryMax` 等 unit 设置不适用于容器。
- 迁移未在真实服务器执行过；步骤需在目标机按实际文件核对。不能因为镜像改名而重建空数据目录。
- OAuth 回调在旧形态同样依赖可信运维环境完成；新 Vault 模式不发布回调端口，保持离线授权流程。
- 历史设计记录见 [systemd 混合部署计划](agent-vault-router-plan.md)；以本文件的迁移结论和当前 Docker 文档为准。

# Aster web adapter — local development stack

**This stack is for local/dev verification only. It must not be deployed to the production host.**

The production Aster bot (Telegram/Slack) keeps running untouched. The web stack is a separate
Compose project (`aster-web`) with its own volume (`aster-web-data`), its own `DATA_DIR`, and
non-standard host ports.

## What it runs

- `app`: the existing Aster Node process with `CHANNEL=web`. It opens `agent.sqlite` and
  `web.sqlite` under `/data`, serves the Fastify API and, when present, `web/dist`.
- `caddy`: SSE-aware reverse proxy on the internal network. Published as `8788` on the host by
  default.

## First run

```bash
cp deploy/web/.env.example deploy/web/.env
# fill in development-only MODEL_* values and a development API key

docker compose -f deploy/web/docker-compose.yml build
docker compose -f deploy/web/docker-compose.yml up -d app
docker compose -f deploy/web/docker-compose.yml exec app node dist/src/web-set-password.js
docker compose -f deploy/web/docker-compose.yml up -d
```

The password prompt is interactive and writes only a scrypt digest to `/data/web-auth.json`
(mode 0600).

Without Docker:

```bash
DATA_DIR=./data-web npm run web:set-password
CHANNEL=web DATA_DIR=./data-web WEB_PORT=8787 npm run dev
```

`DATA_DIR` must be a fresh directory for development. Never point it at the production data
directory, SQLite files, `model-selection.json`, workspace or memory.

## Verification

```bash
curl -s http://127.0.0.1:8787/api/v1/health
TOKEN=$(curl -s -X POST http://127.0.0.1:8787/api/v1/auth/login \
  -H 'content-type: application/json' -d '{"password":"..."}' | jq -r .token)
curl -s http://127.0.0.1:8787/api/v1/models -H "authorization: Bearer $TOKEN"
curl -N http://127.0.0.1:8787/api/v1/events -H "authorization: Bearer $TOKEN"
```

SSE must arrive incrementally through Caddy (`flush_interval -1`, no `encode` on the stream).

## Connectors (GitHub / Gmail, read and write)

Operation owns the OAuth apps and the secret files; the server owns the tokens. One browser
authorization is shared by Web, Tauri and Capacitor — clients never store connector tokens.

Secret files live in `ASTER_CONNECTOR_SECRET_DIR` (default `/run/secrets/aster-connectors`), mode
`0444` for Docker secrets or `0400` for a bind mount:

| File | Purpose |
| --- | --- |
| `credential_master_key` | 32 bytes as 64 hex chars, base64, or raw. AES-256-GCM key for token encryption. |
| `github_client_id` / `github_client_secret` | GitHub OAuth App. |
| `google_client_id` / `google_client_secret` | Google OAuth client, shared by Gmail, Google Calendar and Google Drive. Scopes are requested per connector. |

Register `<CONNECTOR_OAUTH_REDIRECT_BASE>/api/v1/connectors/oauth/callback` as the redirect URI in
both OAuth apps. Never put these values in `.env`, the repo, SQLite, a log or a chat message.
Losing `credential_master_key` means every stored connector needs reauthorization.

The API is small:

```bash
POST /api/v1/connectors                       {"provider":"github","slug":"work"}
POST /api/v1/connectors/work/oauth/start      -> {"url":"https://github.com/login/oauth/authorize?..."}
GET  /api/v1/connectors                       -> providers + connections (never tokens)
GET  /api/v1/connectors/oauth/callback        provider redirect target; one-time state
```

Local stdio MCP connectors use `{"provider":"mcp_stdio","slug":"local","command":"node","args":[...]}`.
`command` must be listed in `CONNECTOR_STDIO_ALLOWLIST` (empty denies all); the process starts on the
next boot and runs in `<DATA_DIR>/connectors/stdio/<slug>`. `inheritEnv=false` means it receives only
the MCP transport's minimal allowlist (PATH, HOME, locale, proxy) — never provider keys, the connector
secret directory or `.env` values.
**High risk:** an allowlisted binary is arbitrary host code — list only binaries you would run
manually.

Model tools, per provider: read tools (`connector_list`, `connector_github_list_repositories`,
`connector_github_list_issues`, `connector_github_get_issue`, `connector_gmail_search_messages`,
`connector_gmail_get_message`) and write tools (`connector_github_create_issue`,
`connector_github_comment_issue`, `connector_github_update_issue`, `connector_gmail_send_message`,
`connector_gmail_create_draft`, `connector_gmail_modify_labels`). Read tools are `authz: read`,
write tools `authz: write`; there is no delete tool and Gmail never requests `mail.google.com`.
The full per-provider table is in `docs/api/README.md`. `credential.request` on SSE asks a client
to start the OAuth flow for a slug; it never contains a credential.

## Production isolation checklist

- [ ] Compose project is `aster-web`, not `aster` / `personal-agent`.
- [ ] Volume is `aster-web-data`, not the production `personal-agent-data`.
- [ ] `DATA_DIR` is independent and does not point at production data.
- [ ] Host ports are 8788/8443 (or another free pair), never 80/443 on a host running production.
- [ ] No `docker compose` command targets the production project.
- [ ] Production `.env`, Caddyfile, systemd units, SQLite files, workspace and memory are untouched.
- [ ] Only development API keys are used; no production credentials in `deploy/web/.env`.
- [ ] No deploy workflow or production deploy command was triggered.
- [ ] Verification requests go only to the local/dev address, never the production domain.

## Notes

- `web/dist` is bind-mounted read-only. Build it with `cd web && npm run build` (Dev 2); without
  it the API still runs and `GET /` returns a JSON 404.
- `WEB_TRUST_PROXY=1` is correct only behind the bundled Caddy; do not expose port 8787 directly
  if login rate limiting by client IP matters.
- Session tokens live in `web.sqlite` only as SHA-256 hashes; `web-auth.json` never contains the
  password.

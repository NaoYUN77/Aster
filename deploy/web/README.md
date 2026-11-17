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

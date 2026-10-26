# agent-egress-router

A small, loopback-only CONNECT proxy that routes each allowed `host:port` to a
different Agent Vault vault. It exists because a Node process has one global
`HTTP_PROXY` / `HTTPS_PROXY`, while each Agent Vault vault is addressed by a
different agent token and vault name.

```text
app ── CONNECT api.telegram.org:443 ──▶ router :14323
                                          │ route table
                                          ├─ telegram token → vault telegram
                                          ├─ deepseek token → vault deepseek
                                          └─ tools token    → vault tools
                                          │
                                          ▼
                                   Agent Vault :14322 ──▶ target
```

The router never sees plaintext HTTPS. It only reads the CONNECT authority,
selects a route, authenticates to Agent Vault, and copies bytes. It does not
resolve DNS, hold Infisical credentials, or read real API keys.

## Production deployment

The router runs as the `egress-router` service in
[`docker-compose.router.yml`](../docker-compose.router.yml), which is an override
for [`docker-compose.agent-vault.yml`](../docker-compose.agent-vault.yml) only.
It shares the `tool-network` namespace with Aster; the broker remains on its
separate bridge endpoint. The app reaches the router at `127.0.0.1:14323` and
the router reaches the broker at `172.30.82.2:14322`. Compose 2.24.4 or newer
is required because the override uses `!override` to replace the app's env file.

The image is `${ASTER_ROUTER_IMAGE:-aster-router:local}`; Compose only consumes
it and never builds. There is no published image. Build on a builder and
distribute the image, for example:

```sh
docker compose -f docker-compose.agent-vault.yml -f docker-compose.router.yml \
  -f docker-compose.agent-vault.build.yml -f docker-compose.router.build.yml \
  build egress-router
docker save aster-router:local | gzip > aster-router.tar.gz
# on the server: docker load < aster-router.tar.gz
```

The container runs as uid 1001, read-only, without capabilities, with a 128 MiB
memory limit. It publishes no host ports. Only the shared namespace can reach
`127.0.0.1:14323` (proxy) and `127.0.0.1:14324` (health). The router does not
take part in the app's `flock` singleton; the app image handles same-volume
duplicate protection.

## Configuration

The whole private directory is mounted read-only at `/etc/aster-router`:

```text
deploy/agent-vault/private/router/
  config.json             -> /etc/aster-router/config.json
  client-password         -> /etc/aster-router/client-password
  agent-token-telegram    -> /etc/aster-router/agent-token-telegram
  agent-token-deepseek    -> /etc/aster-router/agent-token-deepseek
  agent-token-tools       -> /etc/aster-router/agent-token-tools
```

The directory should be owned by uid 1001 with mode `700`, and credential
files should be uid 1001, mode `600`, so the container user can read them.
Config validation rejects credential files with any "other" permission or
group write (use `0600` or `0640`). The container command is
`serve -config /etc/aster-router/config.json`.

Start from
[`deploy/agent-vault/egress-router.example.json`](../deploy/agent-vault/egress-router.example.json).
Secrets are not allowed in the JSON: each route points at an agent-token file,
and the client password comes from one or two password files. Remove routes and
credential files you do not use; `check` fails if any referenced file is
missing.

| Field | Meaning |
| --- | --- |
| `listen` | proxy listener, loopback only |
| `upstream_proxy` | Agent Vault proxy endpoint, `host:port`; loopback or a private IP literal such as `172.30.82.2:14322` |
| `client_auth.username` | username the app sends; default `app` |
| `client_auth.password_files` | one password, or two during rotation |
| `routes[].host` / `port` | exact `(host, port)` key; no wildcards |
| `routes[].vault` | Agent Vault vault name |
| `routes[].agent_token_file` | file containing an `av_agt_...` token |
| `allowed_ports` | ports accepted from the app; default `[443]` |
| `health_listen` | optional loopback health endpoint (`/healthz`, `/readyz`) |

The upstream may be a private Docker bridge address so the router can run in
the shared application namespace while still refusing public IPs, metadata
addresses and hostnames. Validation is defined in
[`internal/config/config.go`](internal/config/config.go).

## Check and operate

There are four commands; there is no separate probe command. `check` is the
offline validation and the only pre-start check:

```sh
docker run --rm -u 1001:1001 \
  -v "$PWD/deploy/agent-vault/private/router:/etc/aster-router:ro" \
  aster-router:local check -config /etc/aster-router/config.json
```

It prints the route count and listen addresses, never a token or password.
Start the stack with both Compose files:

```sh
docker compose -f docker-compose.agent-vault.yml -f docker-compose.router.yml up -d --no-build
docker compose -f docker-compose.agent-vault.yml -f docker-compose.router.yml logs --tail 50 egress-router
```

| Command | Purpose |
| --- | --- |
| `serve -config <path>` | run the proxy; `SIGHUP` reloads routes and client passwords |
| `check -config <path>` | offline validation, exit non-zero on error |
| `redact` | filter credential-shaped text from stdin |
| `version` | print build and Go runtime version |

After changing route or credential files:

```sh
docker compose -f docker-compose.agent-vault.yml -f docker-compose.router.yml \
  kill -s SIGHUP egress-router
```

Existing tunnels are unaffected. An invalid config is logged and the old
configuration stays active. To rotate a client password, list both
`client-password` and `client-password.next` in `password_files`, write the new
password to `.next`, reload, update the app, then remove the old file and
reload again.

The app-side file is `deploy/agent-vault/private/app.router.env`; the override
replaces the base env file with it. Only the proxy URL changes:

```env
HTTP_PROXY=http://app:<router-password>@127.0.0.1:14323
HTTPS_PROXY=http://app:<router-password>@127.0.0.1:14323
```

The username and password are the router's client credentials, not an Agent
Vault agent token. URL-encode characters that are special in a URL. The app
never receives agent tokens.

## Security boundary

- Listens only on loopback; public binds are rejected at config load.
- Upstream accepts only loopback or a private IP literal; DNS names and public
  or metadata addresses are rejected.
- Rejects non-CONNECT requests, IP literals, `localhost`, wildcards, and
  unconfigured hosts.
- Uses constant-time client password comparison.
- Keeps one agent token per route; the app never sees them.
- Logs route metadata only. It cannot redact HTTPS bodies or application logs.
- With `ROUTER_ENABLED=1`, `tool-network` blocks the app (uid 1000) from
  connecting directly to the broker and permits only the router (uid 1001).
- No host ports are published, so the health endpoints are not externally
  reachable and cannot be used as a probe from the host.

## Build and test

Go 1.25 or newer, no third-party dependencies. The container build is in
[`Dockerfile`](Dockerfile) and uses the same `go build` flags:

```sh
cd router
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o agent-egress-router ./cmd/agent-egress-router
go test ./...
go vet ./...
```

`go test -race` requires CGO; it was not available in the current Windows
verification environment. Proxy tests use a fake upstream to cover CONNECT
routing, client and upstream authentication, 403/407 passthrough, early data,
half-close, idle timeout, connection limits, and log redaction. See
[`docs/docker-verification.md`](../docs/docker-verification.md) for the current
verification scope and open blockers.

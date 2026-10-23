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

## Build

Go 1.25 or newer, no third-party dependencies.

```sh
cd router
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o agent-egress-router ./cmd/agent-egress-router
```

Optional version metadata:

```sh
go build -trimpath \
  -ldflags "-s -w -X github.com/NaoYUN77/personal-agent-base-durable/router/internal/version.Version=0.1.0 -X github.com/NaoYUN77/personal-agent-base-durable/router/internal/version.Commit=$(git rev-parse --short HEAD)" \
  -o agent-egress-router ./cmd/agent-egress-router
```

## Check and run

```sh
./agent-egress-router check -config /etc/personal-agent/egress-router.json
./agent-egress-router serve -config /etc/personal-agent/egress-router.json
```

`check` validates every route, timeout, limit and credential file. It prints
the route count and listen addresses, never a token or password.

Commands:

| Command | Purpose |
| --- | --- |
| `serve -config <path>` | run the proxy; `SIGHUP` reloads routes and client passwords |
| `check -config <path>` | offline validation, exit non-zero on error |
| `redact` | filter credential-shaped text from stdin |
| `version` | print build and Go runtime version |

## Configuration

See [`deploy/agent-vault/egress-router.example.json`](../deploy/agent-vault/egress-router.example.json).
Secrets are not allowed in the JSON: each route points at an agent-token file,
and the client password comes from one or two password files. Remove routes and
credential files you do not use; `check` fails if any referenced file is
missing.

| Field | Meaning |
| --- | --- |
| `listen` | proxy listener, loopback only |
| `upstream_proxy` | Agent Vault proxy endpoint, loopback only, including host:port |
| `client_auth.username` | username the app sends; default `app` |
| `client_auth.password_files` | one password, or two during rotation |
| `routes[].host` / `port` | exact `(host, port)` key; no wildcards |
| `routes[].vault` | Agent Vault vault name |
| `routes[].agent_token_file` | file containing an `av_agt_...` token |
| `allowed_ports` | ports accepted from the app; default `[443]` |
| `health_listen` | optional loopback health endpoint (`/healthz`, `/readyz`) |

Defaults and validation are defined in
[`internal/config/config.go`](internal/config/config.go).

## App side

Only the proxy environment changes. The app does not receive Agent Vault agent
tokens.

```env
HTTP_PROXY=http://app:<router-password>@127.0.0.1:14323
HTTPS_PROXY=http://app:<router-password>@127.0.0.1:14323
NO_PROXY=
NODE_USE_ENV_PROXY=1
NODE_EXTRA_CA_CERTS=/etc/personal-agent/agent-vault-ca.pem
```

The username and password in the proxy URL are the router's client credentials,
not an Agent Vault agent token. URL-encode characters that are special in a URL.

## Security boundary

- Listens only on loopback; public binds are rejected at config load.
- Upstream must be loopback; the router has no DNS or direct egress need.
- Rejects non-CONNECT requests, IP literals, `localhost`, wildcards, and
  unconfigured hosts.
- Uses constant-time client password comparison.
- Keeps one agent token per route; the app never sees them.
- Logs route metadata only. It cannot redact HTTPS bodies or application logs.

The systemd unit in
[`deploy/agent-vault/agent-egress-router.service`](../deploy/agent-vault/agent-egress-router.service)
adds `IPAddressDeny=any` / `IPAddressAllow=127.0.0.1 ::1` and a 128 MiB memory
cap.

## Test

```sh
go test ./...
go vet ./...
```

The proxy tests use a fake upstream to cover CONNECT routing, client and
upstream authentication, 403/407 passthrough, early data, half-close, idle
timeout, connection limits, and log redaction.

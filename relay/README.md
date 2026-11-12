# Aster watchers relay

Public ingress for GitHub webhooks when the Aster host is outbound-only. The worker verifies
signatures over the raw body, dedups deliveries, stores events in D1 and serves Bearer-gated
long polls. No npm dependencies; only `worker.js`, this file and `wrangler.toml` are deployed.

## Prerequisites

- `wrangler` authenticated against the target account.
- The GitHub webhook secret and the Aster-side relay token chosen out of band. Neither is ever
  stored in this repository; both enter the worker as secrets and Aster reads them from its own
  environment (`WATCHERS_RELAY_URL`, `WATCHERS_RELAY_TOKEN`).

## Deploy

```sh
cd relay
wrangler d1 create aster-watchers          # prints the database_id for wrangler.toml
wrangler d1 execute aster-watchers --remote \
  --command "CREATE TABLE IF NOT EXISTS webhook_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, delivery TEXT NOT NULL UNIQUE, event TEXT NOT NULL, payload TEXT NOT NULL, received_at TEXT NOT NULL)"
wrangler secret put WEBHOOK_SECRET         # the GitHub webhook secret
wrangler secret put RELAY_TOKEN            # the token Aster presents on GET /pull
wrangler deploy
```

The worker also creates the table lazily on first use, so the execute step above is optional;
keeping it explicit makes the first deploy deterministic.

## Point GitHub at it

Repository (or organization) webhook settings:

- Payload URL: `https://<worker-hostname>/hook`
- Content type: `application/json`
- Secret: the same value stored as `WEBHOOK_SECRET`
- Events: pull requests, issues, issue comments, workflow runs, check suites

## Wire the Aster side

- `WATCHERS_RELAY_URL=https://<worker-hostname>` (no trailing slash; the client trims one anyway)
- `WATCHERS_RELAY_TOKEN=<RELAY_TOKEN value>`
- Optionally `WATCHERS_GITHUB_TOKEN` for REST reconciliation (fine-grained, read-only).

## Operations

- `GET /healthz` — liveness, no auth.
- `GET /pull?after=<seq>&timeout=<s>` — Bearer auth. Returns `{ seq, oldest, events }`; a client
  cursor older than `oldest - 1` means retention dropped rows and the host reconciles from REST.
- Retention: rows older than 7 days are deleted by the scheduled handler (`17 * * * *`).
- Rotation: `wrangler secret put RELAY_TOKEN`, then update the Aster environment in the same
  window. Rotating `WEBHOOK_SECRET` also requires updating the GitHub webhook setting.

## Verification without sending real events

```sh
curl -s https://<worker-hostname>/healthz
curl -s -H "Authorization: Bearer $RELAY_TOKEN" "https://<worker-hostname>/pull?after=0&timeout=0"
```

An unsigned `POST /hook` is rejected with 401; only GitHub-signed deliveries are stored.

# Three-client API contract

The OpenAPI file `three-client-v1.openapi.yaml` is the shared contract between the web adapter
(Dev 1) and the React client (Dev 2). Generate types and the client from this file; propose changes
through this contract first.

## Surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/health` | no | liveness |
| POST | `/api/v1/auth/login` | no (rate limited) | password → bearer token |
| POST | `/api/v1/auth/logout` | bearer | revoke token |
| GET | `/api/v1/auth/me` | bearer | owner + expiry |
| POST | `/api/v1/messages` | bearer | enqueue text (idempotent per `clientMessageId`) |
| GET | `/api/v1/messages` | bearer | durable transcript page |
| GET | `/api/v1/queue` | bearer | pending queue in worker claim order |
| POST | `/api/v1/requests/{requestId}/abort` | bearer | stop queued/running request |
| POST | `/api/v1/requests/{requestId}/steer` | bearer | inject text into the running request |
| POST | `/api/v1/requests/{requestId}/promote` | bearer | run a queued message now (steer or start) |
| GET | `/api/v1/models` | bearer | live catalog + current selection |
| POST | `/api/v1/models/select` | bearer | manual selection / back to primary |
| GET | `/api/v1/events` | bearer | SSE (fetch + ReadableStream, not EventSource) |

## `$model` and the UI are one policy

`GET /api/v1/models` and `POST /api/v1/models/select` call the same `ModelSelectionService` as the
`$model` chat command. `selectable` is the live runtime catalog filtered by `selectableModels()`
(OpenCode / Command Code, DeepSeek / GLM / Gemini Flash, speed variants excluded). No model id is
hardcoded in the HTTP layer, and selecting a model never calls a model or appends a chat message.

`$model` still works in the web input: the agent answers it host-side, and a change made that way
is broadcast as `model.changed` just like a button click.

## Details worth matching on the client

- History messages are returned oldest-first; `nextCursor` goes back as `before`.
- Durable history rows carry the host `requestId` that produced them (both the user input and its
  assistant answer) and, for web requests, the `clientMessageId`. Use these to reconcile an
  optimistic/local message with history instead of matching text or timestamps. A host-side
  `$model` reply has no durable user row; keep its local user bubble.
- `request.done.message` has the durable entry id when the turn is durable and includes
  `requestId` and `clientMessageId`; a host-side `$model` reply uses a request-scoped id.
- `request.done.model.degraded` is true only when a manual selection was unavailable and a
  different model answered. Automatic fallback stays `degraded: false`.
- `effective: "next_request"` means a generation was running; the selection applies afterwards.
- SSE has no replay. On reconnect: fetch history, then use the new `snapshot`.
- Host notifications (reminders, watch events, routine results) arrive as `host.message` with
  `{ message }`. The same row is durable history with `role: "system"`, `model: null`; a client that
  missed the event recovers it from `GET /messages`. Replaying a host delivery is keyed
  server-side, so reconnecting or restarting does not duplicate the row.
- After `abort`, the stopped input remains in history but is omitted from the next model context;
  the next answer does not answer it again. A stop before any visible token leaves no empty
  assistant message.
- `steer` is not a queued message: while `requestId` is running, its text joins the same run and
  the model sees it at the next tool boundary. It creates no `web_requests` row and no separate
  `request.done`; the original answer covers it. A successful admission broadcasts
  `request.steered` (envelope `requestId` is the original request, `steerId` is
  `steer:<clientMessageId>`; dedupe replays by `steerId`). If the steer lands after the last tool
  boundary, the runtime starts one more run and `steer.done` carries that projected answer; when
  the original run consumed the steer, `steer.done.message.id` is the original answer, so dedupe
  by message id.
- Steer needs a running request: with none, the route returns `409 NO_ACTIVE_REQUEST` and the
  client falls back to `POST /messages`. A path `requestId` that is not the running one returns
  `409 REQUEST_NOT_ACTIVE`. A stopped run leaves the steer's user row in history but, like the
  original input, it is excluded from the next model context.
- Known v1 limitation: a steer that starts an extra run does not run Memory's per-request
  projection/after-request hooks for that run; it is part of the current request's context, not a
  new memory request.
- The pending queue is `GET /api/v1/queue` (`{ items }`, oldest first, `created_at` then insertion
  order, at most 100) and `snapshot.queue`. `queue.changed` always carries the complete list after
  an enqueue, a worker claim, a successful promote, or an abort of a queued row; replace the local
  list with `items` rather than applying deltas. A `promoted` row has left the queue and is not
  returned. A reconnect recovers the queue from the snapshot, since SSE has no replay.
- `POST /api/v1/requests/{requestId}/promote` takes one queued message out of the FIFO. If a run is
  active it is injected into that run (same path as steer, `202 { mode: "steered", steerId }`); if
  nothing is running it starts immediately ahead of older queued rows (`202 { mode: "started" }`)
  and broadcasts `request.running`. The row becomes `promoted`, or `running` when it starts.
  Promoting an already-promoted row replays the same `steerId` without injecting again. A row that
  is running/done/failed/aborted returns `409 QUEUE_ITEM_NOT_QUEUED` with
  `error.requestStatus` (`running`, `done`, `failed`, `aborted`, or `null` when unknown); use it to
  say "已开始执行" for `running` instead of re-adding the message. A malformed `requestId` returns
  `400 INVALID_REQUEST`.
- A run that is aborting is not a steer target: if the controller is aborted or the row is no
  longer `running`, promote waits for the current run to settle and then starts the message
  (`mode: "started"`). If the steer's durable submission is later withdrawn without an answer
  (abort), the promoted row returns to `queued`, `queue.changed` is broadcast, and the worker runs
  it as a normal request. A promote therefore never leaves a message in `promoted` with no run.
- `text` over 32000 characters returns `400 TEXT_TOO_LONG` with a user-facing message; branch on
  the code rather than on status 400 alone.
- CORS allows `Authorization`, `Content-Type`, and `Cache-Control`. Defaults include
  `http://localhost:5173`, `https://localhost` (Capacitor), `http://tauri.localhost`,
  `tauri://localhost`, and `capacitor://localhost`. Setting `WEB_ALLOWED_ORIGINS` replaces the
  defaults, so a native shell deployment must list its exact origin there. The SSE response is
  written on a hijacked socket and therefore echoes `Access-Control-Allow-Origin` and
  `Vary: Origin` itself; an origin outside the allowlist gets no ACAO.
- Connectors (GitHub/Gmail, read-only) are authorized once on the server and shared by every
  client: create with `POST /connectors`, open the URL from `POST /connectors/{slug}/oauth/start`,
  and poll `GET /connectors` (or listen for `connector.changed`). Tokens never reach a client.
  `credential.request` means a tool needs authorization; it carries only the slug/provider/tool.
  Gmail has no send/delete/modify tools.
- Local stdio MCP connectors (`provider: "mcp_stdio"`, with `command`/`args`) are created through
  the same route but start only on the next server boot, after the command is re-checked against
  `CONNECTOR_STDIO_ALLOWLIST`. They run a host binary with `inheritEnv: false` and a private working
  directory under `DATA_DIR`; treat enabling one as a high-risk admin action.
- Connector tools are `connector_list`, `connector_github_list_repositories`,
  `connector_github_list_issues`, `connector_github_get_issue`,
  `connector_gmail_search_messages`, `connector_gmail_get_message`.
- Errors use `{ "error": { "code", "message" } }`; display `message`, branch on `code`.

## Error codes

Transport/auth: `INVALID_REQUEST`, `TEXT_TOO_LONG` (text over 32000 characters; message says so),
`UNAUTHORIZED`, `RATE_LIMITED`, `REQUEST_NOT_FOUND`, `REQUEST_NOT_ACTIVE`, `NO_ACTIVE_REQUEST`,
`QUEUE_ITEM_NOT_QUEUED`, `PAYLOAD_TOO_LARGE`, `INTERNAL_ERROR`, `NOT_FOUND`.

Model selection: `MODEL_NOT_FOUND`, `MODEL_OUT_OF_SCOPE`, `MODEL_SWITCH_DISABLED`,
`SELECTION_WRITE_FAILED`.

Connectors: `CONNECTOR_NOT_FOUND`, `CONNECTOR_ALREADY_EXISTS`, `CONNECTOR_INVALID_PROVIDER`,
`CONNECTOR_INVALID_SLUG`, `CONNECTOR_INVALID_INPUT`, `CONNECTOR_NOT_CONNECTED`,
`CONNECTOR_OAUTH_DISABLED`, `CONNECTOR_OAUTH_STATE_INVALID`, `CONNECTOR_OAUTH_EXCHANGE_FAILED`,
`CONNECTOR_SECRET_MISSING`, `CONNECTOR_SECRET_UNREADABLE`, `CONNECTOR_MASTER_KEY_INVALID`,
`CONNECTOR_CREDENTIAL_UNREADABLE`, `CONNECTOR_AUTH_EXPIRED`, `CONNECTOR_SCOPE_DENIED`,
`CONNECTOR_RATE_LIMITED`, `CONNECTOR_UPSTREAM_UNAVAILABLE`, `CONNECTOR_UPSTREAM_NOT_FOUND`,
`CONNECTORS_DISABLED`. Messages are fixed and safe; never display or log a token.

Request failures (`request.failed`): `MODEL_UNAVAILABLE`, `MODEL_INCOMPATIBLE`, `AGENT_TIMEOUT`,
`AGENT_UNANSWERED`, `AGENT_TRUNCATED`, `EMPTY_REPLY`, `AGENT_LOOP_DETECTED`,
`AGENT_SESSION_FAILED`, `PROCESS_INTERRUPTED`, `ABORTED`, `EXECUTION_ERROR`.

## Environment (server)

`CHANNEL=web`, `WEB_OWNER_ID`, `WEB_PORT`, `WEB_HOST`, `WEB_ALLOWED_ORIGINS`,
`WEB_SESSION_TTL_DAYS`, `WEB_STATIC_DIR`, `WEB_TRUST_PROXY`, plus the existing `DATA_DIR`,
`MODEL_PROVIDER`, `MODEL_ID`, `MODEL_FALLBACKS` and provider key. The owner password is set with
`npm run web:set-password`, never through an environment variable.

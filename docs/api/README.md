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
| POST | `/api/v1/requests/{requestId}/abort` | bearer | stop queued/running request |
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
- `request.done.message` has the durable entry id when the turn is durable; a host-side `$model`
  reply uses a request-scoped id.
- `request.done.model.degraded` is true only when a manual selection was unavailable and a
  different model answered. Automatic fallback stays `degraded: false`.
- `effective: "next_request"` means a generation was running; the selection applies afterwards.
- SSE has no replay. On reconnect: fetch history, then use the new `snapshot`.
- After `abort`, the stopped input remains in history but is omitted from the next model context;
  the next answer does not answer it again. A stop before any visible token leaves no empty
  assistant message.
- `text` over 32000 characters returns `400 TEXT_TOO_LONG` with a user-facing message; branch on
  the code rather than on status 400 alone.
- CORS allows `Authorization`, `Content-Type`, and `Cache-Control`. Defaults include
  `http://localhost:5173`, `https://localhost` (Capacitor), `http://tauri.localhost`,
  `tauri://localhost`, and `capacitor://localhost`. Setting `WEB_ALLOWED_ORIGINS` replaces the
  defaults, so a native shell deployment must list its exact origin there. The SSE response is
  written on a hijacked socket and therefore echoes `Access-Control-Allow-Origin` and
  `Vary: Origin` itself; an origin outside the allowlist gets no ACAO.
- Errors use `{ "error": { "code", "message" } }`; display `message`, branch on `code`.

## Error codes

Transport/auth: `INVALID_REQUEST`, `TEXT_TOO_LONG` (text over 32000 characters; message says so),
`UNAUTHORIZED`, `RATE_LIMITED`, `REQUEST_NOT_FOUND`, `REQUEST_NOT_ACTIVE`,
`PAYLOAD_TOO_LARGE`, `INTERNAL_ERROR`, `NOT_FOUND`.

Model selection: `MODEL_NOT_FOUND`, `MODEL_OUT_OF_SCOPE`, `MODEL_SWITCH_DISABLED`,
`SELECTION_WRITE_FAILED`.

Request failures (`request.failed`): `MODEL_UNAVAILABLE`, `MODEL_INCOMPATIBLE`, `AGENT_TIMEOUT`,
`AGENT_UNANSWERED`, `AGENT_TRUNCATED`, `EMPTY_REPLY`, `AGENT_LOOP_DETECTED`,
`AGENT_SESSION_FAILED`, `PROCESS_INTERRUPTED`, `ABORTED`, `EXECUTION_ERROR`.

## Environment (server)

`CHANNEL=web`, `WEB_OWNER_ID`, `WEB_PORT`, `WEB_HOST`, `WEB_ALLOWED_ORIGINS`,
`WEB_SESSION_TTL_DAYS`, `WEB_STATIC_DIR`, `WEB_TRUST_PROXY`, plus the existing `DATA_DIR`,
`MODEL_PROVIDER`, `MODEL_ID`, `MODEL_FALLBACKS` and provider key. The owner password is set with
`npm run web:set-password`, never through an environment variable.

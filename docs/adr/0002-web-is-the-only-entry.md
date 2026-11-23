# The web adapter is the only entry

Aster serves exactly one conversation surface: the HTTP/SSE web adapter. We deleted the Telegram
long-polling and Slack Socket Mode transports, the `CHANNEL` selector and their configuration —
bot tokens, owner/member ids, allowed channels, emoji receipts and `STYLE_LEARNING`. The web
adapter already had its own durable store, password login and owner identity, so it needed no bot
credential or second identity model. The legacy Slack `src/reactions.ts`, `src/style.ts`, and
channel `src/inbox.ts` / `src/deliveries.ts` modules were subsequently removed.

We rejected keeping Slack as a transition entry: it would keep two authentication models, two
inbound identity schemes and a second delivery loop alive with no owner to migrate them. We
rejected keeping `CHANNEL` as a selector: every value would now mean web, so the variable could
only mislead. We rejected failing fast on a leftover `TELEGRAM_*`/`SLACK_*`/`CHANNEL`/
`STYLE_LEARNING`/`MEMORY_ENABLED` variable: an upgraded host must be able to pull a new image and
boot with its existing `.env` before anyone edits it. Instead those keys are ignored, and startup
prints one line — `REMOVED_CONFIG: CHANNEL, TELEGRAM_*, SLACK_*, STYLE_LEARNING, MEMORY_ENABLED are
no longer read` — naming variables only, never values. (`MEMORY_ENABLED` was the MEM-07 master
switch; the memory system is now always composed, so the key became a removed one.)

Consequences: an old `.env` boots silently with those keys inert until the operator removes them;
the reaction-feedback path has no live event source; and production currently runs as a Slack DM,
so this branch must not be deployed as-is. Shipping it requires a web-entry deployment plan first
(password provisioning, TLS/host, port exposure and a data-directory migration check).

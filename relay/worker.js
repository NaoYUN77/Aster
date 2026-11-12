/**
 * GitHub webhook relay for Aster watchers, deployed on Cloudflare Workers.
 *
 * Why it exists: the Aster host runs behind an outbound-only network, so GitHub cannot reach it
 * directly. This worker receives webhooks on the public internet, verifies them against the raw
 * body (HMAC-SHA256 of the exact bytes GitHub signed — never a re-serialized copy), dedups on the
 * `X-GitHub-Delivery` GUID, and stores each event in D1. The Aster host then drains them with
 * Bearer-authenticated long polls against `GET /pull`.
 *
 * Deliberate limits:
 * - Delivery ids are replay keys only: dedup here is transport-level (GitHub retries the same
 *   delivery on timeout). Semantic dedup by terminal-state key happens in Aster's store, which
 *   is why the worker stores payloads untouched rather than interpreting them.
 * - Errors never echo payloads or signatures; responses carry fixed machine codes only.
 * - The long poll is a single wait-and-requery: simple, and bounded by `timeout` (max 25s) so a
 *   poll never occupies an isolate indefinitely.
 * - Rows older than the retention window are pruned by a scheduled handler; clients detect the
 *   resulting hole through `oldest` and reconcile from REST.
 *
 * Secrets (set with `wrangler secret put`, never written here): WEBHOOK_SECRET (the GitHub
 * webhook secret), RELAY_TOKEN (the Bearer token the Aster host presents).
 */

const MAX_BODY_BYTES = 1_048_576;
const MAX_DELIVERY_CHARS = 128;
const MAX_EVENT_CHARS = 64;
const MAX_PULL_EVENTS = 100;
const MAX_TIMEOUT_SEC = 25;
const RETENTION_DAYS = 7;

const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS webhook_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery TEXT NOT NULL UNIQUE,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL
)`;

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.prepare(SCHEMA_SQL).run();
  schemaReady = true;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index] ^ b[index];
  return diff === 0;
}

function hexToBytes(hex) {
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index++) out[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
}

function encoder() {
  return new TextEncoder();
}

/** Constant-time string comparison for the Bearer token; both sides are controlled values. */
function tokenMatches(provided, expected) {
  return timingSafeEqual(encoder().encode(provided), encoder().encode(expected));
}

/** Verify `sha256=<hex>` against HMAC-SHA256 over the raw request body bytes. */
async function verifySignature(secret, bodyBytes, header) {
  if (typeof header !== "string") return false;
  const match = /^sha256=([0-9a-fA-F]+)$/.exec(header.trim());
  if (match === null) return false;
  const provided = hexToBytes(match[1]);
  if (provided === null) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, bodyBytes));
  return timingSafeEqual(mac, provided);
}

async function handleHook(request, env) {
  if (typeof env.WEBHOOK_SECRET !== "string" || env.WEBHOOK_SECRET === "") {
    return json(500, { error: "relay_not_configured" });
  }
  const delivery = request.headers.get("X-GitHub-Delivery");
  const eventName = request.headers.get("X-GitHub-Event");
  const signature = request.headers.get("X-Hub-Signature-256");
  if (!delivery || !eventName || !signature) return json(400, { error: "missing_headers" });

  const bodyBytes = new Uint8Array(await request.arrayBuffer());
  if (bodyBytes.byteLength === 0 || bodyBytes.byteLength > MAX_BODY_BYTES) {
    return json(413, { error: "payload_too_large" });
  }
  if (!(await verifySignature(env.WEBHOOK_SECRET, bodyBytes, signature))) {
    return json(401, { error: "bad_signature" });
  }
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return json(400, { error: "payload_invalid" });
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return json(400, { error: "payload_invalid" });
  }

  await ensureSchema(env);
  const inserted = await env.DB.prepare(
    "INSERT INTO webhook_events (delivery, event, payload, received_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (delivery) DO NOTHING",
  ).bind(
    delivery.slice(0, MAX_DELIVERY_CHARS),
    eventName.slice(0, MAX_EVENT_CHARS),
    new TextDecoder().decode(bodyBytes),
    new Date().toISOString(),
  ).run();
  const duplicate = !(inserted.meta && inserted.meta.changes > 0);
  return json(202, { ok: true, duplicate });
}

function parsePullPage(rows) {
  return rows.map((row) => ({ seq: Number(row.seq), delivery: String(row.delivery), event: String(row.event), payload: JSON.parse(String(row.payload)) }));
}

async function handlePull(request, env, url) {
  if (typeof env.RELAY_TOKEN !== "string" || env.RELAY_TOKEN === "") {
    return json(500, { error: "relay_not_configured" });
  }
  const provided = request.headers.get("Authorization") ?? "";
  if (!tokenMatches(provided, `Bearer ${env.RELAY_TOKEN}`)) return json(401, { error: "unauthorized" });

  const afterRaw = url.searchParams.get("after") ?? "0";
  if (!/^\d+$/.test(afterRaw)) return json(400, { error: "after_invalid" });
  const after = Number(afterRaw);
  const timeoutRaw = Number(url.searchParams.get("timeout") ?? "0");
  const timeoutSec = Number.isFinite(timeoutRaw) ? Math.min(MAX_TIMEOUT_SEC, Math.max(0, Math.floor(timeoutRaw))) : 0;

  await ensureSchema(env);
  const select = "SELECT seq, delivery, event, payload FROM webhook_events WHERE seq > ?1 ORDER BY seq LIMIT ?2";
  let rows = (await env.DB.prepare(select).bind(after, MAX_PULL_EVENTS).all()).results ?? [];
  if (rows.length === 0 && timeoutSec > 0) {
    // One wait-and-requery pass: cheap long polling without holding a stream open.
    await new Promise((resolve) => setTimeout(resolve, timeoutSec * 1000));
    rows = (await env.DB.prepare(select).bind(after, MAX_PULL_EVENTS).all()).results ?? [];
  }
  let bounds;
  try {
    bounds = await env.DB.prepare("SELECT MIN(seq) AS oldest, MAX(seq) AS latest FROM webhook_events").first();
  } catch {
    return json(500, { error: "store_unavailable" });
  }
  let events;
  try {
    events = parsePullPage(rows);
  } catch {
    return json(500, { error: "store_corrupt" });
  }
  const latest = bounds && bounds.latest !== null ? Number(bounds.latest) : after;
  const oldest = bounds && bounds.oldest !== null ? Number(bounds.oldest) : null;
  return json(200, { seq: latest, oldest, events });
}

async function pruneExpired(env) {
  await ensureSchema(env);
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  await env.DB.prepare("DELETE FROM webhook_events WHERE received_at < ?1").bind(cutoff).run();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/hook") return handleHook(request, env);
    if (request.method === "GET" && url.pathname === "/pull") return handlePull(request, env, url);
    if (request.method === "GET" && url.pathname === "/healthz") return json(200, { ok: true });
    return json(404, { error: "not_found" });
  },
  async scheduled(_controller, env, _context) {
    await pruneExpired(env);
  },
};

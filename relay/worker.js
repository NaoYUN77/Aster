/**
 * Cloudflare Worker: the public entry point for GitHub webhooks.
 *
 * Aster never exposes an inbound port. GitHub posts here, this Worker proves the body came from
 * GitHub with HMAC-SHA256 over the raw bytes, collapses duplicate deliveries by their
 * `X-GitHub-Delivery` id in D1, and only then acknowledges with 202. The application pulls with a
 * bearer token and a sequence cursor; a pull that has nothing waits up to 50 seconds, which turns
 * polling into a cheap long poll. Nothing is logged: payloads contain repository data and the
 * signature secret must never be echoed.
 */

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_PULL_EVENTS = 500;
const MAX_WAIT_SECONDS = 50;
const POLL_INTERVAL_MS = 250;

const encoder = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/hook") return hook(request, env);
    if (request.method === "GET" && url.pathname === "/pull") return pull(request, env, url);
    return new Response("Not found", { status: 404 });
  },
};

async function hook(request, env) {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (typeof secret !== "string" || secret === "" || env.DB === undefined) {
    return new Response("Relay is not configured", { status: 503 });
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return new Response("Too large", { status: 413 });
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES) return new Response("Too large", { status: 413 });
  if (!(await verifySignature(secret, body, request.headers.get("x-hub-signature-256")))) {
    return new Response("Invalid signature", { status: 401 });
  }
  const deliveryId = request.headers.get("x-github-delivery");
  const event = request.headers.get("x-github-event");
  if (typeof deliveryId !== "string" || deliveryId === "" || deliveryId.length > 128
    || typeof event !== "string" || event === "" || event.length > 64) {
    return new Response("Missing delivery headers", { status: 400 });
  }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(body);
  try {
    JSON.parse(raw);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  await ensureSchema(env);
  // A replayed delivery is acknowledged but not stored twice; GitHub retries are routine.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO events (delivery_id, event, payload, received_at) VALUES (?, ?, ?, ?)",
  ).bind(deliveryId, event, raw, new Date().toISOString()).run();
  return new Response(null, { status: 202 });
}

async function pull(request, env, url) {
  const token = bearer(request.headers.get("authorization"));
  if (typeof env.RELAY_TOKEN !== "string" || token === null || !constantTimeEqual(token, env.RELAY_TOKEN)) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (env.DB === undefined) return new Response("Relay is not configured", { status: 503 });
  await ensureSchema(env);

  const requested = url.searchParams.get("after");
  const parsedAfter = requested !== null && /^\d{1,16}$/.test(requested) ? Number(requested) : null;
  const timeout = Math.max(0, Math.min(Number(url.searchParams.get("timeout") ?? "0") || 0, MAX_WAIT_SECONDS));
  const baseline = parsedAfter === null;
  const after = baseline ? await tail(env) : parsedAfter;

  let events = baseline ? [] : await readAfter(env, after);
  const deadline = Date.now() + timeout * 1000;
  while (events.length === 0 && !baseline && Date.now() < deadline) {
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    events = await readAfter(env, after);
  }
  const seq = events.length > 0 ? events[events.length - 1].seq : baseline ? after : Math.max(after, await tail(env));
  return json({ seq, events });
}

async function tail(env) {
  const row = await env.DB.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").first();
  return typeof row?.seq === "number" ? row.seq : 0;
}

async function readAfter(env, after) {
  const result = await env.DB.prepare(
    "SELECT seq, delivery_id AS deliveryId, event, payload FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
  ).bind(after, MAX_PULL_EVENTS).all();
  const rows = Array.isArray(result.results) ? result.results : [];
  const events = [];
  for (const row of rows) {
    if (typeof row.seq !== "number" || typeof row.event !== "string" || typeof row.payload !== "string") continue;
    try {
      events.push({
        seq: row.seq,
        deliveryId: typeof row.deliveryId === "string" ? row.deliveryId : undefined,
        event: row.event,
        payload: JSON.parse(row.payload),
      });
    } catch {
      // A row that cannot be parsed is skipped; reconcile is the safety net for its terminal state.
    }
  }
  return events;
}

let schemaReady = null;
function ensureSchema(env) {
  if (schemaReady !== null) return schemaReady;
  schemaReady = env.DB.exec(
    "CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT NOT NULL UNIQUE, event TEXT NOT NULL, payload TEXT NOT NULL, received_at TEXT NOT NULL)",
  ).catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function verifySignature(secret, body, header) {
  if (typeof header !== "string" || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return constantTimeEqual(hex(signature), header.slice("sha256=".length).toLowerCase());
}

function bearer(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{8,256})$/.exec(header);
  return match === null ? null : match[1];
}

/** Both inputs must have the same length; the loop touches every byte regardless of mismatches. */
function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function json(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

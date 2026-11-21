import assert from "node:assert/strict";
import test from "node:test";
import { BrokerClient } from "../src/connectors/broker-client.js";
import { BrokerTokenVault } from "../src/connectors/vault.js";
import type { OAuthToken } from "../src/connectors/providers.js";
import type { ConnectorConnection } from "../src/connectors/store.js";

const BASE = "https://broker.example.test";
const NOW = Date.parse("2026-11-18T12:00:00.000Z");

function connection(overrides: Partial<ConnectorConnection> = {}): ConnectorConnection {
  return {
    id: "connection-1",
    provider: "github",
    slug: "work",
    ownerId: "owner",
    status: "connected",
    accountLabel: "octocat",
    scopes: ["read:user"],
    createdAt: "2026-11-18T00:00:00.000Z",
    updatedAt: "2026-11-18T00:00:01.000Z",
    lastErrorCode: null,
    ...overrides,
  };
}

function fakeBroker(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; method: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function client(fetchImpl: typeof fetch): BrokerClient {
  return new BrokerClient({
    baseUrl: BASE,
    accessClientId: "access-client-id",
    accessClientSecret: "access-client-secret",
    timeoutMs: 5_000,
    fetch: fetchImpl,
  });
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

function token(overrides: Partial<OAuthToken> = {}): OAuthToken {
  return {
    access_token: "gho_access",
    refresh_token: "ghr_refresh",
    expires_at: NOW + 3_600_000,
    ...overrides,
  };
}

test("save writes the documented PUT body and seeds the in-memory cache", async () => {
  let now = NOW;
  const { fetchImpl, calls } = fakeBroker(() => new Response(null, { status: 204 }));
  const vault = new BrokerTokenVault({ client: client(fetchImpl), now: () => now });

  await vault.save(connection(), token(), { accountLabel: "octocat", scopes: ["repo"] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${BASE}/v1/connections/work`);
  assert.equal(calls[0]!.method, "PUT");
  assert.equal(new Headers(calls[0]!.init.headers).get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    provider: "github",
    accountLabel: "octocat",
    scopes: ["repo"],
    refreshToken: "ghr_refresh",
    accessToken: "gho_access",
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
  });

  // The freshly saved token is used without a token request.
  now += 1_000;
  const { fetchImpl: afterSave, calls: later } = fakeBroker((_url, init) => {
    if (init.method === "PUT") return new Response(null, { status: 204 });
    throw new Error("the token endpoint must not be called");
  });
  const second = new BrokerTokenVault({ client: client(afterSave), now: () => now });
  await second.save(connection(), token(), { accountLabel: "octocat", scopes: ["repo"] });
  assert.equal(await second.accessToken(connection()), "gho_access");
  assert.equal(later.length, 1, "only the save request was sent");
});

test("save omits refreshToken for a github connection that has none", async () => {
  const { fetchImpl, calls } = fakeBroker(() => new Response(null, { status: 204 }));
  const vault = new BrokerTokenVault({ client: client(fetchImpl), now: () => NOW });
  await vault.save(
    connection(),
    { access_token: "gho_access_only" },
    { accountLabel: "octocat", scopes: ["repo"] },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "PUT");
  const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
  assert.equal("refreshToken" in body, false, "the field is omitted, never an empty string");
  assert.equal(body.accessToken, "gho_access_only");
  assert.equal(body.expiresAt, null);
});

test("a github access-only connection round-trips through the broker unchanged", async () => {
  const { fetchImpl } = fakeBroker((url, init) => {
    if (init.method === "PUT") return new Response(null, { status: 204 });
    if (url.endsWith("/token")) return json({ accessToken: "gho_access_only", expiresAt: null });
    throw new Error(`unexpected ${init.method ?? "GET"} ${url}`);
  });
  const vault = new BrokerTokenVault({ client: client(fetchImpl), now: () => NOW });
  await vault.save(connection(), { access_token: "gho_access_only" }, { accountLabel: "octocat", scopes: [] });
  assert.equal(await vault.accessToken(connection()), "gho_access_only");
});

test("save refuses providers the broker cannot accept", async () => {
  const { fetchImpl, calls } = fakeBroker(() => new Response(null, { status: 204 }));
  const vault = new BrokerTokenVault({ client: client(fetchImpl) });
  await assert.rejects(
    vault.save(connection({ provider: "mcp_stdio" }), token(), { accountLabel: "x", scopes: [] }),
    { code: "CONNECTOR_INVALID_PROVIDER" },
  );
  assert.equal(calls.length, 0);
});

test("accessToken caches until 60s before expiresAt and then asks the broker again", async () => {
  let now = NOW;
  let issued = 0;
  const { fetchImpl, calls } = fakeBroker(() => {
    issued += 1;
    return json({
      accessToken: `token-${issued}`,
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
    });
  });
  const vault = new BrokerTokenVault({ client: client(fetchImpl), now: () => now });

  assert.equal(await vault.accessToken(connection()), "token-1");
  assert.equal(await vault.accessToken(connection()), "token-1");
  assert.equal(calls.length, 1, "the second call is served from memory");

  now = NOW + 3_600_000 - 60_001;
  assert.equal(await vault.accessToken(connection()), "token-1");
  assert.equal(calls.length, 1, "still cached just before the 60s skew");

  now = NOW + 3_600_000 - 60_000;
  assert.equal(await vault.accessToken(connection()), "token-2");
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.method, "POST");
  assert.equal(calls[1]!.url, `${BASE}/v1/connections/work/token`);
});

test("a token without expiresAt is never cached", async () => {
  let issued = 0;
  const { fetchImpl, calls } = fakeBroker(() => {
    issued += 1;
    return json({ accessToken: `token-${issued}`, expiresAt: null });
  });
  const vault = new BrokerTokenVault({ client: client(fetchImpl), now: () => NOW });
  assert.equal(await vault.accessToken(connection()), "token-1");
  assert.equal(await vault.accessToken(connection()), "token-2");
  assert.equal(calls.length, 2);
});

test("broker HTTP failures map to stable codes without quoting the body", async () => {
  const cases: { status: number; code: string; body?: string }[] = [
    { status: 401, code: "CONNECTOR_AUTH_EXPIRED" },
    { status: 404, code: "CONNECTOR_NOT_CONNECTED" },
    { status: 500, code: "CONNECTOR_UPSTREAM_UNAVAILABLE", body: "internal detail gho_access" },
    { status: 502, code: "CONNECTOR_UPSTREAM_UNAVAILABLE" },
    { status: 200, code: "CONNECTOR_UPSTREAM_UNAVAILABLE", body: "not json at all" },
    { status: 200, code: "CONNECTOR_UPSTREAM_UNAVAILABLE", body: JSON.stringify({ accessToken: "" }) },
    { status: 200, code: "CONNECTOR_UPSTREAM_UNAVAILABLE", body: JSON.stringify({ accessToken: "x", expiresAt: "tomorrow" }) },
  ];
  for (const item of cases) {
    const { fetchImpl } = fakeBroker(() => new Response(item.body ?? "", { status: item.status }));
    const vault = new BrokerTokenVault({ client: client(fetchImpl), now: () => NOW });
    await assert.rejects(vault.accessToken(connection()), (error) => {
      assert.equal(codeOf(error), item.code);
      assert.equal((error as Error).message.includes("gho_access"), false);
      return true;
    });
  }
});

test("remove deletes remotely, tolerates 404 and clears the cache", async () => {
  let now = NOW;
  let tokenCalls = 0;
  const { fetchImpl, calls } = fakeBroker((url, init) => {
    if (url.endsWith("/token")) {
      tokenCalls += 1;
      return json({ accessToken: `token-${tokenCalls}`, expiresAt: new Date(now + 3_600_000).toISOString() });
    }
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(null, { status: 204 });
  });
  const vault = new BrokerTokenVault({ client: client(fetchImpl), now: () => now });

  assert.equal(await vault.accessToken(connection()), "token-1");
  await vault.remove(connection());
  assert.equal(calls.at(-1)!.method, "DELETE");
  assert.equal(calls.at(-1)!.url, `${BASE}/v1/connections/work`);
  now += 1_000;
  assert.equal(await vault.accessToken(connection()), "token-2", "the cache was cleared by remove");

  const missing = new BrokerTokenVault({
    client: client((async () => new Response(null, { status: 404 })) as typeof fetch),
  });
  await missing.remove(connection());
});

test("a failing broker remove surfaces a safe error", async () => {
  const { fetchImpl } = fakeBroker(() => new Response("broker exploded", { status: 500 }));
  const vault = new BrokerTokenVault({ client: client(fetchImpl) });
  await assert.rejects(vault.remove(connection()), (error) => {
    assert.equal(codeOf(error), "CONNECTOR_UPSTREAM_UNAVAILABLE");
    assert.equal((error as Error).message.includes("exploded"), false);
    return true;
  });
});

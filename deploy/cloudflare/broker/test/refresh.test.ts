import assert from "node:assert/strict";
import test from "node:test";

import type { FetchLike } from "../src/refresh";
import { needsRefresh, refreshAccessToken } from "../src/refresh";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const CREDS = { clientId: "client-id", clientSecret: "client-secret" };

function responder(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  };
  return { fetchImpl, calls };
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

test("needsRefresh only refreshes missing, expired or nearly expired access tokens", () => {
  assert.equal(needsRefresh(undefined, null, NOW), true);
  assert.equal(needsRefresh("", null, NOW), true);
  assert.equal(needsRefresh("token", null, NOW), false, "a non-expiring token is reused");
  assert.equal(needsRefresh("token", "2026-11-18T12:00:30Z", NOW), true, "inside the 60s skew");
  assert.equal(needsRefresh("token", "2026-11-18T11:59:00Z", NOW), true);
  assert.equal(needsRefresh("token", "2026-11-18T12:02:00Z", NOW), false);
  assert.equal(needsRefresh("token", "not-a-date", NOW), true);
});

test("refreshes a GitHub token, sends the documented form body and keeps rotated refresh tokens", async () => {
  const { fetchImpl, calls } = responder(() => new Response(JSON.stringify({
    access_token: "gho_new",
    expires_in: 28800,
    refresh_token: "ghr_rotated",
    token_type: "bearer",
    scope: "repo",
  }), { status: 200, headers: { "content-type": "application/json" } }));

  const result = await refreshAccessToken("github", "ghr_old", CREDS, fetchImpl, () => NOW);
  assert.deepEqual(result, {
    accessToken: "gho_new",
    expiresAt: new Date(NOW + 28_800_000).toISOString(),
    refreshToken: "ghr_rotated",
  });

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, "https://github.com/login/oauth/access_token");
  assert.equal(call.init.method, "POST");
  assert.equal((call.init.headers as Record<string, string>)["content-type"], "application/x-www-form-urlencoded");
  assert.equal((call.init.headers as Record<string, string>).accept, "application/json");
  const body = new URLSearchParams(String(call.init.body));
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("client_id"), "client-id");
  assert.equal(body.get("client_secret"), "client-secret");
  assert.equal(body.get("refresh_token"), "ghr_old");
});

test("refreshes a Google token without inventing a rotated refresh token", async () => {
  const { fetchImpl, calls } = responder(() => new Response(JSON.stringify({
    access_token: "ya29.test_access",
    expires_in: 3599,
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    token_type: "Bearer",
  })));

  const result = await refreshAccessToken("gmail", "google-refresh", CREDS, fetchImpl, () => NOW);
  assert.deepEqual(result, { accessToken: "ya29.test_access", expiresAt: new Date(NOW + 3_599_000).toISOString() });
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  const body = new URLSearchParams(String(calls[0].init.body));
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "google-refresh");
});

test("treats tokens without expires_in as non-expiring", async () => {
  const { fetchImpl } = responder(() => new Response(JSON.stringify({ access_token: "static" })));
  const result = await refreshAccessToken("github", "refresh", CREDS, fetchImpl, () => NOW);
  assert.deepEqual(result, { accessToken: "static", expiresAt: null });
});

test("refresh failures are always CONNECTOR_AUTH_EXPIRED and never quote upstream data", async () => {
  const cases: Array<(url: string, init: RequestInit) => Response | Promise<Response>> = [
    () => new Response("upstream leaked gho_secret_refresh", { status: 400 }),
    () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "bad token ghr_secret_value" })),
    () => new Response("not json at all"),
    () => new Response(JSON.stringify({ access_token: "" })),
    () => {
      throw new Error("socket refused");
    },
  ];
  for (const handler of cases) {
    const { fetchImpl } = responder(handler);
    await assert.rejects(
      refreshAccessToken("github", "ghr_secret_value", CREDS, fetchImpl, () => NOW),
      (error) => {
        assert.equal(codeOf(error), "CONNECTOR_AUTH_EXPIRED");
        assert.equal((error as { status: number }).status, 401);
        const text = `${(error as Error).message} ${JSON.stringify(error)}`;
        assert.ok(!text.includes("gho_secret_refresh"));
        assert.ok(!text.includes("ghr_secret_value"));
        return true;
      },
    );
  }
});

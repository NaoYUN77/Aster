import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { beforeEach, test } from "node:test";

import { authenticate, clearAuthCache, issuerFor, jwksUrlFor, verifyAccessJwt } from "../src/auth";

const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-tag";
const KID = "kid-1";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string };

type Claims = Record<string, unknown>;

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function sign(claims: Claims, header: Record<string, unknown> = { alg: "RS256", kid: KID, typ: "JWT" }): string {
  const head = b64url(JSON.stringify(header));
  const payload = b64url(JSON.stringify(claims));
  const signature = createSign("RSA-SHA256").update(`${head}.${payload}`).sign(privateKey);
  return `${head}.${payload}.${signature.toString("base64url")}`;
}

function claims(overrides: Claims = {}, now = Date.now()): Claims {
  return {
    iss: `https://${TEAM}`,
    aud: [AUD],
    sub: "service-token-id",
    iat: Math.floor(now / 1000) - 10,
    exp: Math.floor(now / 1000) + 600,
    ...overrides,
  };
}

function jwks(): { keys: Array<{ kid: string; kty: string; n: string; e: string }> } {
  return { keys: [{ kid: KID, kty: "RSA", n: jwk.n, e: jwk.e }] };
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

beforeEach(() => clearAuthCache());

test("accepts a correctly signed, current token and returns its claims", async () => {
  const token = sign(claims());
  const verified = await verifyAccessJwt(token, { teamDomain: TEAM, audience: AUD }, { fetchJwks: async () => jwks() });
  assert.equal(verified.sub, "service-token-id");
});

test("team domain and JWKS URL are normalised", () => {
  assert.equal(issuerFor("team.cloudflareaccess.com/"), "https://team.cloudflareaccess.com");
  assert.equal(issuerFor("https://team.cloudflareaccess.com"), "https://team.cloudflareaccess.com");
  assert.equal(jwksUrlFor(TEAM), "https://team.cloudflareaccess.com/cdn-cgi/access/certs");
});

test("rejects wrong issuer, audience, expiry and not-before", async () => {
  const config = { teamDomain: TEAM, audience: AUD };
  const now = Date.now();
  const bad: Claims[] = [
    claims({ iss: "https://evil.cloudflareaccess.com" }),
    claims({ aud: ["other-aud"] }),
    claims({ aud: "other-aud" }),
    claims({ aud: undefined }),
    claims({ exp: Math.floor((now - 120_000) / 1000) }),
    claims({ exp: undefined }),
    claims({ nbf: Math.floor((now + 120_000) / 1000) }),
  ];
  for (const value of bad) {
    await assert.rejects(
      verifyAccessJwt(sign(value), config, { fetchJwks: async () => jwks() }),
      (error) => codeOf(error) === "BROKER_UNAUTHORIZED",
    );
  }
});

test("rejects tampered payloads, wrong algorithms, missing kid and forged signatures", async () => {
  const config = { teamDomain: TEAM, audience: AUD };
  const valid = sign(claims());
  const [head, , signature] = valid.split(".");
  const tampered = `${head}.${b64url(JSON.stringify(claims({ sub: "attacker" })))}.${signature}`;

  const bad = [
    tampered,
    sign(claims(), { alg: "none", kid: KID }),
    sign(claims(), { alg: "HS256", kid: KID }),
    sign(claims(), { alg: "RS256" }),
    `${head}.${b64url(JSON.stringify(claims()))}.${Buffer.alloc(256).toString("base64url")}`,
    "not-a-jwt",
    `${head}.garbage.${signature}`,
  ];
  for (const token of bad) {
    await assert.rejects(
      verifyAccessJwt(token, config, { fetchJwks: async () => jwks() }),
      (error) => {
        assert.ok(!String((error as Error).message).includes(token));
        return codeOf(error) === "BROKER_UNAUTHORIZED";
      },
    );
  }
});

test("fetches signing keys lazily, caches them, and reports unknown kids as 401", async () => {
  let calls = 0;
  const fetchJwks = async () => {
    calls += 1;
    return jwks();
  };
  const config = { teamDomain: TEAM, audience: AUD };
  await verifyAccessJwt(sign(claims()), config, { fetchJwks });
  await verifyAccessJwt(sign(claims()), config, { fetchJwks });
  assert.equal(calls, 1, "second verification reuses the cached key");

  await assert.rejects(
    verifyAccessJwt(sign(claims(), { alg: "RS256", kid: "rotated" }), config, { fetchJwks }),
    (error) => codeOf(error) === "BROKER_UNAUTHORIZED",
  );
  assert.equal(calls, 2, "an unknown kid triggers one refetch for rotation");
});

test("a JWKS outage is a 503, not a 401", async () => {
  await assert.rejects(
    verifyAccessJwt(sign(claims()), { teamDomain: TEAM, audience: AUD }, {
      fetchJwks: async () => {
        throw new Error("network down");
      },
    }),
    (error) => codeOf(error) === "BROKER_AUTH_UNAVAILABLE",
  );
});

test("authenticate requires the Access assertion and reports missing configuration", async () => {
  const request = (url: string, token?: string) => {
    const headers: Record<string, string> = {};
    if (token !== undefined) headers["Cf-Access-Jwt-Assertion"] = token;
    return new Request(url, { headers });
  };

  await assert.rejects(
    authenticate(request("https://secrets.naiwa.asia/v1/connections"), { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD }),
    (error) => codeOf(error) === "BROKER_UNAUTHORIZED",
  );
  await assert.rejects(
    authenticate(request("https://secrets.naiwa.asia/v1/connections"), {}),
    (error) => codeOf(error) === "BROKER_NOT_CONFIGURED",
  );
  const verified = await authenticate(
    request("https://secrets.naiwa.asia/v1/connections", sign(claims())),
    { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD },
    { fetchJwks: async () => jwks() },
  );
  assert.equal(verified?.sub, "service-token-id");
});

test("dev bypass works only on loopback and only when switched on", async () => {
  const env = { BROKER_DEV_BYPASS: "1" };
  assert.equal(await authenticate(new Request("http://127.0.0.1:8787/v1/connections"), env), null);
  assert.equal(await authenticate(new Request("http://localhost:8787/v1/connections"), env), null);
  await assert.rejects(
    authenticate(new Request("https://secrets.naiwa.asia/v1/connections"), env),
    (error) => codeOf(error) === "DEV_BYPASS_FORBIDDEN",
  );
  await assert.rejects(
    authenticate(new Request("http://127.0.0.1:8787/v1/connections"), { BROKER_DEV_BYPASS: "0" }),
    (error) => codeOf(error) === "BROKER_NOT_CONFIGURED",
  );
});

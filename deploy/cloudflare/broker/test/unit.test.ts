import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import test from "node:test";

import { aadFor, decryptCredential, encryptCredential, parseMasterKey } from "../src/crypto";
import { handleRequest } from "../src/handler";
import type { Env } from "../src/types";
import { SECRET_WHITELIST, connectionInput, connectionSlug, providerName, secretName, storedTokens } from "../src/validate";

function brokerCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

/** Independent implementation of the host's node format, to prove byte-level compatibility. */
function nodeEncrypt(key: Uint8Array, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function nodeDecrypt(key: Uint8Array, stored: string, aad: string): string {
  const [version, iv, tag, ciphertext] = stored.split(".");
  assert.equal(version, "v1");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

test("AES-GCM round-trips unicode and empty plaintext", async () => {
  const key = randomBytes(32);
  for (const plaintext of ["", "hello", "刷新令牌-🔐", "a".repeat(4096)]) {
    const stored = await encryptCredential(key, plaintext, aadFor("acme"));
    assert.match(stored, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/);
    assert.equal(await decryptCredential(key, stored, aadFor("acme")), plaintext);
  }
});

test("ciphertext matches src/connectors/crypto.ts byte format in both directions", async () => {
  const key = randomBytes(32);
  const aad = aadFor("acme");
  const fromBroker = await encryptCredential(key, "refresh-token", aad);
  assert.equal(nodeDecrypt(key, fromBroker, aad), "refresh-token");

  const fromHost = nodeEncrypt(key, "refresh-token", aad);
  assert.equal(await decryptCredential(key, fromHost, aad), "refresh-token");
});

test("decryption rejects tampering, wrong AAD, wrong key and malformed values", async () => {
  const key = randomBytes(32);
  const other = randomBytes(32);
  const stored = await encryptCredential(key, "secret-value", aadFor("acme"));
  const parts = stored.split(".");
  const flipped = parts[3].startsWith("A") ? `B${parts[3].slice(1)}` : `A${parts[3].slice(1)}`;

  await assert.rejects(decryptCredential(key, [parts[0], parts[1], parts[2], flipped].join("."), aadFor("acme")), (error) =>
    brokerCode(error) === "CONNECTOR_CREDENTIAL_UNREADABLE");
  await assert.rejects(decryptCredential(key, stored, aadFor("other")), (error) =>
    brokerCode(error) === "CONNECTOR_CREDENTIAL_UNREADABLE");
  await assert.rejects(decryptCredential(other, stored, aadFor("acme")), (error) =>
    brokerCode(error) === "CONNECTOR_CREDENTIAL_UNREADABLE");
  for (const malformed of ["", "v2.a.b.c", "v1.a.b", "v1..b.c", "v1.a.b.c!"]) {
    await assert.rejects(decryptCredential(key, malformed, aadFor("acme")), (error) =>
      brokerCode(error) === "CONNECTOR_CREDENTIAL_UNREADABLE");
  }
  await assert.rejects(decryptCredential(new Uint8Array(16), stored, aadFor("acme")), (error) =>
    brokerCode(error) === "CONNECTOR_MASTER_KEY_INVALID");
});

test("master key parsing accepts the host encodings and rejects everything else", () => {
  const raw = randomBytes(32);
  const hex = raw.toString("hex");
  const base64 = raw.toString("base64");
  const base64url = raw.toString("base64url");
  const rawText = "0123456789abcdef0123456789abcdef";
  assert.deepEqual(Buffer.from(parseMasterKey(hex)), raw);
  assert.deepEqual(Buffer.from(parseMasterKey(base64)), raw);
  assert.deepEqual(Buffer.from(parseMasterKey(base64url)), raw);
  assert.deepEqual(Buffer.from(parseMasterKey(` ${hex} `)), raw);
  assert.equal(Buffer.from(parseMasterKey(rawText)).toString(), rawText);

  for (const bad of [undefined, "", "0".repeat(63), "0".repeat(65), "not-a-key", raw.toString("hex").slice(2)]) {
    assert.throws(() => parseMasterKey(bad), (error) => brokerCode(error) === "CONNECTOR_MASTER_KEY_INVALID");
  }
});

test("the secret whitelist is exactly the documented set", () => {
  assert.deepEqual([...SECRET_WHITELIST], [
    "credential_master_key",
    "github_client_id",
    "github_client_secret",
    "google_client_id",
    "google_client_secret",
    "deepseek_web_api_key",
    "exa_api_key",
  ]);
  for (const name of SECRET_WHITELIST) assert.equal(secretName(name), name);
  for (const name of ["accessToken", "github", "GITHUB_CLIENT_ID", "credential-master-key", "openai_api_key"]) {
    assert.throws(() => secretName(name), (error) => brokerCode(error) === "SECRET_NOT_ALLOWED");
    try {
      secretName(name);
    } catch (error) {
      assert.equal((error as { status: number }).status, 404);
    }
  }
});

test("slugs and providers follow the documented grammar", () => {
  for (const slug of ["a", "0", "acme", "acme-github", "acme_2", "a".repeat(48)]) {
    assert.equal(connectionSlug(slug), slug);
  }
  for (const slug of ["", "-acme", "_acme", "Acme", "acme.github", "a".repeat(49), "acme/other"]) {
    assert.throws(() => connectionSlug(slug), (error) => brokerCode(error) === "INVALID_SLUG");
  }
  assert.equal(providerName("github"), "github");
  assert.equal(providerName("gmail"), "gmail");
  for (const provider of ["google", "GitHub", "", 1, null, undefined]) {
    assert.throws(() => providerName(provider), (error) => brokerCode(error) === "INVALID_PROVIDER");
  }
});

test("connection bodies are validated without echoing token values", () => {
  const input = connectionInput({
    provider: "github",
    accountLabel: "octocat",
    scopes: ["repo", "read:user"],
    refreshToken: "r3fresh",
    accessToken: "acc3ss",
    expiresAt: "2030-01-02T03:04:05Z",
  });
  assert.equal(input.provider, "github");
  assert.equal(input.accountLabel, "octocat");
  assert.deepEqual(input.scopes, ["repo", "read:user"]);
  assert.deepEqual(input.tokens, {
    refreshToken: "r3fresh",
    accessToken: "acc3ss",
    expiresAt: "2030-01-02T03:04:05.000Z",
  });

  const minimal = connectionInput({ provider: "gmail", accountLabel: "me", scopes: [], refreshToken: "r" });
  assert.deepEqual(minimal.tokens, { refreshToken: "r" });

  // GitHub OAuth apps return only an access token; the refresh token must be optional.
  const github = connectionInput({
    provider: "github",
    accountLabel: "octocat",
    scopes: [],
    accessToken: "acc3ss",
  });
  assert.deepEqual(github.tokens, { refreshToken: null, accessToken: "acc3ss" });
  const accessOnly = connectionInput({
    provider: "github",
    accountLabel: "octocat",
    scopes: [],
    accessToken: "acc3ss",
    expiresAt: null,
  });
  assert.deepEqual(accessOnly.tokens, { refreshToken: null, accessToken: "acc3ss", expiresAt: null });

  assert.throws(
    () => connectionInput({ provider: "github", accountLabel: "octocat", scopes: [] }),
    (error) => brokerCode(error) === "INVALID_BODY",
    "a body with neither token is rejected",
  );

  const cases: unknown[] = [
    null,
    [],
    {},
    { provider: "google", accountLabel: "me", scopes: [], refreshToken: "r" },
    { provider: "gmail", accountLabel: "", scopes: [], refreshToken: "r" },
    { provider: "gmail", accountLabel: "me", scopes: "repo", refreshToken: "r" },
    { provider: "gmail", accountLabel: "me", scopes: [1], refreshToken: "r" },
    { provider: "gmail", accountLabel: "me", scopes: [], refreshToken: "" },
    { provider: "gmail", accountLabel: "me", scopes: [], refreshToken: "r", expiresAt: "tomorrow" },
    { provider: "gmail", accountLabel: "me", scopes: [], refreshToken: "secret-refresh", accessToken: 7 },
  ];
  for (const body of cases) {
    assert.throws(() => connectionInput(body), (error) => {
      assert.ok(["INVALID_BODY", "INVALID_PROVIDER"].includes(String(brokerCode(error))));
      assert.ok(!(error as Error).message.includes("secret-refresh"));
      return true;
    });
  }
});

test("stored token payloads must contain at least one usable token", () => {
  assert.deepEqual(storedTokens({ refreshToken: "r", accessToken: "a", expiresAt: "2030-01-01T00:00:00.000Z" }), {
    refreshToken: "r",
    accessToken: "a",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  assert.deepEqual(storedTokens({ refreshToken: "r", accessToken: "" }), { refreshToken: "r", expiresAt: null });
  assert.deepEqual(storedTokens({ refreshToken: null, accessToken: "a" }), { refreshToken: null, accessToken: "a", expiresAt: null });
  assert.deepEqual(storedTokens({ accessToken: "a" }), { refreshToken: null, accessToken: "a", expiresAt: null });
  // No token at all is a served 503, not a malformed payload.
  assert.deepEqual(storedTokens({}), { refreshToken: null, expiresAt: null });
  assert.deepEqual(storedTokens({ refreshToken: null }), { refreshToken: null, expiresAt: null });
  for (const bad of [null, [], { refreshToken: "" }, { refreshToken: 1 }]) {
    assert.throws(() => storedTokens(bad), (error) => brokerCode(error) === "CONNECTOR_CREDENTIAL_UNREADABLE");
  }
});

async function tokenCall(
  stored: Record<string, unknown>,
  options: { readonly provider?: "github" | "gmail"; readonly now?: number } = {},
): Promise<{ readonly response: Response; readonly refreshCalls: string[] }> {
  const keyHex = randomBytes(32).toString("hex");
  const provider = options.provider ?? "github";
  const ciphertext = await encryptCredential(parseMasterKey(keyHex), JSON.stringify(stored), aadFor("acme"));
  const refreshCalls: string[] = [];
  const env = {
    BROKER_DEV_BYPASS: "1",
    credential_master_key: keyHex,
    github_client_id: "github-client-id",
    github_client_secret: "github-client-secret",
    google_client_id: "google-client-id",
    google_client_secret: "google-client-secret",
    VAULT: {
      idFromName: (name: string) => name,
      get: () => ({
        list: async () => [],
        put: async () => {},
        get: async () => ({ ciphertext, expiresAt: null, provider }),
        updateTokens: async () => true,
        remove: async () => {},
      }),
    },
  } as unknown as Env;
  const response = await handleRequest(
    new Request("http://127.0.0.1/v1/connections/acme/token", { method: "POST" }),
    env,
    {
      now: () => options.now ?? Date.parse("2026-11-18T12:00:00.000Z"),
      fetchImpl: async (input) => {
        refreshCalls.push(String(input));
        return new Response(JSON.stringify({ access_token: "refreshed-access", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  return { response, refreshCalls };
}

test("a github connection without a refresh token returns its access token and never refreshes", async () => {
  const { response, refreshCalls } = await tokenCall({
    refreshToken: null,
    accessToken: "github-access",
    expiresAt: null,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accessToken: "github-access", expiresAt: null });
  assert.deepEqual(refreshCalls, []);
});

test("a connection with no token at all is a 503, not a refresh attempt", async () => {
  const { response, refreshCalls } = await tokenCall({ refreshToken: null });
  assert.equal(response.status, 503);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, "CONNECTOR_NOT_CONFIGURED");
  assert.deepEqual(refreshCalls, []);
});

test("a non-expiring access token is served without refreshing even with a refresh token present", async () => {
  const { response, refreshCalls } = await tokenCall(
    { refreshToken: "google-refresh", accessToken: "google-access", expiresAt: null },
    { provider: "gmail" },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accessToken: "google-access", expiresAt: null });
  assert.deepEqual(refreshCalls, []);
});

test("a google connection with a refresh token still refreshes an expired access token", async () => {
  const { response, refreshCalls } = await tokenCall(
    { refreshToken: "google-refresh", accessToken: "old-access", expiresAt: "2026-11-18T11:00:00.000Z" },
    { provider: "gmail" },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.accessToken, "refreshed-access");
  assert.equal(typeof body.expiresAt, "string");
  assert.equal(refreshCalls.length, 1);
  assert.match(refreshCalls[0]!, /googleapis/);
});

import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import test from "node:test";

import { aadFor, decryptCredential, encryptCredential, parseMasterKey } from "../src/crypto";
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

test("stored token payloads must contain a refresh token", () => {
  assert.deepEqual(storedTokens({ refreshToken: "r", accessToken: "a", expiresAt: "2030-01-01T00:00:00.000Z" }), {
    refreshToken: "r",
    accessToken: "a",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  assert.deepEqual(storedTokens({ refreshToken: "r", accessToken: "" }), { refreshToken: "r", expiresAt: null });
  for (const bad of [null, [], {}, { refreshToken: "" }, { refreshToken: 1 }]) {
    assert.throws(() => storedTokens(bad), (error) => brokerCode(error) === "CONNECTOR_CREDENTIAL_UNREADABLE");
  }
});

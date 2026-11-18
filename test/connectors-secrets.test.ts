import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decryptCredential, encryptCredential } from "../src/connectors/crypto.js";
import { ConnectorError } from "../src/connectors/errors.js";
import { FileSecretProvider } from "../src/connectors/secrets.js";

async function secrets(files: Record<string, string | Buffer>): Promise<{ directory: string; provider: FileSecretProvider }> {
  const directory = await mkdtemp(join(tmpdir(), "aster-secrets-"));
  for (const [name, value] of Object.entries(files)) await writeFile(join(directory, name), value, { mode: 0o400 });
  return { directory, provider: new FileSecretProvider(directory) };
}

test("file secrets are read by logical name and a missing file names only the item", async () => {
  const { directory, provider } = await secrets({
    github_client_id: "client-id-value\n",
    credential_master_key: "11".repeat(32),
  });
  try {
    assert.equal(await provider.readText("github_client_id"), "client-id-value");
    await assert.rejects(provider.read("google_client_secret"), (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "CONNECTOR_SECRET_MISSING");
      assert.match(error.message, /google_client_secret/);
      return true;
    });
    assert.equal(await provider.readOptional("google_client_secret"), undefined);
    await assert.rejects(provider.read("../escape"), { name: "ConnectorError" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unreadable secret is a safe error that does not include the path or value", async () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const { directory, provider } = await secrets({ github_client_secret: "super-secret-value" });
  try {
    await chmod(join(directory, "github_client_secret"), 0o000);
    await assert.rejects(provider.read("github_client_secret"), (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "CONNECTOR_SECRET_UNREADABLE");
      assert.equal(error.message.includes("super-secret-value"), false);
      assert.equal(error.message.includes(directory), false);
      return true;
    });
  } finally {
    await chmod(join(directory, "github_client_secret"), 0o400).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("the master key accepts hex, base64 and raw 32-byte files only", async () => {
  const key = Buffer.from("0123456789abcdef0123456789abcdef");
  for (const value of [key.toString("hex"), key.toString("base64"), key]) {
    const { directory, provider } = await secrets({ credential_master_key: value });
    try {
      assert.deepEqual(await provider.masterKey(), key);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  const { directory, provider } = await secrets({ credential_master_key: "too-short" });
  try {
    await assert.rejects(provider.masterKey(), (error: unknown) =>
      error instanceof ConnectorError && error.code === "CONNECTOR_MASTER_KEY_INVALID");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AES-256-GCM binds ciphertext to its connection and rejects tampering", () => {
  const key = Buffer.from("0123456789abcdef0123456789abcdef");
  const stored = encryptCredential(key, JSON.stringify({ access_token: "secret-token" }), "connection:one:oauth");
  assert.equal(stored.startsWith("v1."), true);
  assert.equal(stored.includes("secret-token"), false, "the access token is not stored in plaintext");
  assert.equal(decryptCredential(key, stored, "connection:one:oauth"), JSON.stringify({ access_token: "secret-token" }));
  assert.throws(() => decryptCredential(key, stored, "connection:two:oauth"), {
    name: "ConnectorError",
    code: "CONNECTOR_CREDENTIAL_UNREADABLE",
  });
  const tampered = stored.slice(0, -2) + (stored.endsWith("A") ? "BB" : "AA");
  assert.throws(() => decryptCredential(key, tampered, "connection:one:oauth"), {
    code: "CONNECTOR_CREDENTIAL_UNREADABLE",
  });
});

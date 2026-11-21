import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AuthError,
  hashPassword,
  loadPasswordRecord,
  parsePasswordRecord,
  savePasswordRecord,
  SessionStore,
  tokenHash,
  verifyPassword,
} from "../src/http/auth.js";
import { WebRequestStore } from "../src/http/store.js";

test("scrypt verifies the right password and rejects everything else", () => {
  const record = hashPassword("correct horse battery staple");
  assert.equal(record.hash.includes("correct horse"), false);
  assert.equal(verifyPassword("correct horse battery staple", record), true);
  assert.equal(verifyPassword("wrong", record), false);
  assert.equal(verifyPassword("", record), false);
});

test("the auth file round-trips with 0600 permissions and never contains the plaintext", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-auth-"));
  try {
    const path = join(directory, "web-auth.json");
    savePasswordRecord(path, hashPassword("secret-password"));
    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, 0o600);
    const record = loadPasswordRecord(path);
    assert.equal(verifyPassword("secret-password", record), true);
    const raw = await import("node:fs/promises").then(({ readFile }) => readFile(path, "utf8"));
    assert.equal(raw.includes("secret-password"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing or malformed auth file is reported without leaking contents", () => {
  assert.throws(() => loadPasswordRecord("/nonexistent/web-auth.json"), (error: unknown) =>
    error instanceof AuthError && error.code === "AUTH_NOT_CONFIGURED");
  assert.throws(() => parsePasswordRecord("{}"), (error: unknown) =>
    error instanceof AuthError && error.code === "INVALID_AUTH_FILE");
  const huge = { ...hashPassword("x"), N: 100_000_000 };
  assert.throws(() => parsePasswordRecord(JSON.stringify(huge)), (error: unknown) =>
    error instanceof AuthError && error.code === "INVALID_AUTH_FILE");
});

test("sessions store only a hash, expire, and can be revoked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-session-"));
  const store = new WebRequestStore(join(directory, "web.sqlite"));
  try {
    const sessions = new SessionStore(store.database, 60_000);
    const issued = sessions.issue("test-agent");
    assert.ok(issued.token.length >= 32);
    assert.ok(issued.expiresAt > Date.now());
    assert.deepEqual(sessions.verify(issued.token), { expiresAt: issued.expiresAt });

    const rows = store.database.prepare("SELECT token_hash FROM web_sessions").all() as { token_hash: string }[];
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0]!.token_hash, issued.token);
    assert.equal(rows[0]!.token_hash, tokenHash(issued.token));

    sessions.revoke(issued.token);
    assert.equal(sessions.verify(issued.token), undefined);

    const expired = sessions.issue();
    store.database.prepare("UPDATE web_sessions SET expires_at = ? WHERE token_hash = ?")
      .run(Date.now() - 1, tokenHash(expired.token));
    assert.equal(sessions.verify(expired.token), undefined);
    assert.equal((store.database.prepare("SELECT COUNT(*) AS n FROM web_sessions").get() as { n: number }).n, 0);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

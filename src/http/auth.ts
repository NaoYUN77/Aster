import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

/**
 * Single-owner authentication.
 *
 * The password is never stored: `web-auth.json` holds a scrypt digest (0600). A successful login
 * issues an opaque 32-byte token; only its SHA-256 hash reaches `web.sqlite`, so a database leak
 * does not hand out live sessions. There is no registration endpoint and no cookie flow.
 */

export const AUTH_FILE_NAME = "web-auth.json";
export const AUTH_FILE_VERSION = 1;

export type PasswordRecord = {
  readonly version: 1;
  readonly algorithm: "scrypt";
  readonly salt: string;
  readonly hash: string;
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keylen: number;
  readonly createdAt: string;
};

export type SessionIssue = {
  readonly token: string;
  readonly expiresAt: number;
};

export class AuthError extends Error {
  override name = "AuthError";
  constructor(readonly code: "AUTH_NOT_CONFIGURED" | "INVALID_AUTH_FILE") {
    super(code);
  }
}

function digest(password: string, salt: Buffer, params: { N: number; r: number; p: number; keylen: number }): Buffer {
  // 128 * N * r is the scrypt working set; give the allocator headroom so a valid record always fits.
  return scryptSync(password, salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: Math.max(32 * 1024 * 1024, 256 * params.N * params.r),
  });
}

export function hashPassword(password: string): PasswordRecord {
  const params = { N: 16_384, r: 8, p: 1, keylen: 32 };
  const salt = randomBytes(16);
  const hash = digest(password, salt, params);
  return {
    version: AUTH_FILE_VERSION,
    algorithm: "scrypt",
    salt: salt.toString("hex"),
    hash: hash.toString("hex"),
    ...params,
    createdAt: new Date().toISOString(),
  };
}

export function parsePasswordRecord(raw: string): PasswordRecord {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new AuthError("INVALID_AUTH_FILE");
  const record = parsed as Record<string, unknown>;
  const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  if (record.version !== AUTH_FILE_VERSION || record.algorithm !== "scrypt"
    || typeof record.salt !== "string" || !/^[0-9a-f]+$/i.test(record.salt)
    || typeof record.hash !== "string" || !/^[0-9a-f]+$/i.test(record.hash)
    || !integer(record.N) || !integer(record.r) || !integer(record.p) || !integer(record.keylen)) {
    throw new AuthError("INVALID_AUTH_FILE");
  }
  // Bounds keep a tampered file from asking scrypt for an unbounded amount of memory or time.
  if (record.N > 1_048_576 || record.r > 32 || record.p > 16 || record.keylen < 16 || record.keylen > 128) {
    throw new AuthError("INVALID_AUTH_FILE");
  }
  return {
    version: 1,
    algorithm: "scrypt",
    salt: record.salt,
    hash: record.hash,
    N: record.N,
    r: record.r,
    p: record.p,
    keylen: record.keylen,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
  };
}

export function loadPasswordRecord(path: string): PasswordRecord {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new AuthError("AUTH_NOT_CONFIGURED");
  }
  try {
    return parsePasswordRecord(raw);
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("INVALID_AUTH_FILE");
  }
}

/** Write the record atomically with owner-only permissions. The plaintext never touches disk. */
export function savePasswordRecord(path: string, record: PasswordRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function verifyPassword(password: string, record: PasswordRecord): boolean {
  try {
    const expected = Buffer.from(record.hash, "hex");
    const actual = digest(password, Buffer.from(record.salt, "hex"), record);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class SessionStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ttlMs: number,
  ) {}

  issue(label?: string): SessionIssue {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    const expiresAt = now + this.ttlMs;
    this.db.prepare(`
      INSERT INTO web_sessions (token_hash, created_at, expires_at, last_seen_at, label)
      VALUES (?, ?, ?, ?, ?)
    `).run(tokenHash(token), now, expiresAt, now, label?.slice(0, 120) ?? null);
    return { token, expiresAt };
  }

  verify(token: string): { expiresAt: number } | undefined {
    if (token === "" || token.length > 256) return undefined;
    const hash = tokenHash(token);
    const row = this.db.prepare("SELECT expires_at FROM web_sessions WHERE token_hash = ?").get(hash) as
      | { expires_at: number }
      | undefined;
    if (row === undefined) return undefined;
    const now = Date.now();
    if (row.expires_at <= now) {
      this.db.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(hash);
      return undefined;
    }
    this.db.prepare("UPDATE web_sessions SET last_seen_at = ? WHERE token_hash = ?").run(now, hash);
    return { expiresAt: row.expires_at };
  }

  revoke(token: string): void {
    this.db.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(tokenHash(token));
  }

  cleanup(now = Date.now()): void {
    this.db.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").run(now);
  }
}

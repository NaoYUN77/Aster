import { DurableObject } from "cloudflare:workers";
import type { ConnectionMetadata, EncryptedTokens, Env, Provider, VaultRecord } from "./types";

type Row = {
  slug: string;
  provider: string;
  account_label: string;
  scopes: string;
  ciphertext: string;
  expires_at: string | null;
  updated_at: string;
};

/**
 * One Durable Object per owner (`idFromName(owner)`), using SQLite storage. Rows hold the
 * AES-GCM ciphertext only; decryption happens in the Worker so a storage dump never reveals a
 * token. This class never logs and never returns decrypted material.
 */
export class Vault extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  async list(): Promise<ConnectionMetadata[]> {
    const rows = this.ctx.storage.sql
      .exec<Row>("SELECT slug, provider, account_label, scopes, ciphertext, expires_at, updated_at FROM connections ORDER BY updated_at DESC, slug ASC")
      .toArray();
    return rows.map((row) => metadata(row));
  }

  async put(record: VaultRecord): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO connections (slug, provider, account_label, scopes, ciphertext, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         provider = excluded.provider,
         account_label = excluded.account_label,
         scopes = excluded.scopes,
         ciphertext = excluded.ciphertext,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      record.slug,
      record.provider,
      record.accountLabel,
      JSON.stringify(record.scopes),
      record.ciphertext,
      record.expiresAt,
      record.updatedAt,
    );
  }

  async get(slug: string): Promise<EncryptedTokens | null> {
    const rows = this.ctx.storage.sql
      .exec<Pick<Row, "ciphertext" | "expires_at" | "provider">>("SELECT ciphertext, expires_at, provider FROM connections WHERE slug = ?", slug)
      .toArray();
    const row = rows[0];
    if (row === undefined) return null;
    return { ciphertext: row.ciphertext, expiresAt: row.expires_at, provider: provider(row.provider) };
  }

  async updateTokens(slug: string, tokens: EncryptedTokens): Promise<boolean> {
    const result = this.ctx.storage.sql.exec(
      "UPDATE connections SET ciphertext = ?, expires_at = ?, updated_at = ? WHERE slug = ?",
      tokens.ciphertext,
      tokens.expiresAt,
      new Date().toISOString(),
      slug,
    );
    return result.rowsWritten > 0;
  }

  async remove(slug: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM connections WHERE slug = ?", slug);
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS connections (
         slug TEXT PRIMARY KEY,
         provider TEXT NOT NULL,
         account_label TEXT NOT NULL,
         scopes TEXT NOT NULL,
         ciphertext TEXT NOT NULL,
         expires_at TEXT,
         updated_at TEXT NOT NULL
       )`,
    );
  }
}

function metadata(row: Row): ConnectionMetadata {
  return {
    slug: row.slug,
    provider: provider(row.provider),
    accountLabel: row.account_label,
    scopes: scopes(row.scopes),
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
}

function provider(value: string): Provider {
  // The Worker only writes github/gmail; anything else is corrupted storage, not a caller error.
  return value === "gmail" ? "gmail" : "github";
}

function scopes(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    // Fall through to the empty list.
  }
  return [];
}

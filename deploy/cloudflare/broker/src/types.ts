/** Shared broker types. This Worker never returns a token to a caller outside this list. */

export type Provider = "github" | "gmail";

export type ConnectionMetadata = {
  readonly slug: string;
  readonly provider: Provider;
  readonly accountLabel: string;
  readonly scopes: readonly string[];
  /** ISO timestamp of the current access token, or null when it does not expire. */
  readonly expiresAt: string | null;
  readonly updatedAt: string;
};

/** Encrypted at rest; only the Worker crypto module can turn this back into tokens. */
export type VaultRecord = {
  readonly slug: string;
  readonly provider: Provider;
  readonly accountLabel: string;
  readonly scopes: readonly string[];
  readonly ciphertext: string;
  readonly expiresAt: string | null;
  readonly updatedAt: string;
};

export type EncryptedTokens = {
  readonly ciphertext: string;
  readonly expiresAt: string | null;
  readonly provider: Provider;
};

/** RPC surface of the per-owner Durable Object. */
export type VaultRpc = {
  list(): Promise<ConnectionMetadata[]>;
  put(record: VaultRecord): Promise<void>;
  get(slug: string): Promise<EncryptedTokens | null>;
  updateTokens(slug: string, tokens: EncryptedTokens): Promise<boolean>;
  remove(slug: string): Promise<void>;
};

/** `refreshToken` is null for providers that do not issue one (plain GitHub OAuth apps). */
export type StoredTokens = {
  readonly refreshToken: string | null;
  readonly accessToken?: string;
  readonly expiresAt?: string | null;
};

export interface Env {
  readonly VAULT: DurableObjectNamespace;
  readonly ACCESS_TEAM_DOMAIN: string;
  readonly ACCESS_AUD: string;
  readonly BROKER_OWNER_ID?: string;
  readonly BROKER_DEV_BYPASS?: string;
  readonly credential_master_key?: string;
  readonly github_client_id?: string;
  readonly github_client_secret?: string;
  readonly google_client_id?: string;
  readonly google_client_secret?: string;
  readonly deepseek_web_api_key?: string;
  readonly exa_api_key?: string;
  readonly [name: string]: unknown;
}

import type { ConnectorsConfig } from "../config.js";
import type { BrokerClient } from "./broker-client.js";
import { decryptCredential, encryptCredential } from "./crypto.js";
import { ConnectorError } from "./errors.js";
import { boundedJson, credentialAad, expiresAtIso, specFor, tokenFromJson, type OAuthToken } from "./providers.js";
import type { SecretProvider } from "./secrets.js";
import { isOAuthProvider, type ConnectorConnection, type ConnectorStore } from "./store.js";

export type TokenVaultMeta = {
  readonly accountLabel: string;
  readonly scopes: readonly string[];
};

/**
 * Storage for one connection's OAuth token. The local implementation keeps the current encrypted
 * SQLite row; the broker implementation sends the token to the Cloudflare Worker over TLS and lets
 * it handle encryption at rest. Callers never learn which one is in use.
 */
export type TokenVault = {
  save(connection: ConnectorConnection, token: OAuthToken, meta: TokenVaultMeta): Promise<void>;
  accessToken(connection: ConnectorConnection): Promise<string>;
  remove(connection: ConnectorConnection): Promise<void>;
};

export type LocalTokenVaultOptions = {
  readonly store: ConnectorStore;
  readonly secrets: SecretProvider;
  readonly config: ConnectorsConfig;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
};

/** Existing behavior, unchanged: AES-256-GCM ciphertext in connectors.sqlite. */
export class LocalTokenVault implements TokenVault {
  readonly #store: ConnectorStore;
  readonly #secrets: SecretProvider;
  readonly #config: ConnectorsConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: LocalTokenVaultOptions) {
    this.#store = options.store;
    this.#secrets = options.secrets;
    this.#config = options.config;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async save(connection: ConnectorConnection, token: OAuthToken): Promise<void> {
    this.#store.saveCredential(connection.id, {
      ciphertext: encryptCredential(await this.#secrets.masterKey(), JSON.stringify(token), credentialAad(connection.id)),
      expiresAt: expiresAtIso(token),
    });
  }

  async accessToken(connection: ConnectorConnection): Promise<string> {
    const stored = this.#store.credential(connection.id);
    if (stored === undefined) {
      throw new ConnectorError("CONNECTOR_NOT_CONNECTED", "connector is not authorized yet");
    }
    let token: OAuthToken;
    try {
      token = JSON.parse(decryptCredential(await this.#secrets.masterKey(), stored.ciphertext, credentialAad(connection.id))) as OAuthToken;
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("CONNECTOR_CREDENTIAL_UNREADABLE", "stored connector credential cannot be decrypted");
    }
    if (typeof token.access_token !== "string" || token.access_token === "") {
      throw new ConnectorError("CONNECTOR_CREDENTIAL_UNREADABLE", "stored connector credential is malformed");
    }
    if (token.expires_at !== undefined && token.expires_at <= this.#now().getTime() + 60_000) {
      if (token.refresh_token === undefined || token.refresh_token === "") {
        throw new ConnectorError("CONNECTOR_AUTH_EXPIRED", "connector authorization expired; reauthorize it");
      }
      token = await this.#refresh(connection, token);
    }
    return token.access_token;
  }

  async remove(connection: ConnectorConnection): Promise<void> {
    this.#store.deleteCredential(connection.id);
  }

  async #refresh(connection: ConnectorConnection, previous: OAuthToken): Promise<OAuthToken> {
    const spec = specFor(connection.provider);
    const [clientId, clientSecret] = await Promise.all([
      this.#secrets.readText(spec.clientIdSecret),
      this.#secrets.readText(spec.clientSecretSecret),
    ]);
    const response = await this.#fetch(spec.tokenUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: previous.refresh_token!,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(this.#config.httpTimeoutMs),
    });
    if (!response.ok) {
      this.#store.setStatus(connection.id, "error", "CONNECTOR_AUTH_EXPIRED");
      this.#store.audit(connection.id, "oauth.refresh_failed", "CONNECTOR_AUTH_EXPIRED");
      throw new ConnectorError("CONNECTOR_AUTH_EXPIRED", "connector authorization expired; reauthorize it");
    }
    const refreshed = await tokenFromJson(await boundedJson(response), this.#now().getTime());
    const merged: OAuthToken = {
      ...refreshed,
      refresh_token: refreshed.refresh_token ?? previous.refresh_token,
    };
    await this.save(connection, merged);
    return merged;
  }
}

export type BrokerTokenVaultOptions = {
  readonly client: BrokerClient;
  readonly now?: () => number;
};

const CACHE_SKEW_MS = 60_000;

/**
 * Tokens live in the broker's Durable Object. Notes:
 * - the access token cache holds values only in process memory until 60s before `expiresAt`;
 * - no master key, no crypto and no ciphertext exist on this host in this mode;
 * - the current access token is the only token value that ever crosses the network.
 */
export class BrokerTokenVault implements TokenVault {
  readonly #client: BrokerClient;
  readonly #now: () => number;
  readonly #cache = new Map<string, { readonly token: string; readonly deadline: number }>();

  constructor(options: BrokerTokenVaultOptions) {
    this.#client = options.client;
    this.#now = options.now ?? Date.now;
  }

  async save(connection: ConnectorConnection, token: OAuthToken, meta: TokenVaultMeta): Promise<void> {
    if (!isOAuthProvider(connection.provider)) {
      throw new ConnectorError("CONNECTOR_INVALID_PROVIDER", "unsupported connector provider");
    }
    // GitHub OAuth apps return no refresh token. The field is omitted (never an empty string) so
    // the broker stores null and serves the access token back without trying to refresh.
    const refreshToken = token.refresh_token === undefined || token.refresh_token === ""
      ? undefined
      : token.refresh_token;
    const response = await this.#client.request(`/v1/connections/${encodeURIComponent(connection.slug)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: connection.provider,
        accountLabel: meta.accountLabel,
        scopes: [...meta.scopes],
        ...(refreshToken === undefined ? {} : { refreshToken }),
        accessToken: token.access_token,
        expiresAt: expiresAtIso(token),
      }),
    });
    if (!response.ok) failBroker(response, "save");
    this.#remember(connection.id, token.access_token, token.expires_at);
  }

  async accessToken(connection: ConnectorConnection): Promise<string> {
    const cached = this.#cache.get(connection.id);
    if (cached !== undefined && cached.deadline > this.#now()) return cached.token;

    const response = await this.#client.request(
      `/v1/connections/${encodeURIComponent(connection.slug)}/token`,
      { method: "POST" },
    );
    if (!response.ok) failBroker(response, "token");
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "connector secret broker returned an invalid response");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "connector secret broker returned an invalid response");
    }
    const record = body as Record<string, unknown>;
    if (typeof record.accessToken !== "string" || record.accessToken === "") {
      throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "connector secret broker returned an invalid response");
    }
    let expiresAtMs: number | undefined;
    if (record.expiresAt !== null && record.expiresAt !== undefined) {
      if (typeof record.expiresAt !== "string" || Number.isNaN(Date.parse(record.expiresAt))) {
        throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "connector secret broker returned an invalid response");
      }
      expiresAtMs = Date.parse(record.expiresAt);
    }
    if (expiresAtMs === undefined) this.#cache.delete(connection.id);
    else this.#remember(connection.id, record.accessToken, expiresAtMs);
    return record.accessToken;
  }

  async remove(connection: ConnectorConnection): Promise<void> {
    this.#cache.delete(connection.id);
    const response = await this.#client.request(`/v1/connections/${encodeURIComponent(connection.slug)}`, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 404) failBroker(response, "remove");
  }

  #remember(connectionId: string, token: string, expiresAtMs: number | undefined): void {
    if (expiresAtMs === undefined) {
      this.#cache.delete(connectionId);
      return;
    }
    const deadline = expiresAtMs - CACHE_SKEW_MS;
    if (deadline > this.#now()) this.#cache.set(connectionId, { token, deadline });
    else this.#cache.delete(connectionId);
  }
}

function failBroker(response: Response, operation: "save" | "token" | "remove"): never {
  // The broker answers 401 CONNECTOR_AUTH_EXPIRED when its refresh fails, and 404 when the slug is
  // unknown. Any other 401/403 means Access rejected this host's service token: fail closed.
  if (operation === "token" && response.status === 401) {
    throw new ConnectorError("CONNECTOR_AUTH_EXPIRED", "connector authorization expired; reauthorize it");
  }
  if (operation === "token" && response.status === 404) {
    throw new ConnectorError("CONNECTOR_NOT_CONNECTED", "connector is not authorized yet");
  }
  if (response.status === 401 || response.status === 403) {
    throw new ConnectorError("SECRETS_UNAVAILABLE", "connector secret broker rejected the request");
  }
  if (operation === "save" && response.status === 400) {
    throw new ConnectorError("CONNECTOR_OAUTH_EXCHANGE_FAILED", "connector secret broker rejected the credential");
  }
  throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "connector secret broker is unavailable");
}

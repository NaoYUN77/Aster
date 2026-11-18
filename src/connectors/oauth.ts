import { createHash, randomBytes } from "node:crypto";
import type { ConnectorsConfig } from "../config.js";
import { decryptCredential, encryptCredential } from "./crypto.js";
import { ConnectorError, connectorCode } from "./errors.js";
import type { SecretProvider } from "./secrets.js";
import type { ConnectorConnection, ConnectorProvider, ConnectorStore } from "./store.js";

export type OAuthToken = {
  readonly access_token: string;
  readonly refresh_token?: string;
  /** Unix epoch milliseconds. Absent means the provider did not tell us. */
  readonly expires_at?: number;
  readonly token_type?: string;
  readonly scope?: string;
};

type ProviderSpec = {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly clientIdSecret: string;
  readonly clientSecretSecret: string;
  readonly profile: (token: string, fetchImpl: typeof fetch, signal: AbortSignal) => Promise<string>;
};

const PROVIDERS: Readonly<Record<"github" | "gmail", ProviderSpec>> = {
  github: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    clientIdSecret: "github_client_id",
    clientSecretSecret: "github_client_secret",
    profile: async (token, fetchImpl, signal) => {
      const response = await fetchImpl("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "aster-connector",
        },
        signal,
      });
      if (!response.ok) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "GitHub profile request failed");
      const body = await boundedJson(response);
      const login = typeof body.login === "string" ? body.login : "";
      if (login === "") throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "GitHub profile response was invalid");
      return login;
    },
  },
  gmail: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientIdSecret: "google_client_id",
    clientSecretSecret: "google_client_secret",
    profile: async (token, fetchImpl, signal) => {
      const response = await fetchImpl("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal,
      });
      if (!response.ok) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Gmail profile request failed");
      const body = await boundedJson(response);
      const address = typeof body.emailAddress === "string" ? body.emailAddress : "";
      if (address === "") throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Gmail profile response was invalid");
      return address;
    },
  },
};

export type ConnectorOAuthOptions = {
  readonly store: ConnectorStore;
  readonly secrets: SecretProvider;
  readonly config: ConnectorsConfig;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
};

/**
 * Server-side OAuth for GitHub and Gmail. The browser is only sent to the provider; the code is
 * exchanged here, the refresh token lives encrypted in connectors.sqlite, and every client sees the
 * same connection status. PKCE plus a one-time state row protect the callback.
 */
export class ConnectorOAuth {
  readonly #store: ConnectorStore;
  readonly #secrets: SecretProvider;
  readonly #config: ConnectorsConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: ConnectorOAuthOptions) {
    this.#store = options.store;
    this.#secrets = options.secrets;
    this.#config = options.config;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  redirectUri(): string {
    if (this.#config.redirectBaseUrl === undefined) {
      throw new ConnectorError("CONNECTOR_OAUTH_DISABLED", "OAuth redirect base URL is not configured on the server");
    }
    return `${this.#config.redirectBaseUrl}/api/v1/connectors/oauth/callback`;
  }

  async start(connection: ConnectorConnection): Promise<{ readonly url: string }> {
    const spec = specFor(connection.provider);
    const redirectUri = this.redirectUri();
    const clientId = await this.#secrets.readText(spec.clientIdSecret);
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    this.#store.createOAuthSession({
      state,
      connectionId: connection.id,
      ownerId: connection.ownerId,
      provider: connection.provider,
      codeVerifier,
      redirectUri,
      scopes: connection.scopes,
      expiresAt: new Date(this.#now().getTime() + this.#config.oauthStateTtlMs).toISOString(),
    });
    const url = new URL(spec.authorizeUrl);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", connection.scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (connection.provider === "gmail") {
      // Offline access is what makes the connection survive a restart without a new browser flow.
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("include_granted_scopes", "true");
    }
    return { url: url.toString() };
  }

  async complete(state: string, code: string): Promise<ConnectorConnection> {
    if (state === "" || code === "" || state.length > 512 || code.length > 4_096) {
      throw new ConnectorError("CONNECTOR_OAUTH_STATE_INVALID", "OAuth state is invalid or has expired");
    }
    const session = this.#store.consumeOAuthSession(state);
    if (session === undefined) {
      throw new ConnectorError("CONNECTOR_OAUTH_STATE_INVALID", "OAuth state is invalid or has expired");
    }
    const connection = this.#store.getById(session.connectionId);
    if (connection === undefined || connection.provider !== session.provider) {
      throw new ConnectorError("CONNECTOR_OAUTH_STATE_INVALID", "OAuth state is invalid or has expired");
    }
    const spec = specFor(connection.provider);
    try {
      const [clientId, clientSecret] = await Promise.all([
        this.#secrets.readText(spec.clientIdSecret),
        this.#secrets.readText(spec.clientSecretSecret),
      ]);
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: session.redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: session.codeVerifier,
      });
      const response = await this.#fetch(spec.tokenUrl, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(this.#config.httpTimeoutMs),
      });
      if (!response.ok) throw new ConnectorError("CONNECTOR_OAUTH_EXCHANGE_FAILED", "OAuth token exchange failed");
      const token = await tokenFromJson(await boundedJson(response), this.#now().getTime());
      this.#store.saveCredential(connection.id, {
        ciphertext: encryptCredential(await this.#secrets.masterKey(), JSON.stringify(token), aad(connection.id)),
        expiresAt: token.expires_at === undefined ? null : new Date(token.expires_at).toISOString(),
      });
      let label: string;
      try {
        label = await spec.profile(token.access_token, this.#fetch, AbortSignal.timeout(this.#config.httpTimeoutMs));
      } catch {
        // The grant is valid even if the profile endpoint is temporarily unavailable. The UI still
        // sees a connected account; the label can be refreshed by reconnecting.
        label = connection.provider;
      }
      const scopes = token.scope === undefined || token.scope === ""
        ? session.scopes
        : token.scope.split(/\s+/).filter((value) => value !== "");
      return this.#store.setConnected(connection.id, { accountLabel: label, scopes });
    } catch (error) {
      const codeName = error instanceof ConnectorError ? error.code : connectorCode(error);
      this.#store.setStatus(connection.id, "error", codeName);
      this.#store.audit(connection.id, "oauth.exchange_failed", codeName);
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("CONNECTOR_OAUTH_EXCHANGE_FAILED", "OAuth token exchange failed");
    }
  }

  /** Decrypts, refreshes when needed, and returns a short-lived access token for one tool call. */
  async accessToken(connection: ConnectorConnection): Promise<string> {
    const stored = this.#store.credential(connection.id);
    if (stored === undefined) {
      throw new ConnectorError("CONNECTOR_NOT_CONNECTED", "connector is not authorized yet");
    }
    let token: OAuthToken;
    try {
      token = JSON.parse(decryptCredential(await this.#secrets.masterKey(), stored.ciphertext, aad(connection.id))) as OAuthToken;
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
    this.#store.saveCredential(connection.id, {
      ciphertext: encryptCredential(await this.#secrets.masterKey(), JSON.stringify(merged), aad(connection.id)),
      expiresAt: merged.expires_at === undefined ? null : new Date(merged.expires_at).toISOString(),
    });
    return merged;
  }
}

function specFor(provider: ConnectorProvider): ProviderSpec {
  if (provider === "github" || provider === "gmail") return PROVIDERS[provider];
  throw new ConnectorError("CONNECTOR_INVALID_PROVIDER", "unsupported connector provider");
}

function aad(connectionId: string): string {
  return `connection:${connectionId}:oauth`;
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.length > 64 * 1024) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "connector response was too large");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // GitHub can answer with form encoding; the accept header normally prevents it, but a malformed
    // acknowledgement is still only a safe exchange failure.
    throw new ConnectorError("CONNECTOR_OAUTH_EXCHANGE_FAILED", "OAuth token response was not JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConnectorError("CONNECTOR_OAUTH_EXCHANGE_FAILED", "OAuth token response was not an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.error === "string") {
    throw new ConnectorError("CONNECTOR_OAUTH_EXCHANGE_FAILED", "OAuth provider rejected the exchange");
  }
  return record;
}

async function tokenFromJson(body: Record<string, unknown>, nowMs: number): Promise<OAuthToken> {
  const access = body.access_token;
  if (typeof access !== "string" || access === "") {
    throw new ConnectorError("CONNECTOR_OAUTH_EXCHANGE_FAILED", "OAuth token response had no access token");
  }
  const expiresIn = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : undefined;
  return {
    access_token: access,
    ...(typeof body.refresh_token === "string" && body.refresh_token !== "" ? { refresh_token: body.refresh_token } : {}),
    ...(expiresIn === undefined ? {} : { expires_at: nowMs + expiresIn * 1_000 }),
    ...(typeof body.token_type === "string" ? { token_type: body.token_type } : {}),
    ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
  };
}

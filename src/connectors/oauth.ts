import { createHash, randomBytes } from "node:crypto";
import type { ConnectorsConfig } from "../config.js";
import { ConnectorError } from "./errors.js";
import { boundedJson, specFor, tokenFromJson, type OAuthToken } from "./providers.js";
import type { SecretProvider } from "./secrets.js";
import type { ConnectorConnection } from "./store.js";

/** The subset of a stored OAuth session the exchange needs. */
export type OAuthSessionInput = {
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly scopes: readonly string[];
};

export type OAuthExchangeResult = {
  readonly token: OAuthToken;
  readonly accountLabel: string;
  readonly scopes: readonly string[];
};

export type ConnectorOAuthOptions = {
  readonly secrets: SecretProvider;
  readonly config: ConnectorsConfig;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
};

/**
 * Server-side OAuth for GitHub and Gmail. This class only talks to the provider and the secret
 * source: session state, token persistence and connection status belong to the service and the
 * token vault, so the same flow works with local storage or the Cloudflare broker.
 */
export class ConnectorOAuth {
  readonly #secrets: SecretProvider;
  readonly #config: ConnectorsConfig;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: ConnectorOAuthOptions) {
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

  async start(connection: ConnectorConnection): Promise<{
    readonly url: string;
    readonly state: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }> {
    const spec = specFor(connection.provider);
    const redirectUri = this.redirectUri();
    const clientId = await this.#secrets.readText(spec.clientIdSecret);
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
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
    return { url: url.toString(), state, codeVerifier, redirectUri };
  }

  /**
   * Exchanges the authorization code for a token and looks up the account label. The caller is
   * responsible for state validation and for persisting the result in a token vault.
   */
  async exchange(
    connection: ConnectorConnection,
    session: OAuthSessionInput,
    code: string,
  ): Promise<OAuthExchangeResult> {
    const spec = specFor(connection.provider);
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
    let accountLabel: string;
    try {
      accountLabel = await spec.profile(token.access_token, this.#fetch, AbortSignal.timeout(this.#config.httpTimeoutMs));
    } catch {
      // The grant is valid even if the profile endpoint is temporarily unavailable. The UI still
      // sees a connected account; the label can be refreshed by reconnecting.
      accountLabel = connection.provider;
    }
    const scopes = token.scope === undefined || token.scope === ""
      ? session.scopes
      : token.scope.split(/\s+/).filter((value) => value !== "");
    return { token, accountLabel, scopes };
  }
}

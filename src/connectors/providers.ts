import { ConnectorError } from "./errors.js";
import { isOAuthProvider, type ConnectorProvider, type OAuthProvider } from "./store.js";

/** The provider-independent token shape used by both vaults. Never logged. */
export type OAuthToken = {
  readonly access_token: string;
  readonly refresh_token?: string;
  /** Unix epoch milliseconds. Absent means the provider did not tell us. */
  readonly expires_at?: number;
  readonly token_type?: string;
  readonly scope?: string;
};

export type ProviderSpec = {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly clientIdSecret: string;
  readonly clientSecretSecret: string;
  /**
   * Send PKCE (S256) on the authorization and token requests. Documented as supported by every
   * provider below; providers that do not support it must set this to false.
   */
  readonly pkce: boolean;
  /** Extra authorization-request parameters (Gmail's offline access, for example). */
  readonly authorizeParams?: Readonly<Record<string, string>>;
  /** Send the connection's scopes as `scope` on the authorization request (default true). */
  readonly sendScope?: boolean;
  /**
   * How the token request is authenticated and encoded. `form` is the RFC 6749 default;
   * `basic-json` sends HTTP Basic client credentials with a JSON body (Notion).
   */
  readonly tokenRequest?: "form" | "basic-json";
  /**
   * `scope` sent on the token request. Microsoft requires it, and `offline_access` must be part of
   * it or no refresh token is issued; other providers reject or ignore unknown fields.
   */
  readonly tokenScope?: string;
  readonly profile: (token: string, fetchImpl: typeof fetch, signal: AbortSignal) => Promise<string>;
};

export const PROVIDERS: Readonly<Record<OAuthProvider, ProviderSpec>> = {
  github: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    clientIdSecret: "github_client_id",
    clientSecretSecret: "github_client_secret",
    pkce: true,
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
    pkce: true,
    authorizeParams: {
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    },
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
  outlook: {
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    clientIdSecret: "outlook_client_id",
    clientSecretSecret: "outlook_client_secret",
    pkce: true,
    // With the `common` endpoint the token request must repeat the scope, including offline_access,
    // or Microsoft returns no refresh token.
    tokenScope: "offline_access User.Read Mail.Read",
    profile: async (token, fetchImpl, signal) => {
      const response = await fetchImpl(
        "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName",
        { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal },
      );
      if (!response.ok) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Microsoft Graph profile request failed");
      const body = await boundedJson(response);
      const mail = typeof body.mail === "string" && body.mail !== "" ? body.mail : undefined;
      const principal = typeof body.userPrincipalName === "string" && body.userPrincipalName !== ""
        ? body.userPrincipalName
        : undefined;
      const label = mail ?? principal;
      if (label === undefined) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Microsoft Graph profile response was invalid");
      return label;
    },
  },
  linear: {
    authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    clientIdSecret: "linear_client_id",
    clientSecretSecret: "linear_client_secret",
    // Linear documents code_challenge + code_challenge_method=S256 (and code_verifier on exchange).
    pkce: true,
    profile: async (token, fetchImpl, signal) => {
      const response = await fetchImpl("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "{ viewer { name email } }" }),
        signal,
      });
      if (!response.ok) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Linear profile request failed");
      const body = await boundedJson(response);
      const data = typeof body.data === "object" && body.data !== null && !Array.isArray(body.data)
        ? body.data as Record<string, unknown>
        : undefined;
      const viewer = data !== undefined && typeof data.viewer === "object" && data.viewer !== null
        && !Array.isArray(data.viewer)
        ? data.viewer as Record<string, unknown>
        : undefined;
      const name = viewer !== undefined && typeof viewer.name === "string" && viewer.name !== "" ? viewer.name : undefined;
      const email = viewer !== undefined && typeof viewer.email === "string" && viewer.email !== "" ? viewer.email : undefined;
      const label = name ?? email;
      if (label === undefined) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Linear profile response was invalid");
      return label;
    },
  },
  notion: {
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    clientIdSecret: "notion_client_id",
    clientSecretSecret: "notion_client_secret",
    // Notion has no PKCE, no scope parameter and no refresh token; the token is long-lived.
    pkce: false,
    sendScope: false,
    authorizeParams: { owner: "user" },
    tokenRequest: "basic-json",
    profile: async (token, fetchImpl, signal) => {
      const response = await fetchImpl("https://api.notion.com/v1/users/me", {
        headers: {
          authorization: `Bearer ${token}`,
          "notion-version": "2022-06-28",
          accept: "application/json",
        },
        signal,
      });
      if (!response.ok) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Notion profile request failed");
      const body = await boundedJson(response);
      const name = typeof body.name === "string" && body.name !== "" ? body.name : undefined;
      const bot = typeof body.bot === "object" && body.bot !== null && !Array.isArray(body.bot)
        ? body.bot as Record<string, unknown>
        : undefined;
      const workspace = bot !== undefined && typeof bot.workspace_name === "string" && bot.workspace_name !== ""
        ? bot.workspace_name
        : undefined;
      const label = name ?? workspace;
      if (label === undefined) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Notion profile response was invalid");
      return label;
    },
  },
  google_calendar: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientIdSecret: "google_client_id",
    clientSecretSecret: "google_client_secret",
    pkce: true,
    authorizeParams: {
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    },
    profile: googleProfile,
  },
  google_drive: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientIdSecret: "google_client_id",
    clientSecretSecret: "google_client_secret",
    pkce: true,
    authorizeParams: {
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    },
    profile: googleProfile,
  },
};

/** The Google providers share the OIDC userinfo endpoint for their account label. */
async function googleProfile(token: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<string> {
  const response = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Google profile request failed");
  const body = await boundedJson(response);
  const email = typeof body.email === "string" && body.email !== "" ? body.email : undefined;
  if (email === undefined) throw new ConnectorError("CONNECTOR_UPSTREAM_UNAVAILABLE", "Google profile response was invalid");
  return email;
}

export function specFor(provider: ConnectorProvider): ProviderSpec {
  if (!isOAuthProvider(provider)) {
    throw new ConnectorError("CONNECTOR_INVALID_PROVIDER", "unsupported connector provider");
  }
  return PROVIDERS[provider];
}

/** AAD for the local ciphertext store; the broker uses the slug with its own prefix. */
export function credentialAad(connectionId: string): string {
  return `connection:${connectionId}:oauth`;
}

export function expiresAtIso(token: OAuthToken): string | null {
  return token.expires_at === undefined ? null : new Date(token.expires_at).toISOString();
}

export async function boundedJson(response: Response): Promise<Record<string, unknown>> {
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

export async function tokenFromJson(body: Record<string, unknown>, nowMs: number): Promise<OAuthToken> {
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

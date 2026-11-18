import { ConnectorError } from "./errors.js";
import type { ConnectorProvider } from "./store.js";

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
  readonly profile: (token: string, fetchImpl: typeof fetch, signal: AbortSignal) => Promise<string>;
};

export const PROVIDERS: Readonly<Record<"github" | "gmail", ProviderSpec>> = {
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

export function specFor(provider: ConnectorProvider): ProviderSpec {
  if (provider === "github" || provider === "gmail") return PROVIDERS[provider];
  throw new ConnectorError("CONNECTOR_INVALID_PROVIDER", "unsupported connector provider");
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

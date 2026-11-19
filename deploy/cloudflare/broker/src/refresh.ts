import { BrokerError } from "./errors";
import type { Provider } from "./types";

/** Refreshes provider OAuth access tokens. Upstream bodies and credentials never leave this module. */

export type ProviderCredentials = {
  readonly clientId: string;
  readonly clientSecret: string;
};

export type RefreshResult = {
  readonly accessToken: string;
  readonly expiresAt: string | null;
  /** Present when the provider rotated the refresh token (GitHub does on every refresh). */
  readonly refreshToken?: string;
};

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const ENDPOINTS: Record<Provider, string> = {
  github: "https://github.com/login/oauth/access_token",
  gmail: "https://oauth2.googleapis.com/token",
  outlook: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  linear: "https://api.linear.app/oauth/token",
  // Notion tokens do not expire and carry no refresh token; this entry is never reached.
  notion: "https://api.notion.com/v1/oauth/token",
  google_calendar: "https://oauth2.googleapis.com/token",
  google_drive: "https://oauth2.googleapis.com/token",
};

/**
 * Provider-specific refresh parameters. Microsoft only reissues a refresh token when offline_access
 * is in scope. Google and Microsoft only return a token covering what was granted, so this list must
 * stay in step with the connector definitions on the host.
 */
const REFRESH_PARAMS: Readonly<Record<Provider, Readonly<Record<string, string>>>> = {
  github: {},
  gmail: { scope: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send" },
  outlook: { scope: "offline_access User.Read Mail.ReadWrite Mail.Send" },
  linear: {},
  notion: {},
  google_calendar: { scope: "openid email https://www.googleapis.com/auth/calendar" },
  google_drive: { scope: "openid email https://www.googleapis.com/auth/drive.file" },
};

const REFRESH_SKEW_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;

/** Tokens are refreshed slightly before they expire so a request never races the deadline. */
export function needsRefresh(
  accessToken: string | undefined,
  expiresAt: string | null | undefined,
  now = Date.now(),
): boolean {
  if (accessToken === undefined || accessToken === "") return true;
  if (expiresAt === undefined || expiresAt === null) return false;
  const deadline = Date.parse(expiresAt);
  if (Number.isNaN(deadline)) return true;
  return deadline - REFRESH_SKEW_MS <= now;
}

export async function refreshAccessToken(
  provider: Provider,
  refreshToken: string,
  credentials: ProviderCredentials,
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now,
): Promise<RefreshResult> {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  for (const [name, value] of Object.entries(REFRESH_PARAMS[provider])) body.set(name, value);
  let response: Response;
  try {
    response = await fetchImpl(ENDPOINTS[provider], {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw authExpired();
  }
  if (!response.ok) {
    // Never surface the upstream status body; it can contain token fragments.
    throw authExpired();
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw authExpired();
  }
  const parsed = record(payload);
  if (parsed === null) throw authExpired();
  if (parsed.error !== undefined) throw authExpired();
  const accessToken = parsed.access_token;
  if (typeof accessToken !== "string" || accessToken === "") throw authExpired();

  const expiresIn = parsed.expires_in;
  let expiresAt: string | null = null;
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    expiresAt = new Date(now() + expiresIn * 1000).toISOString();
  } else if (typeof expiresIn === "string" && /^\d+$/.test(expiresIn)) {
    expiresAt = new Date(now() + Number(expiresIn) * 1000).toISOString();
  }
  const rotated = parsed.refresh_token;
  return {
    accessToken,
    expiresAt,
    ...(typeof rotated === "string" && rotated !== "" ? { refreshToken: rotated } : {}),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function authExpired(): BrokerError {
  return new BrokerError(401, "CONNECTOR_AUTH_EXPIRED", "connector authorization expired; reconnect the provider");
}

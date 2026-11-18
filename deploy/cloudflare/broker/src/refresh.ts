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

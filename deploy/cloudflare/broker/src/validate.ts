import { BrokerError } from "./errors";
import type { Provider, StoredTokens } from "./types";

/** Only these names may ever be read through the broker; everything else is a 404, not a 403. */
export const SECRET_WHITELIST = [
  "credential_master_key",
  "github_client_id",
  "github_client_secret",
  "google_client_id",
  "google_client_secret",
  "deepseek_web_api_key",
  "exa_api_key",
] as const;

export type SecretName = (typeof SECRET_WHITELIST)[number];

const SLUG = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const PROVIDERS: readonly Provider[] = ["github", "gmail"];

export function isSecretName(name: string): name is SecretName {
  return (SECRET_WHITELIST as readonly string[]).includes(name);
}

export function secretName(name: string): SecretName {
  if (!isSecretName(name)) {
    throw new BrokerError(404, "SECRET_NOT_ALLOWED", "secret is not exposed by this broker");
  }
  return name;
}

export function connectionSlug(value: string): string {
  if (!SLUG.test(value)) {
    throw new BrokerError(400, "INVALID_SLUG", "slug must match [a-z0-9][a-z0-9_-]{0,47}");
  }
  return value;
}

export function providerName(value: unknown): Provider {
  if (typeof value !== "string" || !(PROVIDERS as readonly string[]).includes(value)) {
    throw new BrokerError(400, "INVALID_PROVIDER", "provider must be github or gmail");
  }
  return value as Provider;
}

export type ConnectionInput = {
  readonly provider: Provider;
  readonly accountLabel: string;
  readonly scopes: readonly string[];
  readonly tokens: StoredTokens;
};

/**
 * Validates a `PUT /v1/connections/:slug` body. Error messages describe the shape only; token
 * values from the body are never echoed.
 */
export function connectionInput(body: unknown): ConnectionInput {
  const record = object(body);
  const provider = providerName(record.provider);
  const accountLabel = text(record.accountLabel, "accountLabel", 256);
  const scopes = stringList(record.scopes, "scopes");
  // GitHub OAuth apps only return an access token; a missing refresh token is stored as null.
  const refreshToken = optionalText(record.refreshToken, "refreshToken", 4096) ?? null;
  const accessToken = optionalText(record.accessToken, "accessToken", 4096);
  if (refreshToken === null && accessToken === undefined) {
    throw new BrokerError(400, "INVALID_BODY", "refreshToken or accessToken is required");
  }
  const expiresAt = optionalTimestamp(record.expiresAt, "expiresAt");
  return {
    provider,
    accountLabel,
    scopes,
    tokens: {
      refreshToken,
      ...(accessToken === undefined ? {} : { accessToken }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    },
  };
}

export function storedTokens(value: unknown): StoredTokens {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BrokerError(500, "CONNECTOR_CREDENTIAL_UNREADABLE", "stored connector credential is malformed");
  }
  const record = value as Record<string, unknown>;
  const rawRefreshToken = record.refreshToken;
  let refreshToken: string | null;
  if (rawRefreshToken === undefined || rawRefreshToken === null) {
    refreshToken = null;
  } else if (typeof rawRefreshToken === "string" && rawRefreshToken !== "") {
    refreshToken = rawRefreshToken;
  } else {
    throw new BrokerError(500, "CONNECTOR_CREDENTIAL_UNREADABLE", "stored connector credential is malformed");
  }
  const accessToken = typeof record.accessToken === "string" && record.accessToken !== ""
    ? record.accessToken
    : undefined;
  const expiresAt = typeof record.expiresAt === "string" ? record.expiresAt : null;
  return {
    refreshToken,
    ...(accessToken === undefined ? {} : { accessToken }),
    expiresAt,
  };
}

/** Rejects anything but a JSON object so a mistyped body cannot half-write a connection. */
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BrokerError(400, "INVALID_BODY", "request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new BrokerError(400, "INVALID_BODY", "request body must be JSON");
  }
  return object(parsed);
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new BrokerError(400, "INVALID_BODY", `${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value, field, max);
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new BrokerError(400, "INVALID_BODY", `${field} must be an array of at most 64 strings`);
  }
  return value.map((entry) => text(entry, field, 256));
}

function optionalTimestamp(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new BrokerError(400, "INVALID_BODY", `${field} must be an ISO 8601 timestamp or null`);
  }
  return new Date(value).toISOString();
}

/**
 * Connector failures always carry a stable code and a fixed, safe message. Provider responses,
 * tokens, client secrets and file contents never reach an error string, a log or a tool result.
 */
export class ConnectorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ConnectorError";
  }
}

const SAFE_MESSAGES: Readonly<Record<string, string>> = {
  CONNECTOR_NOT_FOUND: "connector was not found",
  CONNECTOR_ALREADY_EXISTS: "a connector with this slug already exists",
  CONNECTOR_INVALID_PROVIDER: "unsupported connector provider",
  CONNECTOR_INVALID_SLUG: "slug must be 1-48 characters of lowercase letters, digits, '-' or '_'",
  CONNECTOR_NOT_CONFIGURED: "connector secrets are not configured on the server",
  CONNECTOR_SECRET_MISSING: "a required connector secret file is missing",
  CONNECTOR_SECRET_UNREADABLE: "a required connector secret file cannot be read",
  CONNECTOR_MASTER_KEY_INVALID: "credential_master_key must encode exactly 32 bytes",
  CONNECTOR_CREDENTIAL_UNREADABLE: "stored connector credential cannot be decrypted; reauthorize the connection",
  CONNECTOR_NOT_CONNECTED: "connector is not authorized yet",
  CONNECTOR_OAUTH_DISABLED: "OAuth redirect base URL is not configured on the server",
  CONNECTOR_OAUTH_STATE_INVALID: "OAuth state is invalid or has expired",
  CONNECTOR_OAUTH_EXCHANGE_FAILED: "OAuth token exchange failed",
  CONNECTOR_AUTH_EXPIRED: "connector authorization expired; reauthorize it",
  CONNECTOR_SCOPE_DENIED: "the connector is missing a required scope",
  CONNECTOR_UPSTREAM_UNAVAILABLE: "connector upstream is unavailable",
  CONNECTOR_UPSTREAM_NOT_FOUND: "the requested connector resource was not found",
  CONNECTOR_RATE_LIMITED: "connector upstream rate limit reached",
  CONNECTOR_INVALID_INPUT: "connector tool input is invalid",
  CONNECTOR_STDIO_NOT_ALLOWED: "this local connector command is not allowed",
};

export function safeConnectorMessage(code: string): string {
  return SAFE_MESSAGES[code] ?? "connector operation failed";
}

export function connectorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "CONNECTOR_UPSTREAM_UNAVAILABLE";
}

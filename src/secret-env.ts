import { BrokerClient } from "./connectors/broker-client.js";
import { ConnectorError } from "./connectors/errors.js";

/**
 * Optional provider keys that may live in the Cloudflare secret broker instead of the environment.
 * The environment keeps working unchanged: a value already present is never replaced.
 */
export type OptionalEnvSecret = {
  /** Environment variable the key normally comes from. */
  readonly env: string;
  /** Logical secret name in the broker. */
  readonly secret: string;
};

export const OPTIONAL_ENV_SECRETS: readonly OptionalEnvSecret[] = [
  { env: "EXA_API_KEY", secret: "exa_api_key" },
  { env: "DEEPSEEK_WEB_API_KEY", secret: "deepseek_web_api_key" },
];

/** A broker round trip must never hold up startup for long; two probes run in parallel. */
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 3_000;

export type SecretEnvOptions = {
  readonly fetch?: typeof fetch;
  /** Receives names and codes only; values are never passed here. */
  readonly log?: (line: string) => void;
  /** Per-request timeout; clamped to at most 3 seconds. */
  readonly timeoutMs?: number;
};

/**
 * Fills `EXA_API_KEY` / `DEEPSEEK_WEB_API_KEY` from the broker when `ASTER_SECRET_BACKEND=cf` and
 * the variable is absent or empty. This is strictly additive: a missing backend, an incomplete
 * broker configuration, a missing secret and any transport failure all leave the value unset and
 * never fail startup. Connector secret handling is untouched. The passed env object is mutated and
 * returned, so `process.env` gains the value for the rest of the process.
 */
export async function resolveOptionalEnvSecrets(
  env: NodeJS.ProcessEnv,
  options: SecretEnvOptions = {},
): Promise<NodeJS.ProcessEnv> {
  if ((env.ASTER_SECRET_BACKEND ?? "").trim() !== "cf") return env;
  const log = options.log ?? ((line: string) => console.error(line));

  const wanted = OPTIONAL_ENV_SECRETS.filter(({ env: name }) => (env[name] ?? "").trim() === "");
  if (wanted.length === 0) return env;

  const client = brokerClient(env, options, log);
  if (client === undefined) return env;

  await Promise.all(wanted.map(async ({ env: name, secret }) => {
    try {
      const response = await client.request(`/v1/secrets/${encodeURIComponent(secret)}`);
      if (!response.ok) {
        log(`secret env: ${secret} not resolved (code=${httpCode(response.status)})`);
        return;
      }
      const value = await secretValue(response, secret);
      if (value === undefined) {
        log(`secret env: ${secret} not resolved (code=INVALID_RESPONSE)`);
        return;
      }
      // Mirror the config boundary for vault placeholders so a malformed broker value cannot turn
      // a previously optional key into a startup failure.
      if (value.includes("__vault_") && value !== `__vault_${name}__`) {
        log(`secret env: ${secret} not resolved (code=INVALID_VALUE)`);
        return;
      }
      env[name] = value;
      log(`secret env: ${secret} resolved`);
    } catch (error) {
      const failureCode = error instanceof ConnectorError ? error.code : "SECRETS_UNAVAILABLE";
      log(`secret env: ${secret} not resolved (code=${failureCode})`);
    }
  }));
  return env;
}

/** Builds the client only when the broker settings are complete; incomplete settings stay silent. */
function brokerClient(
  env: NodeJS.ProcessEnv,
  options: SecretEnvOptions,
  log: (line: string) => void,
): BrokerClient | undefined {
  const rawUrl = env.ASTER_SECRET_BROKER_URL?.trim();
  const accessTokenFile = env.ASTER_CF_ACCESS_TOKEN_FILE?.trim() || undefined;
  const accessClientId = env.ASTER_CF_ACCESS_CLIENT_ID?.trim() || undefined;
  const accessClientSecret = env.ASTER_CF_ACCESS_CLIENT_SECRET?.trim() || undefined;
  if (rawUrl === undefined || rawUrl === ""
    || (accessTokenFile === undefined && (accessClientId === undefined || accessClientSecret === undefined))) {
    log("secret env: broker not configured (code=SECRETS_UNAVAILABLE)");
    return undefined;
  }
  let origin: string;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol");
    origin = url.origin;
  } catch {
    log("secret env: broker URL is invalid (code=INVALID_CONFIG)");
    return undefined;
  }
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);
  return new BrokerClient({
    baseUrl: origin,
    timeoutMs,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(accessClientId === undefined ? {} : { accessClientId }),
    ...(accessClientSecret === undefined ? {} : { accessClientSecret }),
    ...(accessTokenFile === undefined ? {} : { accessTokenFile }),
  });
}

/** `{ name, value }` only; anything else is treated as a failed read. */
async function secretValue(response: Response, secret: string): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  if (record.name !== secret || typeof record.value !== "string") return undefined;
  const value = record.value.trim();
  return value === "" ? undefined : value;
}

function httpCode(status: number): string {
  if (status === 404) return "SECRET_NOT_CONFIGURED";
  if (status === 401 || status === 403) return "ACCESS_DENIED";
  if (status === 429) return "RATE_LIMITED";
  return `HTTP_${status}`;
}

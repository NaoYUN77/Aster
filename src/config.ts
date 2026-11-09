import { readFileSync } from "node:fs";
import { setGlobalProxyFromEnv } from "node:http";
import { join, resolve } from "node:path";
import { ConfigurationError } from "./errors.js";
import { isProviderId, PROVIDER_IDS, providerApiKeyEnv } from "./providers.js";
import type { CustomProviderDeclaration } from "./provider-config.js";
import {
  assertSchema,
  eventDate,
  MEMORY_BUDGET_DEFAULTS,
  MemoryBudgetSchema,
  MemoryError,
  type MemoryBudget,
} from "./memory/contracts.js";

export { ConfigurationError };

const VAULT_PLACEHOLDER = /^__vault_[A-Z][A-Z0-9_]*__$/;

/** True when value is a well-formed OpenBao/MITM placeholder (`__vault_<NAME>__`). */
export function isVaultPlaceholder(value: string): boolean {
  return VAULT_PLACEHOLDER.test(value);
}

function assertValidCredentialShape(key: string, value: string): void {
  if (value.includes("__vault_") && !isVaultPlaceholder(value)) {
    throw new ConfigurationError(`${key} has a malformed vault placeholder; expected __vault_${key}__`);
  }
}

/** True when HTTP(S)_PROXY is present in the environment. */
export function hasProxyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.HTTPS_PROXY?.trim() || env.https_proxy?.trim() || env.HTTP_PROXY?.trim() || env.http_proxy?.trim(),
  );
}

const PROXY_VARS = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"] as const;
const MITM_TOKEN_FILE = "ASTER_MITM_TOKEN_FILE";
// Same shape the addon accepts: workable as URL userinfo without percent-encoding surprises.
const MITM_TOKEN_SHAPE = /^[A-Za-z0-9._~-]{16,256}$/;

/**
 * Adds the MITM proxy credentials from ASTER_MITM_TOKEN_FILE to every configured proxy URL. Node
 * sends URL userinfo as `Proxy-Authorization: Basic ...` on CONNECT, so the app satisfies the proxy's
 * token gate without a token in .env, argv, or tool arguments. An unreadable or malformed token is a
 * startup error: connecting without credentials would only earn a 407 later.
 */
export function withProxyToken(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const path = env[MITM_TOKEN_FILE]?.trim();
  if (!path) return env;
  let token: string;
  try {
    token = readFileSync(path, "utf8").trim();
  } catch {
    throw new ConfigurationError(`${MITM_TOKEN_FILE} could not be read`);
  }
  if (!MITM_TOKEN_SHAPE.test(token)) {
    throw new ConfigurationError(`${MITM_TOKEN_FILE} must contain 16-256 characters of [A-Za-z0-9._~-]`);
  }
  const effective: NodeJS.ProcessEnv = { ...env };
  for (const key of PROXY_VARS) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    const url = new URL(raw);
    url.username = "aster";
    url.password = token;
    effective[key] = url.toString();
  }
  return effective;
}

function validateProxyEnv(env: NodeJS.ProcessEnv): void {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new ConfigurationError(
      "NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed; trust the MITM CA via NODE_EXTRA_CA_CERTS",
    );
  }
  for (const key of PROXY_VARS) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ConfigurationError(`${key} must be a valid HTTP(S) URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ConfigurationError(`${key} must use http: or https:`);
    }
  }
}

/**
 * Enable Node's global HTTP(S) proxy dispatcher from the environment when a proxy variable is set.
 * Needed when HTTPS_PROXY is loaded from --env-file=.env after Node startup; safe alongside NODE_USE_ENV_PROXY=1.
 * With ASTER_MITM_TOKEN_FILE set, the effective URLs carry the proxy credentials and are written back
 * so clients that build their own agent from process.env (TelegramClient, MCP children) use them too.
 */
export function configureEnvProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  validateProxyEnv(env);
  if (!hasProxyEnv(env)) return false;
  const effective = withProxyToken(env);
  for (const key of PROXY_VARS) {
    const value = effective[key];
    if (value) env[key] = value;
  }
  setGlobalProxyFromEnv(effective);
  return true;
}

/**
 * MCP paths without the bot's own requirements, so the authorization CLI resolves the same file as the
 * running service. The default path is optional: a missing file just means no MCP servers. An explicitly
 * configured path must exist.
 */
export function resolveMcpConfigPaths(env: NodeJS.ProcessEnv = process.env) {
  const dataDir = resolve(env.DATA_DIR || "data");
  const mcpConfig = env.MCP_CONFIG?.trim();
  return {
    dataDir,
    mcpConfigPath: mcpConfig ? resolve(mcpConfig) : join(dataDir, "mcp.json"),
    mcpConfigExplicit: Boolean(mcpConfig),
  };
}

/**
 * Paths for the optional provider declaration file. Resolved from the environment alone, so the
 * provider list is known before MODEL_PROVIDER is validated. A missing default file means only the
 * compiled-in providers exist; an explicitly configured path must exist.
 */
export function resolveProviderConfigPath(env: NodeJS.ProcessEnv = process.env) {
  const dataDir = resolve(env.DATA_DIR || "data");
  const configured = env.PROVIDERS_CONFIG?.trim();
  return {
    providerConfigPath: configured ? resolve(configured) : join(dataDir, "providers.json"),
    providerConfigExplicit: Boolean(configured),
  };
}

export function readConfig(env: NodeJS.ProcessEnv = process.env, customProviders: readonly CustomProviderDeclaration[] = []) {
  validateProxyEnv(env);
  const paths = resolveMcpConfigPaths(env);
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new ConfigurationError(`Missing configuration: ${key}`);
    return value;
  };
  // The channel comes first: which variables exist, including the owner id, depends on it.
  const channelKind = readChannelKind(env);
  const ownerId = channelKind === "slack" ? readSlackOwnerId(env, required) : readOwnerId(env);
  const provider = required("MODEL_PROVIDER");
  // A declared provider carries its own credential variable name; either kind resolves to exactly
  // one environment variable holding one explicit key.
  const providerKeyEnv = providerApiKeyEnv(provider, customProviders);
  if (providerKeyEnv === undefined) {
    const detail = isProviderId(provider) ? "" : "; declared providers come from the provider config file";
    throw new ConfigurationError(`MODEL_PROVIDER must be one of: ${PROVIDER_IDS.join(", ")}${detail}`);
  }
  const providerKey = required(providerKeyEnv);
  assertValidCredentialShape(providerKeyEnv, providerKey);
  const deepseekWebApiKey = env.DEEPSEEK_WEB_API_KEY?.trim();
  if (deepseekWebApiKey) assertValidCredentialShape("DEEPSEEK_WEB_API_KEY", deepseekWebApiKey);
  const exaApiKey = env.EXA_API_KEY?.trim();
  if (exaApiKey) assertValidCredentialShape("EXA_API_KEY", exaApiKey);
  const reminders = readReminderConfig(env);
  const browser = readBrowserConfig(env);
  return {
    channel: readChannelCredentials(env, channelKind, ownerId, required),
    provider,
    model: required("MODEL_ID"),
    ...(deepseekWebApiKey ? { deepseekWebApiKey } : {}),
    ...(exaApiKey ? { exaApiKey } : {}),
    ...paths,
    ...(reminders.enabled ? { reminders } : {}),
    ...(browser === undefined ? {} : { browser }),
    trace: readTraceConfig(env),
  };
}

/** The browser the agent drives, named by the endpoint the host runs it on. */
export type BrowserConfig = {
  /** The CDP endpoint as agent-browser accepts it on `--cdp`, such as http://172.18.0.1:9222. */
  readonly cdp: string;
};

/**
 * AGENT_BROWSER_CDP names a browser that runs outside this process. The CLI reads the same variable
 * itself, so one setting decides both what the agent can run and whether the system prompt mentions
 * it: with no endpoint the prompt stays silent instead of pointing the model at a command that
 * cannot work. The endpoint is host context, never a model parameter, and it is not a credential —
 * but it is the browser's whole control channel, so an unreachable or public value is a
 * configuration error, not something to discover at request time.
 */
export function readBrowserConfig(env: NodeJS.ProcessEnv = process.env): BrowserConfig | undefined {
  const raw = env.AGENT_BROWSER_CDP?.trim();
  if (raw === undefined || raw === "") return undefined;
  const shape = "AGENT_BROWSER_CDP must be an http(s) or ws(s) URL, such as http://172.18.0.1:9222";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigurationError(shape);
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    throw new ConfigurationError(shape);
  }
  return { cdp: raw };
}

/** One-time reminders (REMINDERS_*). Enabled by default; limits bound each owner's stored rows. */
export type ReminderConfig = {
  readonly enabled: boolean;
  readonly maxPending: number;
  readonly maxPerHour: number;
  readonly horizonDays: number;
};

/**
 * Every reminder bound is validated even when reminders are disabled, so a malformed value cannot
 * silently take effect after the switch is flipped. Time itself is always resolved by the host.
 */
export function readReminderConfig(env: NodeJS.ProcessEnv = process.env): ReminderConfig {
  const enabledRaw = env.REMINDERS_ENABLED?.trim();
  if (enabledRaw !== undefined && enabledRaw !== "" && enabledRaw !== "0" && enabledRaw !== "1") {
    throw new ConfigurationError("REMINDERS_ENABLED must be 0 or 1");
  }
  return {
    enabled: enabledRaw !== "0",
    maxPending: boundedInteger(env, "REMINDERS_MAX_PENDING", 100, 1, 1_000),
    maxPerHour: boundedInteger(env, "REMINDERS_MAX_PER_HOUR", 20, 1, 1_000),
    horizonDays: boundedInteger(env, "REMINDERS_MAX_HORIZON_DAYS", 366, 1, 3_650),
  };
}

/**
 * Langfuse Cloud tracing. Off unless both API keys are configured; `LANGFUSE_TRACING_ENABLED=0`
 * switches it off while keeping the keys in place. Tracing is diagnostics: an absent or incomplete
 * configuration disables it instead of failing startup.
 */
export type TraceConfig = {
  readonly enabled: boolean;
  readonly publicKey?: string;
  readonly secretKey?: string;
  readonly baseUrl?: string;
};

/** Env var names belong to the Langfuse SDK; `LANGFUSE_HOST` is the common self-hosted alias. */
export function readTraceConfig(env: NodeJS.ProcessEnv = process.env): TraceConfig {
  const raw = env.LANGFUSE_TRACING_ENABLED?.trim().toLowerCase();
  if (raw !== undefined && raw !== "" && !["0", "1", "false", "true"].includes(raw)) {
    throw new ConfigurationError("LANGFUSE_TRACING_ENABLED must be 0, 1, false, or true");
  }
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
  const baseUrl = env.LANGFUSE_BASE_URL?.trim() || env.LANGFUSE_HOST?.trim();
  const keysConfigured = Boolean(publicKey && secretKey);
  const enabled = (keysConfigured || raw === "1" || raw === "true")
    && raw !== "0"
    && raw !== "false";
  return {
    enabled,
    ...(publicKey ? { publicKey } : {}),
    ...(secretKey ? { secretKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

function boundedInteger(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigurationError(`${key} must be an integer in ${min}..${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${key} must be an integer in ${min}..${max}`);
  }
  return value;
}

/**
 * The one conversation surface this process serves. Exactly one channel is active: the Inbox holds a
 * single request stream and a single identity, so two channels cannot share a data directory without
 * telling each other's messages apart. Switching the variable switches the channel.
 */
export type ChannelConfig =
  | { readonly kind: "telegram"; readonly ownerId: string; readonly token: string; readonly apiRoot?: string }
  | { readonly kind: "slack"; readonly ownerId: string; readonly botToken: string; readonly appToken: string };

export const CHANNELS = ["telegram", "slack"] as const;

const SLACK_BOT_TOKEN_SHAPE = /^xoxb-[A-Za-z0-9-]{20,250}$/;
const SLACK_APP_TOKEN_SHAPE = /^xapp-[A-Za-z0-9-]{20,250}$/;
// Slack member ids: a U (or legacy W) plus the member's alphanumeric id.
const SLACK_OWNER_ID_SHAPE = /^[UW][A-Z0-9]{6,15}$/;

/**
 * Which channel this process serves. The default keeps every existing deployment working, and an
 * unrecognised value is a startup error rather than a silent fallback to Telegram.
 */
function readChannelKind(env: NodeJS.ProcessEnv): "telegram" | "slack" {
  const raw = env.CHANNEL?.trim().toLowerCase();
  if (raw !== undefined && raw !== "" && !(CHANNELS as readonly string[]).includes(raw)) {
    throw new ConfigurationError(`CHANNEL must be one of: ${CHANNELS.join(", ")}`);
  }
  return raw === "slack" ? "slack" : "telegram";
}

function readSlackOwnerId(env: NodeJS.ProcessEnv, required: (key: string) => string): string {
  const ownerId = required("SLACK_OWNER_ID");
  if (!SLACK_OWNER_ID_SHAPE.test(ownerId)) {
    throw new ConfigurationError("SLACK_OWNER_ID must be a Slack member ID, such as U0123ABCDEF");
  }
  return ownerId;
}

/**
 * Reads the selected channel's own variables. Only the active channel's credentials are required, so
 * a Telegram deployment never needs Slack tokens and vice versa. A prefix check catches a token
 * pasted into the wrong variable; a vault placeholder is accepted wherever a credential is expected.
 */
function readChannelCredentials(
  env: NodeJS.ProcessEnv,
  kind: "telegram" | "slack",
  ownerId: string,
  required: (key: string) => string,
): ChannelConfig {
  if (kind === "slack") {
    const botToken = required("SLACK_BOT_TOKEN");
    const appToken = required("SLACK_APP_TOKEN");
    assertSlackToken("SLACK_BOT_TOKEN", botToken, SLACK_BOT_TOKEN_SHAPE);
    assertSlackToken("SLACK_APP_TOKEN", appToken, SLACK_APP_TOKEN_SHAPE);
    return { kind: "slack", ownerId, botToken, appToken };
  }
  const token = required("TELEGRAM_BOT_TOKEN");
  assertValidCredentialShape("TELEGRAM_BOT_TOKEN", token);
  const apiRoot = readTelegramApiRoot(env);
  return { kind: "telegram", ownerId, token, ...(apiRoot ? { apiRoot } : {}) };
}

function assertSlackToken(key: string, value: string, shape: RegExp): void {
  assertValidCredentialShape(key, value);
  if (isVaultPlaceholder(value)) return;
  if (!shape.test(value)) throw new ConfigurationError(`${key} is not shaped like a Slack token`);
}

/**
 * Optional Telegram Bot API root override (a reverse proxy, e.g. a Cloudflare Worker) for hosts
 * that cannot reach api.telegram.org directly. The value is a URL prefix: the client appends
 * /bot<token>/<method> to it. It must be an https URL without query or fragment; trailing
 * slashes are dropped so the join is exact. Unset means the default api.telegram.org root.
 */
function readTelegramApiRoot(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.TELEGRAM_API_ROOT?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError("TELEGRAM_API_ROOT must be a valid URL");
  }
  if (url.protocol !== "https:") throw new ConfigurationError("TELEGRAM_API_ROOT must be an https URL");
  if (url.search || url.hash) throw new ConfigurationError("TELEGRAM_API_ROOT must not contain a query or fragment");
  return url.href.replace(/\/+$/, "");
}

/** Memory wiring (MEM-07): budgets, the compaction reserve, the archive timezone and timeout. */
export type MemoryConfig = {
  readonly enabled: boolean;
  readonly budget: MemoryBudget;
  /** Tokens kept free for the model's answer; the compaction thresholds derive from it. */
  readonly reserveTokens: number;
  /** Zone archive dates are computed in. Default UTC; never the machine's local zone. */
  readonly timezone: string;
  readonly archiveTimeoutMs: number;
};

function memoryInteger(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigurationError(`${key} must be an integer in ${min}..${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(`${key} must be an integer in ${min}..${max}`);
  }
  return value;
}

/**
 * Every memory parameter is optional; an explicitly set value must be an integer inside its valid
 * range, and the assembled budget must satisfy the one budget schema (MEM-01) plus the rule that a
 * single retrieval fits inside one request's cumulative retrieval budget. Anything else is a
 * startup configuration error naming the variable, never a silent clamp.
 */
export function readMemoryConfig(env: NodeJS.ProcessEnv = process.env): MemoryConfig {
  const enabledRaw = env.MEMORY_ENABLED?.trim();
  if (enabledRaw !== undefined && enabledRaw !== "" && enabledRaw !== "0" && enabledRaw !== "1") {
    throw new ConfigurationError("MEMORY_ENABLED must be 0 or 1");
  }
  const budget: MemoryBudget = {
    backgroundTargetTokens: memoryInteger(env, "MEMORY_BACKGROUND_TARGET_TOKENS", MEMORY_BUDGET_DEFAULTS.backgroundTargetTokens, 1_024, 1_048_576),
    recentVerbatimTokens: memoryInteger(env, "MEMORY_RECENT_VERBATIM_TOKENS", MEMORY_BUDGET_DEFAULTS.recentVerbatimTokens, 512, 1_048_576),
    snapshotTokens: memoryInteger(env, "MEMORY_SNAPSHOT_TOKENS", MEMORY_BUDGET_DEFAULTS.snapshotTokens, 256, 262_144),
    narrativeTokens: memoryInteger(env, "MEMORY_NARRATIVE_TOKENS", MEMORY_BUDGET_DEFAULTS.narrativeTokens, 128, 262_144),
    instructionsTokens: memoryInteger(env, "MEMORY_INSTRUCTIONS_TOKENS", MEMORY_BUDGET_DEFAULTS.instructionsTokens, 256, 1_048_576),
    searchResultTokens: memoryInteger(env, "MEMORY_SEARCH_RESULT_TOKENS", MEMORY_BUDGET_DEFAULTS.searchResultTokens, 128, 65_536),
    requestSearchTokens: memoryInteger(env, "MEMORY_REQUEST_SEARCH_TOKENS", MEMORY_BUDGET_DEFAULTS.requestSearchTokens, 128, 262_144),
    evaluateAfterUserTurns: memoryInteger(env, "MEMORY_EVALUATE_AFTER_USER_TURNS", MEMORY_BUDGET_DEFAULTS.evaluateAfterUserTurns, 1, 1_000),
  };
  if (budget.requestSearchTokens < budget.searchResultTokens) {
    throw new ConfigurationError("MEMORY_REQUEST_SEARCH_TOKENS must be at least MEMORY_SEARCH_RESULT_TOKENS");
  }
  try {
    assertSchema<MemoryBudget>(MemoryBudgetSchema, budget, "invalid-input");
  } catch (error) {
    if (error instanceof MemoryError) throw new ConfigurationError("MEMORY_* budget values do not satisfy the memory budget schema");
    throw error;
  }
  const timezone = env.MEMORY_TIMEZONE?.trim() || "UTC";
  try {
    eventDate(0, timezone);
  } catch {
    throw new ConfigurationError(`MEMORY_TIMEZONE is not a known time zone: ${timezone}`);
  }
  return {
    enabled: enabledRaw !== "0",
    budget,
    reserveTokens: memoryInteger(env, "MEMORY_RESERVE_TOKENS", 16_384, 1, 1_048_576),
    timezone,
    archiveTimeoutMs: memoryInteger(env, "MEMORY_ARCHIVE_TIMEOUT_MS", 60_000, 1, 300_000),
  };
}

function readOwnerId(env: NodeJS.ProcessEnv): string {
  const ownerId = env.TELEGRAM_OWNER_ID?.trim();
  if (!ownerId) throw new ConfigurationError("Missing configuration: TELEGRAM_OWNER_ID");
  if (!/^[1-9]\d*$/.test(ownerId)) throw new ConfigurationError("TELEGRAM_OWNER_ID must be a positive numeric user ID");
  return ownerId;
}

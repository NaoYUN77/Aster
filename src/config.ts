import { readFileSync } from "node:fs";
import { setGlobalProxyFromEnv } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import { ConfigurationError } from "./errors.js";
import { MODEL_FAILOVER_DEFAULTS, type ModelRef } from "./model-failover.js";
import type { WatchersConfig } from "./watchers/protocol.js";
import { MEMORY_LIMITS } from "./memory/fs/contracts.js";
import { DREAMING_DEFAULTS, type DreamingBehavior, type DreamingConfig } from "./memory/dreaming.js";
import { isProviderId, PROVIDER_IDS, providerApiKeyEnv } from "./providers.js";
import type { CustomProviderDeclaration } from "./provider-config.js";
import { ROUTINE_DEFAULTS, type RoutinesConfig } from "./routines/protocol.js";
import { assertTimeZone, isValidTimeOfDay, normalizeTimeOfDay } from "./routines/time.js";
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
 * so clients that build their own agent from process.env (MCP children) use them too.
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
  // The web adapter is the only conversation surface, so its owner id is the only channel identity.
  const ownerId = readWebOwnerId(env);
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
  const watchers = readWatchersConfig(env);
  const routines = readRoutinesConfig(env);
  const skills = readSkillsConfig(env);
  const browser = readBrowserConfig(env);
  // The web adapter has no bot credential: the owner authenticates with a password, and the HTTP
  // layer enforces that. Configuration only names the internal sender id.
  const channel: ChannelConfig = { kind: "web", ownerId };
  const model = required("MODEL_ID");
  const failover = readModelFailoverConfig(
    env,
    { provider, modelId: model },
    (id) => providerApiKeyEnv(id, customProviders) !== undefined,
  );
  // Each provider in the chain is a separate credential. A fallback whose key variable is absent
  // would only fail at the first outage, so it fails startup instead.
  for (const fallbackProvider of new Set(failover?.fallbacks.map((fallback) => fallback.provider) ?? [])) {
    if (fallbackProvider === provider) continue;
    const fallbackKeyEnv = providerApiKeyEnv(fallbackProvider, customProviders);
    if (fallbackKeyEnv === undefined) continue; // readModelFailoverConfig already rejected this.
    const fallbackKey = required(fallbackKeyEnv);
    assertValidCredentialShape(fallbackKeyEnv, fallbackKey);
  }
  return {
    channel,
    provider,
    model,
    ...(failover === undefined ? {} : { failover }),
    ...(deepseekWebApiKey ? { deepseekWebApiKey } : {}),
    ...(exaApiKey ? { exaApiKey } : {}),
    ...paths,
    ...(reminders.enabled ? { reminders } : {}),
    ...(watchers.enabled ? { watchers } : {}),
    ...(routines.enabled ? { routines } : {}),
    ...(skills.enabled ? { skills } : {}),
    ...(browser === undefined ? {} : { browser }),
    memoryFs: readMemoryFsConfig(env),
    dreaming: readDreamingConfig(env),
    trace: readTraceConfig(env),
    // The memory system is always composed; MEMORY_ENABLED is a removed key, reported by name.
    memory: readMemoryConfig(env),
    web: readWebConfig(env),
    connectors: readConnectorsConfig(env),
  };
}

/**
 * Variables an upgraded deployment may still carry: the Telegram/Slack builds, and the memory
 * switch that no longer exists because the memory system is always composed.
 */
const REMOVED_ENV_KEYS = ["CHANNEL", "STYLE_LEARNING", "MEMORY_ENABLED", "DREAMING_REVIEW"] as const;
const REMOVED_ENV_PREFIXES = ["TELEGRAM_", "SLACK_"] as const;

/**
 * The names (never the values) of environment variables this build no longer reads. They are
 * silently ignored so an existing .env keeps booting, but startup says so once so nobody believes
 * a leftover `CHANNEL` or token still does something.
 */
export function removedConfigKeys(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return Object.keys(env)
    .filter((key) => (REMOVED_ENV_KEYS as readonly string[]).includes(key)
      || REMOVED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))
    .sort();
}

/** The one startup line printed when {@link removedConfigKeys} finds anything. Names only. */
export const REMOVED_CONFIG_LINE = "REMOVED_CONFIG: CHANNEL, TELEGRAM_*, SLACK_*, STYLE_LEARNING, MEMORY_ENABLED, DREAMING_REVIEW are no longer read";

/** At most this many fallbacks; the first batch intentionally keeps the chain short. */
const MAX_MODEL_FALLBACKS = 5;

/** Model-provider failover (MODEL_FALLBACKS / MODEL_REQUEST_TIMEOUT_MS). */
export type ModelFailoverConfig = {
  /** Models to try, in order, after the primary. Never contains the primary itself. */
  readonly fallbacks: readonly ModelRef[];
  /** Bound for one model request before the next model takes over. */
  readonly requestTimeoutMs: number;
};

/**
 * `MODEL_FALLBACKS` is a comma-separated `provider:model` list. An absent or empty value means the
 * feature is off and nothing about the request path changes. Every malformed entry is a startup
 * error: a typo must not silently leave the deployment without a fallback, and a list that repeats
 * the primary would double-count it. Model ids may contain a colon, so the first colon separates
 * provider from model.
 */
export function readModelFailoverConfig(
  env: NodeJS.ProcessEnv,
  primary: ModelRef,
  knownProvider: (id: string) => boolean,
): ModelFailoverConfig | undefined {
  const raw = env.MODEL_FALLBACKS?.trim();
  const timeoutConfigured = env.MODEL_REQUEST_TIMEOUT_MS?.trim();
  if (raw === undefined || raw === "") {
    if (timeoutConfigured !== undefined && timeoutConfigured !== "") {
      throw new ConfigurationError("MODEL_REQUEST_TIMEOUT_MS requires MODEL_FALLBACKS");
    }
    return undefined;
  }
  const entries = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (entries.length === 0) {
    throw new ConfigurationError("MODEL_FALLBACKS must name at least one provider:model");
  }
  if (entries.length > MAX_MODEL_FALLBACKS) {
    throw new ConfigurationError(`MODEL_FALLBACKS must list at most ${MAX_MODEL_FALLBACKS} models`);
  }
  const fallbacks: ModelRef[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new ConfigurationError(`MODEL_FALLBACKS entry "${entry}" must be provider:model`);
    }
    const provider = entry.slice(0, separator).trim();
    const modelId = entry.slice(separator + 1).trim();
    if (provider === "" || modelId === "" || /\s/.test(provider) || /\s/.test(modelId)) {
      throw new ConfigurationError(`MODEL_FALLBACKS entry "${entry}" must be provider:model without spaces`);
    }
    if (!knownProvider(provider)) {
      throw new ConfigurationError(`MODEL_FALLBACKS names an unknown provider: ${provider}`);
    }
    const key = `${provider}:${modelId}`;
    if (seen.has(key)) {
      throw new ConfigurationError(`MODEL_FALLBACKS lists ${key} more than once`);
    }
    seen.add(key);
    if (provider === primary.provider && modelId === primary.modelId) {
      throw new ConfigurationError(
        `MODEL_FALLBACKS lists the primary model ${key}; the primary is already the first model in the chain`,
      );
    }
    fallbacks.push({ provider, modelId });
  }
  return {
    fallbacks,
    requestTimeoutMs: boundedInteger(
      env,
      "MODEL_REQUEST_TIMEOUT_MS",
      MODEL_FAILOVER_DEFAULTS.requestTimeoutMs,
      10_000,
      600_000,
    ),
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
 * Event tracking (WATCHERS_*). On by default, matching `.env.example`: no outbound request is made
 * while no watcher exists. `WATCHERS_ENABLED=0` disables the loop entirely. Every malformed bound
 * fails startup rather than being discovered at the first check.
 */
export function readWatchersConfig(env: NodeJS.ProcessEnv = process.env): WatchersConfig {
  const enabledRaw = env.WATCHERS_ENABLED?.trim();
  if (enabledRaw !== undefined && enabledRaw !== "" && enabledRaw !== "0" && enabledRaw !== "1") {
    throw new ConfigurationError("WATCHERS_ENABLED must be 0 or 1");
  }
  const relayUrl = env.WATCHERS_RELAY_URL?.trim();
  if (relayUrl !== undefined && relayUrl !== "" && !/^https?:\/\/[^\s]+$/.test(relayUrl)) {
    throw new ConfigurationError("WATCHERS_RELAY_URL must be an absolute http(s) URL");
  }
  const relayToken = env.WATCHERS_RELAY_TOKEN?.trim();
  if (relayToken !== undefined && relayToken !== "" && relayToken.length < 16) {
    throw new ConfigurationError("WATCHERS_RELAY_TOKEN must be at least 16 characters");
  }
  const githubToken = env.WATCHERS_GITHUB_TOKEN?.trim();
  if (githubToken !== undefined && githubToken !== "" && githubToken.length < 16) {
    throw new ConfigurationError("WATCHERS_GITHUB_TOKEN must be at least 16 characters");
  }
  // Half a relay configuration is a mistake: the URL without a secret would 404 forever, and the
  // secret without a URL would silently disable GitHub tracking.
  if ((relayUrl === undefined || relayUrl === "") !== (relayToken === undefined || relayToken === "")) {
    throw new ConfigurationError("WATCHERS_RELAY_URL and WATCHERS_RELAY_TOKEN must be set together");
  }
  return {
    enabled: enabledRaw !== "0",
    maxActive: boundedInteger(env, "WATCHERS_MAX_ACTIVE", 20, 1, 100),
    maxPerHour: boundedInteger(env, "WATCHERS_MAX_PER_HOUR", 10, 1, 100),
    feedIntervalSec: boundedInteger(env, "WATCHERS_FEED_INTERVAL_SEC", 600, 300, 86_400),
    xIntervalSec: boundedInteger(env, "WATCHERS_X_INTERVAL_SEC", 900, 300, 86_400),
    githubReconcileMin: boundedInteger(env, "WATCHERS_GITHUB_RECONCILE_MIN", 15, 0, 1_440),
    fetchTimeoutMs: boundedInteger(env, "WATCHERS_FETCH_TIMEOUT_MS", 15_000, 1_000, 60_000),
    ...(relayUrl === undefined || relayUrl === "" ? {} : { relayUrl }),
    ...(relayToken === undefined || relayToken === "" ? {} : { relayToken }),
    ...(githubToken === undefined || githubToken === "" ? {} : { githubToken }),
  };
}

/**
 * Standing tasks (ROUTINES_*). Enabled by default because that is the feature Jay asked for; every
 * bound is validated even when disabled, so flipping the switch cannot surface a malformed value
 * later. `ROUTINES_PAUSED=1` is the process-level kill switch: the scheduler never dispatches.
 */
export function readRoutinesConfig(env: NodeJS.ProcessEnv = process.env): RoutinesConfig {
  const switchValue = (key: string, fallback: boolean): boolean => {
    const raw = env[key]?.trim();
    if (raw === undefined || raw === "") return fallback;
    if (raw !== "0" && raw !== "1") throw new ConfigurationError(`${key} must be 0 or 1`);
    return raw === "1";
  };
  const timezone = env.ROUTINES_TIMEZONE?.trim() || ROUTINE_DEFAULTS.timezone;
  try {
    assertTimeZone(timezone);
  } catch {
    throw new ConfigurationError("ROUTINES_TIMEZONE must be a valid IANA time zone name, such as Asia/Shanghai");
  }
  const summaryLocalTime = normalizeTimeOfDay(env.ROUTINES_SUMMARY_TIME?.trim() || ROUTINE_DEFAULTS.summaryLocalTime);
  if (!isValidTimeOfDay(summaryLocalTime)) {
    throw new ConfigurationError("ROUTINES_SUMMARY_TIME must be a 24-hour local time such as 21:00");
  }
  return {
    enabled: switchValue("ROUTINES_ENABLED", true),
    paused: switchValue("ROUTINES_PAUSED", false),
    timezone,
    maxPerOwner: boundedInteger(env, "ROUTINES_MAX_PER_OWNER", ROUTINE_DEFAULTS.maxPerOwner, 1, 500),
    minIntervalMinutes: boundedInteger(env, "ROUTINES_MIN_INTERVAL_MINUTES", ROUTINE_DEFAULTS.minIntervalMinutes, 1, 1_440),
    // 0 is the confirmed default: no hard cap, with the daily summary and anomaly alert as backstops.
    maxRunsPerDay: boundedInteger(env, "ROUTINES_MAX_RUNS_PER_DAY", ROUTINE_DEFAULTS.maxRunsPerDay, 0, 10_000),
    runTimeoutMs: boundedInteger(env, "ROUTINES_RUN_TIMEOUT_MS", ROUTINE_DEFAULTS.runTimeoutMs, 30_000, 3_600_000),
    summaryEnabled: switchValue("ROUTINES_SUMMARY_ENABLED", true),
    summaryLocalTime,
    retentionDays: boundedInteger(env, "ROUTINES_RETENTION_DAYS", ROUTINE_DEFAULTS.retentionDays, 7, 3_650),
  };
}

/** Skills (SKILLS_*): a directory of procedures indexed at startup; a body is read only on demand. */
export type SkillsConfig = {
  readonly enabled: boolean;
  readonly dir: string;
};

/**
 * The directory is resolved once so the index, the loader and an operator looking at the host all
 * agree on one path. A missing directory is an empty index, not a startup failure.
 */
export function readSkillsConfig(env: NodeJS.ProcessEnv = process.env): SkillsConfig {
  const enabledRaw = env.SKILLS_ENABLED?.trim();
  if (enabledRaw !== undefined && enabledRaw !== "" && enabledRaw !== "0" && enabledRaw !== "1") {
    throw new ConfigurationError("SKILLS_ENABLED must be 0 or 1");
  }
  const rawDir = env.SKILLS_DIR?.trim();
  const dir = rawDir === undefined || rawDir === ""
    ? join(resolve(env.DATA_DIR || "data"), "skills")
    : resolve(rawDir);
  return { enabled: enabledRaw !== "0", dir };
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
 * The one conversation surface this process serves. The web adapter is the only entry: one owner,
 * one conversation, no bot credential. The discriminant stays so call sites keep reading the same
 * `kind`, but there is nothing left to switch on.
 */
export type ChannelConfig = { readonly kind: "web"; readonly ownerId: string };

/** Web adapter runtime settings. */
export type WebConfig = {
  readonly port: number;
  readonly host: string;
  /** Origins allowed to call the API from a desktop/mobile WebView. Same-origin needs no entry. */
  readonly allowedOrigins: readonly string[];
  readonly sessionTtlDays: number;
  /** Directory of the built frontend; relative paths resolve from the process working directory. */
  readonly staticDir: string;
  /** Whether to trust X-Forwarded-For from the local reverse proxy for the login rate limit. */
  readonly trustProxy: boolean;
};

const WEB_OWNER_ID_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;
// scheme://authority, no path/query/fragment. Native WebView origins use custom schemes.
const ORIGIN_SHAPE = /^[a-z][a-z0-9+.-]*:\/\/[^\s/?#]+$/i;
const DEFAULT_WEB_ORIGINS = [
  "http://localhost",
  "http://localhost:5173",
  // Capacitor WebView origins used by the native shells.
  "https://localhost",
  "http://tauri.localhost",
  "tauri://localhost",
  "capacitor://localhost",
] as const;

/**
 * The web adapter is one owner. `WEB_OWNER_ID` is only the internal sender id the agent sees; it is
 * not a login name and never creates a second user.
 */
function readWebOwnerId(env: NodeJS.ProcessEnv): string {
  const raw = env.WEB_OWNER_ID?.trim();
  const ownerId = raw === undefined || raw === "" ? "owner" : raw;
  if (!WEB_OWNER_ID_SHAPE.test(ownerId)) {
    throw new ConfigurationError("WEB_OWNER_ID must be 1-64 characters of [A-Za-z0-9._-]");
  }
  return ownerId;
}

function readOriginList(env: NodeJS.ProcessEnv, key: string): readonly string[] {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_WEB_ORIGINS;
  const origins = raw.split(",").map((value) => value.trim()).filter((value) => value !== "");
  for (const origin of origins) {
    if (!ORIGIN_SHAPE.test(origin)) {
      throw new ConfigurationError(`${key} must list origins such as https://desktop.example (no path), comma-separated`);
    }
  }
  return [...new Set(origins)];
}

export function readWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const host = env.WEB_HOST?.trim() || "0.0.0.0";
  if (/\s/.test(host)) throw new ConfigurationError("WEB_HOST must not contain whitespace");
  const rawTrustProxy = env.WEB_TRUST_PROXY?.trim();
  if (rawTrustProxy !== undefined && rawTrustProxy !== "" && rawTrustProxy !== "0" && rawTrustProxy !== "1") {
    throw new ConfigurationError("WEB_TRUST_PROXY must be 0 or 1");
  }
  return {
    port: boundedInteger(env, "WEB_PORT", 8787, 1, 65_535),
    host,
    allowedOrigins: readOriginList(env, "WEB_ALLOWED_ORIGINS"),
    sessionTtlDays: boundedInteger(env, "WEB_SESSION_TTL_DAYS", 30, 1, 3_650),
    staticDir: env.WEB_STATIC_DIR?.trim() || "web/dist",
    trustProxy: rawTrustProxy === "1",
  };
}

export type SecretBackend = "file" | "cf";

/** Cloudflare Worker secret broker access: URL plus the Cloudflare Access service token. */
export type SecretBrokerConfig = {
  readonly url: string;
  readonly accessClientId?: string;
  readonly accessClientSecret?: string;
  /** Two-line file (client id, client secret); takes precedence over the two env values. */
  readonly accessTokenFile?: string;
};

/** Connector MVP settings. Secret values come from the file directory or the CF broker. */
export type ConnectorsConfig = {
  readonly enabled: boolean;
  /** Directory of read-only secret files, used only when `secretBackend` is `file`. */
  readonly secretDir: string;
  /** Where connector secrets and OAuth tokens live; `file` (default) or `cf`. */
  readonly secretBackend: SecretBackend;
  readonly broker?: SecretBrokerConfig;
  /** Public origin the OAuth provider redirects to; the callback path is appended. */
  readonly redirectBaseUrl?: string;
  /**
   * Optional app URL shown on the OAuth success page. When set, the page offers a button and a
   * meta refresh to it; when unset (the default) the page stays in the browser.
   */
  readonly oauthReturnUrl?: string;
  /** One-shot migration of local ciphertext into the broker at startup. */
  readonly migrateCredentials: boolean;
  readonly httpTimeoutMs: number;
  readonly oauthStateTtlMs: number;
  readonly leaseTtlMs: number;
  /** Commands allowed for a local `mcp_stdio` connector; empty denies every command. */
  readonly stdioAllowlist: readonly string[];
};

function readSecretBackend(env: NodeJS.ProcessEnv): SecretBackend {
  const raw = env.ASTER_SECRET_BACKEND?.trim();
  if (raw === undefined || raw === "") return "file";
  if (raw !== "file" && raw !== "cf") {
    throw new ConfigurationError("ASTER_SECRET_BACKEND must be file or cf");
  }
  return raw;
}

function readSecretBroker(env: NodeJS.ProcessEnv): SecretBrokerConfig {
  const raw = env.ASTER_SECRET_BROKER_URL?.trim();
  if (raw === undefined || raw === "") {
    throw new ConfigurationError("ASTER_SECRET_BROKER_URL is required when ASTER_SECRET_BACKEND=cf");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError("ASTER_SECRET_BROKER_URL must be an absolute http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigurationError("ASTER_SECRET_BROKER_URL must be an absolute http(s) URL");
  }
  // Host secrets and tokens must not travel in clear text; loopback is the local test exception.
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback) {
    throw new ConfigurationError("ASTER_SECRET_BROKER_URL must use https outside loopback");
  }
  if (url.search !== "" || url.hash !== "" || (url.pathname !== "/" && url.pathname !== "")) {
    throw new ConfigurationError("ASTER_SECRET_BROKER_URL must be an origin without a path");
  }
  const accessTokenFile = env.ASTER_CF_ACCESS_TOKEN_FILE?.trim() || undefined;
  if (accessTokenFile !== undefined && (accessTokenFile.length > 4_096 || accessTokenFile.includes("\0"))) {
    throw new ConfigurationError("ASTER_CF_ACCESS_TOKEN_FILE is not a valid path");
  }
  const accessClientId = env.ASTER_CF_ACCESS_CLIENT_ID?.trim() || undefined;
  const accessClientSecret = env.ASTER_CF_ACCESS_CLIENT_SECRET?.trim() || undefined;
  for (const [key, value] of [
    ["ASTER_CF_ACCESS_CLIENT_ID", accessClientId],
    ["ASTER_CF_ACCESS_CLIENT_SECRET", accessClientSecret],
  ] as const) {
    if (value !== undefined && value.length > 4_096) {
      throw new ConfigurationError(`${key} is too long`);
    }
  }
  if (accessTokenFile === undefined && (accessClientId === undefined || accessClientSecret === undefined)) {
    throw new ConfigurationError(
      "ASTER_CF_ACCESS_TOKEN_FILE or both ASTER_CF_ACCESS_CLIENT_ID and ASTER_CF_ACCESS_CLIENT_SECRET are required when ASTER_SECRET_BACKEND=cf",
    );
  }
  return {
    url: url.origin,
    ...(accessClientId === undefined ? {} : { accessClientId }),
    ...(accessClientSecret === undefined ? {} : { accessClientSecret }),
    ...(accessTokenFile === undefined ? {} : { accessTokenFile }),
  };
}

function readOAuthReturnUrl(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.CONNECTOR_OAUTH_RETURN_URL?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (raw.length > 2_048) throw new ConfigurationError("CONNECTOR_OAUTH_RETURN_URL is too long");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigurationError("CONNECTOR_OAUTH_RETURN_URL must be an absolute URL");
  }
  if (!["aster:", "http:", "https:"].includes(url.protocol)) {
    throw new ConfigurationError("CONNECTOR_OAUTH_RETURN_URL must use aster:, http: or https:");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigurationError("CONNECTOR_OAUTH_RETURN_URL must not contain credentials");
  }
  return url.toString();
}

export function readConnectorsConfig(env: NodeJS.ProcessEnv = process.env): ConnectorsConfig {
  const enabledRaw = env.CONNECTORS_ENABLED?.trim();
  if (enabledRaw !== undefined && enabledRaw !== "" && enabledRaw !== "0" && enabledRaw !== "1") {
    throw new ConfigurationError("CONNECTORS_ENABLED must be 0 or 1");
  }
  const secretDir = env.ASTER_CONNECTOR_SECRET_DIR?.trim() || "/run/secrets/aster-connectors";
  if (secretDir.length > 4_096 || secretDir.includes("\0")) {
    throw new ConfigurationError("ASTER_CONNECTOR_SECRET_DIR is not a valid directory");
  }
  const redirectRaw = env.CONNECTOR_OAUTH_REDIRECT_BASE?.trim();
  if (redirectRaw !== undefined && redirectRaw !== "") {
    let parsed: URL;
    try {
      parsed = new URL(redirectRaw);
    } catch {
      throw new ConfigurationError("CONNECTOR_OAUTH_REDIRECT_BASE must be an absolute http(s) URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new ConfigurationError("CONNECTOR_OAUTH_REDIRECT_BASE must be an absolute http(s) URL");
    }
    if (parsed.search !== "" || parsed.hash !== "" || (parsed.pathname !== "/" && parsed.pathname !== "")) {
      throw new ConfigurationError("CONNECTOR_OAUTH_REDIRECT_BASE must be an origin without a path");
    }
  }
  const secretBackend = readSecretBackend(env);
  const broker = secretBackend === "cf" ? readSecretBroker(env) : undefined;
  const oauthReturnUrl = readOAuthReturnUrl(env);
  const migrateRaw = env.ASTER_CONNECTOR_MIGRATE?.trim();
  if (migrateRaw !== undefined && migrateRaw !== "" && migrateRaw !== "0" && migrateRaw !== "1") {
    throw new ConfigurationError("ASTER_CONNECTOR_MIGRATE must be 0 or 1");
  }
  const migrateCredentials = migrateRaw === "1";
  if (migrateCredentials && secretBackend !== "cf") {
    throw new ConfigurationError("ASTER_CONNECTOR_MIGRATE requires ASTER_SECRET_BACKEND=cf");
  }
  const allowlist = (env.CONNECTOR_STDIO_ALLOWLIST ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  for (const command of allowlist) {
    // A relative path would make the basename match ambiguous; only a bare name or absolute path.
    const bareName = /^[A-Za-z0-9._-]{1,256}$/.test(command);
    const absolutePath = command.startsWith("/") && /^[A-Za-z0-9._/-]{1,256}$/.test(command);
    if (!bareName && !absolutePath) {
      throw new ConfigurationError("CONNECTOR_STDIO_ALLOWLIST must list bare command names or absolute paths");
    }
  }
  return {
    enabled: enabledRaw !== "0",
    secretDir,
    secretBackend,
    ...(broker === undefined ? {} : { broker }),
    ...(redirectRaw === undefined || redirectRaw === "" ? {} : { redirectBaseUrl: redirectRaw.replace(/\/+$/, "") }),
    ...(oauthReturnUrl === undefined ? {} : { oauthReturnUrl }),
    migrateCredentials,
    httpTimeoutMs: boundedInteger(env, "CONNECTOR_HTTP_TIMEOUT_MS", 15_000, 1_000, 120_000),
    oauthStateTtlMs: boundedInteger(env, "CONNECTOR_OAUTH_STATE_TTL_MS", 600_000, 60_000, 3_600_000),
    leaseTtlMs: boundedInteger(env, "CONNECTOR_LEASE_TTL_MS", 30_000, 1_000, 300_000),
    stdioAllowlist: [...new Set(allowlist)],
  };
}
/** Memory wiring (MEM-07): budgets, the compaction reserve and the activity timezone. */
export type MemoryConfig = {
  /**
   * Injection-only. `readMemoryConfig` always returns true because the memory system is part of the
   * product, not a switchable feature; an isolating test sets this to false on the returned section.
   */
  readonly enabled: boolean;
  readonly budget: MemoryBudget;
  /** Tokens kept free for the model's answer; the compaction thresholds derive from it. */
  readonly reserveTokens: number;
  /** Zone activity dates are computed in. Default UTC; never the machine's local zone. */
  readonly timezone: string;
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
 *
 * There is no environment switch for the memory system itself: it is part of the product. Tests
 * that need to isolate other features inject `enabled: false` into the returned section.
 */
export function readMemoryConfig(env: NodeJS.ProcessEnv = process.env): MemoryConfig {
  const budget: MemoryBudget = {
    backgroundTargetTokens: memoryInteger(env, "MEMORY_BACKGROUND_TARGET_TOKENS", MEMORY_BUDGET_DEFAULTS.backgroundTargetTokens, 1_024, 1_048_576),
    recentVerbatimTokens: memoryInteger(env, "MEMORY_RECENT_VERBATIM_TOKENS", MEMORY_BUDGET_DEFAULTS.recentVerbatimTokens, 512, 1_048_576),
    snapshotTokens: memoryInteger(env, "MEMORY_SNAPSHOT_TOKENS", MEMORY_BUDGET_DEFAULTS.snapshotTokens, 256, 262_144),
    narrativeTokens: memoryInteger(env, "MEMORY_NARRATIVE_TOKENS", MEMORY_BUDGET_DEFAULTS.narrativeTokens, 128, 262_144),
    instructionsTokens: memoryInteger(env, "MEMORY_INSTRUCTIONS_TOKENS", MEMORY_BUDGET_DEFAULTS.instructionsTokens, 256, 1_048_576),
    evaluateAfterUserTurns: memoryInteger(env, "MEMORY_EVALUATE_AFTER_USER_TURNS", MEMORY_BUDGET_DEFAULTS.evaluateAfterUserTurns, 1, 1_000),
  };
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
    enabled: true,
    budget,
    reserveTokens: memoryInteger(env, "MEMORY_RESERVE_TOKENS", 16_384, 1, 1_048_576),
    timezone,
  };
}

/** MemFS (M1): the git-backed core-memory repository. */
export type MemoryFsConfig = {
  readonly enabled: boolean;
  /** Absolute repository path; `main` creates it lazily and fails startup if it cannot. */
  readonly dir: string;
  /** Token budget for the core section injected into the owner's prompt. */
  readonly coreTokens: number;
};

/**
 * All MemFS settings are validated even when the switch is off, so a malformed value cannot surface
 * later when somebody flips MEMORY_FS_ENABLED. Relative paths are refused: the repository path is
 * resolved once, at startup, and must not depend on the process working directory.
 */
export function readMemoryFsConfig(env: NodeJS.ProcessEnv = process.env): MemoryFsConfig {
  const enabledRaw = env.MEMORY_FS_ENABLED?.trim();
  if (enabledRaw !== undefined && enabledRaw !== "" && enabledRaw !== "0" && enabledRaw !== "1") {
    throw new ConfigurationError("MEMORY_FS_ENABLED must be 0 or 1");
  }
  const rawDir = env.MEMORY_FS_DIR?.trim();
  const dir = rawDir === undefined || rawDir === ""
    ? join(resolve(env.DATA_DIR || "data"), "memory-fs")
    : isAbsolute(rawDir)
      ? resolve(rawDir)
      : (() => { throw new ConfigurationError("MEMORY_FS_DIR must be an absolute path"); })();
  return {
    enabled: enabledRaw !== "0",
    dir,
    coreTokens: boundedInteger(
      env,
      "MEMORY_FS_CORE_TOKENS",
      MEMORY_LIMITS.coreTokens,
      MEMORY_LIMITS.minCoreTokens,
      MEMORY_LIMITS.maxCoreTokens,
    ),
  };
}

/**
 * Dreaming (M2): the background consolidation pass over core memory. Every value is validated even
 * when the pass is disabled, so a malformed setting cannot surface later after DREAMING_ENABLED is
 * flipped. An unknown behavior is a startup error rather than a silent fallback: a reminder-only
 * deployment and an auto-launch one are different promises to the owner.
 */
export function readDreamingConfig(env: NodeJS.ProcessEnv = process.env): DreamingConfig {
  const flag = (key: string, fallback: boolean): boolean => {
    const raw = env[key]?.trim();
    if (raw === undefined || raw === "") return fallback;
    if (raw !== "0" && raw !== "1") throw new ConfigurationError(`${key} must be 0 or 1`);
    return raw === "1";
  };
  const behaviorRaw = env.DREAMING_BEHAVIOR?.trim().toLowerCase();
  const behaviors: readonly DreamingBehavior[] = ["auto-launch", "reminder"];
  if (behaviorRaw !== undefined && behaviorRaw !== "" && !behaviors.includes(behaviorRaw as DreamingBehavior)) {
    throw new ConfigurationError(`DREAMING_BEHAVIOR must be one of: ${behaviors.join(", ")}`);
  }
  return {
    enabled: flag("DREAMING_ENABLED", DREAMING_DEFAULTS.enabled),
    turns: boundedInteger(env, "DREAMING_TURNS", DREAMING_DEFAULTS.turns, 1, 10_000),
    onCompaction: flag("DREAMING_ON_COMPACTION", DREAMING_DEFAULTS.onCompaction),
    behavior: (behaviorRaw === undefined || behaviorRaw === "" ? DREAMING_DEFAULTS.behavior : behaviorRaw) as DreamingBehavior,
    dryRun: flag("DREAMING_DRY_RUN", DREAMING_DEFAULTS.dryRun),
    timeoutMs: boundedInteger(env, "DREAMING_TIMEOUT_MS", DREAMING_DEFAULTS.timeoutMs, 1_000, 600_000),
  };
}

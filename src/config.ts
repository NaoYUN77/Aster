import { join, resolve } from "node:path";
import { ConfigurationError } from "./errors.js";
import { isProviderId, PROVIDER_IDS, PROVIDERS } from "./providers.js";
import {
  assertSchema,
  eventDate,
  MEMORY_BUDGET_DEFAULTS,
  MemoryBudgetSchema,
  MemoryError,
  type MemoryBudget,
} from "./memory/contracts.js";

export { ConfigurationError };

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

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new ConfigurationError(`Missing configuration: ${key}`);
    return value;
  };
  const ownerId = readOwnerId(env);
  const provider = required("MODEL_PROVIDER");
  if (!isProviderId(provider)) {
    throw new ConfigurationError(`MODEL_PROVIDER must be one of: ${PROVIDER_IDS.join(", ")}`);
  }
  required(PROVIDERS[provider].apiKeyEnv);
  const token = required("TELEGRAM_BOT_TOKEN");
  return {
    token,
    ownerId,
    provider,
    model: required("MODEL_ID"),
    ...resolveMcpConfigPaths(env),
  };
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

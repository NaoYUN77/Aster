import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ConfigurationError } from "./errors.js";
import { agentVaultEnabled, isBrokeredValue, isVaultPlaceholder, readAgentVaultEnvironment } from "./agent-vault.js";
import { isProviderId, PROVIDER_IDS, PROVIDERS } from "./providers.js";

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
  readAgentVaultEnvironment(env);
  const brokered = agentVaultEnabled(env);
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new ConfigurationError(`Missing configuration: ${key}`);
    return value;
  };
  const ownerId = readOwnerId(env, brokered);
  const provider = required("MODEL_PROVIDER");
  if (!isProviderId(provider)) {
    throw new ConfigurationError(`MODEL_PROVIDER must be one of: ${PROVIDER_IDS.join(", ")}`);
  }
  required(PROVIDERS[provider].apiKeyEnv);
  const token = required("TELEGRAM_BOT_TOKEN");
  if (brokered) {
    // Real entry credentials must not remain in the workload environment when the broker is enabled.
    // Check every registered key, not just the selected provider, so an unused leftover is not exposed.
    for (const name of new Set(Object.values(PROVIDERS).map((entry) => entry.apiKeyEnv))) {
      const value = env[name]?.trim();
      if (value && !isBrokeredValue(value)) {
        throw new ConfigurationError(`${name} must be an Agent Vault placeholder when AGENT_VAULT_ENABLED=1`);
      }
    }
    if (!isVaultPlaceholder(token)) {
      throw new ConfigurationError("TELEGRAM_BOT_TOKEN must be an Agent Vault placeholder when AGENT_VAULT_ENABLED=1");
    }
  }
  return {
    token,
    ownerId,
    provider,
    model: required("MODEL_ID"),
    ...resolveMcpConfigPaths(env),
  };
}

/**
 * The owner ID is not sent to Telegram, so Agent Vault cannot inject it at request time. Deployments
 * can still keep it in a secret manager and export it to a file; the running process reads that file
 * instead of receiving the value in its environment.
 */
function readOwnerId(env: NodeJS.ProcessEnv, brokered: boolean): string {
  const inline = env.TELEGRAM_OWNER_ID?.trim();
  const file = env.TELEGRAM_OWNER_ID_FILE?.trim();
  if (inline && file) throw new ConfigurationError("Set either TELEGRAM_OWNER_ID or TELEGRAM_OWNER_ID_FILE, not both");
  if (brokered && inline) {
    throw new ConfigurationError("AGENT_VAULT_ENABLED=1 requires TELEGRAM_OWNER_ID_FILE exported from Infisical");
  }
  let ownerId = inline;
  if (!inline && file) {
    if (!isAbsolute(file)) throw new ConfigurationError("TELEGRAM_OWNER_ID_FILE must be an absolute path");
    try {
      ownerId = readFileSync(file, "utf8").trim();
    } catch {
      throw new ConfigurationError("TELEGRAM_OWNER_ID_FILE must point to a readable file");
    }
  }
  if (!ownerId) throw new ConfigurationError("Missing configuration: TELEGRAM_OWNER_ID");
  if (!/^[1-9]\d*$/.test(ownerId)) throw new ConfigurationError("TELEGRAM_OWNER_ID must be a positive numeric user ID");
  return ownerId;
}

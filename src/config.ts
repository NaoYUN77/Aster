import { join, resolve } from "node:path";
import { ConfigurationError } from "./errors.js";
import { readAgentVaultEnvironment } from "./agent-vault.js";
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
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new ConfigurationError(`Missing configuration: ${key}`);
    return value;
  };
  const ownerId = required("TELEGRAM_OWNER_ID");
  if (!/^[1-9]\d*$/.test(ownerId)) throw new ConfigurationError("TELEGRAM_OWNER_ID must be a positive numeric user ID");
  const provider = required("MODEL_PROVIDER");
  if (!isProviderId(provider)) {
    throw new ConfigurationError(`MODEL_PROVIDER must be one of: ${PROVIDER_IDS.join(", ")}`);
  }
  required(PROVIDERS[provider].apiKeyEnv);
  return {
    token: required("TELEGRAM_BOT_TOKEN"),
    ownerId,
    provider,
    model: required("MODEL_ID"),
    ...resolveMcpConfigPaths(env),
  };
}

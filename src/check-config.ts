import { ConfigurationError, readConfig, resolveProviderConfigPath } from "./config.js";
import { readMcpConfig } from "./mcp-config.js";
import { readProviderConfig } from "./provider-config.js";
import { createProviderModels, findCustomProvider, PROVIDER_IDS, refreshProviderCatalog, requireModel } from "./providers.js";

// Configuration check for an Aster image. Exits non-zero when a required setting is missing, the
// provider is unknown, or MODEL_ID is absent from the provider catalog. Compiled-in providers are
// checked offline from the catalog shipped with pi-ai; a declared provider that lists its models
// from its own endpoint makes this check reach that endpoint, because its catalog is the only
// source of truth for its MODEL_ID values.
try {
  const providerPaths = resolveProviderConfigPath();
  const providerConfig = await readProviderConfig(
    providerPaths.providerConfigPath,
    providerPaths.providerConfigExplicit,
    PROVIDER_IDS,
  );
  if (providerConfig.error !== undefined) throw new ConfigurationError(providerConfig.error);
  const config = readConfig(process.env, providerConfig.providers);
  const models = createProviderModels(config.provider, providerConfig.providers);
  const declaration = findCustomProvider(providerConfig.providers, config.provider);
  if (declaration !== undefined) await refreshProviderCatalog(models, config.provider, declaration);
  requireModel(models, config.provider, config.model);
  const mcp = await readMcpConfig(config.mcpConfigPath, config.mcpConfigExplicit);
  // Match the runtime: a broken optional default file disables MCP instead of blocking startup, so it
  // must not block deployment preflight either. Only an explicitly configured file is required.
  if (mcp.error !== undefined) {
    if (config.mcpConfigExplicit) throw new ConfigurationError(mcp.error);
    console.error(`MCP config invalid; MCP would be disabled: ${mcp.error}`);
  }
  for (const warning of mcp.warnings) console.error(`MCP config warning: ${warning}`);
  const servers = mcp.config?.servers.length ?? 0;
  console.info(`Configuration OK: CHANNEL=${config.channel.kind} MODEL_PROVIDER=${config.provider} MODEL_ID=${config.model} MCP_SERVERS=${servers}`);
} catch (error) {
  // ConfigurationError messages contain variable names only, never credential values.
  console.error(error instanceof ConfigurationError ? error.message : "Configuration check failed");
  process.exitCode = 1;
}

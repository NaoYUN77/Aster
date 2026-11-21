import { ConfigurationError, readConfig, resolveProviderConfigPath } from "./config.js";
import { readMcpConfig } from "./mcp-config.js";
import { readProviderConfig } from "./provider-config.js";
import { MODEL_UNAVAILABLE_MESSAGE, modelLabel } from "./model-failover.js";
import { resolveOptionalEnvSecrets } from "./secret-env.js";
import {
  createModelPool,
  PROVIDER_IDS,
  refreshProviderCatalogs,
  resolveModelChain,
} from "./providers.js";

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
  // Matches the runtime: optional provider keys come from the broker in cf mode, and a broker
  // failure leaves them unset instead of failing the check.
  const env = await resolveOptionalEnvSecrets(process.env);
  const config = readConfig(env, providerConfig.providers);
  const fallbacks = config.failover?.fallbacks ?? [];
  const models = createModelPool(config.provider, fallbacks, providerConfig.providers);
  await refreshProviderCatalogs(models, config.provider, fallbacks, providerConfig.providers);
  // Resolving the chain validates every id, the primary included, and rejects a fallback that
  // cannot take over the primary's context. A broken chain is a failed startup check, never a
  // silent deployment without failover.
  const chain = resolveModelChain(models, { provider: config.provider, modelId: config.model }, fallbacks);
  const chainLabel = chain.map(modelLabel).join(" -> ");
  const mcp = await readMcpConfig(config.mcpConfigPath, config.mcpConfigExplicit);
  // Match the runtime: a broken optional default file disables MCP instead of blocking startup, so it
  // must not block deployment preflight either. Only an explicitly configured file is required.
  if (mcp.error !== undefined) {
    if (config.mcpConfigExplicit) throw new ConfigurationError(mcp.error);
    console.error(`MCP config invalid; MCP would be disabled: ${mcp.error}`);
  }
  for (const warning of mcp.warnings) console.error(`MCP config warning: ${warning}`);
  const servers = mcp.config?.servers.length ?? 0;
  console.info(
    `Configuration OK: CHANNEL=${config.channel.kind} MODEL_PROVIDER=${config.provider} MODEL_ID=${config.model} `
    + `MODEL_CHAIN=${chainLabel} MCP_SERVERS=${servers}`,
  );
  if (config.failover !== undefined) {
    for (const member of chain.slice(1)) {
      if (chain[0]!.input.includes("image") && !member.input.includes("image")) {
        console.info(`Model failover warning: ${modelLabel(member)} is text-only; images stay on the primary.`);
      }
    }
    console.info(
      `Model failover: request timeout ${config.failover.requestTimeoutMs}ms; `
      + `all models failing reports "${MODEL_UNAVAILABLE_MESSAGE}"`,
    );
  }
} catch (error) {
  // ConfigurationError messages contain variable names only, never credential values.
  console.error(error instanceof ConfigurationError ? error.message : "Configuration check failed");
  process.exitCode = 1;
}

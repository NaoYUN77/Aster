import { ConfigurationError, readConfig } from "./config.js";
import { createProviderModels, requireModel } from "./providers.js";

// Offline configuration check used by the systemd installer. Exits non-zero when a required
// setting is missing, the provider is unknown, or MODEL_ID is absent from the provider catalog.
try {
  const config = readConfig();
  requireModel(createProviderModels(config.provider), config.provider, config.model);
  console.info(`Configuration OK: MODEL_PROVIDER=${config.provider} MODEL_ID=${config.model}`);
} catch (error) {
  // ConfigurationError messages contain variable names only, never credential values.
  console.error(error instanceof ConfigurationError ? error.message : "Configuration check failed");
  process.exitCode = 1;
}

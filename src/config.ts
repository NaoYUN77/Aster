import { resolve } from "node:path";
import { ConfigurationError } from "./errors.js";
import { isProviderId, PROVIDER_IDS, PROVIDERS } from "./providers.js";

export { ConfigurationError };

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
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
    dataDir: resolve(env.DATA_DIR || "data"),
  };
}

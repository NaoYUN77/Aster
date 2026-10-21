import { resolve } from "node:path";

export class ConfigurationError extends Error {
  override name = "ConfigurationError";
}

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new ConfigurationError(`Missing configuration: ${key}`);
    return value;
  };
  const ownerId = required("TELEGRAM_OWNER_ID");
  if (!/^[1-9]\d*$/.test(ownerId)) throw new ConfigurationError("TELEGRAM_OWNER_ID must be a positive numeric user ID");
  const provider = required("MODEL_PROVIDER");
  if (provider !== "anthropic" && provider !== "openai") throw new ConfigurationError("MODEL_PROVIDER must be anthropic or openai");
  required(provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY");
  return {
    token: required("TELEGRAM_BOT_TOKEN"),
    ownerId,
    provider,
    model: required("MODEL_ID"),
    dataDir: resolve(env.DATA_DIR || "data"),
  };
}

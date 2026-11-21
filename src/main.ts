import { ConfigurationError, configureEnvProxy, readConfig, REMOVED_CONFIG_LINE, removedConfigKeys, resolveProviderConfigPath } from "./config.js";
import { errorCode, StateError } from "./errors.js";
import { runWebMode } from "./http/run-web.js";
import { readProviderConfig } from "./provider-config.js";
import { PROVIDER_IDS } from "./providers.js";
import { resolveOptionalEnvSecrets } from "./secret-env.js";
import { startTrace, type TraceRuntime } from "./trace.js";

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

let trace: TraceRuntime | undefined;
try {
  configureEnvProxy();
  // The provider list must be known before MODEL_PROVIDER is validated: a declared provider supplies
  // its own credential variable name. A broken or missing explicit file stops startup; the default
  // path stays optional, so an installation without the file behaves exactly as before.
  const providerPaths = resolveProviderConfigPath();
  const providerConfig = await readProviderConfig(
    providerPaths.providerConfigPath,
    providerPaths.providerConfigExplicit,
    PROVIDER_IDS,
  );
  if (providerConfig.error !== undefined) throw new ConfigurationError(providerConfig.error);
  // Optional provider keys may live in the Cloudflare broker; this never fails startup and never
  // overwrites an environment value. Connector secrets keep their own (fail-closed) path.
  const env = await resolveOptionalEnvSecrets(process.env);
  const config = readConfig(env, providerConfig.providers);
  // Tracing is auxiliary: absent keys or an exporter failure must not stop the service.
  trace = startTrace(config.trace);
  // An upgraded .env may still carry CHANNEL, TELEGRAM_*, SLACK_*, STYLE_LEARNING or MEMORY_ENABLED.
  // They are ignored; say so once, by name only, so nobody believes a leftover token still does
  // something.
  if (removedConfigKeys(process.env).length > 0) console.info(REMOVED_CONFIG_LINE);
  // The web adapter is the only entry: one owner, one conversation, one HTTP surface. It owns the
  // request queue, the connector runtime, core memory and the reminder/watcher/routine loops.
  await runWebMode(config, shutdown.signal);
} catch (error) {
  if (!shutdown.signal.aborted) {
    // SDK error objects can contain credentials and message content, so only messages this
    // application wrote are logged verbatim.
    console.error("Personal agent stopped:",
      error instanceof ConfigurationError || error instanceof StateError ? error.message : errorCode(error));
    process.exitCode = 1;
  }
} finally {
  await trace?.close();
}

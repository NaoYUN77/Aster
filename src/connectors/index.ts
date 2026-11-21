import { join } from "node:path";
import { ConfigurationError, type ConnectorsConfig } from "../config.js";
import type { EventHub } from "../http/events.js";
import { BrokerClient } from "./broker-client.js";
import { migrateLocalCredentials, type MigrationResult } from "./migrate.js";
import { ConnectorOAuth } from "./oauth.js";
import { CfSecretProvider, FileSecretProvider, type SecretProvider } from "./secrets.js";
import { ConnectorService } from "./service.js";
import { ConnectorStore } from "./store.js";
import { BrokerTokenVault, LocalTokenVault, type TokenVault } from "./vault.js";

export type OpenConnectorsOptions = {
  readonly dataDir: string;
  readonly ownerId: string;
  readonly config: ConnectorsConfig;
  readonly hub?: EventHub;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
};

export type OpenConnectorsResult = {
  readonly service: ConnectorService;
  readonly store: ConnectorStore;
  /** Copies locally encrypted tokens into the broker; only meaningful in `cf` mode. */
  migrateCredentials(): Promise<MigrationResult>;
  close(): void;
};

/**
 * Opens connector state without reading any secret. The master key and OAuth client credentials are
 * read only when a connection is authorized or used, so a deployment with no connector activity
 * starts normally; a missing file then becomes a named, safe error at the point that needs it.
 *
 * With `ASTER_SECRET_BACKEND=cf` the file directory is never consulted: secrets come from the
 * Cloudflare broker and tokens live in its Durable Object, so this host holds no master key.
 */
export function openConnectors(options: OpenConnectorsOptions): OpenConnectorsResult | undefined {
  if (!options.config.enabled) return undefined;
  const store = new ConnectorStore(join(options.dataDir, "connectors.sqlite"), {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const { secrets, vault } = backends(options.config, store, options);
  const oauth = new ConnectorOAuth({
    secrets,
    config: options.config,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const service = new ConnectorService({
    store,
    oauth,
    vault,
    config: options.config,
    ownerId: options.ownerId,
    dataDir: options.dataDir,
    ...(options.hub === undefined ? {} : { hub: options.hub }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    service,
    store,
    migrateCredentials: () => migrateLocalCredentials({ store, vault, secrets }),
    close(): void {
      service.close();
      store.close();
    },
  };
}

function backends(
  config: ConnectorsConfig,
  store: ConnectorStore,
  options: OpenConnectorsOptions,
): { readonly secrets: SecretProvider; readonly vault: TokenVault } {
  if (config.secretBackend === "file") {
    const secrets = new FileSecretProvider(config.secretDir);
    const vault = new LocalTokenVault({
      store,
      secrets,
      config,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    return { secrets, vault };
  }
  const broker = config.broker;
  if (broker === undefined) {
    throw new ConfigurationError("ASTER_SECRET_BROKER_URL is required when ASTER_SECRET_BACKEND=cf");
  }
  const client = new BrokerClient({
    baseUrl: broker.url,
    ...(broker.accessClientId === undefined ? {} : { accessClientId: broker.accessClientId }),
    ...(broker.accessClientSecret === undefined ? {} : { accessClientSecret: broker.accessClientSecret }),
    ...(broker.accessTokenFile === undefined ? {} : { accessTokenFile: broker.accessTokenFile }),
    timeoutMs: config.httpTimeoutMs,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const clock = options.now;
  const nowMs = clock === undefined ? undefined : () => clock().getTime();
  return {
    secrets: new CfSecretProvider({ client, ...(nowMs === undefined ? {} : { now: nowMs }) }),
    vault: new BrokerTokenVault({ client, ...(nowMs === undefined ? {} : { now: nowMs }) }),
  };
}

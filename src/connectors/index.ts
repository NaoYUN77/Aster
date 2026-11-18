import { join } from "node:path";
import type { ConnectorsConfig } from "../config.js";
import type { EventHub } from "../http/events.js";
import { ConnectorOAuth } from "./oauth.js";
import { FileSecretProvider } from "./secrets.js";
import { ConnectorService } from "./service.js";
import { ConnectorStore } from "./store.js";

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
  close(): void;
};

/**
 * Opens connector state without reading any secret. The master key and OAuth client credentials are
 * read only when a connection is authorized or used, so a deployment with no connector activity
 * starts normally; a missing file then becomes a named, safe error at the point that needs it.
 */
export function openConnectors(options: OpenConnectorsOptions): OpenConnectorsResult | undefined {
  if (!options.config.enabled) return undefined;
  const store = new ConnectorStore(join(options.dataDir, "connectors.sqlite"), {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const secrets = new FileSecretProvider(options.config.secretDir);
  const oauth = new ConnectorOAuth({
    store,
    secrets,
    config: options.config,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const service = new ConnectorService({
    store,
    oauth,
    config: options.config,
    ownerId: options.ownerId,
    dataDir: options.dataDir,
    ...(options.hub === undefined ? {} : { hub: options.hub }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return {
    service,
    store,
    close(): void {
      service.close();
      store.close();
    },
  };
}

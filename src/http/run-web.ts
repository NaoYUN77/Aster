import { join } from "node:path";
import { openAgent } from "../agent.js";
import { ConfigurationError, type readConfig, type WebConfig } from "../config.js";
import {
  AUTH_FILE_NAME,
  AuthError,
  loadPasswordRecord,
  SessionStore,
  type PasswordRecord,
} from "./auth.js";
import { EventHub } from "./events.js";
import { createWebServer } from "./server.js";
import { WebRequestStore } from "./store.js";
import { RequestWorker } from "./worker.js";
import type { ModelUsedEvent } from "../model-failover.js";

export const WEB_APP_VERSION = "1.0.0";

/**
 * Boot the web adapter next to the existing channels without touching them.
 *
 * The web process never creates a HubStore, never connects Telegram/Slack, and never opens another
 * data directory than the one it was configured with. Shutdown drains the worker, ends SSE, and only
 * then closes the agent and SQLite.
 */
export async function runWebMode(
  config: ReturnType<typeof readConfig>,
  signal: AbortSignal,
): Promise<void> {
  const web = (config as { web?: WebConfig }).web;
  if (web === undefined) throw new ConfigurationError("CHANNEL=web requires WEB_* configuration");
  if (config.channel.kind !== "web") throw new ConfigurationError("runWebMode called without CHANNEL=web");

  const authPath = join(config.dataDir, AUTH_FILE_NAME);
  let auth: PasswordRecord;
  try {
    auth = loadPasswordRecord(authPath);
  } catch (error) {
    if (error instanceof AuthError && error.code === "AUTH_NOT_CONFIGURED") {
      throw new ConfigurationError(
        `Web password is not configured (${authPath}); run "npm run web:set-password" with the same DATA_DIR first`,
      );
    }
    throw new ConfigurationError("web-auth.json is invalid; set the password again with npm run web:set-password");
  }

  const store = new WebRequestStore(join(config.dataDir, "web.sqlite"));
  let agent: Awaited<ReturnType<typeof openAgent>> | undefined;
  const hub = new EventHub();
  let worker: RequestWorker | undefined;
  let app: Awaited<ReturnType<typeof createWebServer>> | undefined;
  let sessionCleanup: NodeJS.Timeout | undefined;
  let modelVersion = 0;
  let runtime: { notifyModelChanged: () => void } | undefined;
  const usage: { last: ModelUsedEvent | undefined } = { last: undefined };

  try {
    const sessions = new SessionStore(store.database, web.sessionTtlDays * 24 * 60 * 60 * 1000);
    sessions.cleanup();
    agent = await openAgent(config, undefined, undefined, {
      signal,
      onModelUsed: (event) => {
        usage.last = event;
      },
      // A `$model` switch or an automatic sticky fallback reaches every client, not only the caller.
      onModelSelectionChanged: () => {
        runtime?.notifyModelChanged();
      },
    });
    const modelService = agent.modelService;
    runtime = {
      notifyModelChanged: () => {
        modelVersion += 1;
        hub.broadcast("model.changed", { current: modelService.catalog().current, version: modelVersion });
      },
    };
    worker = new RequestWorker({
      store,
      agent,
      hub,
      ownerId: config.channel.ownerId,
      ...(process.env.WEB_SHUTDOWN_TIMEOUT_MS === undefined
        ? {}
        : { shutdownTimeoutMs: Number(process.env.WEB_SHUTDOWN_TIMEOUT_MS) }),
    });
    app = await createWebServer({
      config: web,
      ownerId: config.channel.ownerId,
      version: WEB_APP_VERSION,
      auth,
      sessions,
      store,
      hub,
      worker,
      agent,
      modelService,
      modelVersion: () => modelVersion,
    });
    await app.listen({ port: web.port, host: web.host });
    worker.start();
    sessionCleanup = setInterval(() => sessions.cleanup(), 60 * 60 * 1000);
    sessionCleanup.unref();
    console.info(`Web adapter listening on ${web.host}:${web.port}; owner ${config.channel.ownerId}; data ${config.dataDir}`);

    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    if (sessionCleanup !== undefined) clearInterval(sessionCleanup);
    // Stop accepting new connections first, then let the worker finish (or bound it), then end SSE.
    const serverClosing = app?.close().catch((error: unknown) => {
      console.error(`Web server close failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    await worker?.stop().catch((error: unknown) => {
      console.error(`Web worker stop failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    hub.close();
    await serverClosing;
    await agent?.close().catch((error: unknown) => {
      console.error(`Agent close failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    store.close();
    // `usage` is intentionally unused after shutdown; kept for a future request-scoped reporter.
    void usage.last;
  }
}

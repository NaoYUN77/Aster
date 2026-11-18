import { join } from "node:path";
import { openAgent } from "../agent.js";
import { buildAgentOptions } from "../agent-options.js";
import { openConnectors, type OpenConnectorsResult } from "../connectors/index.js";
import { createConnectorExtension } from "../connectors/tools.js";
import { ConfigurationError, type readConfig, type WebConfig } from "../config.js";
import { ReminderScheduler, ReminderStore } from "../reminders.js";
import { createRoutines, type RoutinesRuntime } from "../routines/runtime.js";
import { SqliteRoutineStore } from "../routines/store.js";
import { createRoutinesExtension } from "../routines/tools.js";
import { SkillIndex } from "../skills.js";
import { createWatchers, type WatchersRuntime } from "../watchers/index.js";
import { SqliteWatchStore } from "../watchers/store.js";
import { AgentGate } from "./agent-gate.js";
import { WebHostDelivery } from "./host-delivery.js";
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
  const hub = new EventHub();
  // One serialization point for the durable writer: user turns, routine runs and host messages.
  const gate = new AgentGate();
  let agent: Awaited<ReturnType<typeof openAgent>> | undefined;
  let worker: RequestWorker | undefined;
  let app: Awaited<ReturnType<typeof createWebServer>> | undefined;
  let host: WebHostDelivery | undefined;
  let reminders: ReminderStore | undefined;
  let scheduler: ReminderScheduler | undefined;
  let watchersStore: SqliteWatchStore | undefined;
  let watchers: WatchersRuntime | undefined;
  let routinesStore: SqliteRoutineStore | undefined;
  let routines: RoutinesRuntime | undefined;
  let connectors: OpenConnectorsResult | undefined;
  let sessionCleanup: NodeJS.Timeout | undefined;
  let modelVersion = 0;
  let runtime: { notifyModelChanged: () => void } | undefined;
  const usage: { last: ModelUsedEvent | undefined } = { last: undefined };
  const ownerId = config.channel.ownerId;

  try {
    const sessions = new SessionStore(store.database, web.sessionTtlDays * 24 * 60 * 60 * 1000);
    sessions.cleanup();

    // Reminders, watches and routines are only registered when this adapter has a host delivery
    // path. Without it the tools must not exist: a reminder that can never be pushed is worse than
    // a missing tool. The adapter always creates one, so every loop below has somewhere to deliver.
    reminders = config.reminders === undefined
      ? undefined
      : new ReminderStore(join(config.dataDir, "reminders.sqlite"), { limits: config.reminders });
    reminders?.recover();

    watchersStore = config.watchers === undefined
      ? undefined
      : new SqliteWatchStore(join(config.dataDir, "watchers.sqlite"));
    watchers = watchersStore === undefined || config.watchers === undefined
      ? undefined
      : createWatchers({
          store: watchersStore,
          config: config.watchers,
          // The runtime is built before the agent so its extension can be registered; delivery
          // starts only after `host` exists.
          deliver: async (_chatId, text, _threadTs, deliverySignal, deliveryKey) => {
            if (host === undefined) throw new Error("Web host delivery is not ready");
            return (await host.send("watch", text, deliverySignal, deliveryKey)).id;
          },
          chatId: ownerId,
          signal,
          log: (line) => console.error(line),
          classifyFailure: (error) => (error instanceof Error && error.name === "AbortError" ? "uncertain" : "failed"),
          failureCode: (error) => {
            const code = (error as { code?: unknown } | null)?.code;
            return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "HOST_DELIVERY_FAILED";
          },
        });

    routinesStore = config.routines === undefined
      ? undefined
      : new SqliteRoutineStore(join(config.dataDir, "routines.sqlite"));
    const routinesExtension = routinesStore === undefined || config.routines === undefined
      ? undefined
      : createRoutinesExtension({
          store: routinesStore,
          config: config.routines,
          chatId: ownerId,
        });
    const skills = config.skills === undefined
      ? undefined
      : await SkillIndex.scan(config.skills.dir, { log: (line) => console.error(line) });
    connectors = config.connectors === undefined
      ? undefined
      : openConnectors({
          dataDir: config.dataDir,
          ownerId,
          config: config.connectors,
          hub,
        });
    const connectorExtension = connectors === undefined ? undefined : createConnectorExtension(connectors.service, ownerId);
    // Local stdio connectors are host-managed MCP servers: persisted rows are re-validated against the
    // allowlist and started here, on boot, not per client request.
    const stdioServers = connectors === undefined ? [] : await connectors.service.stdioServers();

    const extraExtensions = [
      ...(watchers?.extension === undefined ? [] : [watchers.extension]),
      ...(routinesExtension === undefined ? [] : [routinesExtension]),
      ...(connectorExtension === undefined ? [] : [connectorExtension]),
    ];
    agent = await openAgent(config, undefined, undefined, buildAgentOptions(config, {
      ...(reminders === undefined ? {} : { reminderStore: reminders }),
      ...(extraExtensions.length === 0 ? {} : { extraExtensions }),
      ...(stdioServers.length === 0 ? {} : { mcpServers: stdioServers }),
      ...(skills === undefined ? {} : { skills }),
    }, {
      signal,
      onModelUsed: (event) => {
        usage.last = event;
      },
      // A `$model` switch or an automatic sticky fallback reaches every client, not only the caller.
      onModelSelectionChanged: () => {
        runtime?.notifyModelChanged();
      },
    }));
    host = new WebHostDelivery({ agent, hub, gate });
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
      gate,
      ownerId,
      ...(process.env.WEB_SHUTDOWN_TIMEOUT_MS === undefined
        ? {}
        : { shutdownTimeoutMs: Number(process.env.WEB_SHUTDOWN_TIMEOUT_MS) }),
    });
    app = await createWebServer({
      config: web,
      ownerId,
      version: WEB_APP_VERSION,
      auth,
      sessions,
      store,
      hub,
      worker,
      agent,
      modelService,
      modelVersion: () => modelVersion,
      ...(connectors === undefined ? {} : { connectors: connectors.service }),
    });
    await app.listen({ port: web.port, host: web.host });
    worker.start();
    scheduler = reminders === undefined
      ? undefined
      : new ReminderScheduler({
          store: reminders,
          client: host.reminderChannel(),
          signal,
          log: (line) => console.error(line),
        });
    routines = routinesStore === undefined || config.routines === undefined || host === undefined
      ? undefined
      : createRoutines({
          store: routinesStore,
          config: config.routines,
          chatId: ownerId,
          deliver: async (_chatId, text, deliverySignal, deliveryKey) =>
            (await host!.send("routine", text, deliverySignal, deliveryKey)).id,
          run: (request) => gate.run(() => agent!.routineRun(request)),
          signal,
          log: (line) => console.error(line),
          classifyFailure: (error) => (error instanceof Error && error.name === "AbortError" ? "uncertain" : "failed"),
          failureCode: (error) => {
            const code = (error as { code?: unknown } | null)?.code;
            return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "HOST_DELIVERY_FAILED";
          },
        });
    scheduler?.start();
    watchers?.start();
    routines?.start();
    sessionCleanup = setInterval(() => sessions.cleanup(), 60 * 60 * 1000);
    sessionCleanup.unref();
    console.info(`Web adapter listening on ${web.host}:${web.port}; owner ${ownerId}; data ${config.dataDir}`);

    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    if (sessionCleanup !== undefined) clearInterval(sessionCleanup);
    // Stop background senders before the durable writer and SSE hub close. A delivery already in
    // flight is bounded by the same signal; its store row decides whether it is retried.
    await routines?.stop().catch((error: unknown) => {
      console.error(`Routine stop failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    await watchers?.stop().catch((error: unknown) => {
      console.error(`Watcher stop failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    await scheduler?.stop().catch((error: unknown) => {
      console.error(`Reminder stop failed: ${error instanceof Error ? error.message : String(error)}`);
    });
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
    connectors?.close();
    watchersStore?.close();
    routinesStore?.close();
    reminders?.close();
    // `usage` is intentionally unused after shutdown; kept for a future request-scoped reporter.
    void usage.last;
  }
}

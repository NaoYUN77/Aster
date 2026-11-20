import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openAgent } from "./agent.js";
import { buildAgentOptions } from "./agent-options.js";
import { ConfigurationError, configureEnvProxy, readConfig, resolveProviderConfigPath } from "./config.js";
import { errorCode, StateError } from "./errors.js";
import { Inbox } from "./inbox.js";
import { readProviderConfig } from "./provider-config.js";
import { PROVIDER_IDS } from "./providers.js";
import { ReminderScheduler, ReminderStore } from "./reminders.js";
import { resolveOptionalEnvSecrets } from "./secret-env.js";
import { serveTelegram, TelegramClient } from "./telegram.js";
import { SkillIndex } from "./skills.js";
import { SqliteRoutineStore } from "./routines/store.js";
import { createRoutinesExtension } from "./routines/tools.js";
import { createRoutines as createRoutinesRuntime, type RoutinesRuntime } from "./routines/runtime.js";
import { startTrace, type TraceRuntime } from "./trace.js";
import { createWatchers, type WatchersRuntime } from "./watchers/index.js";
import { SqliteWatchStore } from "./watchers/store.js";
import { runWebMode } from "./http/run-web.js";

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
  // Tracing is auxiliary: absent keys or an exporter failure must not stop the bot.
  trace = startTrace(config.trace);
  if (config.channel.kind === "web") {
    // One owner, one conversation: no bot identity and no Inbox polling. The adapter owns its own
    // SQLite file under the same (independent) DATA_DIR.
    await runWebMode(config, shutdown.signal);
  } else {
  const channel = new TelegramClient(config.channel.token, config.channel.apiRoot);
  const botId = await channel.identity(shutdown.signal);
  await mkdir(config.dataDir, { recursive: true });
  let inbox: Inbox | undefined;
  // Only names and descriptions are read here; a skill body is opened when the model asks.
  const skills = config.skills === undefined
    ? undefined
    : await SkillIndex.scan(config.skills.dir, { log: (line) => console.error(line) });
  let reminders: ReminderStore | undefined;
  let watchers: WatchersRuntime | undefined;
  let watchersStore: SqliteWatchStore | undefined;
  let routinesStore: SqliteRoutineStore | undefined;
  let routines: RoutinesRuntime | undefined;
  try {
    // Reminder state is separate from the Inbox: its lifecycle is a due time, not a user request.
    reminders = config.reminders === undefined
      ? undefined
      : new ReminderStore(join(config.dataDir, "reminders.sqlite"), { limits: config.reminders });
    inbox = new Inbox(join(config.dataDir, "inbox.sqlite"));
    // The data directory remembers one bot per channel, so switching CHANNEL keeps the conversation.
    inbox.bindIdentity(config.channel.kind, botId, config.channel.ownerId);
    inbox.recover();
    // A sending row may already have reached the channel; recovery records it as uncertain instead of resending.
    reminders?.recover();
    // Event tracking owns its own database: a watcher row is never terminal, so its lifecycle is
    // neither the Inbox's nor a reminder's. One store backs the poll loop, the relay pull and the
    // outbox, so there is exactly one writer and one recovery path.
    if (config.watchers !== undefined) {
      const store = new SqliteWatchStore(join(config.dataDir, "watchers.sqlite"));
      watchersStore = store;
      store.recoverInterrupted(new Date().toISOString());
      watchers = createWatchers({
        store,
        config: config.watchers,
        deliver: (chatId, text, _threadTs, signal) => channel.send(chatId, text, signal),
        chatId: config.channel.ownerId,
        signal: shutdown.signal,
        log: (line) => console.error(line),
        classifyFailure: (error) => channel.classifyFailure(error),
        failureCode: (error) => channel.failureCode(error),
      });
    }
    // Standing tasks own their ledger and their own conversation per task. The tool extension is
    // built before the agent (it must be in the registry), while the executor needs the agent.
    if (config.routines !== undefined) {
      routinesStore = new SqliteRoutineStore(join(config.dataDir, "routines.sqlite"));
    }
    const routinesExtension = routinesStore === undefined || config.routines === undefined
      ? undefined
      : createRoutinesExtension({
          store: routinesStore,
          config: config.routines,
          chatId: config.channel.ownerId,
        });
    const agent = await openAgent(config, undefined, undefined, buildAgentOptions(config, {
      ...(reminders === undefined ? {} : { reminderStore: reminders }),
      ...(watchers?.extension === undefined && routinesExtension === undefined
        ? {}
        : {
            extraExtensions: [
              ...(watchers?.extension === undefined ? [] : [watchers.extension]),
              ...(routinesExtension === undefined ? [] : [routinesExtension]),
            ],
          }),
      ...(skills === undefined ? {} : { skills }),
    }, { signal: shutdown.signal }));
    const scheduler = reminders === undefined ? undefined : new ReminderScheduler({
      store: reminders,
      client: channel,
      signal: shutdown.signal,
      log: (line) => console.error(line),
    });
    // The executor is created after the agent because a routine run is an agent turn; the scheduler
    // dispatches one at a time and delivers through the same channel the chat uses.
    routines = routinesStore === undefined || config.routines === undefined
      ? undefined
      : createRoutinesRuntime({
          store: routinesStore,
          config: config.routines,
          chatId: config.channel.ownerId,
          deliver: (chatId, text, signal) => channel.send(chatId, text, signal),
          run: (request) => agent.routineRun(request),
          signal: shutdown.signal,
          log: (line) => console.error(line),
          classifyFailure: (error) => channel.classifyFailure(error),
          failureCode: (error) => channel.failureCode(error),
        });
    scheduler?.start();
    watchers?.start();
    routines?.start();
    try {
      console.info(`Personal agent starting; single-owner private ${channel.label} messages enabled.`);
      if (skills !== undefined) {
        console.info(`Skills: ${skills.summaries().length} indexed (names and descriptions only; bodies load on demand).`);
      }
      if (config.routines !== undefined) {
        const routineSettings = config.routines;
        console.info(`Standing tasks: ${routineSettings.paused ? "paused by ROUTINES_PAUSED=1" : "active"}, timezone ${routineSettings.timezone}.`);
      }
      await serveTelegram(config.channel.ownerId, botId, inbox, agent.reply, shutdown.signal, channel);
    } finally {
      // Stop proactive sends before the agent and databases close; an in-flight send becomes uncertain.
      await routines?.stop();
      await watchers?.stop();
      await scheduler?.stop();
      await agent.close();
    }
  } finally {
    inbox?.close();
    reminders?.close();
    watchersStore?.close();
    routinesStore?.close();
  }
  }
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

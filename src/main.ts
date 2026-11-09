import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openAgent } from "./agent.js";
import { ConfigurationError, configureEnvProxy, readConfig, resolveProviderConfigPath } from "./config.js";
import { errorCode, StateError } from "./errors.js";
import { Inbox } from "./inbox.js";
import { readProviderConfig } from "./provider-config.js";
import { PROVIDER_IDS } from "./providers.js";
import { ReminderScheduler, ReminderStore } from "./reminders.js";
import { serveSlack, SlackClient } from "./slack.js";
import { serveTelegram, TelegramClient } from "./telegram.js";
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
  const config = readConfig(process.env, providerConfig.providers);
  // Tracing is auxiliary: absent keys or an exporter failure must not stop the bot.
  trace = startTrace(config.trace);
  const channel = config.channel.kind === "slack"
    ? new SlackClient({
        botToken: config.channel.botToken,
        appToken: config.channel.appToken,
        ownerId: config.channel.ownerId,
      })
    : new TelegramClient(config.channel.token, config.channel.apiRoot);
  const botId = await channel.identity(shutdown.signal);
  await mkdir(config.dataDir, { recursive: true });
  let inbox: Inbox | undefined;
  let reminders: ReminderStore | undefined;
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
    const agent = await openAgent(config, undefined, undefined, {
      signal: shutdown.signal,
      ...(reminders === undefined ? {} : { reminderStore: reminders }),
    });
    const scheduler = reminders === undefined ? undefined : new ReminderScheduler({
      store: reminders,
      client: channel,
      signal: shutdown.signal,
      log: (line) => console.error(line),
    });
    scheduler?.start();
    try {
      console.info(`Personal agent starting; single-owner private ${channel.label} messages enabled.`);
      if (channel instanceof SlackClient) {
        await serveSlack(config.channel.ownerId, botId, inbox, agent.reply, shutdown.signal, channel);
      } else {
        await serveTelegram(config.channel.ownerId, botId, inbox, agent.reply, shutdown.signal, channel);
      }
    } finally {
      // Stop proactive sends before the agent and databases close; an in-flight send becomes uncertain.
      await scheduler?.stop();
      await agent.close();
    }
  } finally {
    inbox?.close();
    reminders?.close();
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

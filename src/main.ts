import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openAgent } from "./agent.js";
import { ConfigurationError, configureEnvProxy, readConfig, resolveProviderConfigPath } from "./config.js";
import { errorCode, StateError } from "./errors.js";
import { HubStore } from "./hubs.js";
import { Inbox } from "./inbox.js";
import { readProviderConfig } from "./provider-config.js";
import { ReactionAnchor } from "./reactions.js";
import { PROVIDER_IDS } from "./providers.js";
import { ReminderScheduler, ReminderStore } from "./reminders.js";
import { serveSlack, SlackClient } from "./slack.js";
import { serveTelegram, TelegramClient } from "./telegram.js";
import { SkillIndex } from "./skills.js";
import { startTrace, type TraceRuntime } from "./trace.js";
import { createWatchers, type WatchersRuntime } from "./watchers/index.js";
import { SqliteWatchStore } from "./watchers/store.js";

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
  // A Slack deployment carries an inbound policy — who may drive the bot and where — read from
  // configuration once, so no channel event can widen its own access. Telegram has no counterpart.
  const deployment = config.channel.kind === "slack"
    ? {
        kind: "slack" as const,
        client: new SlackClient({
          botToken: config.channel.botToken,
          appToken: config.channel.appToken,
          ownerId: config.channel.ownerId,
        }),
        policy: {
          ownerId: config.channel.ownerId,
          allowedUsers: config.channel.allowedUsers,
          allowedChannels: config.channel.allowedChannels,
          log: (line: string) => console.error(line),
        },
        // The one slot a reaction is aimed through: the delivery loop writes it for the request it is
        // answering, and the model's reaction tool only reads it. The per-message budget lives here
        // too, so a fresh request always starts with a full one.
        anchor: new ReactionAnchor({ limit: config.channel.maxReactions }),
        receipts: config.channel.receipts,
      }
    : {
        kind: "telegram" as const,
        client: new TelegramClient(config.channel.token, config.channel.apiRoot),
      };
  // The workspace's own emoji names come from Slack and nowhere else: this is what lets the model use
  // the team's uploads instead of only the standard set. Slack refuses the call without `emoji:read`,
  // and the tool reports that rather than the run failing.
  const emoji = deployment.kind === "slack"
    ? { source: { list: (signal: AbortSignal) => deployment.client.emojiList(signal) } }
    : undefined;
  const channel = deployment.client;
  const botId = await channel.identity(shutdown.signal);
  await mkdir(config.dataDir, { recursive: true });
  let inbox: Inbox | undefined;
  // Only names and descriptions are read here; a skill body is opened when the model asks.
  const skills = config.skills === undefined
    ? undefined
    : await SkillIndex.scan(config.skills.dir, { log: (line) => console.error(line) });
  let reminders: ReminderStore | undefined;
  let hubs: HubStore | undefined;
  let watchers: WatchersRuntime | undefined;
  let watchersStore: SqliteWatchStore | undefined;
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
        deliver: (chatId, text, threadTs, signal) => channel.send(chatId, text, signal, threadTs),
        chatId: config.channel.ownerId,
        signal: shutdown.signal,
        log: (line) => console.error(line),
        classifyFailure: (error) => channel.classifyFailure(error),
        failureCode: (error) => channel.failureCode(error),
      });
    }
    // One Hub per member is a shared-channel idea: a Slack deployment gets the bookkeeping, Telegram
    // stays single-owner. The data directory keeps the member mappings across restarts.
    hubs = deployment.kind === "slack" ? new HubStore(join(config.dataDir, "hubs.sqlite")) : undefined;
    const agent = await openAgent(config, undefined, undefined, {
      signal: shutdown.signal,
      ...(reminders === undefined ? {} : { reminderStore: reminders }),
      ...(hubs === undefined ? {} : { hubStore: hubs }),
      ...(watchers?.extension === undefined ? {} : { extraExtensions: [watchers.extension] }),
      ...(skills === undefined ? {} : { skills }),
      ...(deployment.kind === "slack"
        ? { reactions: { host: deployment.client, anchor: deployment.anchor, emoji } }
        : {}),
    });
    const scheduler = reminders === undefined ? undefined : new ReminderScheduler({
      store: reminders,
      client: channel,
      signal: shutdown.signal,
      log: (line) => console.error(line),
    });
    scheduler?.start();
    watchers?.start();
    try {
      console.info(deployment.kind === "telegram"
        ? `Personal agent starting; single-owner private ${channel.label} messages enabled.`
        : `Personal agent starting; the owner's DM and ${deployment.policy.allowedUsers.length} allowed`
          + ` member(s) in ${deployment.policy.allowedChannels.length} allowed channel(s) enabled.`);
      if (skills !== undefined) {
        console.info(`Skills: ${skills.summaries().length} indexed (names and descriptions only; bodies load on demand).`);
      }
      if (deployment.kind === "slack") {
        await serveSlack({ ...deployment.policy, botId }, inbox, agent.reply, shutdown.signal, deployment.client, {
          receipts: deployment.receipts,
          reactions: { host: deployment.client, anchor: deployment.anchor },
        });
      } else {
        await serveTelegram(config.channel.ownerId, botId, inbox, agent.reply, shutdown.signal, deployment.client);
      }
    } finally {
      // Stop proactive sends before the agent and databases close; an in-flight send becomes uncertain.
      await watchers?.stop();
      await scheduler?.stop();
      await agent.close();
    }
  } finally {
    inbox?.close();
    reminders?.close();
    watchersStore?.close();
    hubs?.close();
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

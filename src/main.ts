import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openAgent } from "./agent.js";
import { ConfigurationError, configureEnvProxy, readConfig } from "./config.js";
import { StateError } from "./errors.js";
import { Inbox } from "./inbox.js";
import { ProactiveScheduler, ProactiveStore } from "./proactive.js";
import { ReminderScheduler, ReminderStore } from "./reminders.js";
import { failureCode, serveTelegram, TelegramClient } from "./telegram.js";
import { startTrace, type TraceRuntime } from "./trace.js";

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

let trace: TraceRuntime | undefined;
try {
  configureEnvProxy();
  const config = readConfig();
  // Tracing is auxiliary: absent keys or an exporter failure must not stop the bot.
  trace = startTrace(config.trace);
  const client = new TelegramClient(config.token, config.telegramApiRoot);
  const botId = await client.identity(shutdown.signal);
  await mkdir(config.dataDir, { recursive: true });
  let inbox: Inbox | undefined;
  let reminders: ReminderStore | undefined;
  let proactive: ProactiveStore | undefined;
  try {
    // Reminder state is separate from the Inbox: its lifecycle is a due time, not a user request.
    reminders = config.reminders === undefined
      ? undefined
      : new ReminderStore(join(config.dataDir, "reminders.sqlite"), { limits: config.reminders });
    const openedInbox = new Inbox(join(config.dataDir, "inbox.sqlite"));
    inbox = openedInbox;
    openedInbox.bindIdentity(botId, config.ownerId);
    openedInbox.recover();
    // A sending row may already have reached Telegram; recovery records it as uncertain instead of resending.
    reminders?.recover();
    // Proactive run and delivery state is separate from both the Telegram Inbox and Memory.
    proactive = config.proactive === undefined
      ? undefined
      : new ProactiveStore(join(config.dataDir, "proactive.sqlite"), { limits: config.proactive, timezone: config.proactive.timezone });
    // A run with no durable Submission did no model or Web work; it safely returns to the queue.
    proactive?.recover();
    const agent = await openAgent(config, undefined, undefined, {
      signal: shutdown.signal,
      ...(reminders === undefined ? {} : { reminderStore: reminders }),
      ...(proactive === undefined ? {} : {
        proactive: {
          store: proactive,
          enqueue: (requestId: string, text: string) => openedInbox.enqueue({
            requestId,
            // The owner's private chat is the only delivery target; it is never a model parameter.
            conversationId: config.ownerId,
            senderId: config.ownerId,
            text: "proactive",
          }, text),
        },
      }),
    });
    const backgroundStop = new AbortController();
    const backgroundSignal = AbortSignal.any([shutdown.signal, backgroundStop.signal]);
    const scheduler = reminders === undefined ? undefined : new ReminderScheduler({
      store: reminders,
      client,
      signal: backgroundSignal,
      log: (line) => console.error(line),
    });
    const proactiveScheduler = proactive === undefined || config.proactive === undefined || agent.proactive === undefined
      ? undefined
      : new ProactiveScheduler({
          store: proactive,
          config: config.proactive,
          runner: agent.proactive,
          inbox: openedInbox,
          signal: backgroundSignal,
          log: (line) => console.error(line),
        });
    // Unfinished runs from the previous process are resumed before the scheduler claims new ones;
    // the runner serializes them either way. A decided run only re-enqueues its saved delivery.
    const proactiveRecovery = agent.proactive?.recover(backgroundSignal).catch((error: unknown) => {
      if (!backgroundSignal.aborted) {
        console.error(`Proactive recovery failed: ${error instanceof Error ? error.message : failureCode(error)}`);
      }
    });
    scheduler?.start();
    proactiveScheduler?.start();
    try {
      console.info("Personal agent starting; single-owner private Telegram messages enabled.");
      await serveTelegram(config, botId, openedInbox, agent.reply, shutdown.signal, client);
    } finally {
      // A fatal polling error also stops recovery waits before closing shared resources.
      backgroundStop.abort();
      // Stop background sends before the agent and databases close; an in-flight send becomes uncertain.
      await scheduler?.stop();
      await proactiveScheduler?.stop();
      await proactiveRecovery;
      await agent.close();
    }
  } finally {
    inbox?.close();
    reminders?.close();
    proactive?.close();
  }
} catch (error) {
  if (!shutdown.signal.aborted) {
    // SDK error objects can contain credentials and message content, so only messages this
    // application wrote are logged verbatim.
    console.error("Personal agent stopped:",
      error instanceof ConfigurationError || error instanceof StateError ? error.message : failureCode(error));
    process.exitCode = 1;
  }
} finally {
  await trace?.close();
}

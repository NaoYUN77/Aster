import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openAgent } from "./agent.js";
import { ConfigurationError, configureEnvProxy, readConfig } from "./config.js";
import { StateError } from "./errors.js";
import { Inbox } from "./inbox.js";
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
  const inbox = new Inbox(join(config.dataDir, "inbox.sqlite"));
  try {
    inbox.bindIdentity(botId, config.ownerId);
    inbox.recover();
    const agent = await openAgent(config, undefined, undefined, { signal: shutdown.signal });
    try {
      console.info("Personal agent starting; single-owner private Telegram messages enabled.");
      await serveTelegram(config, botId, inbox, agent.reply, shutdown.signal, client);
    } finally {
      await agent.close();
    }
  } finally {
    inbox.close();
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

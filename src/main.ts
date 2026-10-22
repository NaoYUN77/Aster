import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openAgent } from "./agent.js";
import { ConfigurationError, readConfig } from "./config.js";
import { Inbox } from "./inbox.js";
import { failureCode, serveTelegram, TelegramClient } from "./telegram.js";

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

try {
  const config = readConfig();
  const client = new TelegramClient(config.token);
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
    // SDK error objects can contain credentials and message content.
    console.error("Personal agent stopped:", error instanceof ConfigurationError ? error.message : failureCode(error));
    process.exitCode = 1;
  }
}

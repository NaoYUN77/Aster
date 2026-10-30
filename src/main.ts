import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openAgent } from "./agent.js";
import { ConfigurationError, readConfig } from "./config.js";
import { StateError } from "./errors.js";
import { Inbox } from "./inbox.js";
import { failureCode, serveTelegram, TelegramClient } from "./telegram.js";
import { openBrowser, readBrowserConfig } from "./browser.js";

const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort());
process.once("SIGTERM", () => shutdown.abort());

try {
  const config = readConfig();
  const browserConfig = readBrowserConfig();
  const client = new TelegramClient(config.token, config.telegramApiRoot);
  const botId = await client.identity(shutdown.signal);
  await mkdir(config.dataDir, { recursive: true });
  const inbox = new Inbox(join(config.dataDir, "inbox.sqlite"));
  try {
    inbox.bindIdentity(botId, config.ownerId);
    inbox.recover();
    const browser = browserConfig ? await openBrowser(browserConfig, config.dataDir, shutdown.signal) : undefined;
    try {
      const agent = await openAgent(config, undefined, undefined, { signal: shutdown.signal, browser });
      try {
        console.info("Personal agent starting; single-owner private Telegram messages enabled.");
        await serveTelegram(config, botId, inbox, async (request, signal) => {
          if (!browser) return request.text.trim() === "/browser_health" ? "浏览器未启用：请配置 BROWSER_CDP_URL。" : agent.reply(request, signal);
          const taskSignal = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
          await browser.begin(request.requestId, taskSignal);
          try {
            const text = request.text.trim() === "/browser_health"
              ? await browser.health(taskSignal) : await agent.reply(request, signal);
            return { text, photos: await browser.photos(request.requestId) };
          } finally {
            await browser.end();
          }
        }, shutdown.signal, client);
      } finally {
        await agent.close();
      }
    } finally {
      await browser?.close();
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
}

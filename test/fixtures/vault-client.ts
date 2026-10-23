import { initializeAgentVault } from "../../src/agent-vault.js";
import { TelegramClient } from "../../src/telegram.js";

initializeAgentVault();
const response = await fetch("https://api.example.test/check", {
  headers: { Authorization: "Bearer __vault_TEST_TOKEN__" },
  signal: AbortSignal.timeout(5_000),
});
if (!response.ok || await response.text() !== "proxied") throw new Error("Proxy request failed");
const client = new TelegramClient("__vault_TELEGRAM_BOT_TOKEN__");
if (await client.identity(AbortSignal.timeout(5_000)) !== "123") throw new Error("Telegram proxy request failed");
console.info("proxy transport OK");

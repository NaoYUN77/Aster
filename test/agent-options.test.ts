import assert from "node:assert/strict";
import test from "node:test";
import type { Extension } from "@earendil-works/pi-durable";
import { buildAgentOptions } from "../src/agent-options.js";
import { readConfig } from "../src/config.js";
import type { ReminderStore } from "../src/reminders.js";
import type { SkillIndex } from "../src/skills.js";

const extra: Extension = { name: "test-extension" } as unknown as Extension;
const reminders = {} as ReminderStore;
const skills = {} as SkillIndex;

function telegramConfig() {
  return readConfig({
    TELEGRAM_OWNER_ID: "123456789",
    TELEGRAM_BOT_TOKEN: "dummy-telegram-token",
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    OPENAI_API_KEY: "dummy-openai-key",
    DATA_DIR: "agent-options-telegram",
    MEMORY_ENABLED: "0",
  });
}

function webConfig() {
  return readConfig({
    CHANNEL: "web",
    WEB_OWNER_ID: "owner",
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    OPENAI_API_KEY: "dummy-openai-key",
    DATA_DIR: "agent-options-web",
    MEMORY_ENABLED: "0",
  });
}

test("telegram carries reminders, extensions, skills and runtime options", () => {
  const signal = new AbortController().signal;
  const options = buildAgentOptions(telegramConfig(), {
    reminderStore: reminders,
    extraExtensions: [extra],
    skills,
  }, { signal });
  assert.equal(options.reminderStore, reminders);
  assert.deepEqual(options.extraExtensions, [extra]);
  assert.equal(options.skills, skills);
  assert.equal(options.signal, signal);
});

test("web carries the same shared composition", () => {
  const options = buildAgentOptions(webConfig(), {
    reminderStore: reminders,
    extraExtensions: [extra],
    skills,
  });
  assert.equal(options.reminderStore, reminders);
  assert.deepEqual(options.extraExtensions, [extra]);
  assert.equal(options.skills, skills);
});

test("host-managed MCP servers are carried, and an empty list is omitted", () => {
  const server = {
    name: "conn_local", transport: "stdio" as const, command: "node", args: ["server.js"],
    env: {}, inheritEnv: false, timeoutMs: 60_000, connectTimeoutMs: 10_000,
  };
  const options = buildAgentOptions(webConfig(), { mcpServers: [server] });
  assert.deepEqual(options.mcpServers, [server]);
  const omitted = buildAgentOptions(webConfig(), { mcpServers: [] });
  assert.equal("mcpServers" in omitted, false);
});

test("absent capabilities are omitted instead of passed as undefined", () => {
  const options = buildAgentOptions(webConfig(), { extraExtensions: [] });
  assert.equal("reminderStore" in options, false);
  assert.equal("hubStore" in options, false);
  assert.equal("reactions" in options, false);
  assert.equal("extraExtensions" in options, false);
  assert.equal("mcpServers" in options, false);
  assert.equal("skills" in options, false);
});

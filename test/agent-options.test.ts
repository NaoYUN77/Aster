import assert from "node:assert/strict";
import test from "node:test";
import type { Extension } from "@earendil-works/pi-durable";
import { buildAgentOptions } from "../src/agent-options.js";
import { readConfig } from "../src/config.js";
import type { MemoryFs } from "../src/memory-fs.js";
import type { ReminderStore } from "../src/reminders.js";
import type { SkillIndex } from "../src/skills.js";

const extra: Extension = { name: "test-extension" } as unknown as Extension;
const reminders = {} as ReminderStore;
const memory = {} as MemoryFs;
const skills = {} as SkillIndex;

function webConfig() {
  return readConfig({
    WEB_OWNER_ID: "owner",
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    OPENAI_API_KEY: "offline-test",
    DATA_DIR: "agent-options-web",
    MEMORY_ENABLED: "0",
  });
}

test("the shared composition carries reminders, hubs, extensions and skills", () => {
  const signal = new AbortController().signal;
  const options = buildAgentOptions(webConfig(), {
    reminderStore: reminders,
    memoryFs: memory,
    extraExtensions: [extra],
    skills,
  }, { signal });
  assert.equal(options.reminderStore, reminders);
  assert.equal(options.memoryFs, memory);
  assert.deepEqual(options.extraExtensions, [extra]);
  assert.equal(options.skills, skills);
  assert.equal(options.signal, signal);
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
  assert.equal("memoryFs" in options, false);
  assert.equal("extraExtensions" in options, false);
  assert.equal("mcpServers" in options, false);
  assert.equal("skills" in options, false);
});

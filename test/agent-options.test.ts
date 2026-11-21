import assert from "node:assert/strict";
import test from "node:test";
import type { Extension } from "@earendil-works/pi-durable";
import { buildAgentOptions } from "../src/agent-options.js";
import { readConfig } from "../src/config.js";
import type { HubStore } from "../src/hubs.js";
import type { ReminderStore } from "../src/reminders.js";
import type { SkillIndex } from "../src/skills.js";

const extra: Extension = { name: "test-extension" } as unknown as Extension;
const reminders = {} as ReminderStore;
const hubs = {} as HubStore;
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
    hubStore: hubs,
    extraExtensions: [extra],
    skills,
  }, { signal });
  assert.equal(options.reminderStore, reminders);
  assert.equal(options.hubStore, hubs);
  assert.deepEqual(options.extraExtensions, [extra]);
  assert.equal(options.skills, skills);
  assert.equal(options.signal, signal);
});

test("absent capabilities are omitted instead of passed as undefined", () => {
  const options = buildAgentOptions(webConfig(), { extraExtensions: [] });
  assert.equal("reminderStore" in options, false);
  assert.equal("hubStore" in options, false);
  assert.equal("extraExtensions" in options, false);
  assert.equal("skills" in options, false);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { Extension } from "@earendil-works/pi-durable";
import { buildAgentOptions } from "../src/agent-options.js";
import { readConfig } from "../src/config.js";
import type { HubStore } from "../src/hubs.js";
import type { ReminderStore } from "../src/reminders.js";
import type { SkillIndex } from "../src/skills.js";
import type { ReactionAnchor, ReactionHost } from "../src/reactions.js";

const extra: Extension = { name: "test-extension" } as unknown as Extension;
const reminders = {} as ReminderStore;
const hubs = {} as HubStore;
const skills = {} as SkillIndex;
const reactions = {
  host: {} as ReactionHost,
  anchor: {} as ReactionAnchor,
};

function slackConfig() {
  return readConfig({
    CHANNEL: "slack",
    SLACK_OWNER_ID: "U0123456789",
    SLACK_BOT_TOKEN: `xoxb-${"a".repeat(24)}`,
    SLACK_APP_TOKEN: `xapp-${"b".repeat(24)}`,
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    OPENAI_API_KEY: "offline-test",
    DATA_DIR: "agent-options-slack",
    MEMORY_ENABLED: "0",
  });
}

function webConfig() {
  return readConfig({
    CHANNEL: "web",
    WEB_OWNER_ID: "owner",
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    OPENAI_API_KEY: "offline-test",
    DATA_DIR: "agent-options-web",
    MEMORY_ENABLED: "0",
  });
}

test("web carries reminders, extensions and skills but never Slack reactions", () => {
  const signal = new AbortController().signal;
  const options = buildAgentOptions(webConfig(), {
    reminderStore: reminders,
    hubStore: hubs,
    extraExtensions: [extra],
    skills,
    // Even if a web caller supplies this by mistake, the capability stays Slack-only.
    reactions,
  }, { signal });
  assert.equal(options.reminderStore, reminders);
  assert.equal(options.hubStore, hubs);
  assert.deepEqual(options.extraExtensions, [extra]);
  assert.equal(options.skills, skills);
  assert.equal(options.reactions, undefined);
  assert.equal(options.signal, signal);
});

test("Slack adds reactions over the same shared composition", () => {
  const options = buildAgentOptions(slackConfig(), {
    reminderStore: reminders,
    extraExtensions: [extra],
    skills,
    reactions,
  });
  assert.equal(options.reminderStore, reminders);
  assert.deepEqual(options.extraExtensions, [extra]);
  assert.equal(options.reactions, reactions);
});

test("absent capabilities are omitted instead of passed as undefined", () => {
  const options = buildAgentOptions(webConfig(), { extraExtensions: [] });
  assert.equal("reminderStore" in options, false);
  assert.equal("hubStore" in options, false);
  assert.equal("extraExtensions" in options, false);
  assert.equal("skills" in options, false);
  assert.equal("reactions" in options, false);
});

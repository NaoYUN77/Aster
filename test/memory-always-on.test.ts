// The MEM-07 memory system has no environment switch: it is part of the product. A leftover
// MEMORY_ENABLED in an upgraded .env is reported by name, never honored. Tests that need to
// isolate other features inject `enabled: false` into the memory config section themselves.
import assert from "node:assert/strict";
import test from "node:test";
import { readConfig, readMemoryConfig, REMOVED_CONFIG_LINE, removedConfigKeys } from "../src/config.js";

const base = {
  MODEL_PROVIDER: "openai",
  MODEL_ID: "faux-1",
  OPENAI_API_KEY: "test",
  WEB_OWNER_ID: "1",
  DATA_DIR: "memory-always-on",
} as const;

test("a leftover MEMORY_ENABLED does not disable the memory system", () => {
  assert.equal(readMemoryConfig({ MEMORY_ENABLED: "0" }).enabled, true);
  assert.equal(readMemoryConfig({ MEMORY_ENABLED: "yes" }).enabled, true);
  assert.equal(readConfig({ ...base, MEMORY_ENABLED: "0" }).memory.enabled, true);
  assert.equal(readConfig({ ...base, MEMORY_ENABLED: "1" }).memory.enabled, true);
});

test("a leftover MEMORY_ENABLED is reported by name, never by value", () => {
  assert.deepEqual(removedConfigKeys({ MEMORY_ENABLED: "0" }), ["MEMORY_ENABLED"]);
  assert.deepEqual(removedConfigKeys({ MEMORY_ENABLED: "yes" }), ["MEMORY_ENABLED"]);
  assert.match(REMOVED_CONFIG_LINE, /MEMORY_ENABLED/);
  // Every removable key family is named, so the prose cannot drift from the filter silently.
  const keys = removedConfigKeys({
    CHANNEL: "web", MEMORY_ENABLED: "0", STYLE_LEARNING: "observe", DREAMING_REVIEW: "1",
    TELEGRAM_BOT_TOKEN: "x", SLACK_APP_TOKEN: "x",
  });
  for (const key of keys) {
    const family = key.startsWith("TELEGRAM_") ? "TELEGRAM_*" : key.startsWith("SLACK_") ? "SLACK_*" : key;
    assert.ok(REMOVED_CONFIG_LINE.includes(family), family);
  }
});

test("other memory settings still validate and apply", () => {
  const config = readConfig({
    ...base,
    MEMORY_EVALUATE_AFTER_USER_TURNS: "3",
    MEMORY_TIMEZONE: "Asia/Shanghai",
  });
  assert.equal(config.memory.enabled, true);
  assert.equal(config.memory.budget.evaluateAfterUserTurns, 3);
  assert.equal(config.memory.timezone, "Asia/Shanghai");
});

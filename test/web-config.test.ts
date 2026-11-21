import assert from "node:assert/strict";
import test from "node:test";
import {
  ConfigurationError,
  readConfig,
  readWebConfig,
  REMOVED_CONFIG_LINE,
  removedConfigKeys,
} from "../src/config.js";

const WEB_ENV = {
  MODEL_PROVIDER: "deepseek",
  MODEL_ID: "fixture-model",
  DEEPSEEK_API_KEY: "fixture-key",
};

test("the web entry needs no bot token and defaults to a local owner identity", () => {
  const config = readConfig(WEB_ENV);
  assert.equal(config.channel.kind, "web");
  assert.equal(config.channel.ownerId, "owner");
  const web = config.web;
  assert.equal(web.port, 8787);
  assert.equal(web.host, "0.0.0.0");
  assert.equal(web.sessionTtlDays, 30);
  assert.equal(web.staticDir, "web/dist");
  assert.equal(web.trustProxy, false);
  assert.ok(web.allowedOrigins.includes("http://localhost:5173"));
  assert.ok(web.allowedOrigins.includes("https://localhost"));
  assert.ok(web.allowedOrigins.includes("tauri://localhost"));
  assert.ok(web.allowedOrigins.includes("capacitor://localhost"));
});

test("WEB_OWNER_ID and WEB_* bounds are validated", () => {
  const custom = readConfig({ ...WEB_ENV, WEB_OWNER_ID: "jay", WEB_PORT: "8790", WEB_ALLOWED_ORIGINS: "https://desktop.example" });
  assert.equal(custom.channel.ownerId, "jay");
  assert.equal(custom.web.port, 8790);
  assert.deepEqual(custom.web.allowedOrigins, ["https://desktop.example"]);

  assert.throws(() => readConfig({ ...WEB_ENV, WEB_OWNER_ID: "two words" }), ConfigurationError);
  assert.throws(() => readConfig({ ...WEB_ENV, WEB_PORT: "0" }), ConfigurationError);
  assert.throws(() => readConfig({ ...WEB_ENV, WEB_ALLOWED_ORIGINS: "not-an-origin" }), ConfigurationError);
  assert.throws(() => readConfig({ ...WEB_ENV, WEB_SESSION_TTL_DAYS: "0" }), ConfigurationError);
  assert.throws(() => readConfig({ ...WEB_ENV, WEB_TRUST_PROXY: "yes" }), ConfigurationError);
});

test("residual Telegram/Slack variables are ignored rather than required", () => {
  const config = readConfig({
    ...WEB_ENV,
    CHANNEL: "slack",
    SLACK_BOT_TOKEN: ["xoxb", "0000000000000", "legacy", "ignored"].join("-"),
    SLACK_OWNER_ID: "U0123456789",
    TELEGRAM_BOT_TOKEN: "not-a-real-credential",
    TELEGRAM_OWNER_ID: "42",
    STYLE_LEARNING: "ask",
  });
  assert.equal(config.channel.kind, "web");
  assert.equal(config.channel.ownerId, "owner");
});

test("removedConfigKeys names what is no longer read, and nothing when the environment is clean", () => {
  assert.deepEqual(removedConfigKeys({}), []);
  assert.deepEqual(removedConfigKeys({ MODEL_PROVIDER: "deepseek", MODEL_ID: "x", DEEPSEEK_API_KEY: "k" }), []);
  assert.deepEqual(
    removedConfigKeys({
      CHANNEL: "telegram",
      STYLE_LEARNING: "observe",
      TELEGRAM_API_ROOT: "https://example.invalid",
      TELEGRAM_BOT_TOKEN: "value-that-must-not-be-printed",
      TELEGRAM_OWNER_ID: "42",
      SLACK_BOT_TOKEN: "value-that-must-not-be-printed",
      SLACK_APP_TOKEN: "value-that-must-not-be-printed",
    }),
    ["CHANNEL", "SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "STYLE_LEARNING", "TELEGRAM_API_ROOT", "TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_ID"],
  );
  // The startup line names families only; no value from the environment can reach it.
  assert.equal(REMOVED_CONFIG_LINE, "REMOVED_CONFIG: CHANNEL, TELEGRAM_*, SLACK_*, STYLE_LEARNING are no longer read");
  assert.doesNotMatch(REMOVED_CONFIG_LINE, /value-that-must-not-be-printed/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { ConfigurationError, readConfig, readWebConfig } from "../src/config.js";

const WEB_ENV = {
  CHANNEL: "web",
  MODEL_PROVIDER: "deepseek",
  MODEL_ID: "fixture-model",
  DEEPSEEK_API_KEY: "fixture-key",
};

test("CHANNEL=web needs no bot token and defaults to a local owner identity", () => {
  const config = readConfig(WEB_ENV);
  assert.equal(config.channel.kind, "web");
  if (config.channel.kind !== "web") return;
  assert.equal(config.channel.ownerId, "owner");
  const web = (config as { web?: ReturnType<typeof readWebConfig> }).web;
  assert.ok(web !== undefined);
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
  const web = (custom as { web?: ReturnType<typeof readWebConfig> }).web!;
  assert.equal(web.port, 8790);
  assert.deepEqual(web.allowedOrigins, ["https://desktop.example"]);

  assert.throws(() => readConfig({ ...WEB_ENV, WEB_OWNER_ID: "two words" }), ConfigurationError);
  assert.throws(() => readConfig({ ...WEB_ENV, WEB_PORT: "0" }), ConfigurationError);
  assert.throws(() => readConfig({ ...WEB_ENV, WEB_ALLOWED_ORIGINS: "not-an-origin" }), ConfigurationError);
  assert.throws(() => readConfig({ ...WEB_ENV, WEB_SESSION_TTL_DAYS: "0" }), ConfigurationError);
  assert.throws(() => readConfig({ ...WEB_ENV, WEB_TRUST_PROXY: "yes" }), ConfigurationError);
});

test("telegram and slack still require their own identity and credentials", () => {
  assert.throws(
    () => readConfig({ MODEL_PROVIDER: "deepseek", MODEL_ID: "x", DEEPSEEK_API_KEY: "k" }),
    /TELEGRAM_OWNER_ID/,
  );
  assert.throws(
    () => readConfig({ ...WEB_ENV, CHANNEL: "slack" }),
    /SLACK_OWNER_ID/,
  );
});

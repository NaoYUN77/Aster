import assert from "node:assert/strict";
import test from "node:test";
import {
  ConfigurationError,
  readConfig,
  readConnectorsConfig,
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
      MEMORY_ENABLED: "0",
      STYLE_LEARNING: "observe",
      TELEGRAM_API_ROOT: "https://example.invalid",
      TELEGRAM_BOT_TOKEN: "value-that-must-not-be-printed",
      TELEGRAM_OWNER_ID: "42",
      SLACK_BOT_TOKEN: "value-that-must-not-be-printed",
      SLACK_APP_TOKEN: "value-that-must-not-be-printed",
    }),
    ["CHANNEL", "MEMORY_ENABLED", "SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "STYLE_LEARNING", "TELEGRAM_API_ROOT", "TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_ID"],
  );
  // The startup line names families only; no value from the environment can reach it.
  assert.equal(REMOVED_CONFIG_LINE, "REMOVED_CONFIG: CHANNEL, TELEGRAM_*, SLACK_*, STYLE_LEARNING, MEMORY_ENABLED are no longer read");
  assert.doesNotMatch(REMOVED_CONFIG_LINE, /value-that-must-not-be-printed/);
});

test("connector config defaults to on with local secret files and no stdio commands", () => {
  const config = readConnectorsConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.secretDir, "/run/secrets/aster-connectors");
  assert.deepEqual(config.stdioAllowlist, []);
  assert.equal(readConnectorsConfig({ CONNECTORS_ENABLED: "0" }).enabled, false);
  assert.equal(readConnectorsConfig({ CONNECTOR_STDIO_ALLOWLIST: "node,/usr/bin/echo" })
    .stdioAllowlist.join(","), "node,/usr/bin/echo");
  // A relative path would make the basename match ambiguous.
  assert.throws(() => readConnectorsConfig({ CONNECTOR_STDIO_ALLOWLIST: "bin/node" }), ConfigurationError);
  assert.throws(() => readConnectorsConfig({ CONNECTOR_STDIO_ALLOWLIST: "node;rm -rf /" }), ConfigurationError);
  assert.throws(() => readConnectorsConfig({ CONNECTORS_ENABLED: "yes" }), ConfigurationError);
});

test("connector secret backend defaults to file and never needs broker settings", () => {
  const config = readConnectorsConfig({});
  assert.equal(config.secretBackend, "file");
  assert.equal(config.broker, undefined);
  assert.equal(config.oauthReturnUrl, undefined, "the OAuth page does not redirect by default");
  assert.equal(config.migrateCredentials, false);
  assert.throws(() => readConnectorsConfig({ ASTER_SECRET_BACKEND: "vault" }), ConfigurationError);
});

test("cf mode requires an https broker URL and an Access service token", () => {
  assert.throws(() => readConnectorsConfig({ ASTER_SECRET_BACKEND: "cf" }), /ASTER_SECRET_BROKER_URL/);
  assert.throws(
    () => readConnectorsConfig({
      ASTER_SECRET_BACKEND: "cf",
      ASTER_SECRET_BROKER_URL: "http://secrets.example.test",
      ASTER_CF_ACCESS_CLIENT_ID: "id",
      ASTER_CF_ACCESS_CLIENT_SECRET: "secret",
    }),
    /https/,
  );
  assert.throws(
    () => readConnectorsConfig({ ASTER_SECRET_BACKEND: "cf", ASTER_SECRET_BROKER_URL: "https://secrets.example.test" }),
    /ASTER_CF_ACCESS_TOKEN_FILE/,
  );
  assert.throws(
    () => readConnectorsConfig({
      ASTER_SECRET_BACKEND: "cf",
      ASTER_SECRET_BROKER_URL: "https://secrets.example.test",
      ASTER_CF_ACCESS_CLIENT_ID: "id",
    }),
    /ASTER_CF_ACCESS_CLIENT_ID/,
  );

  const config = readConnectorsConfig({
    ASTER_SECRET_BACKEND: "cf",
    ASTER_SECRET_BROKER_URL: "https://secrets.example.test",
    ASTER_CF_ACCESS_CLIENT_ID: "id",
    ASTER_CF_ACCESS_CLIENT_SECRET: "secret",
  });
  assert.equal(config.secretBackend, "cf");
  assert.deepEqual(config.broker, { url: "https://secrets.example.test", accessClientId: "id", accessClientSecret: "secret" });

  const fileConfig = readConnectorsConfig({
    ASTER_SECRET_BACKEND: "cf",
    ASTER_SECRET_BROKER_URL: "http://127.0.0.1:8787",
    ASTER_CF_ACCESS_TOKEN_FILE: "/run/secrets/cf-access-token",
  });
  assert.equal(fileConfig.broker?.accessTokenFile, "/run/secrets/cf-access-token");
});

test("the OAuth return URL is optional and the migration flag requires cf mode", () => {
  assert.equal(readConnectorsConfig({ CONNECTOR_OAUTH_RETURN_URL: "" }).oauthReturnUrl, undefined);
  assert.equal(
    readConnectorsConfig({ CONNECTOR_OAUTH_RETURN_URL: "aster://oauth/done" }).oauthReturnUrl,
    "aster://oauth/done",
  );
  assert.throws(() => readConnectorsConfig({ CONNECTOR_OAUTH_RETURN_URL: "not a url" }), /CONNECTOR_OAUTH_RETURN_URL/);
  assert.throws(() => readConnectorsConfig({ CONNECTOR_OAUTH_RETURN_URL: "javascript:alert(1)" }), /CONNECTOR_OAUTH_RETURN_URL/);
  assert.throws(() => readConnectorsConfig({ ASTER_CONNECTOR_MIGRATE: "1" }), /ASTER_CONNECTOR_MIGRATE/);
  assert.equal(
    readConnectorsConfig({
      ASTER_SECRET_BACKEND: "cf",
      ASTER_SECRET_BROKER_URL: "https://secrets.example.test",
      ASTER_CF_ACCESS_TOKEN_FILE: "/run/secrets/cf-access-token",
      ASTER_CONNECTOR_MIGRATE: "1",
    }).migrateCredentials,
    true,
  );
});

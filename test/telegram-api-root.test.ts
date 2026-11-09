import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../src/config.js";

const base = {
  TELEGRAM_BOT_TOKEN: "token",
  TELEGRAM_OWNER_ID: "42",
  MODEL_PROVIDER: "deepseek",
  MODEL_ID: "deepseek-flash",
  DEEPSEEK_API_KEY: "key",
};

/** The Telegram channel's own address, or undefined when the official root is used. */
function apiRoot(env: Record<string, string>): string | undefined {
  const channel = readConfig(env).channel;
  assert.equal(channel.kind, "telegram");
  return channel.kind === "telegram" ? channel.apiRoot : undefined;
}

test("TELEGRAM_API_ROOT defaults to undefined (the api.telegram.org root)", () => {
  assert.equal(apiRoot(base), undefined);
  assert.equal(apiRoot({ ...base, TELEGRAM_API_ROOT: "  " }), undefined);
});

test("TELEGRAM_API_ROOT accepts an https prefix and drops trailing slashes", () => {
  assert.equal(
    apiRoot({ ...base, TELEGRAM_API_ROOT: "https://tg.example.com/tg-abc" }),
    "https://tg.example.com/tg-abc",
  );
  assert.equal(
    apiRoot({ ...base, TELEGRAM_API_ROOT: "https://tg.example.com/tg-abc/" }),
    "https://tg.example.com/tg-abc",
  );
  assert.equal(
    apiRoot({ ...base, TELEGRAM_API_ROOT: "https://example.com/" }),
    "https://example.com",
  );
});

test("TELEGRAM_API_ROOT rejects non-https, malformed, and query/fragment values", () => {
  assert.throws(() => readConfig({ ...base, TELEGRAM_API_ROOT: "http://tg.example.com" }), /https/);
  assert.throws(() => readConfig({ ...base, TELEGRAM_API_ROOT: "not a url" }), /valid URL/);
  assert.throws(() => readConfig({ ...base, TELEGRAM_API_ROOT: "https://tg.example.com/x?y=1" }), /query or fragment/);
  assert.throws(() => readConfig({ ...base, TELEGRAM_API_ROOT: "https://tg.example.com/x#y" }), /query or fragment/);
});

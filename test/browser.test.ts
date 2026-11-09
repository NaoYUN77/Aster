import assert from "node:assert/strict";
import test from "node:test";
import { buildInstructions } from "../src/agent.js";
import { readBrowserConfig, readConfig } from "../src/config.js";

const env = {
  TELEGRAM_BOT_TOKEN: "token",
  TELEGRAM_OWNER_ID: "42",
  MODEL_PROVIDER: "deepseek",
  MODEL_ID: "deepseek-flash",
  DEEPSEEK_API_KEY: "secret",
};

test("no browser endpoint means no browser: the setting stays absent", () => {
  assert.equal(readBrowserConfig({}), undefined);
  assert.equal(readBrowserConfig({ AGENT_BROWSER_CDP: "   " }), undefined);
  assert.equal(readConfig(env).browser, undefined);
});

test("the browser endpoint is taken as written and kept out of the model's reach", () => {
  // The CLI reads the same variable itself, so the value is passed through unchanged rather than
  // normalized: what the model's shell sees and what the host configured must be the same string.
  assert.deepEqual(readBrowserConfig({ AGENT_BROWSER_CDP: " http://172.18.0.1:9222 " }), {
    cdp: "http://172.18.0.1:9222",
  });
  assert.equal(readConfig({ ...env, AGENT_BROWSER_CDP: "ws://127.0.0.1:9222/devtools/browser/abc" }).browser?.cdp,
    "ws://127.0.0.1:9222/devtools/browser/abc");
  assert.equal(readConfig({ ...env, AGENT_BROWSER_CDP: "https://browser.example/mcp" }).browser?.cdp,
    "https://browser.example/mcp");
});

test("a browser endpoint that is not a URL is a configuration failure, not a silent absence", () => {
  for (const value of ["172.18.0.1:9222", "9222", "not a url", "ftp://172.18.0.1:9222", "file:///tmp/sock"]) {
    assert.throws(() => readBrowserConfig({ AGENT_BROWSER_CDP: value }),
      /AGENT_BROWSER_CDP must be an http\(s\) or ws\(s\) URL/, `accepted ${value}`);
  }
  assert.throws(() => readConfig({ ...env, AGENT_BROWSER_CDP: "9222" }), /AGENT_BROWSER_CDP must be/);
});

test("the system prompt offers the browser only when the host named one", () => {
  const base = { workingDirectory: "/data/workspace", reminders: true };
  const withBrowser = buildInstructions({ ...base, browser: true });
  const withoutBrowser = buildInstructions({ ...base, browser: false });
  assert.match(withBrowser, /A browser is reachable through the agent-browser command/);
  assert.match(withBrowser, /never pass a connection flag of your own/);
  // The endpoint itself is host context and never appears in the prompt.
  assert.doesNotMatch(withBrowser, /9222/);
  assert.doesNotMatch(withoutBrowser, /agent-browser/);
  assert.equal(
    withoutBrowser,
    withBrowser.replace(/ A browser is reachable through the agent-browser command.*?does not load\./, ""),
  );
});

test("reminders and the browser are independent switches on the same prompt", () => {
  const workspace = "/data/workspace";
  const none = buildInstructions({ workingDirectory: workspace, reminders: false, browser: false });
  const remindersOnly = buildInstructions({ workingDirectory: workspace, reminders: true, browser: false });
  assert.doesNotMatch(none, /Reminders: use reminder_create/);
  assert.match(remindersOnly, /Reminders: use reminder_create/);
  assert.match(buildInstructions({ workingDirectory: workspace, reminders: false, browser: true }), /agent-browser/);
  // The workspace is the only thing that varies by deployment besides the two switches.
  assert.match(none, new RegExp(`The working directory is ${workspace}\\.`));
});

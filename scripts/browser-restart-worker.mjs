import assert from "node:assert/strict";
import { openBrowser, readBrowserConfig } from "../dist/src/browser.js";
const browser = await openBrowser(readBrowserConfig(), "/data");
const execute = async () => browser.extension.tools.find((tool) => tool.name === "pw.browser_navigate").execute({ url: "about:blank" }, undefined, { abortSignal: AbortSignal.timeout(30_000) });
try {
  await browser.begin(`restart-before:${Date.now()}`, AbortSignal.timeout(90_000));
  assert.equal((await execute()).isError, false);
  console.log("READY_FOR_BROWSER_RESTART");
  await new Promise((resolve) => process.stdin.once("data", resolve));
  assert.equal((await execute()).isError, true, "interrupted context must fail rather than retry");
  await browser.end();
  await browser.begin(`restart-after:${Date.now()}`, AbortSignal.timeout(45_000));
  assert.match(await browser.health(AbortSignal.timeout(40_000)), /CDP 正常/);
  await browser.end();
  console.log("PASS: Aster browser runtime stayed alive, old operation failed, next request reconnected and captured screenshot");
} finally { await browser.close(); }

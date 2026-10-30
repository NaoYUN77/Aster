// Run inside the Aster image on the browser Compose network; no host CDP mapping.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { openBrowser, readBrowserConfig } from "../dist/src/browser.js";

const config = readBrowserConfig();
if (!config) throw new Error("BROWSER_CDP_URL required");
const dataDir = process.env.DATA_DIR || "/data";
const browser = await openBrowser(config, dataDir, AbortSignal.timeout(20_000));
const inspection = await chromium.connectOverCDP(config.endpoint, { timeout: 10_000 });
const cdp = await inspection.newBrowserCDPSession();
const contextCount = async () => (await cdp.send("Target.getBrowserContexts")).browserContextIds.length;
const baseline = await contextCount();
const report = { date: new Date().toISOString(), modelTest: false, telegramTest: false, scenarios: [] };
const execute = async (name, args) => {
  const tool = browser.extension.tools.find((entry) => entry.name === `pw.${name}`);
  const result = await tool.execute(args, undefined, { abortSignal: AbortSignal.timeout(35_000) });
  return { error: result.isError === true, text: result.output.filter((part) => part.type === "text").map((part) => part.text).join("\n").slice(0, 32_000) };
};
try {
  const id = `health:${randomUUID()}`;
  await browser.begin(id, AbortSignal.timeout(60_000));
  const health = await browser.health(AbortSignal.timeout(45_000));
  const contexts = await contextCount();
  assert.equal(contexts, baseline + 1, "isolated context exists during task");
  assert.equal((await browser.photos(id)).length, 1);
  await browser.end();
  assert.equal(await contextCount(), baseline, "task context closed without closing browser");
  report.scenarios.push({ name: "health/isolation/cleanup", passed: true, health });
  for (const [name, url] of [
    ["baidu", "https://www.baidu.com/s?wd=Playwright"],
    ["google", "https://www.google.com/search?q=Playwright"],
    ["chaoxing", "https://www.chaoxing.com/"],
  ]) {
    const requestId = `${name}:${randomUUID()}`;
    const start = performance.now();
    await browser.begin(requestId, AbortSignal.timeout(60_000));
    try {
      const navigation = await execute("browser_navigate", { url });
      const challenge = /验证码|安全验证|人机验证|captcha|unusual traffic|verify you are human|google\.com\/sorry\/|HTTP status: 429/i.test(navigation.text);
      let snapshot;
      if (!navigation.error && !challenge) snapshot = await execute("browser_snapshot", {});
      let screenshot;
      if (!navigation.error) screenshot = await execute("browser_take_screenshot", {});
      report.scenarios.push({ name, accessible: !navigation.error, challenge, stoppedOnChallenge: challenge,
        elapsedMs: Math.round(performance.now() - start), steps: navigation.error ? 1 : snapshot ? 3 : 2,
        result: navigation.error ? "无法访问" : challenge ? "安全验证，截图停止" : "公开页面已打开（无模型摘要）",
        navigation: navigation.text, snapshot: snapshot?.text, screenshotSaved: screenshot ? !screenshot.error : false,
        photos: await browser.photos(requestId) });
    } finally { await browser.end(); }
    assert.equal(await contextCount(), baseline);
  }
} finally {
  await browser.close(); await inspection.close();
  await mkdir(join(dataDir, "browser", "traces"), { recursive: true });
  await writeFile(join(dataDir, "browser", "traces", "smoke.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));

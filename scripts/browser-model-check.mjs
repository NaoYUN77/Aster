// Explicit live model acceptance; run from the repository after npm run build.
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { openAgent } from "../dist/src/agent.js";
import { readConfig } from "../dist/src/config.js";
import { openBrowser, readBrowserConfig } from "../dist/src/browser.js";

const config = readConfig();
if (config.provider !== "deepseek" || !["deepseek-flash", "deepseek-v4-pro"].includes(config.model)) throw new Error("Select deepseek-flash or deepseek-v4-pro explicitly");
const browserConfig = readBrowserConfig();
if (!browserConfig) throw new Error("BROWSER_CDP_URL required");
await mkdir(config.dataDir, { recursive: true });
const runDir = await mkdtemp(join(config.dataDir, "browser-model-check-"));
const browser = await openBrowser(browserConfig, runDir);
const app = await openAgent({ ...config, dataDir: runDir }, undefined, undefined, { browser });
const report = { date: new Date().toISOString(), provider: config.provider, model: config.model,
  proxyTrafficBytes: null, proxyCost: null, serverCost: "excluded", usageBefore: await app.usage(), tasks: [] };
try {
  for (const [name, text] of [
    ["baidu", "用浏览器打开百度首页，通过页面搜索 Playwright，总结前3个结果并返回截图。遇安全验证立即截图停止。"],
    ["google", "用浏览器打开谷歌首页，通过页面搜索 Playwright，总结前3个结果并返回截图。遇安全验证立即截图停止；不可达时明确回复无法访问，不要重试。"],
    ["chaoxing", "打开学习通/超星官网，只检查未登录的公开首页和主要入口，总结并返回截图。不要登录。"],
  ]) {
    const requestId = `browser-model-check:${name}`;
    const start = performance.now();
    const signal = AbortSignal.timeout(300_000);
    const taskReport = { name, usageBefore: await app.usage() };
    report.tasks.push(taskReport);
    await browser.begin(requestId, signal);
    try {
      taskReport.reply = await app.reply({ requestId, conversationId: "acceptance", senderId: config.ownerId, text }, signal);
      taskReport.photos = await browser.photos(requestId);
      taskReport.status = "requires-human-assessment";
    } catch (error) {
      taskReport.error = /^[A-Z_]+$/.test(error.code || "") ? error.code : "EXECUTION_ERROR";
    } finally {
      await browser.end();
      taskReport.elapsedMs = Math.round(performance.now() - start);
      taskReport.usageAfter = await app.usage();
      const key = createHash("sha256").update(requestId).digest("hex");
      const trace = JSON.parse(await readFile(join(runDir, "browser", "traces", `${key}.json`), "utf8"));
      taskReport.browserCalls = trace.calls;
    }
  }
} finally {
  report.usageAfter = await app.usage();
  await app.close(); await browser.close();
  const path = join(runDir, "report.json");
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`Live acceptance report saved: ${path}`);
}

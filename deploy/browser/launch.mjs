import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createCdpProxy } from "./proxy.mjs";

let browser;
let proxy;
let profile;
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => { browser?.kill("SIGKILL"); process.exit(code); }, 8000);
  deadline.unref();
  if (proxy?.server.listening) await proxy.close().catch(() => {});
  if (browser?.pid && browser.exitCode === null && browser.signalCode === null) {
    await new Promise((resolve) => {
      browser.once("exit", resolve);
      browser.kill("SIGTERM");
    });
  }
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(code);
}
process.on("SIGTERM", () => void stop(0));
process.on("SIGINT", () => void stop(0));

try {
  const args = [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=9223",
  ];
  if (process.env.BROWSER_PROXY) {
    const url = new URL(process.env.BROWSER_PROXY);
    if (!["http:", "https:", "socks5:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
      throw new Error("Invalid proxy configuration");
    }
    args.push(`--proxy-server=${url.protocol}//${url.host}`);
  }
  await Promise.all(["shots", "pages", "traces"].map((name) => mkdir(join("/data/browser", name), { recursive: true })));
  profile = await mkdtemp(join(tmpdir(), "aster-browser-"));
  args.push(`--user-data-dir=${profile}`, "about:blank");
  // The official image has browser binaries and Node, but does not ship the JS package.
  // playwright-core is installed only in this sidecar and resolves the matching executable.
  browser = spawn(chromium.executablePath(), args, { stdio: "ignore" });
  browser.once("error", () => { console.error("Browser process failed"); void stop(1); });
  browser.once("exit", () => {
    if (!stopping) { console.error("Browser process exited"); void stop(1); }
  });
  const deadline = Date.now() + 30_000;
  while (!stopping) {
    try {
      const response = await fetch("http://127.0.0.1:9223/json/version", { signal: AbortSignal.timeout(1000) });
      if (response.ok) break;
    } catch { /* Browser startup is bounded by the deadline below. */ }
    if (Date.now() >= deadline) throw new Error("Browser startup timeout");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!stopping) {
    proxy = createCdpProxy();
    proxy.server.on("error", () => { console.error("Browser proxy failed"); void stop(1); });
    proxy.server.listen(9222, "0.0.0.0", () => console.log("Browser CDP proxy ready"));
  }
} catch {
  // Never print argv, proxy URLs, browser stderr, or environment contents.
  console.error("Browser startup failed; check image, artifact permissions and proxy configuration");
  await stop(1);
}

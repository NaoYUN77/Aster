import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import type { CallToolResult } from "@earendil-works/pi-mcp";
import { ConfigurationError } from "./errors.js";
import { buildMcpTool, openMcpConnection, type McpConnection, type McpToolInfo } from "./mcp.js";
import type { McpStdioServerConfig } from "./mcp-config.js";

const require = createRequire(import.meta.url);
const ALLOWED = new Set([
  "browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_click",
  "browser_type", "browser_press_key", "browser_select_option", "browser_take_screenshot",
]);
const MAX_CALLS = 40;
export type BrowserConfig = { readonly endpoint: string };
export function readBrowserConfig(env: NodeJS.ProcessEnv = process.env): BrowserConfig | undefined {
  const raw = env.BROWSER_CDP_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { throw new ConfigurationError("BROWSER_CDP_URL must be an http(s) CDP URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new ConfigurationError("BROWSER_CDP_URL must be an http(s) origin without credentials, query or fragment");
  }
  return { endpoint: url.origin };
}
function failure(code: string): Error { return Object.assign(new Error(code), { code }); }

/** Read-only discovery may retry before any operation is sent; navigation never retries. */
async function waitForCdp(endpoint: string, signal: AbortSignal): Promise<void> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  for (;;) {
    bounded.throwIfAborted();
    try {
      const response = await fetch(`${endpoint}/json/version`, { redirect: "error", signal: AbortSignal.any([bounded, AbortSignal.timeout(2_000)]) });
      const ok = response.ok;
      await response.body?.cancel();
      if (ok) return;
    } catch { bounded.throwIfAborted(); }
    await delay(250, undefined, { signal: bounded });
  }
}

type Task = {
  id: string; key: string; signal: AbortSignal; calls: number; lost: boolean; challenged: boolean;
  connection?: McpConnection; photos: string[];
};
export type BrowserRuntime = {
  readonly extension: Extension;
  begin(requestId: string, signal: AbortSignal): Promise<void>;
  end(): Promise<void>;
  photos(requestId: string): Promise<readonly string[]>;
  health(signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
};
export type BrowserConnector = typeof openMcpConnection;

/** One host-owned MCP session per serial request. Failed operations are never retried. */
export async function openBrowser(
  config: BrowserConfig, dataDir: string, signal?: AbortSignal, connector: BrowserConnector = openMcpConnection,
): Promise<BrowserRuntime> {
  const root = join(dataDir, "browser");
  for (const part of ["shots", "pages", "traces"]) await mkdir(join(root, part), { recursive: true });
  const server: McpStdioServerConfig = {
    name: "aster-browser", transport: "stdio", command: process.execPath,
    args: [join(dirname(require.resolve("@playwright/mcp/package.json")), "cli.js"),
      "--cdp-endpoint", config.endpoint, "--isolated", "--headless", "--no-webmcp",
      "--cdp-timeout", "10000", "--timeout-action", "5000", "--timeout-navigation", "20000",
      "--image-responses", "omit", "--snapshot-mode", "full", "--output-dir", join(root, "pages"),
      "--output-max-size", "67108864"],
    cwd: root, env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" }, inheritEnv: false,
    timeoutMs: 30_000, connectTimeoutMs: 10_000,
  };
  const connect = (abortSignal?: AbortSignal) => connector(server, { dataDir, env: process.env, signal: abortSignal });
  // tools/list does not attach to CDP, so a stopped browser does not prevent Aster startup.
  const discovery = await connect(signal);
  let infos: McpToolInfo[];
  try { infos = await discovery.listTools({ signal }); } finally { await discovery.close(); }
  let task: Task | undefined;
  const keyFor = (id: string) => createHash("sha256").update(id).digest("hex");
  const manifest = (key: string) => join(root, "shots", key, "photos.json");
  const marker = (key: string) => join(root, "traces", `${key}.json`);
  const save = async (path: string, value: unknown) => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, path);
  };
  async function readPhotos(key: string): Promise<string[]> {
    try {
      const value: unknown = JSON.parse(await readFile(manifest(key), "utf8"));
      if (!Array.isArray(value) || value.length > 3 || value.some((entry) => typeof entry !== "string" || !/^[a-f0-9-]+\.png$/.test(entry))) throw failure("BROWSER_ARTIFACT_INVALID");
      return value.map((name) => join(root, "shots", key, name));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async function call(name: string, args: Record<string, unknown>, callSignal?: AbortSignal): Promise<CallToolResult> {
    const current = task;
    if (!current) throw failure("BROWSER_NO_TASK");
    if (current.lost) return { isError: true, content: [{ type: "text", text: "BROWSER_CONTEXT_LOST: 浏览器状态已丢失；本轮停止，新的请求会重新连接。无法访问的网页请明确报告无法访问。" }] };
    if (current.challenged && name !== "browser_take_screenshot") return { isError: true, content: [{ type: "text", text: "BROWSER_CHALLENGE: 安全验证，截图停止；无法访问搜索结果。" }] };
    const combined = AbortSignal.any([current.signal, ...(callSignal ? [callSignal] : [])]);
    combined.throwIfAborted();
    if (++current.calls > MAX_CALLS) return { isError: true, content: [{ type: "text", text: "BROWSER_CALL_LIMIT: stop this task." }] };
    if (!ALLOWED.has(name) || Object.keys(args).some((key) => ["filename", "files", "code", "function"].includes(key))) throw failure("BROWSER_ARGUMENT_REJECTED");
    if (name === "browser_navigate") {
      const raw = args.url;
      if (typeof raw !== "string" || raw.length > 4096) throw failure("BROWSER_URL_INVALID");
      const url = new URL(raw);
      if ((!["http:", "https:"].includes(url.protocol) && raw !== "about:blank") || url.username || url.password) throw failure("BROWSER_URL_INVALID");
    }
    if (Object.values(args).some((value) => typeof value === "string" && value.length > 16_000)) throw failure("BROWSER_ARGUMENT_LIMIT");
    let photo: string | undefined;
    if (name === "browser_take_screenshot") {
      if (current.photos.length >= 3) return { isError: true, content: [{ type: "text", text: "BROWSER_PHOTO_LIMIT" }] };
      photo = join(root, "shots", current.key, `${randomUUID()}.png`);
      args = { ...args, type: "png", fullPage: false, filename: photo };
    }
    try {
      if (!current.connection) {
        if (connector === openMcpConnection) await waitForCdp(config.endpoint, combined);
        current.connection = await connect(combined);
      }
      const result = await current.connection.callTool(name, args, { signal: combined, timeoutMs: 30_000 });
      const visibleText = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
      if (/验证码|安全验证|人机验证|captcha|unusual traffic|google\.com\/sorry\/|HTTP status: 429|verify you are human/i.test(visibleText)) {
        current.challenged = true;
        result.content.push({ type: "text", text: "BROWSER_CHALLENGE: 安全验证，截图并停止；无法访问搜索结果。" });
      }
      // MCP may return disconnection as a tool error rather than a transport exception.
      // Stop on any browser error so its lazy backend cannot create a replacement context mid-task.
      if (result.isError) current.lost = true;
      if (photo && !result.isError) {
        const info = await stat(photo);
        if (!info.isFile() || info.size > 8 * 1024 * 1024) throw failure("BROWSER_PHOTO_SIZE");
        current.photos.push(photo);
        await save(manifest(current.key), current.photos.map((path) => basename(path)));
      }
      if (name === "browser_snapshot" && !result.isError) {
        const text = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
        if (Buffer.byteLength(text) <= 512 * 1024) await writeFile(join(root, "pages", `${current.key}-${current.calls}.txt`), text, { mode: 0o600 });
      }
      await save(marker(current.key), { state: "active", calls: current.calls });
      return result;
    } catch (error) {
      current.lost = true;
      await current.connection?.close().catch(() => {});
      current.connection = undefined;
      if (combined.aborted) throw error;
      return { isError: true, content: [{ type: "text", text: "BROWSER_CONTEXT_LOST: 无法访问或浏览器连接中断，操作结果未知；本轮停止，不自动重试。新请求会重新连接。" }] };
    }
  }
  const adapter: McpConnection = {
    serverName: server.name, listTools: async () => infos,
    callTool: (name, args, options) => call(name, args, options.signal),
    close: async () => {}, subscribeAvailability: (listener) => { listener("available"); return () => {}; },
  };
  const tools = infos.filter((info) => ALLOWED.has(info.name)).map((info) => {
    const schema = structuredClone(info.inputSchema) as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown> | undefined;
    for (const name of ["filename", ...(info.name === "browser_take_screenshot" ? ["type", "fullPage"] : [])]) {
      if (properties) delete properties[name];
      if (Array.isArray(schema.required)) schema.required = schema.required.filter((key) => key !== name);
    }
    schema.additionalProperties = false;
    const tool = buildMcpTool(server, adapter, { ...info, inputSchema: schema }, `pw_${info.name}`);
    if (!tool) throw failure("BROWSER_SCHEMA_INVALID");
    const { deferred: _deferred, ...resident } = tool;
    return resident;
  });
  if (tools.length !== ALLOWED.size) throw failure("BROWSER_TOOLS_MISSING");
  async function end() {
    const current = task;
    if (!current) return;
    task = undefined;
    if (current.connection) {
      try {
        const result = await current.connection.callTool("browser_close", {}, { timeoutMs: 5_000, signal: AbortSignal.timeout(5_000) });
        if (result.isError) console.error("Browser context cleanup unconfirmed (BROWSER_CLEANUP_UNKNOWN)");
      } catch { console.error("Browser context cleanup unconfirmed (BROWSER_CLEANUP_UNKNOWN)"); }
      await current.connection.close().catch(() => { console.error("Browser MCP close unconfirmed (BROWSER_CLEANUP_UNKNOWN)"); });
    }
    await save(marker(current.key), { state: "ended", calls: current.calls, lost: current.lost });
  }
  return {
    extension: defineExtension({ name: "browser-control", tools }),
    async begin(id, abortSignal) {
      if (task) throw failure("BROWSER_TASK_BUSY");
      const key = keyFor(id);
      await mkdir(join(root, "shots", key), { recursive: true });
      let previous: unknown;
      try { previous = JSON.parse(await readFile(marker(key), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      task = { id, key, signal: abortSignal, calls: 0, lost: previous !== undefined, challenged: false, photos: await readPhotos(key) };
      await save(marker(key), { state: "active", calls: 0 });
    },
    end, photos: (id) => readPhotos(keyFor(id)),
    async health(abortSignal) {
      const navigation = await call("browser_navigate", { url: "about:blank" }, abortSignal);
      if (navigation.isError) throw failure("BROWSER_HEALTH_FAILED");
      const shot = await call("browser_take_screenshot", {}, abortSignal);
      if (shot.isError) throw failure("BROWSER_HEALTH_FAILED");
      let resources = "容器指标无法读取";
      try {
        const response = await fetch(`${config.endpoint}/aster/metrics`, { signal: AbortSignal.any([abortSignal, AbortSignal.timeout(3_000)]), redirect: "error" });
        if (!response.ok || Number(response.headers.get("content-length")) > 4096) throw failure("BROWSER_METRICS_INVALID");
        const reader = response.body!.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 4096) throw failure("BROWSER_METRICS_INVALID"); chunks.push(part.value); } }
        finally { await reader.cancel().catch(() => {}); }
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (![value.memoryBytes, value.pids].every((n) => Number.isSafeInteger(n) && n >= 0)
          || ![value.memoryLimitBytes, value.pidsLimit].every((n) => n === null || (Number.isSafeInteger(n) && n >= 0))) throw failure("BROWSER_METRICS_INVALID");
        resources = `内存 ${value.memoryBytes} / ${value.memoryLimitBytes ?? "无限制"} bytes；进程 ${value.pids} / ${value.pidsLimit ?? "无限制"}`;
      } catch { if (abortSignal.aborted) abortSignal.throwIfAborted(); }
      return `浏览器 CDP 正常；about:blank 截图已保存。\n${resources}`;
    },
    close: end,
  };
}

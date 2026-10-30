import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import { openBrowser, readBrowserConfig, type BrowserConnector } from "../src/browser.js";
import type { McpToolInfo } from "../src/mcp.js";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openAgent } from "../src/agent.js";
import { readConfig } from "../src/config.js";

const names = ["browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_click", "browser_type", "browser_press_key", "browser_select_option", "browser_take_screenshot"];
const infos: McpToolInfo[] = names.map((name) => ({ name, inputSchema: { type: "object", properties: { url: { type: "string" }, filename: { type: "string" } } } }));
const config = { endpoint: "http://aster-browser:9222" };

test("browser configuration rejects credentials, paths, query and invalid protocols", () => {
  assert.equal(readBrowserConfig({}), undefined);
  assert.deepEqual(readBrowserConfig({ BROWSER_CDP_URL: config.endpoint }), config);
  for (const endpoint of ["ws://host:9222", "http://user:secret@host", "http://host/x", "http://host?key=secret", "invalid"]) {
    assert.throws(() => readBrowserConfig({ BROWSER_CDP_URL: endpoint }), /BROWSER_CDP_URL/);
  }
});

test("installed MCP discovers resident pw tools without a running browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-browser-list-"));
  const browser = await openBrowser({ endpoint: "http://127.0.0.1:1" }, root, AbortSignal.timeout(20_000));
  try {
    assert.equal(browser.extension.tools?.length, 8);
    for (const tool of browser.extension.tools!) {
      assert.match(tool.name, /^pw\./);
      assert.equal(tool.replay, "unsafe");
      assert.equal(tool.deferred, undefined);
      assert.equal((tool.parameters as { properties?: Record<string, unknown> }).properties?.filename, undefined);
    }
  } finally { await browser.close(); await rm(root, { recursive: true, force: true }); }
});

test("lost operation is not retried in the same task; next task opens a new MCP session", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-browser-reconnect-"));
  let connects = 0; let operations = 0; let closes = 0;
  const connector: BrowserConnector = async () => {
    connects++;
    return { serverName: "aster-browser", listTools: async () => infos,
      subscribeAvailability: () => () => {}, close: async () => { closes++; },
      callTool: async (name) => {
        if (name === "browser_close") return { content: [] };
        operations++;
        if (operations === 1) throw new Error("connection lost after send");
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
  };
  const browser = await openBrowser(config, root, undefined, connector);
  const execute = browser.extension.tools!.find((tool) => tool.name === "pw.browser_navigate")!.execute!;
  try {
    await browser.begin("request-1", new AbortController().signal);
    const first = await execute({ url: "https://example.com" }, {} as never, {} as never);
    assert.equal(first.isError, true);
    await execute({ url: "https://example.com" }, {} as never, {} as never);
    assert.equal(operations, 1);
    await browser.end();
    await browser.begin("request-2", new AbortController().signal);
    const second = await execute({ url: "https://example.com" }, {} as never, {} as never);
    assert.equal(second.isError, false);
    assert.equal(operations, 2);
    assert.equal(connects, 3);
    await browser.end();
    assert.equal(closes, 3);
    // A recovered request cannot silently obtain a fresh empty context.
    await browser.begin("request-2", new AbortController().signal);
    assert.equal((await execute({ url: "https://example.com" }, {} as never, {} as never)).isError, true);
    assert.equal(operations, 2);
  } finally { await browser.close(); await rm(root, { recursive: true, force: true }); }
});

test("a verification page blocks further actions while still allowing a screenshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-browser-challenge-"));
  let operations = 0;
  const connector: BrowserConnector = async () => ({
    serverName: "aster-browser", listTools: async () => infos, subscribeAvailability: () => () => {}, close: async () => {},
    callTool: async (name, args) => {
      if (name !== "browser_close") operations++;
      if (name === "browser_take_screenshot") await writeFile(args.filename as string, Buffer.from("89504e470d0a1a0a", "hex"));
      return { content: [{ type: "text", text: "Page URL: https://www.google.com/sorry/index\nHTTP status: 429" }] };
    },
  });
  const browser = await openBrowser(config, directory, undefined, connector);
  try {
    await browser.begin("challenge", new AbortController().signal);
    const navigate = browser.extension.tools!.find((tool) => tool.name === "pw.browser_navigate")!.execute!;
    assert.equal((await navigate({ url: "https://www.google.com" }, {} as never, {} as never)).isError, false);
    assert.equal((await navigate({ url: "https://example.com" }, {} as never, {} as never)).isError, true);
    assert.equal(operations, 1);
    const screenshot = browser.extension.tools!.find((tool) => tool.name === "pw.browser_take_screenshot")!.execute!;
    assert.equal((await screenshot({}, {} as never, {} as never)).isError, false);
    assert.equal(operations, 2);
    assert.equal((await browser.photos("challenge")).length, 1);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("cleanup failures preserve saved results and allow the next request", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "aster-browser-cleanup-"));
  let connects = 0;
  const logs: string[] = [];
  context.mock.method(console, "error", (line: string) => logs.push(line));
  const connector: BrowserConnector = async () => {
    const discovery = ++connects === 1;
    return {
      serverName: "aster-browser", listTools: async () => infos, subscribeAvailability: () => () => {},
      close: async () => { if (!discovery) throw new Error("transport close failed"); },
      callTool: async (name, args) => {
        if (name === "browser_close") throw new Error("browser already stopped");
        if (name === "browser_take_screenshot") await writeFile(args.filename as string, Buffer.from("89504e470d0a1a0a", "hex"));
        return { content: [] };
      },
    };
  };
  const browser = await openBrowser(config, directory, undefined, connector);
  try {
    await browser.begin("cleanup", new AbortController().signal);
    const screenshot = browser.extension.tools!.find((tool) => tool.name === "pw.browser_take_screenshot")!.execute!;
    await screenshot({}, {} as never, {} as never);
    await browser.end();
    assert.equal((await browser.photos("cleanup")).length, 1);
    assert.equal(logs.length, 2);
    assert.ok(logs.every((line) => line.includes("BROWSER_CLEANUP_UNKNOWN")));
    await browser.begin("after-cleanup", new AbortController().signal);
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("native durable path rejects invalid browser arguments before MCP execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-browser-native-"));
  let calls = 0;
  const connector: BrowserConnector = async () => ({
    serverName: "aster-browser", listTools: async () => infos, subscribeAvailability: () => () => {}, close: async () => {},
    callTool: async (name) => { if (name !== "browser_close") calls++; return { content: [{ type: "text", text: "ok" }] }; },
  });
  const browser = await openBrowser(config, directory, undefined, connector);
  const faux = fauxProvider({ provider: "openai" });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([
    () => fauxAssistantMessage(fauxToolCall("pw.browser_navigate", { url: "https://example.com", filename: "/tmp/escape" }), { stopReason: "toolUse" }),
    (transcript) => {
      assert.ok(transcript.messages.some((message) => message.role === "toolResult" && message.isError));
      return fauxAssistantMessage(fauxToolCall("pw.browser_navigate", { url: "https://example.com" }), { stopReason: "toolUse" });
    },
    () => fauxAssistantMessage("done"),
  ]);
  const appConfig = readConfig({ TELEGRAM_BOT_TOKEN: "fake", TELEGRAM_OWNER_ID: "1", MODEL_PROVIDER: "openai", MODEL_ID: "faux-1", OPENAI_API_KEY: "fake", DATA_DIR: directory });
  const app = await openAgent(appConfig, models, undefined, { browser, mcp: { extensions: [], subscribeAvailability: () => () => {}, close: async () => {} }, toolReviewLog: () => {} });
  try {
    await browser.begin("native", new AbortController().signal);
    assert.equal(await app.reply({ requestId: "native", conversationId: "1", senderId: "1", text: "browse" }, new AbortController().signal), "done");
    assert.equal(calls, 1);
  } finally { await app.close(); await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("screenshots use host-generated PNG paths and survive task completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-browser-photo-"));
  const connector: BrowserConnector = async () => ({
    serverName: "aster-browser", listTools: async () => infos, subscribeAvailability: () => () => {}, close: async () => {},
    callTool: async (name, args) => {
      if (name === "browser_take_screenshot") {
        assert.equal(args.type, "png"); assert.equal(args.fullPage, false);
        const path = args.filename as string;
        assert.ok(path.startsWith(join(root, "browser", "shots")));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, Buffer.from("89504e470d0a1a0a", "hex"));
      }
      return { content: [] };
    },
  });
  const browser = await openBrowser(config, root, undefined, connector);
  try {
    await browser.begin("photo-1", new AbortController().signal);
    const execute = browser.extension.tools!.find((tool) => tool.name === "pw.browser_take_screenshot")!.execute!;
    await execute({}, {} as never, {} as never);
    assert.equal((await browser.photos("photo-1")).length, 1);
    await browser.end();
    assert.equal((await browser.photos("photo-1")).length, 1);
    await browser.begin("photo-2", new AbortController().signal);
    assert.deepEqual(await browser.photos("photo-2"), []);
  } finally { await browser.close(); await rm(root, { recursive: true, force: true }); }
});

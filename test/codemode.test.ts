import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openAgent } from "../src/agent.js";
import {
  CODEMODE_OUTPUT_LIMITS,
  createCodemodeHost,
  REMOTE_SCRIPT_TOOLS,
  restrictScriptTools,
  serializeNestedCalls,
} from "../src/codemode.js";
import { ConfigurationError, readCodemodeConfig, readConfig, readMemoryConfig } from "../src/config.js";
import { startBrokerServer } from "../src/execution/broker.js";
import type { ExecRequest } from "../src/execution/protocol.js";
import type { TextRequest } from "../src/messages.js";

const request: TextRequest = {
  requestId: "telegram:test:codemode",
  conversationId: "telegram:test",
  senderId: "1",
  text: "Run the code mode task.",
};
const running = new AbortController().signal;

function appConfig(dataDir: string, env: NodeJS.ProcessEnv = {}) {
  const full = {
    TELEGRAM_BOT_TOKEN: "offline-test",
    TELEGRAM_OWNER_ID: "1",
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    OPENAI_API_KEY: "offline-test",
    DATA_DIR: dataDir,
    MEMORY_ENABLED: "0",
    ...env,
  };
  return { ...readConfig(full), memory: readMemoryConfig(full) } as ReturnType<typeof readConfig>;
}

function modelFixture() {
  const faux = fauxProvider({ provider: "openai" });
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

function systemSection(messages: readonly Message[], key: string): string | undefined {
  for (const message of messages) {
    if (message.role !== "system" || message.sections === undefined) continue;
    const value = message.sections[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

test("code mode is opt-in and its sandbox bounds are validated before startup", () => {
  assert.deepEqual(readCodemodeConfig({}), {
    enabled: false,
    timeoutMs: 240_000,
    memoryLimitBytes: 128 * 1024 * 1024,
  });
  assert.equal(readCodemodeConfig({ CODEMODE_ENABLED: "1" }).enabled, true);
  assert.equal(readCodemodeConfig({ CODEMODE_ENABLED: "" }).enabled, false);
  assert.throws(() => readCodemodeConfig({ CODEMODE_ENABLED: "yes" }), (error) =>
    error instanceof ConfigurationError && /CODEMODE_ENABLED/.test(error.message));
  assert.throws(() => readCodemodeConfig({ CODEMODE_TIMEOUT_MS: "999" }), ConfigurationError);
  assert.throws(() => readCodemodeConfig({ CODEMODE_TIMEOUT_MS: "300001" }), ConfigurationError);
  assert.throws(() => readCodemodeConfig({ CODEMODE_MEMORY_LIMIT_BYTES: "16777215" }), ConfigurationError);
  assert.throws(() => readCodemodeConfig({ CODEMODE_MEMORY_LIMIT_BYTES: "536870913" }), ConfigurationError);
  assert.equal(readConfig({
    TELEGRAM_BOT_TOKEN: "test", TELEGRAM_OWNER_ID: "1", MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1", OPENAI_API_KEY: "test",
  }).codemode, undefined, "disabled code mode leaves the config shape unchanged");
});

test("script tools are limited without hiding them from the model", () => {
  const restricted = restrictScriptTools(CodingTools, REMOTE_SCRIPT_TOOLS);
  const tools = new Map((restricted.tools ?? []).map((tool) => [tool.name, tool]));
  assert.equal(tools.get("bash")?.callers, undefined, "the allowed tool is unchanged");
  assert.deepEqual(tools.get("read")?.callers, ["model"]);
  assert.deepEqual(tools.get("write")?.callers, ["model"]);
  assert.deepEqual(tools.get("edit")?.callers, ["model"]);

  const toolsOnly = defineTool({
    name: "tools_only",
    description: "Only scripts may call this.",
    parameters: Type.Object({}),
    callers: ["tools"],
    execute: async () => ({ output: [] }),
  });
  const closed = restrictScriptTools(defineExtension({ name: "tools-only", tools: [toolsOnly] }), new Set());
  assert.deepEqual(closed.tools?.[0]?.callers, [], "a tools-only tool is not promoted to the model");

  const withoutTools = defineExtension({ name: "sections-only" });
  assert.equal(restrictScriptTools(withoutTools, new Set()), withoutTools);
});

test("nested calls stop when their script call ends", async () => {
  const started: string[] = [];
  const signals = new Map<string, AbortSignal | undefined>();
  const fake = defineTool({
    name: "fake-codemode",
    description: "Fake code mode tool.",
    parameters: Type.Object({}),
    execute: async (_args, api, context) => {
      void api.executeTool("first", {}, context).catch(() => undefined);
      void api.executeTool("second", {}, context).catch(() => undefined);
      return { output: [{ type: "text", text: "done" }] };
    },
  });
  const wrapped = serializeNestedCalls(fake);
  const api = {
    executeTool: async (name: string, _args: unknown, nestedContext: Context) => {
      started.push(name);
      signals.set(name, nestedContext.abortSignal);
      await new Promise<void>((resolve) => {
        nestedContext.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { taskId: 1, isError: true, diagnostics: [] };
    },
  } as unknown as ToolExecutionApi;

  assert.deepEqual(await wrapped.execute({}, api, BACKGROUND_CONTEXT), {
    output: [{ type: "text", text: "done" }],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first"], "the queued call never starts after the script ends");
  assert.equal(signals.get("first")?.aborted, true, "a still-running call is cancelled");
});

test("code mode host caps the model-visible result and closes idempotently", async () => {
  const host = createCodemodeHost(readCodemodeConfig({ CODEMODE_ENABLED: "1" }));
  try {
    const tool = host.extension.tools?.find(({ name }) => name === "codemode");
    assert.ok(tool, "the codemode tool is installed");
    assert.deepEqual(tool.outputLimits, CODEMODE_OUTPUT_LIMITS);
    assert.deepEqual(tool.callers, ["model"], "scripts cannot start scripts");
    assert.equal(host.extension.tools?.some(({ name }) => name.startsWith("models.")), false);
  } finally {
    await host.close();
    await host.close();
  }
});

test("code mode runs one script whose nested calls stay out of the transcript", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-codemode-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const fixture = modelFixture();
    fixture.faux.setResponses([
      (transcript) => {
        const section = systemSection(transcript.messages, "codemode");
        assert.ok(section, "the codemode prompt section is present");
        assert.match(section, /bash/);
        assert.match(section, /`read`/, "local scripts keep the file tools");
        assert.match(section, /`write`/);
        assert.match(section, /`edit`/);
        return fauxAssistantMessage(fauxToolCall("codemode", {
          code: `
            const first = await tools.bash({ command: "printf first >> nested.log" });
            const second = await tools.bash({ command: "printf second >> nested.log" });
            return "nested calls done";
          `,
        }), { stopReason: "toolUse" });
      },
      (transcript) => {
        const results = transcript.messages.filter((message) => message.role === "toolResult");
        assert.equal(results.length, 1, "only the codemode result enters the conversation");
        const result = results[0];
        assert.ok(result?.role === "toolResult" && !result.isError);
        const text = result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
        assert.match(text, /nested calls done/);
        return fauxAssistantMessage("done");
      },
    ]);
    app = await openAgent(appConfig(directory, { CODEMODE_ENABLED: "1" }), fixture.models);
    assert.equal(await app.reply(request, running), "done");
    assert.equal(
      await readFile(join(directory, "workspace", "nested.log"), "utf8"),
      "firstsecond",
      "both nested bash calls ran",
    );
  } finally {
    try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("code mode in remote execution exposes only bash to scripts", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "personal-agent-codemode-remote-"));
  const socketPath = join(directory, "broker.sock");
  const executionId = "0000000000000002";
  const requests: ExecRequest[] = [];
  const server = await startBrokerServer({
    socketPath,
    executionId,
    runner: async (message, sink) => {
      requests.push(message);
      sink.stdout("remote\n");
      return { exitCode: 0 };
    },
    maxConcurrent: 4,
    maxOutputBytes: 4096,
    maxOutputLines: 100,
    requestTimeoutMs: 2000,
  });
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const fixture = modelFixture();
    fixture.faux.setResponses([
      (transcript) => {
        const section = systemSection(transcript.messages, "codemode");
        assert.ok(section);
        assert.match(section, /bash/);
        assert.doesNotMatch(section, /`read`/);
        return fauxAssistantMessage(fauxToolCall("codemode", {
          code: `
            const first = await tools.bash({ command: "printf remote-first" });
            const second = await tools.bash({ command: "printf remote-second" });
            return first.output + second.output;
          `,
        }), { stopReason: "toolUse" });
      },
      (transcript) => {
        const result = transcript.messages.find((message) => message.role === "toolResult");
        assert.ok(result?.role === "toolResult" && !result.isError);
        const text = result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
        assert.match(text, /remote/);
        return fauxAssistantMessage("remote done");
      },
    ]);
    app = await openAgent(appConfig(directory, {
      CODEMODE_ENABLED: "1",
      EXECUTION_MODE: "remote",
      EXECUTION_BROKER_SOCKET: socketPath,
      EXECUTION_REMOTE_CWD: "/srv/work",
    }), fixture.models);
    assert.equal(await app.reply(request, running), "remote done");
    assert.equal(requests.length, 2, "two nested calls reached the execution broker");
    assert.deepEqual(requests.map(({ command }) => command), ["printf remote-first", "printf remote-second"]);
  } finally {
    try { await app?.close(); } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

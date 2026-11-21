import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentText } from "@earendil-works/pi-ai";
import type { Message, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { openAgent } from "../src/agent.js";
import { readConfig } from "../src/config.js";
import { waitFor } from "./http-testkit.js";

function config(dataDir: string) {
  return readConfig({
    CHANNEL: "web",
    WEB_OWNER_ID: "owner",
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    OPENAI_API_KEY: "offline-test",
    DATA_DIR: dataDir,
    MEMORY_ENABLED: "0",
  });
}

type ControllableTool = {
  readonly extension: ReturnType<typeof defineExtension>;
  readonly entered: Promise<void>;
  release(): void;
};

/** A registered tool that holds the run at a tool boundary until the test releases it. */
function gatedTool(): ControllableTool {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const enteredOnce = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const extension = defineExtension({
    name: "steer-fixture",
    tools: [defineTool({
      name: "steer_probe",
      description: "Test-only tool that blocks at the tool boundary.",
      parameters: Type.Object({}),
      execute: async () => {
        entered();
        await gate;
        return { output: [{ type: "text", text: "probe done" }] };
      },
    })],
  });
  return { extension, entered: enteredOnce, release };
}

test("a running steer joins the same run, is visible at the next boundary and is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-steer-"));
  const faux = fauxProvider({ provider: "openai" });
  const models = createModels();
  models.setProvider(faux.provider);
  const tool = gatedTool();
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    let contextAtAnswer: readonly Message[] = [];
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("steer_probe", {})], { stopReason: "toolUse" }),
      (context: TranscriptContext) => {
        contextAtAnswer = context.messages;
        return fauxAssistantMessage("final answer");
      },
    ]);
    app = await openAgent(config(directory), models, undefined, { extraExtensions: [tool.extension] });

    const running = app.reply({
      requestId: "web:steer:original",
      conversationId: "owner",
      senderId: "owner",
      text: "original question",
    }, new AbortController().signal);
    await tool.entered;

    const steered = await app.steer({
      requestId: "steer:client-1",
      conversationId: "owner",
      senderId: "owner",
      text: "please also check the logs",
    });
    assert.equal(steered.steerId, "steer:client-1");

    tool.release();
    assert.equal(await running, "final answer");
    const answer = await steered.done;
    assert.equal(answer?.text, "final answer");

    const userTexts = contextAtAnswer
      .filter((message) => message.role === "user")
      .map((message) => contentText(message.content));
    assert.ok(userTexts.includes("please also check the logs"), "the model sees the steer at the next boundary");

    const history = await app.history({ limit: 30 });
    const steerRow = history.messages.find((message) => message.role === "user" && message.text === "please also check the logs");
    assert.ok(steerRow, "the steer is a durable user row");
    assert.equal(steerRow.requestId, "steer:client-1");
    assert.equal(answer?.id, history.messages.find((message) => message.role === "assistant" && message.text === "final answer")?.id);

    // A replay after the run completed returns the same steer id and adds no second row.
    const replay = await app.steer({
      requestId: "steer:client-1",
      conversationId: "owner",
      senderId: "owner",
      text: "please also check the logs",
    });
    assert.equal(replay.steerId, "steer:client-1");
    await replay.done;
    const afterReplay = await app.history({ limit: 30 });
    assert.equal(
      afterReplay.messages.filter((message) => message.role === "user" && message.text === "please also check the logs").length,
      1,
      "a replayed steer is not injected twice",
    );
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("steering an idle conversation is refused without writing an entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-steer-idle-"));
  const faux = fauxProvider({ provider: "openai" });
  const models = createModels();
  models.setProvider(faux.provider);
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    faux.setResponses([fauxAssistantMessage("unused")]);
    app = await openAgent(config(directory), models);
    await assert.rejects(
      app.steer({
        requestId: "steer:idle-1",
        conversationId: "owner",
        senderId: "owner",
        text: "too late",
      }),
      { code: "NO_ACTIVE_REQUEST" },
    );
    const history = await app.history({ limit: 20 });
    assert.equal(history.messages.length, 0);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("abort after a steer keeps the row in history but removes it from the next context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-steer-abort-"));
  const faux = fauxProvider({ provider: "openai", tokensPerSecond: 2 });
  const models = createModels();
  models.setProvider(faux.provider);
  const tool = gatedTool();
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("steer_probe", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage("one two three four five six seven eight nine ten eleven twelve thirteen fourteen"),
    ]);
    app = await openAgent(config(directory), models, undefined, { extraExtensions: [tool.extension] });

    const controller = new AbortController();
    const running = app.reply({
      requestId: "web:steer:abort",
      conversationId: "owner",
      senderId: "owner",
      text: "original question",
    }, controller.signal);
    await tool.entered;
    const steered = await app.steer({
      requestId: "steer:abort-1",
      conversationId: "owner",
      senderId: "owner",
      text: "steer before the stop",
    });
    tool.release();
    // The model call after the boundary is slow enough to stop while the steer is already placed.
    await waitFor(() => faux.state.callCount === 2, 10_000);
    controller.abort();
    await app.abort();
    await assert.rejects(running);
    await steered.done;

    const afterStop = await app.history({ limit: 30 });
    assert.ok(
      afterStop.messages.some((message) => message.role === "user" && message.text === "steer before the stop"),
      "the steer row stays in history",
    );

    let seen: readonly Message[] = [];
    faux.setResponses([(context: TranscriptContext) => {
      seen = context.messages;
      return fauxAssistantMessage("next answer");
    }]);
    assert.equal(await app.reply({
      requestId: "web:steer:next",
      conversationId: "owner",
      senderId: "owner",
      text: "next question",
    }, new AbortController().signal), "next answer");
    const userTexts = seen
      .filter((message) => message.role === "user")
      .map((message) => contentText(message.content));
    assert.equal(userTexts.some((text) => text.includes("steer before the stop")), false,
      "the stopped steer must not enter the next model context");
    assert.equal(userTexts.some((text) => text.includes("original question")), false,
      "the stopped request must not enter the next model context");
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

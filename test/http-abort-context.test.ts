import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contentText } from "@earendil-works/pi-ai";
import type { Message, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
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

test("a stopped turn leaves no empty assistant row and is not answered by the next request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-abort-context-"));
  const faux = fauxProvider({ provider: "openai", tokensPerSecond: 2 });
  const models = createModels();
  models.setProvider(faux.provider);
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    faux.setResponses([fauxAssistantMessage("one two three four five six seven eight nine ten eleven twelve")]);
    app = await openAgent(config(directory), models);

    const controller = new AbortController();
    const stopped = app.reply({
      requestId: "web:test:stopped",
      conversationId: "owner",
      senderId: "owner",
      text: "first question",
    }, controller.signal);
    await waitFor(() => faux.state.callCount === 1, 10_000);
    controller.abort();
    await app.abort();
    await assert.rejects(stopped);

    const afterStop = await app.history({ limit: 20 });
    assert.ok(afterStop.messages.some((message) => message.role === "user" && message.text === "first question"),
      "the user's question stays in history");
    assert.equal(
      afterStop.messages.filter((message) => message.role === "assistant" && message.text.trim() === "").length,
      0,
      "a stop before any token must not leave an empty assistant bubble",
    );

    let seen: readonly Message[] = [];
    faux.setResponses([(context: TranscriptContext) => {
      seen = context.messages;
      return fauxAssistantMessage("second answer");
    }]);
    const answer = await app.reply({
      requestId: "web:test:next",
      conversationId: "owner",
      senderId: "owner",
      text: "second question",
    }, new AbortController().signal);
    assert.equal(answer, "second answer");

    const userTexts = seen
      .filter((message) => message.role === "user")
      .map((message) => contentText(message.content));
    assert.ok(userTexts.includes("second question"));
    assert.equal(userTexts.some((text) => text.includes("first question")), false,
      "the stopped question must not enter the next context");

    const final = await app.history({ limit: 20 });
    assert.equal(
      final.messages.filter((message) => message.role === "assistant" && message.text.trim() === "").length,
      0,
    );
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

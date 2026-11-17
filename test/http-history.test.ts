import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openAgent } from "../src/agent.js";
import { readConfig } from "../src/config.js";

function config(dataDir: string) {
  return readConfig({
    TELEGRAM_BOT_TOKEN: "offline-test",
    TELEGRAM_OWNER_ID: "1",
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    OPENAI_API_KEY: "offline-test",
    DATA_DIR: dataDir,
    MEMORY_ENABLED: "0",
  });
}

function webConfig(dataDir: string) {
  return readConfig({
    CHANNEL: "web",
    WEB_OWNER_ID: "owner",
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    MODEL_FALLBACKS: "openai:faux-2",
    OPENAI_API_KEY: "offline-test",
    DATA_DIR: dataDir,
    MEMORY_ENABLED: "0",
  });
}

test("history reads the durable transcript, projects messages and pages by entry cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-history-"));
  const faux = fauxProvider({ provider: "openai" });
  const models = createModels();
  models.setProvider(faux.provider);
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  const signal = new AbortController().signal;
  try {
    faux.setResponses([
      fauxAssistantMessage("first answer"),
      fauxAssistantMessage("second answer"),
      fauxAssistantMessage("third answer"),
    ]);
    app = await openAgent(config(directory), models);
    const ask = (id: string, text: string) => app!.reply({
      requestId: `web:test:${id}`,
      conversationId: "owner",
      senderId: "owner",
      text,
    }, signal);
    assert.equal(await ask("1", "first question"), "first answer");
    // The same request id replays the settled turn instead of appending a second user entry.
    assert.equal(await ask("1", "first question"), "first answer");
    const replayHistory = await app.history({ limit: 10 });
    assert.equal(replayHistory.messages.filter(
      (message) => message.role === "user" && message.text === "first question",
    ).length, 1);
    assert.equal(await ask("2", "second question"), "second answer");
    assert.equal(await ask("3", "third question"), "third answer");

    const latest = await app.history({ limit: 10 });
    assert.equal(latest.hasMore, false);
    assert.equal(latest.nextCursor, null);
    assert.deepEqual(latest.messages.map((message) => [message.role, message.text]), [
      ["user", "first question"],
      ["assistant", "first answer"],
      ["user", "second question"],
      ["assistant", "second answer"],
      ["user", "third question"],
      ["assistant", "third answer"],
    ]);
    for (const message of latest.messages) {
      assert.ok(message.createdAt > 0, "every projected message has a timestamp");
      assert.ok(/^\d+$/.test(message.id), "the durable entry id is the message id");
      assert.equal(message.clientMessageId, null, "the agent does not know web request rows");
    }
    assert.deepEqual(latest.messages.map((message) => message.requestId), [
      "web:test:1",
      "web:test:1",
      "web:test:2",
      "web:test:2",
      "web:test:3",
      "web:test:3",
    ], "both the input and its answer carry the request id from durable submissions");
    const assistant = latest.messages.find((message) => message.role === "assistant")!;
    assert.equal(assistant.model?.provider, "openai");
    assert.equal(assistant.model?.id, "faux-1");
    assert.equal(assistant.status, "complete");
    assert.equal(assistant.errorCode, null);

    // Two newest messages, with an older page behind a stable cursor.
    const firstPage = await app.history({ limit: 2 });
    assert.equal(firstPage.messages.length, 2);
    assert.equal(firstPage.hasMore, true);
    assert.ok(firstPage.nextCursor !== null);
    assert.deepEqual(firstPage.messages.map((message) => message.text), ["third question", "third answer"]);

    const seen = [...firstPage.messages];
    let cursor: string | null = firstPage.nextCursor;
    while (cursor !== null) {
      const page = await app.history({ limit: 2, before: cursor });
      assert.ok(page.messages.length > 0);
      seen.unshift(...page.messages);
      cursor = page.nextCursor;
    }
    assert.deepEqual(seen.map((message) => [message.role, message.text]), latest.messages
      .map((message) => [message.role, message.text]));
    assert.equal(new Set(seen.map((message) => message.id)).size, seen.length, "pages do not repeat entries");

    await assert.rejects(app.history({ before: "not-a-cursor" }), (error: unknown) =>
      (error as { code?: string }).code === "INVALID_REQUEST");
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("$model stays host-side: no model call and no durable user row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-history-model-"));
  const faux = fauxProvider({
    provider: "openai",
    models: [{ id: "faux-1" }, { id: "faux-2" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    app = await openAgent(webConfig(directory), models);
    const reply = await app.reply({
      requestId: "web:test:model",
      conversationId: "owner",
      senderId: "owner",
      text: "$model",
    }, new AbortController().signal);
    assert.match(reply, /faux-1/);
    assert.equal(faux.state.callCount, 0, "a host command does not call a model");
    const history = await app.history({ limit: 10 });
    assert.deepEqual(history.messages, [], "a host command appends no durable user row");
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

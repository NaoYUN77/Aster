import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Message, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openAgent } from "../src/agent.js";
import { buildAgentOptions } from "../src/agent-options.js";
import { readConfig } from "../src/config.js";
import { ensureMemoryFs } from "../src/memory-fs.js";

function webConfig(dataDir: string, memoryDir: string) {
  return readConfig({
    CHANNEL: "web",
    WEB_OWNER_ID: "owner",
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    OPENAI_API_KEY: "offline-test",
    DATA_DIR: dataDir,
    MEMORY_FS_ENABLED: "1",
    MEMORY_FS_DIR: memoryDir,
    DREAMING_TURNS: "10000",
  });
}

test("the web entry's memory initialization is off when the feature is off", async () => {
  const memoryFs = await ensureMemoryFs({ enabled: false, dir: "unused" });
  assert.equal(memoryFs, undefined);
});

test("the web composition carries core memory into the prompt and arms dreaming", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-web-memory-"));
  const memoryDir = join(directory, "memory-fs");
  const faux = fauxProvider({ provider: "openai" });
  const models = createModels();
  models.setProvider(faux.provider);
  let contextAtAnswer: readonly Message[] = [];
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const config = webConfig(directory, memoryDir);
    // Exactly the web entry's order: ensure the repository, then build the options it hands over.
    const memoryFs = await ensureMemoryFs(config.memoryFs);
    assert.ok(memoryFs !== undefined, "MEMORY_FS_ENABLED=1 creates the repository");
    await writeFile(join(memoryDir, "MEMORY.md"), "# Owner\n\nDeploy checklist: blue first.\n");
    faux.setResponses([(context: TranscriptContext) => {
      contextAtAnswer = context.messages;
      return fauxAssistantMessage("noted");
    }]);
    app = await openAgent(config, models, undefined,
      buildAgentOptions(config, { memoryFs }, { signal: new AbortController().signal }));

    const answer = await app.reply({
      requestId: "web:memory:1",
      conversationId: "owner",
      senderId: "owner",
      text: "what is the deploy checklist?",
    }, new AbortController().signal);
    assert.equal(answer, "noted");

    // The durable prompt puts the instructions in a named section, not in `content`.
    const system = contextAtAnswer
      .filter((message) => message.role === "system")
      .map((message) => JSON.stringify(message.sections ?? message.content))
      .join("\n");
    assert.match(system, /<memory-files>/, "the memory section is in the web agent's prompt");
    assert.match(system, /Deploy checklist: blue first\./, "MEMORY.md is reproduced in the prompt");

    // Dreaming is gated on the same option: one completed owner turn is persisted to its state.
    const state = JSON.parse(await readFile(join(memoryDir, ".aster", "dreaming.json"), "utf8")) as {
      turnsSinceApply?: number;
    };
    assert.equal(state.turnsSinceApply, 1, "the web agent's turn reached the dreaming runner");
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

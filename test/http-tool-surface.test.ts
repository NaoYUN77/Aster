import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openAgent } from "../src/agent.js";
import { buildAgentOptions } from "../src/agent-options.js";
import { openConnectors } from "../src/connectors/index.js";
import { createConnectorExtension } from "../src/connectors/tools.js";
import { readConfig } from "../src/config.js";
import { ReminderStore } from "../src/reminders.js";
import { createRoutinesExtension } from "../src/routines/tools.js";
import { SqliteRoutineStore } from "../src/routines/store.js";
import { SkillIndex } from "../src/skills.js";
import { createWatchers } from "../src/watchers/index.js";
import { SqliteWatchStore } from "../src/watchers/store.js";

test("the web host composition exposes reminders, watches, routines and skills", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-web-tools-"));
  const config = readConfig({
    CHANNEL: "web",
    WEB_OWNER_ID: "owner",
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    OPENAI_API_KEY: "offline-test",
    DATA_DIR: directory,
    MEMORY_ENABLED: "0",
  });
  assert.equal(config.channel.kind, "web");
  assert.ok(config.watchers !== undefined && config.routines !== undefined && config.skills !== undefined);
  const reminders = new ReminderStore(join(directory, "reminders.sqlite"), { limits: config.reminders! });
  const watchStore = new SqliteWatchStore(join(directory, "watchers.sqlite"));
  const watchers = createWatchers({
    store: watchStore,
    config: config.watchers,
    chatId: "owner",
    deliver: async () => "host",
  });
  const routinesStore = new SqliteRoutineStore(join(directory, "routines.sqlite"));
  const routines = createRoutinesExtension({ store: routinesStore, config: config.routines, chatId: "owner" });
  const skillsDir = join(directory, "skills");
  await mkdir(join(skillsDir, "demo"), { recursive: true });
  await writeFile(join(skillsDir, "demo", "SKILL.md"), "---\nname: demo\ndescription: demo skill\n---\nbody\n");
  const skills = await SkillIndex.scan(skillsDir);
  const connectors = openConnectors({
    dataDir: directory,
    ownerId: "owner",
    config: config.connectors!,
  });
  assert.ok(connectors !== undefined);
  const connectorTools = createConnectorExtension(connectors.service, "owner");
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    const faux = fauxProvider({ provider: "openai" });
    const models = createModels();
    models.setProvider(faux.provider);
    let toolNames: string[] = [];
    faux.setResponses([(transcript) => {
      toolNames = transcript.messages.flatMap((message) =>
        message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : []);
      return fauxAssistantMessage("ok");
    }]);
    app = await openAgent(config, models, undefined, buildAgentOptions(config, {
      reminderStore: reminders,
      extraExtensions: [
        ...(watchers.extension === undefined ? [] : [watchers.extension]),
        routines,
        connectorTools,
      ],
      skills,
    }));
    assert.equal(await app.reply({
      requestId: "web:tools:1",
      conversationId: "owner",
      senderId: "owner",
      text: "hello",
    }, new AbortController().signal), "ok");
    for (const name of ["reminder_create", "reminder_list", "watch_create", "watch_list",
      "routine_create", "routine_list", "skill_list", "connector_list",
      "connector_github_list_repositories", "connector_gmail_search_messages"]) {
      assert.ok(toolNames.includes(name), `${name} is registered (${toolNames.join(",")})`);
    }
    assert.ok(toolNames.length > 9, `expected more than 9 tools, saw ${toolNames.length}`);
  } finally {
    await app?.close();
    connectors?.close();
    watchStore.close();
    routinesStore.close();
    reminders.close();
    await rm(directory, { recursive: true, force: true });
  }
});

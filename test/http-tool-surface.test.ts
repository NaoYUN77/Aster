import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { openAgent } from "../src/agent.js";
import { buildAgentOptions } from "../src/agent-options.js";
import { openConnectors } from "../src/connectors/index.js";
import { createConnectorExtension } from "../src/connectors/tools.js";
import { readConfig } from "../src/config.js";
import { ReminderStore } from "../src/reminders.js";
import { withMemoryOff } from "./support/memory-off.js";
import { createRoutinesExtension } from "../src/routines/tools.js";
import { SqliteRoutineStore } from "../src/routines/store.js";
import { SkillIndex } from "../src/skills.js";
import { createWatchers } from "../src/watchers/index.js";
import { SqliteWatchStore } from "../src/watchers/store.js";

test("the web host composition exposes reminders, watches, routines and skills", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-web-tools-"));
  const config = withMemoryOff(readConfig({
    WEB_OWNER_ID: "owner",
    MODEL_PROVIDER: "openai",
    MODEL_ID: "faux-1",
    OPENAI_API_KEY: "offline-test",
    DATA_DIR: directory,
  }));
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
    let turn1Tools: string[] = [];
    let turn2Tools: string[] = [];
    let systemText = "";
    faux.setResponses([
      (transcript) => {
        turn1Tools = getCurrentTools(transcript.messages).map((tool) => tool.name);
        systemText = getCurrentSystemPrompt(transcript.messages);
        return fauxAssistantMessage([
          fauxToolCall("tool_search", { query: "github repositories" }),
        ], { stopReason: "toolUse" });
      },
      (transcript) => {
        turn2Tools = getCurrentTools(transcript.messages).map((tool) => tool.name);
        return fauxAssistantMessage("ok");
      },
    ]);
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
      "routine_create", "routine_list", "skill_list", "skill_load", "connector_list", "tool_search"]) {
      assert.ok(turn1Tools.includes(name), `${name} is registered (${turn1Tools.join(",")})`);
    }
    // Connector action tools stay Tier-2 deferred until discovered via tool_search.
    assert.equal(turn1Tools.includes("connector_github_list_repositories"), false);
    assert.equal(turn1Tools.includes("connector_gmail_search_messages"), false);
    assert.ok(turn2Tools.includes("connector_github_list_repositories"), `discovered via tool_search (${turn2Tools.join(",")})`);
    // Skills index is injected into system context while the skill body stays on disk.
    assert.match(systemText, /- demo: demo skill/);
    assert.equal(systemText.includes("\nbody\n"), false);
  } finally {
    await app?.close();
    connectors?.close();
    watchStore.close();
    routinesStore.close();
    reminders.close();
    await rm(directory, { recursive: true, force: true });
  }
});

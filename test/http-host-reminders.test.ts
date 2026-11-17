import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openAgent } from "../src/agent.js";
import { readConfig } from "../src/config.js";
import { AgentGate } from "../src/http/agent-gate.js";
import type { EventHub } from "../src/http/events.js";
import { WebHostDelivery } from "../src/http/host-delivery.js";
import { ReminderScheduler, ReminderStore } from "../src/reminders.js";
import { createRoutines } from "../src/routines/runtime.js";
import { SqliteRoutineStore } from "../src/routines/store.js";

function webConfig(dataDir: string) {
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

test("a due reminder becomes one durable system row and one host.message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-host-reminder-"));
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  const events: { event: string; data: unknown }[] = [];
  const hub = {
    broadcast(event: string, data: unknown) { events.push({ event, data }); },
  } as unknown as EventHub;
  let now = new Date("2026-11-18T00:00:00.000Z");
  const reminders = new ReminderStore(join(directory, "reminders.sqlite"), {
    now: () => now,
    limits: { maxPending: 100, maxPerHour: 20, horizonDays: 366 },
  });
  try {
    const created = reminders.create({
      chatId: "owner",
      ownerId: "owner",
      content: "喝水",
      triggerAt: "2026-11-18T00:00:05Z",
      timezone: "UTC",
    });
    const faux = fauxProvider({ provider: "openai" });
    const models = createModels();
    models.setProvider(faux.provider);
    app = await openAgent(webConfig(directory), models);
    const delivery = new WebHostDelivery({ agent: app, hub, gate: new AgentGate() });
    now = new Date("2026-11-18T00:00:10.000Z");
    const scheduler = new ReminderScheduler({
      store: reminders,
      client: delivery.reminderChannel(),
      now: () => now,
      log: () => {},
    });
    const signal = new AbortController().signal;
    assert.equal(await scheduler.runDue(signal), 1);
    assert.equal(await scheduler.runDue(signal), 0, "a sent reminder is never claimed again");

    const history = await app.history({ limit: 10 });
    assert.deepEqual(history.messages.map((message) => [message.role, message.text]), [
      ["system", "提醒：喝水"],
    ]);
    assert.equal(events.filter((event) => event.event === "host.message").length, 1);
    assert.equal(reminders.listAll()[0]?.status, "sent");
    assert.equal(reminders.listAll()[0]?.id, created.reminder.id);
    assert.equal(faux.state.callCount, 0, "delivery does not call a model");
  } finally {
    await app?.close();
    reminders.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a notify routine result is delivered through the same durable host path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-host-routine-"));
  const now = () => new Date("2026-11-18T00:00:00.000Z");
  const routinesStore = new SqliteRoutineStore(join(directory, "routines.sqlite"), { now });
  let app: Awaited<ReturnType<typeof openAgent>> | undefined;
  const events: { event: string; data: unknown }[] = [];
  const hub = {
    broadcast(event: string, data: unknown) { events.push({ event, data }); },
  } as unknown as EventHub;
  try {
    const faux = fauxProvider({ provider: "openai" });
    const models = createModels();
    models.setProvider(faux.provider);
    app = await openAgent(webConfig(directory), models);
    const delivery = new WebHostDelivery({ agent: app, hub, gate: new AgentGate() });
    const runtime = createRoutines({
      store: routinesStore,
      config: {
        enabled: true,
        paused: false,
        timezone: "Asia/Shanghai",
        maxPerOwner: 50,
        minIntervalMinutes: 5,
        maxRunsPerDay: 0,
        runTimeoutMs: 600_000,
        summaryEnabled: false,
        summaryLocalTime: "21:00",
        retentionDays: 90,
      },
      chatId: "owner",
      now,
      log: () => {},
      deliver: async (_chatId, text, signal, key) => (await delivery.send("routine", text, signal, key)).id,
      run: async () => {
        throw new Error("a notify routine must not call the model runner");
      },
    });
    try {
      const routine = routinesStore.create({
        chatId: "owner",
        title: "daily note",
        timezone: "Asia/Shanghai",
        mode: "notify",
        text: "日报 {{date}}",
        delivery: "always",
        schedule: { kind: "daily", at: "09:00" },
        now: now(),
      });
      routinesStore.enqueueManual(routine.id, now());
      const result = await runtime.tickOnce(new AbortController().signal);
      assert.equal(result.ran, 1);
      assert.equal(routinesStore.runs(routine.id)[0]?.status, "succeeded");
      const history = await app.history({ limit: 10 });
      assert.deepEqual(history.messages.map((message) => [message.role, message.text]), [["system", "日报 2026-11-18"]]);
      assert.equal(events.filter((event) => event.event === "host.message").length, 1);
      assert.equal(faux.state.callCount, 0);
    } finally {
      await runtime.stop();
    }
  } finally {
    await app?.close();
    routinesStore.close();
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WebConfig } from "../src/config.js";
import { hashPassword, SessionStore } from "../src/http/auth.js";
import { EventHub } from "../src/http/events.js";
import { createWebServer } from "../src/http/server.js";
import { WebRequestStore } from "../src/http/store.js";
import { RequestWorker } from "../src/http/worker.js";
import { ReminderStore } from "../src/reminders.js";
import { SqliteRoutineStore } from "../src/routines/store.js";
import { createWatchers } from "../src/watchers/index.js";
import type { WatchersConfig } from "../src/watchers/protocol.js";
import { SqliteWatchStore } from "../src/watchers/store.js";
import { fakeAgent, fixtureSelection } from "./http-testkit.js";

const PASSWORD = "automations-test-password";

const DEFAULT_WATCHERS_CONFIG: WatchersConfig = {
  enabled: true,
  maxActive: 20,
  maxPerHour: 20,
  feedIntervalSec: 300,
  xIntervalSec: 300,
  githubReconcileMin: 15,
  fetchTimeoutMs: 5_000,
  timezone: "Asia/Shanghai",
  quietHours: "23:00-08:00",
  digestTime: "08:30",
};

async function startAutomationServer(options: {
  withStores?: boolean;
  routinesPaused?: boolean;
} = {}) {
  const fixture = await fixtureSelection();
  const directory = await mkdtemp(join(tmpdir(), "aster-http-automations-"));
  const store = new WebRequestStore(join(directory, "web.sqlite"));
  const sessions = new SessionStore(store.database, 60 * 60 * 1000);
  const hub = new EventHub(() => {});
  const config: WebConfig = {
    port: 0,
    host: "127.0.0.1",
    allowedOrigins: ["http://localhost:5173"],
    sessionTtlDays: 30,
    staticDir: join(directory, "web-dist"),
    trustProxy: false,
  };
  const agent = fakeAgent({
    service: fixture.service,
    reply: async (request) => `reply:${request.text}`,
  });
  const worker = new RequestWorker({ store, hub, ownerId: "owner", agent });

  const withStores = options.withStores !== false;
  const routinesStore = withStores ? new SqliteRoutineStore(join(directory, "routines.sqlite")) : undefined;
  const watchersStore = withStores ? new SqliteWatchStore(join(directory, "watchers.sqlite")) : undefined;
  const deliveredMessages: string[] = [];
  const watchersRuntime = watchersStore === undefined
    ? undefined
    : createWatchers({
        store: watchersStore,
        config: DEFAULT_WATCHERS_CONFIG,
        chatId: "owner",
        deliver: async (_chatId, text) => {
          deliveredMessages.push(text);
          return `msg-${deliveredMessages.length}`;
        },
      });
  const remindersStore = withStores ? new ReminderStore(join(directory, "reminders.sqlite")) : undefined;

  const app = await createWebServer({
    config,
    ownerId: "owner",
    version: "test",
    auth: hashPassword(PASSWORD),
    sessions,
    store,
    hub,
    worker,
    agent,
    modelService: fixture.service,
    modelVersion: () => 0,
    ...(routinesStore === undefined
      ? {}
      : { routines: { store: routinesStore, paused: options.routinesPaused === true } }),
    ...(watchersStore === undefined
      ? {}
      : {
          watchers: {
            store: watchersStore,
            ...(watchersRuntime === undefined ? {} : { runtime: watchersRuntime }),
            config: DEFAULT_WATCHERS_CONFIG,
          },
        }),
    ...(remindersStore === undefined ? {} : { reminders: remindersStore }),
    log: () => {},
  });

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { password: PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  const { token } = login.json() as { token: string };
  const headers = { authorization: `Bearer ${token}` };

  return {
    app,
    headers,
    routinesStore,
    watchersStore,
    remindersStore,
    deliveredMessages,
    async close() {
      await app.close();
      await watchersRuntime?.stop();
      routinesStore?.close();
      watchersStore?.close();
      remindersStore?.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
      await rm(fixture.directory, { recursive: true, force: true });
    },
  };
}

test("automations API requires auth and returns routines, watchers, digest, and reminders", async () => {
  const ctx = await startAutomationServer();
  try {
    const unauth = await ctx.app.inject({ method: "GET", url: "/api/v1/automations" });
    assert.equal(unauth.statusCode, 401);

    const now = new Date("2026-11-23T12:00:00.000Z");
    const routine = ctx.routinesStore!.create({
      chatId: "owner",
      title: "每日科技简报",
      timezone: "Asia/Shanghai",
      mode: "agent",
      brief: "总结今天重要 AI 发布",
      delivery: "report",
      schedule: { kind: "daily", at: "09:00" },
      now,
    });
    // Another chat's routine must never leak or be mutable
    const foreignRoutine = ctx.routinesStore!.create({
      chatId: "stranger",
      title: "外部任务",
      timezone: "Asia/Shanghai",
      mode: "notify",
      text: "hi",
      delivery: "always",
      schedule: { kind: "daily", at: "10:00" },
      now,
    });
    ctx.routinesStore!.enqueueManual(routine.id, now);

    const { watcherId, sourceId } = ctx.watchersStore!.create({
      chatId: "owner",
      kind: "feed",
      target: "https://example.com/rss.xml",
      label: "AI 博客订阅",
      location: "https://example.com/rss.xml",
      mode: "poll",
      intervalSec: 600,
      deliveryMode: "triage",
      triagePrompt: "只关注模型发布和开源框架更新",
      now: now.toISOString(),
    });
    // Establish baseline check so subsequent events enter the outbox
    ctx.watchersStore!.finish(sourceId, { events: [] }, now.toISOString(), now.toISOString());
    // Seed a queued digest item on this watcher
    ctx.watchersStore!.ingest(sourceId, {
      dedupKey: "post-1",
      kind: "feed",
      occurredAt: now.toISOString(),
      facts: { title: "New release v2.0" },
      text: "AI 博客订阅：New release v2.0",
    }, now.toISOString());
    const pending = ctx.watchersStore!.pending(10);
    assert.equal(pending.length, 1);
    assert.equal(ctx.watchersStore!.claimOutbox(pending[0]!.id), true);
    ctx.watchersStore!.queueDigest(pending[0]!.id, "AI 博客发布了 v2.0 更新", "非紧急版本更新", false, now.toISOString());

    const reminder = ctx.remindersStore!.create({
      chatId: "owner",
      ownerId: "owner",
      content: "周五下午准备演示文稿",
      triggerAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      timezone: "Asia/Shanghai",
    }).reminder;

    const listRes = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/automations",
      headers: ctx.headers,
    });
    assert.equal(listRes.statusCode, 200);
    const body = listRes.json() as {
      routines: { enabled: boolean; paused: boolean; items: { id: number; recentRuns: unknown[] }[] };
      watchers: {
        enabled: boolean;
        quietHours: string | null;
        digestTime: string;
        timezone: string;
        items: { id: number; triagePrompt: string | null }[];
        digest: { items: { id: number; text: string }[] };
      };
      reminders: { enabled: boolean; items: { id: number; content: string }[] };
    };

    assert.equal(body.routines.enabled, true);
    assert.equal(body.routines.paused, false);
    assert.equal(body.routines.items.length, 1);
    assert.equal(body.routines.items[0]!.id, routine.id);
    assert.equal(body.routines.items[0]!.recentRuns.length, 1);

    assert.equal(body.watchers.enabled, true);
    assert.equal(body.watchers.quietHours, "23:00-08:00");
    assert.equal(body.watchers.digestTime, "08:30");
    assert.equal(body.watchers.items.length, 1);
    assert.equal(body.watchers.items[0]!.id, watcherId);
    assert.equal(body.watchers.items[0]!.triagePrompt, "只关注模型发布和开源框架更新");
    assert.equal(body.watchers.digest.items.length, 1);
    assert.match(body.watchers.digest.items[0]!.text, /v2\.0/);

    assert.equal(body.reminders.enabled, true);
    assert.equal(body.reminders.items.length, 1);
    assert.equal(body.reminders.items[0]!.id, reminder.id);

    // Foreign routine cannot be mutated or deleted
    const foreignPause = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/routines/${foreignRoutine.id}/pause`,
      headers: ctx.headers,
    });
    assert.equal(foreignPause.statusCode, 404);

    // Pause -> run-now rejected (409) -> resume -> run-now ok -> delete
    const pauseRes = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/routines/${routine.id}/pause`,
      headers: ctx.headers,
    });
    assert.equal(pauseRes.statusCode, 200);
    assert.equal((pauseRes.json() as { routine: { status: string } }).routine.status, "paused");

    const runWhilePaused = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/routines/${routine.id}/run-now`,
      headers: ctx.headers,
    });
    assert.equal(runWhilePaused.statusCode, 409);

    const resumeRes = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/routines/${routine.id}/resume`,
      headers: ctx.headers,
    });
    assert.equal(resumeRes.statusCode, 200);
    assert.equal((resumeRes.json() as { routine: { status: string } }).routine.status, "active");

    const runNowRes = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/routines/${routine.id}/run-now`,
      headers: ctx.headers,
    });
    assert.equal(runNowRes.statusCode, 200);
    assert.equal((runNowRes.json() as { run: { trigger: string } }).run.trigger, "manual");

    const deleteRes = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/routines/${routine.id}`,
      headers: ctx.headers,
    });
    assert.equal(deleteRes.statusCode, 200);
    assert.equal((deleteRes.json() as { deleted: boolean }).deleted, true);

    const deleteAgain = await ctx.app.inject({
      method: "DELETE",
      url: `/api/v1/routines/${routine.id}`,
      headers: ctx.headers,
    });
    assert.equal(deleteAgain.statusCode, 404);

    // Flush watch digest
    const flushRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/watchers/digest/flush",
      headers: ctx.headers,
    });
    assert.equal(flushRes.statusCode, 200);
    assert.equal((flushRes.json() as { count: number }).count, 1);
    assert.equal(ctx.deliveredMessages.length, 1);
    assert.equal(ctx.watchersStore!.queuedDigest("owner", 10).length, 0);

    // Stop watcher
    const stopRes = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/watchers/${watcherId}/stop`,
      headers: ctx.headers,
    });
    assert.equal(stopRes.statusCode, 200);
    assert.equal((stopRes.json() as { stopped: boolean }).stopped, true);

    const stopAgain = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/watchers/${watcherId}/stop`,
      headers: ctx.headers,
    });
    assert.equal(stopAgain.statusCode, 404);

    // Cancel reminder
    const cancelRes = await ctx.app.inject({
      method: "POST",
      url: `/api/v1/reminders/${reminder.id}/cancel`,
      headers: ctx.headers,
    });
    assert.equal(cancelRes.statusCode, 200);
    assert.equal((cancelRes.json() as { reminder: { status: string } }).reminder.status, "cancelled");

    // Invalid IDs return 400
    const badId = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/routines/abc/pause",
      headers: ctx.headers,
    });
    assert.equal(badId.statusCode, 400);
  } finally {
    await ctx.close();
  }
});

test("automations API handles disabled stores cleanly", async () => {
  const ctx = await startAutomationServer({ withStores: false });
  try {
    const listRes = await ctx.app.inject({
      method: "GET",
      url: "/api/v1/automations",
      headers: ctx.headers,
    });
    assert.equal(listRes.statusCode, 200);
    const body = listRes.json() as {
      routines: { enabled: boolean; items: unknown[] };
      watchers: { enabled: boolean; items: unknown[]; digest: { items: unknown[] } };
      reminders: { enabled: boolean; items: unknown[] };
    };
    assert.equal(body.routines.enabled, false);
    assert.equal(body.watchers.enabled, false);
    assert.equal(body.reminders.enabled, false);

    const pauseRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/routines/1/pause",
      headers: ctx.headers,
    });
    assert.equal(pauseRes.statusCode, 503);

    const stopRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/watchers/1/stop",
      headers: ctx.headers,
    });
    assert.equal(stopRes.statusCode, 503);

    const flushRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/watchers/digest/flush",
      headers: ctx.headers,
    });
    assert.equal(flushRes.statusCode, 503);

    const cancelRes = await ctx.app.inject({
      method: "POST",
      url: "/api/v1/reminders/1/cancel",
      headers: ctx.headers,
    });
    assert.equal(cancelRes.statusCode, 503);
  } finally {
    await ctx.close();
  }
});

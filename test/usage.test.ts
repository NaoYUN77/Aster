import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { WebConfig } from "../src/config.js";
import { hashPassword, SessionStore } from "../src/http/auth.js";
import { EventHub } from "../src/http/events.js";
import { createWebServer } from "../src/http/server.js";
import { WebRequestStore } from "../src/http/store.js";
import { RequestWorker } from "../src/http/worker.js";
import { SubagentManager } from "../src/subagents/index.js";
import { UsageLedger, type DailyBudgetCrossedEvent } from "../src/usage/index.js";
import { fakeAgent, fixtureSelection } from "./http-testkit.js";

const DAY_MS = 24 * 60 * 60 * 1000;

test("UsageLedger records all 5 sources, computes totals/cacheHitRate/costUsd and builds 1d/7d/30d trends", () => {
  const ledger = new UsageLedger({ dbPath: ":memory:", timezone: "Asia/Shanghai" });
  const now = Date.parse("2026-11-22T08:30:00Z"); // 2026-11-22 16:30 Asia/Shanghai (bucket 15h)

  try {
    // Today (main + subagent + compaction)
    ledger.record({
      timestamp: now - 60_000,
      source: "main",
      conversationId: "1",
      provider: "gateway",
      modelId: "claude-sonnet-4-6",
      inputTokens: 4_000,
      outputTokens: 1_000,
      cacheReadTokens: 15_000,
      cacheWriteTokens: 1_000,
      totalTokens: 21_000,
      costUsd: 0.045,
    });
    ledger.record({
      timestamp: now - 30_000,
      source: "subagent",
      conversationId: "2",
      subagentId: "sub_abc",
      provider: "gateway",
      modelId: "gpt-5.4",
      inputTokens: 2_000,
      outputTokens: 500,
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
      totalTokens: 3_000,
      costUsd: 0.015,
    });
    ledger.record({
      timestamp: now - 10_000,
      source: "compaction",
      conversationId: "1",
      provider: "gateway",
      modelId: "claude-sonnet-4-6",
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1_500,
      costUsd: null,
    });

    // 2 days ago (dreaming)
    ledger.record({
      timestamp: now - 2 * DAY_MS,
      source: "dreaming",
      conversationId: "3",
      provider: "gateway",
      modelId: "claude-sonnet-4-6",
      inputTokens: 3_000,
      outputTokens: 1_000,
      cacheReadTokens: 2_000,
      cacheWriteTokens: 0,
      totalTokens: 6_000,
      costUsd: 0.02,
    });

    // 10 days ago (routine)
    ledger.record({
      timestamp: now - 10 * DAY_MS,
      source: "routine",
      conversationId: "4",
      provider: "gateway",
      modelId: "gpt-5.4",
      inputTokens: 1_500,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2_000,
      costUsd: 0.01,
    });

    const summary1d = ledger.querySummary("1d", {
      now,
      resolveContextWindow: (_p, m) => (m === "claude-sonnet-4-6" ? 200_000 : 128_000),
      activeModel: { provider: "gateway", modelId: "claude-sonnet-4-6", contextWindow: 200_000 },
    });
    assert.equal(summary1d.range, "1d");
    assert.equal(summary1d.totals.calls, 3);
    assert.equal(summary1d.totals.totalTokens, 25_500);
    assert.equal(summary1d.totals.costUsd, 0.06);
    assert.equal(summary1d.trend.length, 8);
    // 16:30 Asia/Shanghai falls into 15h bucket (index 5)
    assert.equal(summary1d.trend[5]!.key, "15h");
    assert.equal(summary1d.trend[5]!.totalTokens, 25_500);
    // Cache hit rate: 15500 / (7000 + 15500 + 1000) = 15500 / 23500 ≈ 0.66
    assert.equal(summary1d.totals.cacheHitRate, 0.66);
    // Context occupancy reflects the last main call
    assert.equal(summary1d.contextOccupancy.usedTokens, 21_000);
    assert.equal(summary1d.contextOccupancy.contextWindow, 200_000);
    assert.equal(summary1d.contextOccupancy.ratio, 0.105);
    assert.equal(summary1d.contextOccupancy.modelId, "claude-sonnet-4-6");

    const summary7d = ledger.querySummary("7d", { now });
    assert.equal(summary7d.totals.calls, 4);
    assert.equal(summary7d.totals.totalTokens, 31_500);
    assert.equal(summary7d.trend.length, 7);
    assert.equal(summary7d.trend[6]!.label, "今日");
    assert.equal(summary7d.trend[6]!.totalTokens, 25_500);
    assert.equal(summary7d.bySource.length, 4);
    assert.equal(summary7d.bySource[0]!.source, "main");
    assert.equal(summary7d.byModel.length, 2);
    assert.equal(summary7d.byModel[0]!.modelId, "claude-sonnet-4-6");

    const summary30d = ledger.querySummary("30d", { now });
    assert.equal(summary30d.totals.calls, 5);
    assert.equal(summary30d.totals.totalTokens, 33_500);
    assert.equal(summary30d.trend.length, 6);
    assert.equal(summary30d.bySource.length, 5);
  } finally {
    ledger.close();
  }
});

test("UsageLedger leaves costUsd null when upstream provides no cost metadata", () => {
  const ledger = new UsageLedger({ dbPath: ":memory:", timezone: "UTC" });
  try {
    ledger.record({
      source: "main",
      provider: "custom",
      modelId: "local-llama",
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1_200,
      costUsd: 0,
    });
    const summary = ledger.querySummary("1d");
    assert.equal(summary.totals.costUsd, null);
    assert.equal(summary.bySource[0]!.costUsd, null);
    assert.equal(summary.byModel[0]!.costUsd, null);
  } finally {
    ledger.close();
  }
});

test("UsageLedger persists across reopen, hydrates last main context, and supports resetMainContext", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-usage-persist-"));
  const dbPath = join(dir, "usage.sqlite");
  try {
    const first = new UsageLedger({ dbPath, timezone: "UTC" });
    first.record({
      source: "main",
      provider: "gateway",
      modelId: "claude-sonnet-4-6",
      inputTokens: 10_000,
      outputTokens: 2_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 12_000,
    });
    first.setDailyTokenBudget(500_000);
    first.close();

    const reopened = new UsageLedger({ dbPath, timezone: "UTC" });
    try {
      const summary = reopened.querySummary("7d", {
        resolveContextWindow: () => 200_000,
      });
      assert.equal(summary.contextOccupancy.usedTokens, 12_000);
      assert.equal(summary.contextOccupancy.ratio, 0.06);
      assert.equal(summary.budget.dailyTokenBudget, 500_000);

      reopened.resetMainContext();
      const afterReset = reopened.querySummary("7d", {
        activeModel: { provider: "gateway", modelId: "claude-sonnet-4-6", contextWindow: 200_000 },
      });
      assert.equal(afterReset.contextOccupancy.usedTokens, 0);
      assert.equal(afterReset.contextOccupancy.ratio, 0);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UsageLedger triggers soft daily budget alert at most once per local calendar day", () => {
  const alerts: DailyBudgetCrossedEvent[] = [];
  const ledger = new UsageLedger({
    dbPath: ":memory:",
    timezone: "Asia/Shanghai",
    onDailyBudgetCrossed: (event) => alerts.push(event),
  });
  const day1 = Date.parse("2026-11-22T02:00:00Z"); // 2026-11-22 10:00 +08
  const day2 = Date.parse("2026-11-23T02:00:00Z"); // 2026-11-23 10:00 +08

  try {
    ledger.setDailyTokenBudget(10_000, day1);

    const r1 = ledger.record({
      timestamp: day1,
      source: "main",
      provider: "gateway",
      modelId: "m1",
      inputTokens: 6_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 7_000,
    });
    assert.equal(r1.crossedDailyBudget, undefined);
    assert.equal(alerts.length, 0);

    // Crosses 10,000 -> emits once
    const r2 = ledger.record({
      timestamp: day1 + 60_000,
      source: "subagent",
      provider: "gateway",
      modelId: "m1",
      inputTokens: 4_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 5_000,
    });
    assert.equal(r2.crossedDailyBudget?.date, "2026-11-22");
    assert.equal(r2.crossedDailyBudget?.todayTokens, 12_000);
    assert.equal(alerts.length, 1);

    // Another call on the same local day does NOT re-trigger
    const r3 = ledger.record({
      timestamp: day1 + 120_000,
      source: "main",
      provider: "gateway",
      modelId: "m1",
      inputTokens: 3_000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 3_500,
    });
    assert.equal(r3.crossedDailyBudget, undefined);
    assert.equal(alerts.length, 1);

    // Next local calendar day crossing triggers again
    const r4 = ledger.record({
      timestamp: day2,
      source: "main",
      provider: "gateway",
      modelId: "m1",
      inputTokens: 10_500,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 11_000,
    });
    assert.equal(r4.crossedDailyBudget?.date, "2026-11-23");
    assert.equal(alerts.length, 2);

    // Clearing budget sets dailyTokenBudget to null
    const cleared = ledger.setDailyTokenBudget(null, day2);
    assert.equal(cleared.dailyTokenBudget, null);
  } finally {
    ledger.close();
  }
});

test("SubagentManager records sub-agent token usage into standalone UsageLedger even after SQLite cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-subagent-usage-"));
  const workspace = join(dir, "workspace");
  const ledger = new UsageLedger({ dbPath: join(dir, "usage.sqlite"), timezone: "UTC" });
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const manager = new SubagentManager({
    dataDir: dir,
    workspace,
    models,
    defaultModel: { provider: "faux", modelId: "m1" },
    usageLedger: ledger,
    log: () => {},
  });

  try {
    faux.setResponses([fauxAssistantMessage("Sub-agent audit complete.")]);
    const spawned = await manager.spawn({
      task: "Run quick audit",
      mode: "wait",
    });
    assert.equal(spawned.mode, "wait");
    assert.equal(spawned.result.status, "completed");

    // Disposable sub-agent SQLite is deleted (ADR-0005)...
    const leftovers = await readdir(join(dir, "subagents"));
    assert.deepEqual(leftovers, []);

    // ...yet standalone usage ledger retains the sub-agent's generation record (ADR-0007).
    const summary = ledger.querySummary("1d");
    assert.equal(summary.totals.calls, 1);
    assert.equal(summary.bySource.length, 1);
    assert.equal(summary.bySource[0]!.source, "subagent");
    assert.equal(summary.byModel[0]!.provider, "faux");
    assert.equal(summary.byModel[0]!.modelId, "m1");
  } finally {
    await manager.close();
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP /api/v1/usage and /api/v1/usage/budget enforce auth, validate inputs, and persist budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-usage-http-"));
  const fixture = await fixtureSelection();
  const store = new WebRequestStore(join(dir, "web.sqlite"));
  const sessions = new SessionStore(store.database, 60 * 60 * 1000);
  const hub = new EventHub(() => {});
  const ledger = new UsageLedger({ dbPath: join(dir, "usage.sqlite"), timezone: "Asia/Shanghai" });
  ledger.record({
    source: "main",
    provider: "gateway",
    modelId: "claude-sonnet-4-6",
    inputTokens: 12_000,
    outputTokens: 3_000,
    cacheReadTokens: 25_000,
    cacheWriteTokens: 0,
    totalTokens: 40_000,
    costUsd: 0.08,
  });

  const config: WebConfig = {
    port: 0,
    host: "127.0.0.1",
    allowedOrigins: ["http://localhost:5173"],
    sessionTtlDays: 30,
    staticDir: join(dir, "web-dist"),
    trustProxy: false,
  };
  const agent = fakeAgent({ service: fixture.service });
  const worker = new RequestWorker({ store, hub, ownerId: "owner", agent });
  const app = await createWebServer({
    config,
    ownerId: "owner",
    version: "test",
    auth: hashPassword("secret-pass"),
    sessions,
    store,
    hub,
    worker,
    agent,
    modelService: fixture.service,
    modelVersion: () => 1,
    usageLedger: ledger,
    usageContextInfo: () => ({
      resolveContextWindow: () => 200_000,
      activeModel: { provider: "gateway", modelId: "claude-sonnet-4-6", contextWindow: 200_000 },
    }),
    log: () => {},
  });

  try {
    const unauth = await app.inject({ method: "GET", url: "/api/v1/usage" });
    assert.equal(unauth.statusCode, 401);

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { password: "secret-pass" },
    });
    const token = (loginRes.json() as { token: string }).token;
    const headers = { authorization: `Bearer ${token}` };

    const badRange = await app.inject({ method: "GET", url: "/api/v1/usage?range=90d", headers });
    assert.equal(badRange.statusCode, 400);

    const okRes = await app.inject({ method: "GET", url: "/api/v1/usage?range=7d", headers });
    assert.equal(okRes.statusCode, 200);
    const body = okRes.json() as {
      range: string;
      totals: { totalTokens: number; calls: number };
      contextOccupancy: { usedTokens: number; contextWindow: number; ratio: number };
      budget: { dailyTokenBudget: number | null };
    };
    assert.equal(body.range, "7d");
    assert.equal(body.totals.totalTokens, 40_000);
    assert.equal(body.totals.calls, 1);
    assert.equal(body.contextOccupancy.usedTokens, 40_000);
    assert.equal(body.contextOccupancy.contextWindow, 200_000);
    assert.equal(body.contextOccupancy.ratio, 0.2);
    assert.equal(body.budget.dailyTokenBudget, null);

    const badBudget = await app.inject({
      method: "POST",
      url: "/api/v1/usage/budget",
      headers,
      payload: { dailyTokenBudget: -10 },
    });
    assert.equal(badBudget.statusCode, 400);

    const setBudget = await app.inject({
      method: "POST",
      url: "/api/v1/usage/budget",
      headers,
      payload: { dailyTokenBudget: 500_000 },
    });
    assert.equal(setBudget.statusCode, 200);
    assert.equal((setBudget.json() as { budget: { dailyTokenBudget: number } }).budget.dailyTokenBudget, 500_000);

    const clearBudget = await app.inject({
      method: "POST",
      url: "/api/v1/usage/budget",
      headers,
      payload: { dailyTokenBudget: null },
    });
    assert.equal(clearBudget.statusCode, 200);
    assert.equal((clearBudget.json() as { budget: { dailyTokenBudget: number | null } }).budget.dailyTokenBudget, null);
  } finally {
    await app.close();
    hub.close();
    ledger.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

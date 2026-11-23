import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { readWatchersConfig } from "../src/config.js";
import { AgentGate } from "../src/http/agent-gate.js";
import { SubagentManager } from "../src/subagents/index.js";
import { personalTools } from "../src/tools.js";
import { createWebExtension } from "../src/web-tools.js";
import {
  createSubagentWatchTriageRunner,
  createWatchers,
  isDigestDue,
  isInQuietHours,
  parseTriageDecisions,
  resolveTriageModelRef,
  type WatchTriageRunner,
} from "../src/watchers/index.js";
import { SqliteWatchStore } from "../src/watchers/store.js";
import type { WatchersConfig } from "../src/watchers/protocol.js";

function testWatchConfig(overrides: Partial<WatchersConfig> = {}): WatchersConfig {
  return { ...readWatchersConfig({}), ...overrides };
}

test("Quiet Hours, Digest schedule, model ref, and readWatchersConfig parsing", () => {
  // Overnight quiet hours 23:00-08:00 in Asia/Shanghai (+08:00)
  assert.equal(isInQuietHours(new Date("2026-11-23T15:30:00Z"), "Asia/Shanghai", "23:00-08:00"), true);  // 23:30
  assert.equal(isInQuietHours(new Date("2026-11-23T23:30:00Z"), "Asia/Shanghai", "23:00-08:00"), true);  // 07:30
  assert.equal(isInQuietHours(new Date("2026-11-24T00:00:00Z"), "Asia/Shanghai", "23:00-08:00"), false); // 08:00
  assert.equal(isInQuietHours(new Date("2026-11-24T06:00:00Z"), "Asia/Shanghai", "23:00-08:00"), false); // 14:00
  assert.equal(isInQuietHours(new Date("2026-11-23T15:30:00Z"), "Asia/Shanghai", "off"), false);
  assert.equal(isInQuietHours(new Date("2026-11-23T15:30:00Z"), "Asia/Shanghai", null), false);

  // Same-day window 12:00-14:00
  assert.equal(isInQuietHours(new Date("2026-11-24T05:00:00Z"), "Asia/Shanghai", "12:00-14:00"), true);  // 13:00
  assert.equal(isInQuietHours(new Date("2026-11-24T06:00:00Z"), "Asia/Shanghai", "12:00-14:00"), false); // 14:00

  // Daily digest due once per local date at/after 08:30
  assert.deepEqual(isDigestDue(new Date("2026-11-24T00:29:00Z"), "Asia/Shanghai", "08:30", undefined), {
    due: false,
    dateKey: "2026-11-24",
  });
  assert.deepEqual(isDigestDue(new Date("2026-11-24T00:30:00Z"), "Asia/Shanghai", "08:30", undefined), {
    due: true,
    dateKey: "2026-11-24",
  });
  assert.deepEqual(isDigestDue(new Date("2026-11-24T01:00:00Z"), "Asia/Shanghai", "08:30", "2026-11-24"), {
    due: false,
    dateKey: "2026-11-24",
  });

  // Model ref parser
  assert.deepEqual(resolveTriageModelRef("openai/gpt-4.1-mini", "deepseek"), { provider: "openai", modelId: "gpt-4.1-mini" });
  assert.deepEqual(resolveTriageModelRef("deepseek-chat", "deepseek"), { provider: "deepseek", modelId: "deepseek-chat" });
  assert.equal(resolveTriageModelRef("", "deepseek"), undefined);

  // Config defaults and overrides
  const defaults = readWatchersConfig({});
  assert.equal(defaults.quietHours, "23:00-08:00");
  assert.equal(defaults.digestTime, "08:30");
  assert.equal(defaults.triageTimeoutMs, 45_000);

  const custom = readWatchersConfig({
    WATCH_QUIET_HOURS: "off",
    WATCH_DIGEST_TIME: "09:15",
    WATCH_TRIAGE_MODEL: "openai/gpt-4.1-mini",
    WATCH_TRIAGE_TIMEOUT_MS: "30000",
  });
  assert.equal(custom.quietHours, null);
  assert.equal(custom.digestTime, "09:15");
  assert.equal(custom.triageModel, "openai/gpt-4.1-mini");
  assert.equal(custom.triageTimeoutMs, 30_000);

  assert.throws(() => readWatchersConfig({ WATCH_QUIET_HOURS: "bad" }));
  assert.throws(() => readWatchersConfig({ WATCH_DIGEST_TIME: "25:99" }));
});

test("Batch Sub-agent triage locks tools to read-only, injects MEMORY.md preferences, and routes notify/digest/suppress", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-watch-triage-e2e-"));
  const workspace = join(dir, "workspace");
  const store = new SqliteWatchStore(join(dir, "watchers.sqlite"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m1" }, { id: "light-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);

  const webExt = createWebExtension({
    deepseekApiKey: "test-key",
    fetch: async () => new Response(JSON.stringify({ title: "T", content: "C" }), { status: 200 }),
  });

  const manager = new SubagentManager({
    dataDir: dir,
    workspace,
    models,
    defaultModel: { provider: "faux", modelId: "m1" },
    extensions: [CodingTools, personalTools, webExt],
    log: () => {},
  });

  const delivered: Array<{ text: string; key: string | undefined }> = [];
  let currentTime = new Date("2026-11-24T02:00:00Z"); // 10:00 Asia/Shanghai (daytime)

  const watchers = createWatchers({
    store,
    config: testWatchConfig({
      timezone: "Asia/Shanghai",
      quietHours: "23:00-08:00",
      digestTime: "08:30",
    }),
    chatId: "owner",
    now: () => currentTime,
    deliver: async (_chatId, text, _threadTs, _sig, key) => {
      delivered.push({ text, key });
      return `msg-${delivered.length}`;
    },
    triage: createSubagentWatchTriageRunner({
      subagents: () => manager,
      renderMemoryCore: async () => "## MEMORY.md\nOwner focuses on AI Agent architecture and security releases.",
      triageModel: "faux/light-1",
      defaultProvider: "faux",
      timeoutMs: 10_000,
    }),
    log: () => {},
  });

  try {
    // Seed a watcher in default triage mode with custom triagePrompt, finish baseline, then ingest 3 new events.
    const { watcherId, sourceId } = store.create({
      chatId: "owner",
      kind: "feed",
      target: "https://example.com/feed.xml",
      label: "Tech Blog",
      location: "https://example.com/feed.xml",
      mode: "poll",
      intervalSec: 600,
      triagePrompt: "Only notify immediately for major model releases or security fixes.",
      now: "2026-11-24T01:00:00Z",
    });
    store.finish(sourceId, { events: [] }, "2026-11-24T01:00:00Z", "2026-11-24T05:00:00Z");

    store.ingest(sourceId, {
      dedupKey: "e1",
      kind: "feed",
      occurredAt: "2026-11-24T01:30:00Z",
      facts: { title: "Critical CVE in Agent Runtime", url: "https://example.com/cve" },
      text: "Critical CVE in Agent Runtime https://example.com/cve",
    }, "2026-11-24T01:30:00Z");
    store.ingest(sourceId, {
      dedupKey: "e2",
      kind: "feed",
      occurredAt: "2026-11-24T01:31:00Z",
      facts: { title: "Case Study: Company X", url: "https://example.com/case" },
      text: "Case Study: Company X https://example.com/case",
    }, "2026-11-24T01:31:00Z");
    store.ingest(sourceId, {
      dedupKey: "e3",
      kind: "feed",
      occurredAt: "2026-11-24T01:32:00Z",
      facts: { title: "Office Snacks Weekly", url: "https://example.com/snacks" },
      text: "Office Snacks Weekly https://example.com/snacks",
    }, "2026-11-24T01:32:00Z");

    const pending = store.pending(10);
    assert.equal(pending.length, 3);

    let triageCalls = 0;
    let seenTools: string[] = [];
    let seenPromptText = "";

    faux.setResponses([
      (transcript) => {
        triageCalls += 1;
        seenTools = getCurrentTools(transcript.messages).map((t) => t.name).sort();
        seenPromptText = JSON.stringify(transcript.messages);
        return fauxAssistantMessage(JSON.stringify([
          {
            outboxId: pending[0]!.id,
            action: "notify",
            urgent: true,
            summary: "安全预警：Agent Runtime 曝高危 CVE，建议尽快排查 https://example.com/cve",
            reason: "Matches security release priority",
          },
          {
            outboxId: pending[1]!.id,
            action: "digest",
            urgent: false,
            summary: "案例研究：Company X 实践经验 https://example.com/case",
            reason: "Non-urgent reading",
          },
          {
            outboxId: pending[2]!.id,
            action: "suppress",
            urgent: false,
            summary: "",
            reason: "Off-topic noise",
          },
        ]));
      },
    ]);

    // Mark today's digest already sent so this daytime tick only runs triage.
    store.setMeta("last_digest_date:owner", "2026-11-24");

    await watchers.tickOnce(new AbortController().signal);

    // All 3 events from the same watcher must be batched into 1 Sub-agent call!
    assert.equal(triageCalls, 1);
    // Strict read-only lock cage: ONLY web_fetch + current_time (NO read, NO bash, NO write, NO tool_search).
    assert.deepEqual(seenTools, ["current_time", "web_fetch"]);
    // Owner preferences and custom filter injected safely.
    assert.match(seenPromptText, /<owner-preferences>/);
    assert.match(seenPromptText, /AI Agent architecture and security releases/);
    assert.match(seenPromptText, /Only notify immediately for major model releases/);

    // Only event 1 was delivered immediately with the rewritten summary.
    assert.equal(delivered.length, 1);
    assert.match(delivered[0]!.text, /高危 CVE/);

    // Event 2 is queued for digest; event 3 is suppressed.
    const queued = store.queuedDigest("owner", 10);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.id, pending[1]!.id);
    assert.equal(queued[0]!.watcherId, watcherId);
    assert.match(queued[0]!.text, /Company X/);

    // watch_digest tool lists the queued item and can flush it on demand.
    const digestTool = watchers.extension!.tools!.find((t) => t.name === "watch_digest")!;
    const listOut = await digestTool.execute(
      { action: "list" },
      { conversationId: 1, taskId: 1, callId: "d1" } as ToolExecutionApi,
      BACKGROUND_CONTEXT,
    );
    assert.match((listOut.output![0] as { text: string }).text, /Company X/);

    faux.setResponses([fauxAssistantMessage("【监控简报】今天有一条值得看的案例：Company X 实践经验 https://example.com/case")]);
    const flushOut = await digestTool.execute(
      { action: "flush" },
      { conversationId: 1, taskId: 2, callId: "d2" } as ToolExecutionApi,
      BACKGROUND_CONTEXT,
    );
    const flushText = (flushOut.output![0] as { text: string }).text;
    assert.match(flushText, /Flushed 1 queued watch digest item/);
    assert.match(flushText, /监控简报/);
    // Tool flush returns digest text directly to the active reply without re-entering host delivery.
    assert.equal(delivered.length, 1);
    assert.equal(store.queuedDigest("owner", 10).length, 0);
  } finally {
    await watchers.stop();
    await manager.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("watch_digest(flush) inside an active AgentGate turn never deadlocks on host delivery (E2E-03 regression)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-watch-flush-gate-"));
  const store = new SqliteWatchStore(join(dir, "watchers.sqlite"));
  const gate = new AgentGate();
  const hostDelivered: string[] = [];

  const watchers = createWatchers({
    store,
    config: testWatchConfig({
      timezone: "Asia/Shanghai",
      quietHours: null,
      digestTime: "08:30",
    }),
    chatId: "owner",
    now: () => new Date("2026-11-24T02:00:00Z"),
    // Mirrors WebHostDelivery.send(), which acquires AgentGate!
    deliver: async (_chatId, text) => {
      return await gate.run(async () => {
        hostDelivered.push(text);
        return `msg-${hostDelivered.length}`;
      });
    },
    triage: {
      async triageBatch({ items }) {
        return items.map((item) => ({
          outboxId: item.outboxId,
          action: "digest",
          urgent: false,
          summary: `Queued: ${item.text}`,
          reason: "non-urgent",
        }));
      },
      async summarizeDigest({ items }) {
        return `汇总 ${items.length} 条：${items.map((i) => i.text).join("; ")}`;
      },
    },
    log: () => {},
  });

  try {
    store.setMeta("last_digest_date:owner", "2026-11-24");
    const { sourceId } = store.create({
      chatId: "owner",
      kind: "feed",
      target: "https://example.com/gate.xml",
      label: "Gate",
      location: "https://example.com/gate.xml",
      mode: "poll",
      intervalSec: 600,
      now: "2026-11-24T01:00:00Z",
    });
    store.finish(sourceId, { events: [] }, "2026-11-24T01:00:00Z", "2026-11-24T10:00:00Z");
    store.ingest(sourceId, {
      dedupKey: "g1",
      kind: "feed",
      occurredAt: "2026-11-24T01:10:00Z",
      facts: {},
      text: "Item Alpha",
    }, "2026-11-24T01:10:00Z");
    store.ingest(sourceId, {
      dedupKey: "g2",
      kind: "feed",
      occurredAt: "2026-11-24T01:11:00Z",
      facts: {},
      text: "Item Beta",
    }, "2026-11-24T01:11:00Z");

    await watchers.tickOnce(new AbortController().signal);
    assert.equal(store.queuedDigest("owner", 10).length, 2);

    // Hold AgentGate (exactly as RequestWorker does during an active chat turn) and call watch_digest(flush).
    const digestTool = watchers.extension!.tools!.find((t) => t.name === "watch_digest")!;
    const out = await gate.run(async () =>
      digestTool.execute(
        { action: "flush" },
        { conversationId: 1, taskId: 1, callId: "flush-in-turn" } as ToolExecutionApi,
        BACKGROUND_CONTEXT,
      ),
    );
    const outputText = (out.output![0] as { text: string }).text;
    assert.match(outputText, /Flushed 2 queued watch digest item/);
    assert.match(outputText, /汇总 2 条/);
    assert.match(outputText, /Item Alpha/);
    assert.match(outputText, /Item Beta/);
    assert.equal(store.queuedDigest("owner", 10).length, 0);
    assert.equal(hostDelivered.length, 0);
  } finally {
    await watchers.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Quiet Hours downgrades non-urgent notify to digest while urgent breaks through, and daily digest flushes once at 08:30", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-watch-quiet-digest-"));
  const store = new SqliteWatchStore(join(dir, "watchers.sqlite"));
  const delivered: Array<{ text: string; key: string | undefined }> = [];
  let currentTime = new Date("2026-11-23T15:30:00Z"); // 23:30 Asia/Shanghai (IN quiet hours)
  let digestSummaries = 0;

  const stubTriage: WatchTriageRunner = {
    async triageBatch({ items }) {
      return items.map((item) => ({
        outboxId: item.outboxId,
        action: "notify",
        urgent: item.text.includes("URGENT"),
        summary: `Triaged: ${item.text}`,
        reason: item.text.includes("URGENT") ? "critical" : "normal update",
      }));
    },
    async summarizeDigest({ items }) {
      digestSummaries += 1;
      return `早报汇总（${items.length} 条）：${items.map((i) => i.text).join(" | ")}`;
    },
  };

  const watchers = createWatchers({
    store,
    config: testWatchConfig({
      timezone: "Asia/Shanghai",
      quietHours: "23:00-08:00",
      digestTime: "08:30",
    }),
    chatId: "owner",
    now: () => currentTime,
    deliver: async (_chatId, text, _threadTs, _sig, key) => {
      delivered.push({ text, key });
      return `msg-${delivered.length}`;
    },
    triage: stubTriage,
    log: () => {},
  });

  try {
    const { sourceId } = store.create({
      chatId: "owner",
      kind: "feed",
      target: "https://example.com/news.xml",
      label: "News",
      location: "https://example.com/news.xml",
      mode: "poll",
      intervalSec: 600,
      now: "2026-11-23T14:00:00Z",
    });
    store.finish(sourceId, { events: [] }, "2026-11-23T14:00:00Z", "2026-11-24T10:00:00Z");
    store.setMeta("last_digest_date:owner", "2026-11-23");

    store.ingest(sourceId, {
      dedupKey: "q1",
      kind: "feed",
      occurredAt: "2026-11-23T15:20:00Z",
      facts: {},
      text: "Normal midnight article",
    }, "2026-11-23T15:20:00Z");
    store.ingest(sourceId, {
      dedupKey: "q2",
      kind: "feed",
      occurredAt: "2026-11-23T15:25:00Z",
      facts: {},
      text: "URGENT production outage alert",
    }, "2026-11-23T15:25:00Z");

    await watchers.tickOnce(new AbortController().signal);

    // Urgent broke through quiet hours; normal notify was auto-downgraded into queued_digest!
    assert.equal(delivered.length, 1);
    assert.match(delivered[0]!.text, /URGENT production outage alert/);
    const queued = store.queuedDigest("owner", 10);
    assert.equal(queued.length, 1);
    assert.match(queued[0]!.triageReason ?? "", /quiet_hours/);

    // Next morning 08:29 -> digest not due yet.
    currentTime = new Date("2026-11-24T00:29:00Z");
    await watchers.tickOnce(new AbortController().signal);
    assert.equal(delivered.length, 1);
    assert.equal(digestSummaries, 0);

    // At 08:30 -> daily digest fires once!
    currentTime = new Date("2026-11-24T00:30:00Z");
    await watchers.tickOnce(new AbortController().signal);
    assert.equal(delivered.length, 2);
    assert.equal(digestSummaries, 1);
    assert.match(delivered[1]!.text, /早报汇总（1 条）/);
    assert.equal(store.queuedDigest("owner", 10).length, 0);

    // At 08:35 -> does NOT fire again on the same day.
    currentTime = new Date("2026-11-24T00:35:00Z");
    await watchers.tickOnce(new AbortController().signal);
    assert.equal(delivered.length, 2);
    assert.equal(digestSummaries, 1);

    // Next day 08:30 with empty queue -> 0 LLM calls, nothing delivered.
    currentTime = new Date("2026-11-25T00:30:00Z");
    await watchers.tickOnce(new AbortController().signal);
    assert.equal(delivered.length, 2);
    assert.equal(digestSummaries, 1);
  } finally {
    await watchers.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Direct mode bypasses triage, and triage failure degrades GitHub directly while retrying then digesting feeds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-watch-fallback-"));
  const store = new SqliteWatchStore(join(dir, "watchers.sqlite"));
  const delivered: string[] = [];
  let triageAttempts = 0;

  const failingTriage: WatchTriageRunner = {
    async triageBatch() {
      triageAttempts += 1;
      throw new Error("Upstream model unavailable");
    },
    async summarizeDigest() {
      throw new Error("Upstream model unavailable");
    },
  };

  const watchers = createWatchers({
    store,
    config: testWatchConfig({
      timezone: "Asia/Shanghai",
      quietHours: null,
      digestTime: "08:30",
    }),
    chatId: "owner",
    now: () => new Date("2026-11-24T02:00:00Z"),
    deliver: async (_chatId, text) => {
      delivered.push(text);
      return `msg-${delivered.length}`;
    },
    triage: failingTriage,
    log: () => {},
  });

  try {
    store.setMeta("last_digest_date:owner", "2026-11-24");

    // 1. Direct watcher bypasses triage completely.
    const direct = store.create({
      chatId: "owner",
      kind: "feed",
      target: "https://example.com/direct.xml",
      label: "Direct",
      location: "https://example.com/direct.xml",
      mode: "poll",
      intervalSec: 600,
      deliveryMode: "direct",
      now: "2026-11-24T01:00:00Z",
    });
    store.finish(direct.sourceId, { events: [] }, "2026-11-24T01:00:00Z", "2026-11-24T10:00:00Z");
    store.ingest(direct.sourceId, {
      dedupKey: "d1",
      kind: "feed",
      occurredAt: "2026-11-24T01:10:00Z",
      facts: {},
      text: "Direct raw alert",
    }, "2026-11-24T01:10:00Z");

    await watchers.tickOnce(new AbortController().signal);
    assert.equal(triageAttempts, 0);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0]!, /Direct raw alert/);

    // 2. GitHub triage watcher degrades immediately to direct delivery on triage error.
    const gh = store.create({
      chatId: "owner",
      kind: "github_run",
      target: "octo/repo",
      label: "CI",
      location: "octo/repo",
      mode: "push",
      intervalSec: 900,
      now: "2026-11-24T01:00:00Z",
    });
    store.finish(gh.sourceId, { events: [] }, "2026-11-24T01:00:00Z", "2026-11-24T10:00:00Z");
    store.ingest(gh.sourceId, {
      dedupKey: "gh1",
      kind: "github_run",
      occurredAt: "2026-11-24T01:20:00Z",
      facts: { conclusion: "failure" },
      text: "CI failed on main",
    }, "2026-11-24T01:20:00Z");

    await watchers.tickOnce(new AbortController().signal);
    assert.equal(triageAttempts, 1);
    assert.equal(delivered.length, 2);
    assert.match(delivered[1]!, /CI failed on main/);

    // 3. Feed triage watcher retries twice then falls back into queued_digest on 3rd attempt (never spams).
    const feed = store.create({
      chatId: "owner",
      kind: "feed",
      target: "https://example.com/noisy.xml",
      label: "Noisy",
      location: "https://example.com/noisy.xml",
      mode: "poll",
      intervalSec: 600,
      now: "2026-11-24T01:00:00Z",
    });
    store.finish(feed.sourceId, { events: [] }, "2026-11-24T01:00:00Z", "2026-11-24T10:00:00Z");
    store.ingest(feed.sourceId, {
      dedupKey: "f1",
      kind: "feed",
      occurredAt: "2026-11-24T01:30:00Z",
      facts: {},
      text: "Noisy post",
    }, "2026-11-24T01:30:00Z");

    await watchers.tickOnce(new AbortController().signal); // attempt 1 -> requeued
    assert.equal(store.pending(10).length, 1);
    assert.equal(store.queuedDigest("owner", 10).length, 0);

    await watchers.tickOnce(new AbortController().signal); // attempt 2 -> requeued
    assert.equal(store.pending(10).length, 1);
    assert.equal(store.queuedDigest("owner", 10).length, 0);

    await watchers.tickOnce(new AbortController().signal); // attempt 3 -> fallback to queued_digest
    assert.equal(store.pending(10).length, 0);
    assert.equal(store.queuedDigest("owner", 10).length, 1);
    assert.equal(delivered.length, 2); // still never spammed!
  } finally {
    await watchers.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SqliteWatchStore cleanly migrates legacy pre-triage schema without data loss", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aster-watch-migrate-"));
  const dbPath = join(dir, "watchers.sqlite");

  // Create legacy tables without delivery_mode / triage_prompt / triage_* columns.
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE watchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      thread_ts TEXT,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      max_events_per_hour INTEGER NOT NULL DEFAULT 10,
      created_at TEXT NOT NULL,
      stopped_at TEXT
    );
    CREATE TABLE sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watcher_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      location TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      interval_sec INTEGER NOT NULL,
      next_check_at TEXT,
      reconcile_at TEXT,
      etag TEXT,
      last_modified TEXT,
      cursor TEXT,
      failures INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_check_at TEXT,
      UNIQUE(watcher_id)
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      dedup_key TEXT NOT NULL,
      delivery_id TEXT,
      kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      facts TEXT NOT NULL,
      UNIQUE(source_id, dedup_key)
    );
    CREATE TABLE outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watcher_id INTEGER NOT NULL,
      event_id INTEGER NOT NULL UNIQUE,
      chat_id TEXT NOT NULL,
      thread_ts TEXT,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      message_id TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      failure_code TEXT
    );
    INSERT INTO watchers (chat_id, kind, target, label, status, created_at)
    VALUES ('owner', 'feed', 'https://legacy.example/rss', 'Legacy', 'active', '2026-11-01T00:00:00Z');
    INSERT INTO sources (watcher_id, kind, location, mode, status, interval_sec)
    VALUES (1, 'feed', 'https://legacy.example/rss', 'poll', 'active', 600);
  `);
  raw.close();

  const store = new SqliteWatchStore(dbPath);
  try {
    const listed = store.list("owner");
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.deliveryMode, "triage");
    assert.equal(listed[0]!.triagePrompt, null);
    store.setMeta("last_digest_date:owner", "2026-11-24");
    assert.equal(store.meta("last_digest_date:owner"), "2026-11-24");
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseTriageDecisions strips markdown fences and rejects missing or malformed decisions", () => {
  const item = {
    outboxId: 7,
    eventId: 3,
    watcher: {
      id: 1,
      chatId: "owner",
      threadTs: null,
      kind: "feed" as const,
      target: "https://example.com/rss",
      label: "Blog",
      status: "active",
      maxEventsPerHour: 10,
      deliveryMode: "triage" as const,
      triagePrompt: null,
      createdAt: "2026-11-24T00:00:00Z",
      stoppedAt: null,
    },
    text: "Raw title",
    facts: {},
    createdAt: "2026-11-24T00:00:00Z",
  };
  const parsed = parseTriageDecisions(
    '```json\n[{"outboxId": 7, "action": "digest", "urgent": true, "summary": "Clean summary", "reason": "worth reading"}]\n```',
    [item],
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]!.action, "digest");
  // urgent is normalized to false unless action === "notify"
  assert.equal(parsed[0]!.urgent, false);
  assert.equal(parsed[0]!.summary, "Clean summary");

  assert.throws(() => parseTriageDecisions("[]", [item]), /missing decision/);
  assert.throws(() => parseTriageDecisions('[{"outboxId": 7, "action": "invalid"}]', [item]), /Invalid triage action/);
});

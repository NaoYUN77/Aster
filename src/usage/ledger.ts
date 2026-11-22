import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type UsageSource = "main" | "subagent" | "dreaming" | "routine" | "compaction";
export type UsageRange = "1d" | "7d" | "30d";

export type UsageRecordInput = {
  readonly timestamp?: number;
  readonly source: UsageSource;
  readonly conversationId?: string;
  readonly subagentId?: string;
  readonly provider: string;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
  /** Upstream / catalog USD estimate; omit or pass null/0 if unavailable. */
  readonly costUsd?: number | null;
  readonly stopReason?: string;
  readonly durationMs?: number;
};

export type ContextOccupancySnapshot = {
  readonly usedTokens: number;
  readonly contextWindow: number | null;
  readonly ratio: number | null;
  readonly provider: string | null;
  readonly modelId: string | null;
  readonly updatedAt: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
};

export type UsageTotals = {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly cacheHitRate: number | null;
  readonly costUsd: number | null;
};

export type UsageTrendPoint = {
  readonly key: string;
  readonly label: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number | null;
};

export type UsageBySourceItem = {
  readonly source: UsageSource;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly share: number;
  readonly costUsd: number | null;
};

export type UsageByModelItem = {
  readonly provider: string;
  readonly modelId: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheHitRate: number | null;
  readonly totalTokens: number;
  readonly share: number;
  readonly costUsd: number | null;
};

export type UsageCallItem = {
  readonly id: number;
  readonly timestamp: number;
  readonly source: UsageSource;
  readonly subagentId: string | null;
  readonly provider: string;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number | null;
  readonly durationMs: number | null;
  readonly contextWindow: number | null;
};

export type UsageBudgetState = {
  readonly dailyTokenBudget: number | null;
  readonly todayTokens: number;
  readonly lastAlertDate: string | null;
};

export type UsageSummaryResponse = {
  readonly range: UsageRange;
  readonly timezone: string;
  readonly contextOccupancy: ContextOccupancySnapshot;
  readonly totals: UsageTotals;
  readonly trend: UsageTrendPoint[];
  readonly bySource: UsageBySourceItem[];
  readonly byModel: UsageByModelItem[];
  readonly availableModels: { readonly provider: string; readonly modelId: string }[];
  readonly recentCalls: UsageCallItem[];
  readonly budget: UsageBudgetState;
};

export type DailyBudgetCrossedEvent = {
  readonly date: string;
  readonly todayTokens: number;
  readonly budgetTokens: number;
};

export type UsageLedgerOptions = {
  /** SQLite path (or `:memory:` for unit tests). */
  readonly dbPath: string;
  /** IANA timezone for local calendar day bucketing. Defaults to UTC. */
  readonly timezone?: string;
  /** Fired at most once per local calendar day when today's total crosses dailyTokenBudget. */
  readonly onDailyBudgetCrossed?: (event: DailyBudgetCrossedEvent) => void;
};

type UsageRow = {
  readonly id: number;
  readonly timestamp: number;
  readonly local_date: string;
  readonly source: UsageSource;
  readonly subagent_id: string | null;
  readonly provider: string;
  readonly model_id: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly reasoning_tokens: number;
  readonly total_tokens: number;
  readonly cost_usd: number | null;
  readonly duration_ms: number | null;
};

const BUDGET_KEY = "daily_token_budget";
const LAST_ALERT_DATE_KEY = "last_alert_date";
const DAY_MS = 24 * 60 * 60 * 1000;

function nonNegInt(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.trunc(value);
}

function formatLocalDate(timestamp: number, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(timestamp));
    const y = parts.find((p) => p.type === "year")?.value ?? "1970";
    const m = parts.find((p) => p.type === "month")?.value ?? "01";
    const d = parts.find((p) => p.type === "day")?.value ?? "01";
    return `${y}-${m}-${d}`;
  } catch {
    return new Date(timestamp).toISOString().slice(0, 10);
  }
}

function localHourOf(timestamp: number, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date(timestamp));
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    return Number.isFinite(h) ? h % 24 : 0;
  } catch {
    return new Date(timestamp).getUTCHours();
  }
}

function computeCacheHitRate(input: number, cacheRead: number, cacheWrite: number): number | null {
  const denom = input + cacheRead + cacheWrite;
  if (denom <= 0) return null;
  return Math.round((cacheRead / denom) * 1000) / 1000;
}

/**
 * Standalone durable token usage ledger (ADR-0007).
 *
 * Captures every model call across all execution sources (main, subagent, dreaming, routine,
 * compaction) so disposable sub-agent SQLite stores can be unlinked without losing usage history.
 */
export class UsageLedger {
  private readonly db: DatabaseSync;
  private readonly timezone: string;
  private readonly onDailyBudgetCrossed: ((event: DailyBudgetCrossedEvent) => void) | undefined;
  private lastMainContext: {
    usedTokens: number;
    provider: string;
    modelId: string;
    updatedAt: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
  } | null = null;
  private closed = false;

  constructor(options: UsageLedgerOptions) {
    if (options.dbPath !== ":memory:") {
      mkdirSync(dirname(options.dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(options.dbPath);
    this.timezone = options.timezone ?? "UTC";
    this.onDailyBudgetCrossed = options.onDailyBudgetCrossed;
    this.initSchema();
    this.hydrateLastMainContext();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS usage_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        local_date TEXT NOT NULL,
        source TEXT NOT NULL,
        conversation_id TEXT,
        subagent_id TEXT,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        cost_usd REAL,
        stop_reason TEXT,
        duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_usage_records_ts ON usage_records(timestamp);
      CREATE INDEX IF NOT EXISTS idx_usage_records_date ON usage_records(local_date, source);
      CREATE TABLE IF NOT EXISTS usage_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private hydrateLastMainContext(): void {
    const row = this.db.prepare(`
      SELECT timestamp, provider, model_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens
      FROM usage_records
      WHERE source = 'main' AND total_tokens > 0
      ORDER BY timestamp DESC, id DESC
      LIMIT 1
    `).get() as {
      timestamp: number;
      provider: string;
      model_id: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      reasoning_tokens: number;
      total_tokens: number;
    } | undefined;
    if (row !== undefined) {
      const used = row.total_tokens || (row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_write_tokens);
      this.lastMainContext = {
        usedTokens: used,
        provider: row.provider,
        modelId: row.model_id,
        updatedAt: row.timestamp,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        reasoningTokens: row.reasoning_tokens,
      };
    }
  }

  private getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM usage_settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setSetting(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare("DELETE FROM usage_settings WHERE key = ?").run(key);
    } else {
      this.db.prepare(`
        INSERT INTO usage_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, value);
    }
  }

  /** Record one completed LLM generation and evaluate optional daily budget threshold. */
  record(input: UsageRecordInput): { readonly crossedDailyBudget?: DailyBudgetCrossedEvent } {
    if (this.closed) return {};
    const timestamp = input.timestamp ?? Date.now();
    const localDate = formatLocalDate(timestamp, this.timezone);
    const inputTokens = nonNegInt(input.inputTokens);
    const outputTokens = nonNegInt(input.outputTokens);
    const cacheReadTokens = nonNegInt(input.cacheReadTokens);
    const cacheWriteTokens = nonNegInt(input.cacheWriteTokens);
    const reasoningTokens = nonNegInt(input.reasoningTokens);
    const computedTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    const totalTokens = nonNegInt(input.totalTokens) || computedTotal;
    const costUsd =
      typeof input.costUsd === "number" && Number.isFinite(input.costUsd) && input.costUsd > 0
        ? input.costUsd
        : null;

    this.db.prepare(`
      INSERT INTO usage_records (
        timestamp, local_date, source, conversation_id, subagent_id,
        provider, model_id, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, reasoning_tokens, total_tokens, cost_usd, stop_reason, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      timestamp,
      localDate,
      input.source,
      input.conversationId ?? null,
      input.subagentId ?? null,
      input.provider,
      input.modelId,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      totalTokens,
      costUsd,
      input.stopReason ?? null,
      input.durationMs !== undefined && Number.isFinite(input.durationMs) ? Math.trunc(input.durationMs) : null,
    );

    if (input.source === "main" && totalTokens > 0) {
      this.lastMainContext = {
        usedTokens: totalTokens,
        provider: input.provider,
        modelId: input.modelId,
        updatedAt: timestamp,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens,
      };
    }

    const budget = this.getBudgetSettings().dailyTokenBudget;
    if (budget !== null && budget > 0) {
      const todayTokens = this.sumTokensForDate(localDate);
      const lastAlertDate = this.getSetting(LAST_ALERT_DATE_KEY);
      if (todayTokens >= budget && lastAlertDate !== localDate) {
        this.setSetting(LAST_ALERT_DATE_KEY, localDate);
        const event: DailyBudgetCrossedEvent = {
          date: localDate,
          todayTokens,
          budgetTokens: budget,
        };
        this.onDailyBudgetCrossed?.(event);
        return { crossedDailyBudget: event };
      }
    }

    return {};
  }

  private sumTokensForDate(localDate: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(total_tokens), 0) AS total
      FROM usage_records
      WHERE local_date = ?
    `).get(localDate) as { total: number } | undefined;
    return row?.total ?? 0;
  }

  getBudgetSettings(now = Date.now()): UsageBudgetState {
    const raw = this.getSetting(BUDGET_KEY);
    const parsed = raw !== null ? Number(raw) : null;
    const dailyTokenBudget = parsed !== null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    const todayDate = formatLocalDate(now, this.timezone);
    return {
      dailyTokenBudget,
      todayTokens: this.sumTokensForDate(todayDate),
      lastAlertDate: this.getSetting(LAST_ALERT_DATE_KEY),
    };
  }

  setDailyTokenBudget(tokens: number | null, now = Date.now()): UsageBudgetState {
    if (tokens === null || tokens <= 0) {
      this.setSetting(BUDGET_KEY, null);
    } else {
      this.setSetting(BUDGET_KEY, String(Math.trunc(tokens)));
    }
    return this.getBudgetSettings(now);
  }

  querySummary(
    range: UsageRange,
    options: {
      readonly now?: number;
      readonly model?: string;
      readonly source?: UsageSource;
      readonly resolveContextWindow?: (provider: string, modelId: string) => number | null;
      readonly activeModel?: { readonly provider: string; readonly modelId: string; readonly contextWindow: number | null };
    } = {},
  ): UsageSummaryResponse {
    const now = options.now ?? Date.now();
    const todayDate = formatLocalDate(now, this.timezone);
    const days = range === "1d" ? 1 : range === "7d" ? 7 : 30;
    const sinceTs = now - days * DAY_MS;

    const rawRows = (
      range === "1d"
        ? this.db.prepare(`
            SELECT id, timestamp, local_date, source, subagent_id, provider, model_id,
                   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                   reasoning_tokens, total_tokens, cost_usd, duration_ms
            FROM usage_records
            WHERE local_date = ?
            ORDER BY timestamp ASC, id ASC
          `).all(todayDate)
        : this.db.prepare(`
            SELECT id, timestamp, local_date, source, subagent_id, provider, model_id,
                   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                   reasoning_tokens, total_tokens, cost_usd, duration_ms
            FROM usage_records
            WHERE timestamp >= ?
            ORDER BY timestamp ASC, id ASC
          `).all(sinceTs)
    ) as UsageRow[];

    const availableModelMap = new Map<string, { readonly provider: string; readonly modelId: string }>();
    for (const row of rawRows) {
      const key = `${row.provider}/${row.model_id}`;
      if (!availableModelMap.has(key)) {
        availableModelMap.set(key, { provider: row.provider, modelId: row.model_id });
      }
    }
    const availableModels = [...availableModelMap.values()];

    const modelFilter = options.model?.trim() || undefined;
    const sourceFilter = options.source;
    const rows = rawRows.filter((row) => {
      if (sourceFilter !== undefined && row.source !== sourceFilter) return false;
      if (modelFilter !== undefined && row.model_id !== modelFilter && `${row.provider}/${row.model_id}` !== modelFilter) {
        return false;
      }
      return true;
    });

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let reasoningTokens = 0;
    let totalTokens = 0;
    let costSum = 0;
    let hasCost = false;

    const sourceMap = new Map<UsageSource, {
      calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number; hasCost: boolean;
    }>();
    const modelMap = new Map<string, {
      provider: string; modelId: string; calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number; hasCost: boolean;
    }>();

    for (const row of rows) {
      inputTokens += row.input_tokens;
      outputTokens += row.output_tokens;
      cacheReadTokens += row.cache_read_tokens;
      cacheWriteTokens += row.cache_write_tokens;
      reasoningTokens += row.reasoning_tokens;
      totalTokens += row.total_tokens;
      if (row.cost_usd !== null && row.cost_usd > 0) {
        costSum += row.cost_usd;
        hasCost = true;
      }

      const src = sourceMap.get(row.source) ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, hasCost: false };
      src.calls += 1;
      src.input += row.input_tokens;
      src.output += row.output_tokens;
      src.cacheRead += row.cache_read_tokens;
      src.cacheWrite += row.cache_write_tokens;
      src.total += row.total_tokens;
      if (row.cost_usd !== null && row.cost_usd > 0) {
        src.cost += row.cost_usd;
        src.hasCost = true;
      }
      sourceMap.set(row.source, src);

      const mKey = `${row.provider}/${row.model_id}`;
      const mdl = modelMap.get(mKey) ?? {
        provider: row.provider, modelId: row.model_id, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, hasCost: false,
      };
      mdl.calls += 1;
      mdl.input += row.input_tokens;
      mdl.output += row.output_tokens;
      mdl.cacheRead += row.cache_read_tokens;
      mdl.cacheWrite += row.cache_write_tokens;
      mdl.total += row.total_tokens;
      if (row.cost_usd !== null && row.cost_usd > 0) {
        mdl.cost += row.cost_usd;
        mdl.hasCost = true;
      }
      modelMap.set(mKey, mdl);
    }

    const trend = this.buildTrend(range, rows, now);

    const bySource: UsageBySourceItem[] = [...sourceMap.entries()]
      .map(([source, agg]) => ({
        source,
        calls: agg.calls,
        inputTokens: agg.input,
        outputTokens: agg.output,
        cacheReadTokens: agg.cacheRead,
        cacheWriteTokens: agg.cacheWrite,
        totalTokens: agg.total,
        share: totalTokens > 0 ? Math.round((agg.total / totalTokens) * 1000) / 1000 : 0,
        costUsd: agg.hasCost ? Math.round(agg.cost * 10000) / 10000 : null,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const byModel: UsageByModelItem[] = [...modelMap.values()]
      .map((agg) => ({
        provider: agg.provider,
        modelId: agg.modelId,
        calls: agg.calls,
        inputTokens: agg.input,
        outputTokens: agg.output,
        cacheReadTokens: agg.cacheRead,
        cacheHitRate: computeCacheHitRate(agg.input, agg.cacheRead, agg.cacheWrite),
        totalTokens: agg.total,
        share: totalTokens > 0 ? Math.round((agg.total / totalTokens) * 1000) / 1000 : 0,
        costUsd: agg.hasCost ? Math.round(agg.cost * 10000) / 10000 : null,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const recentCalls: UsageCallItem[] = [...rows]
      .reverse()
      .slice(0, 20)
      .map((row) => ({
        id: row.id,
        timestamp: row.timestamp,
        source: row.source,
        subagentId: row.subagent_id,
        provider: row.provider,
        modelId: row.model_id,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        reasoningTokens: row.reasoning_tokens,
        totalTokens: row.total_tokens,
        costUsd: row.cost_usd !== null && row.cost_usd > 0 ? Math.round(row.cost_usd * 10000) / 10000 : null,
        durationMs: row.duration_ms,
        contextWindow: options.resolveContextWindow?.(row.provider, row.model_id) ?? null,
      }));

    const ctx = this.lastMainContext;
    const ctxProvider = ctx?.provider ?? options.activeModel?.provider ?? null;
    const ctxModelId = ctx?.modelId ?? options.activeModel?.modelId ?? null;
    const contextWindow =
      (ctxProvider && ctxModelId ? options.resolveContextWindow?.(ctxProvider, ctxModelId) : null)
      ?? options.activeModel?.contextWindow
      ?? null;
    const usedTokens = ctx?.usedTokens ?? 0;
    const ratio = contextWindow && contextWindow > 0
      ? Math.min(1, Math.round((usedTokens / contextWindow) * 1000) / 1000)
      : null;

    return {
      range,
      timezone: this.timezone,
      contextOccupancy: {
        usedTokens,
        contextWindow,
        ratio,
        provider: ctxProvider,
        modelId: ctxModelId,
        updatedAt: ctx?.updatedAt ?? null,
        inputTokens: ctx?.inputTokens ?? 0,
        outputTokens: ctx?.outputTokens ?? 0,
        cacheReadTokens: ctx?.cacheReadTokens ?? 0,
        cacheWriteTokens: ctx?.cacheWriteTokens ?? 0,
        reasoningTokens: ctx?.reasoningTokens ?? 0,
      },
      totals: {
        calls: rows.length,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens,
        totalTokens,
        cacheHitRate: computeCacheHitRate(inputTokens, cacheReadTokens, cacheWriteTokens),
        costUsd: hasCost ? Math.round(costSum * 10000) / 10000 : null,
      },
      trend,
      bySource,
      byModel,
      availableModels,
      recentCalls,
      budget: this.getBudgetSettings(now),
    };
  }

  private buildTrend(range: UsageRange, rows: readonly UsageRow[], now: number): UsageTrendPoint[] {
    if (range === "1d") {
      // 8 three-hour buckets across the local day: 00h, 03h, 06h, 09h, 12h, 15h, 18h, 21h
      const buckets = Array.from({ length: 8 }, (_, idx) => {
        const hour = String(idx * 3).padStart(2, "0");
        return {
          key: `${hour}h`,
          label: `${hour}h`,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          cost: 0,
          hasCost: false,
        };
      });
      for (const row of rows) {
        const idx = Math.min(7, Math.floor(localHourOf(row.timestamp, this.timezone) / 3));
        const b = buckets[idx]!;
        b.calls += 1;
        b.inputTokens += row.input_tokens;
        b.outputTokens += row.output_tokens;
        b.cacheReadTokens += row.cache_read_tokens;
        b.cacheWriteTokens += row.cache_write_tokens;
        b.totalTokens += row.total_tokens;
        if (row.cost_usd !== null && row.cost_usd > 0) {
          b.cost += row.cost_usd;
          b.hasCost = true;
        }
      }
      return buckets.map(({ cost, hasCost, ...rest }) => ({
        ...rest,
        costUsd: hasCost ? Math.round(cost * 10000) / 10000 : null,
      }));
    }

    if (range === "7d") {
      const bucketList: {
        key: string; label: string; calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; cost: number; hasCost: boolean;
      }[] = [];
      const byDate = new Map<string, typeof bucketList[number]>();
      for (let offset = 6; offset >= 0; offset--) {
        const dateStr = formatLocalDate(now - offset * DAY_MS, this.timezone);
        const label = offset === 0 ? "今日" : dateStr.slice(5).replace("-", "/");
        const entry = {
          key: dateStr, label, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0, hasCost: false,
        };
        bucketList.push(entry);
        byDate.set(dateStr, entry);
      }
      for (const row of rows) {
        const b = byDate.get(row.local_date);
        if (!b) continue;
        b.calls += 1;
        b.inputTokens += row.input_tokens;
        b.outputTokens += row.output_tokens;
        b.cacheReadTokens += row.cache_read_tokens;
        b.cacheWriteTokens += row.cache_write_tokens;
        b.totalTokens += row.total_tokens;
        if (row.cost_usd !== null && row.cost_usd > 0) {
          b.cost += row.cost_usd;
          b.hasCost = true;
        }
      }
      return bucketList.map(({ cost, hasCost, ...rest }) => ({
        ...rest,
        costUsd: hasCost ? Math.round(cost * 10000) / 10000 : null,
      }));
    }

    // 30d: 6 five-day buckets
    const buckets = Array.from({ length: 6 }, (_, idx) => {
      const startDayOffset = (5 - idx) * 5 + 4;
      const endDayOffset = (5 - idx) * 5;
      const startDate = formatLocalDate(now - startDayOffset * DAY_MS, this.timezone);
      const endDate = formatLocalDate(now - endDayOffset * DAY_MS, this.timezone);
      return {
        key: `${startDate}..${endDate}`,
        label: idx === 5 ? "近5日" : endDate.slice(5).replace("-", "/"),
        startTs: now - (startDayOffset + 1) * DAY_MS,
        endTs: now - endDayOffset * DAY_MS + DAY_MS,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        cost: 0,
        hasCost: false,
      };
    });
    for (const row of rows) {
      const ageDays = Math.max(0, Math.floor((now - row.timestamp) / DAY_MS));
      const idx = Math.max(0, Math.min(5, 5 - Math.floor(ageDays / 5)));
      const b = buckets[idx]!;
      b.calls += 1;
      b.inputTokens += row.input_tokens;
      b.outputTokens += row.output_tokens;
      b.cacheReadTokens += row.cache_read_tokens;
      b.cacheWriteTokens += row.cache_write_tokens;
      b.totalTokens += row.total_tokens;
      if (row.cost_usd !== null && row.cost_usd > 0) {
        b.cost += row.cost_usd;
        b.hasCost = true;
      }
    }
    return buckets.map(({ startTs: _s, endTs: _e, cost, hasCost, ...rest }) => ({
      ...rest,
      costUsd: hasCost ? Math.round(cost * 10000) / 10000 : null,
    }));
  }

  /** Clear the cached main-conversation context occupancy (e.g. after an explicit context reset). */
  resetMainContext(): void {
    this.lastMainContext = null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

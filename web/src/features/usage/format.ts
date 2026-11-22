import type { UsageRange, UsageSource } from "@/api/usage";

export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1_000) return String(Math.trunc(tokens));
  if (tokens < 1_000_000) {
    const val = tokens / 1_000;
    return `${val >= 100 ? val.toFixed(0) : val.toFixed(1).replace(/\.0$/, "")}K`;
  }
  if (tokens < 1_000_000_000) {
    const val = tokens / 1_000_000;
    return `${val >= 100 ? val.toFixed(0) : val.toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  const val = tokens / 1_000_000_000;
  return `${val.toFixed(2).replace(/\.?0+$/, "")}B`;
}

export function formatPercent(ratio: number | null, digits = 1): string {
  if (ratio === null || !Number.isFinite(ratio)) return "—";
  const pct = Math.max(0, Math.min(100, ratio * 100));
  if (digits <= 0) return `${Math.round(pct)}%`;
  return `${pct.toFixed(digits).replace(/\.0+$/, "")}%`;
}

export function formatUsd(costUsd: number | null): string {
  if (costUsd === null || !Number.isFinite(costUsd) || costUsd <= 0) return "—";
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  if (costUsd < 10) return `$${costUsd.toFixed(2)}`;
  return `$${costUsd.toFixed(1)}`;
}

const SOURCE_LABELS: Record<UsageSource, string> = {
  main: "对话",
  subagent: "后台子任务",
  dreaming: "记忆整理",
  routine: "定时任务",
  compaction: "上下文压缩",
};

export function formatSourceLabel(source: UsageSource): string {
  return SOURCE_LABELS[source] ?? source;
}

const RANGE_LABELS: Record<UsageRange, string> = {
  "1d": "今日",
  "7d": "最近 7 天",
  "30d": "最近 30 天",
};

export function formatRangeLabel(range: UsageRange): string {
  return RANGE_LABELS[range];
}

const RANGE_TREND_TITLE: Record<UsageRange, string> = {
  "1d": "分时用量",
  "7d": "每日用量",
  "30d": "阶段用量",
};

export function formatTrendTitle(range: UsageRange): string {
  return RANGE_TREND_TITLE[range];
}

/**
 * Compute a clean 4-step Y-axis ceiling and ticks (e.g. max 322K -> ceiling 400K, ticks [400K, 300K, 200K, 100K, 0]).
 */
export function computeChartAxis(maxValue: number): {
  ceiling: number;
  ticks: number[];
} {
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    return { ceiling: 4_000, ticks: [4_000, 3_000, 2_000, 1_000, 0] };
  }
  const rawStep = maxValue / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const niceNorm =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  const step = niceNorm * magnitude;
  const ceiling = step * 4;
  return {
    ceiling,
    ticks: [ceiling, step * 3, step * 2, step, 0],
  };
}

const MAX_BUDGET_TOKENS = 1_000_000_000;

/**
 * Parse a user-entered token budget like `"500k"`, `"1.5M"`, `"300000"`, or `""`.
 * Returns `null` when cleared, a positive integer when valid, or `"invalid"` otherwise.
 */
export function parseBudgetInput(raw: string): number | null | "invalid" {
  const trimmed = raw.trim().replace(/,/g, "");
  if (trimmed === "" || trimmed === "0") return null;
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(trimmed);
  if (!match) return "invalid";
  const num = Number(match[1]);
  if (!Number.isFinite(num) || num <= 0) return "invalid";
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1;
  const total = Math.round(num * multiplier);
  if (!Number.isSafeInteger(total) || total <= 0 || total > MAX_BUDGET_TOKENS) {
    return "invalid";
  }
  return total;
}

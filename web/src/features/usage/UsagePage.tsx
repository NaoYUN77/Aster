import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bell,
  Menu,
  RefreshCw,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  getUsageSummary,
  updateDailyTokenBudget,
  type UsageRange,
  type UsageSource,
  type UsageSummaryResponse,
  type UsageTrendPoint,
} from "@/api/usage";
import { useMobileNav } from "@/app/AppShell";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  formatCompactTokens,
  formatPercent,
  formatSourceLabel,
  formatTrendSubtitle,
  formatUsd,
  parseBudgetInput,
} from "./format";

const RANGE_OPTIONS: readonly { value: UsageRange; label: string }[] = [
  { value: "1d", label: "今日" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
];

const SOURCE_BAR_CLASS: Record<UsageSource, string> = {
  main: "bg-primary",
  subagent: "bg-sky-500 dark:bg-sky-400",
  dreaming: "bg-violet-500 dark:bg-violet-400",
  routine: "bg-emerald-500 dark:bg-emerald-400",
  compaction: "bg-amber-500 dark:bg-amber-400",
};

const MODEL_BAR_CLASSES = [
  "bg-primary",
  "bg-sky-500 dark:bg-sky-400",
  "bg-violet-500 dark:bg-violet-400",
  "bg-emerald-500 dark:bg-emerald-400",
  "bg-amber-500 dark:bg-amber-400",
] as const;

const BUDGET_PRESETS = [200_000, 500_000, 1_000_000] as const;

function occupancyFillClass(ratio: number | null): string {
  if (ratio === null) return "bg-primary";
  if (ratio >= 0.9) return "bg-destructive/80";
  if (ratio >= 0.75) return "bg-warning";
  return "bg-primary";
}

function TrendCard({
  range,
  trend,
}: {
  range: UsageRange;
  trend: UsageTrendPoint[];
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const maxTokens = Math.max(...trend.map((point) => point.totalTokens), 0);
  const activePoint =
    trend.find((point) => point.key === selectedKey) ??
    [...trend].reverse().find((point) => point.totalTokens > 0) ??
    null;

  return (
    <section className="flex flex-col rounded-3xl border border-border/80 bg-card p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">
          消耗趋势
        </h2>
        <span className="text-xs text-muted-foreground">
          {formatTrendSubtitle(range)}
        </span>
      </div>

      {maxTokens <= 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
          <p className="text-xs text-muted-foreground">该时段暂无模型调用记录</p>
        </div>
      ) : (
        <>
          <div
            className="mt-5 flex h-36 items-end justify-between gap-1.5 sm:gap-2"
            role="list"
            aria-label="Token 消耗趋势柱状图"
          >
            {trend.map((point) => {
              const heightPct =
                point.totalTokens > 0
                  ? Math.max(10, Math.round((point.totalTokens / maxTokens) * 100))
                  : 4;
              const isSelected = activePoint?.key === point.key;
              return (
                <button
                  key={point.key}
                  type="button"
                  onClick={() => setSelectedKey(point.key)}
                  onMouseEnter={() => setSelectedKey(point.key)}
                  className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5 focus:outline-none"
                  aria-label={`${point.label}：${formatCompactTokens(point.totalTokens)} Token`}
                >
                  <span
                    className={cn(
                      "truncate text-[10px] font-medium tabular-nums transition-colors",
                      isSelected
                        ? "text-foreground"
                        : "text-muted-foreground/80 group-hover:text-foreground",
                    )}
                  >
                    {point.totalTokens > 0 ? formatCompactTokens(point.totalTokens) : ""}
                  </span>
                  <div className="flex h-24 w-full items-end justify-center">
                    <div
                      className={cn(
                        "w-full max-w-[28px] rounded-t-lg transition-all duration-200",
                        point.totalTokens === 0
                          ? "bg-secondary"
                          : isSelected
                            ? "bg-primary"
                            : "bg-primary/65 group-hover:bg-primary/90",
                      )}
                      style={{ height: `${heightPct}%` }}
                    />
                  </div>
                  <span
                    className={cn(
                      "truncate text-[11px] tabular-nums transition-colors",
                      isSelected ? "font-medium text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {point.label}
                  </span>
                </button>
              );
            })}
          </div>

          {activePoint && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-secondary px-3.5 py-2 text-xs text-muted-foreground tabular-nums">
              <span className="font-medium text-foreground">
                {activePoint.label} · {formatCompactTokens(activePoint.totalTokens)}
              </span>
              <span>
                输入 {formatCompactTokens(activePoint.inputTokens)} · 输出{" "}
                {formatCompactTokens(activePoint.outputTokens)} · {activePoint.calls} 次
              </span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function BreakdownCard({ data }: { data: UsageSummaryResponse }) {
  const [tab, setTab] = useState<"source" | "model">("source");
  const isSource = tab === "source";
  const hasItems = isSource ? data.bySource.length > 0 : data.byModel.length > 0;

  return (
    <section className="flex flex-col rounded-3xl border border-border/80 bg-card p-5">
      <div className="flex items-center justify-between gap-2">
        <div
          className="inline-flex rounded-full bg-secondary p-0.5 text-xs"
          role="tablist"
          aria-label="拆解维度"
        >
          <button
            type="button"
            role="tab"
            aria-selected={isSource}
            onClick={() => setTab("source")}
            className={cn(
              "rounded-full px-3 py-1 font-medium transition-all",
              isSource
                ? "bg-card text-foreground shadow-2xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            按来源
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!isSource}
            onClick={() => setTab("model")}
            className={cn(
              "rounded-full px-3 py-1 font-medium transition-all",
              !isSource
                ? "bg-card text-foreground shadow-2xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            按模型
          </button>
        </div>
        <span className="text-xs text-muted-foreground">占比</span>
      </div>

      {!hasItems ? (
        <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
          <p className="text-xs text-muted-foreground">暂无消耗拆解数据</p>
        </div>
      ) : isSource ? (
        <div className="mt-4 space-y-3.5">
          {data.bySource.map((item) => {
            const pct = Math.max(0, Math.min(100, Math.round(item.share * 100)));
            return (
              <div key={item.source} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate font-medium text-foreground">
                    {formatSourceLabel(item.source)}
                    <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">
                      {item.calls} 次
                    </span>
                  </span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    <span className="font-medium text-foreground">
                      {formatCompactTokens(item.totalTokens)}
                    </span>{" "}
                    ({pct}%)
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all duration-300",
                      SOURCE_BAR_CLASS[item.source] ?? "bg-primary",
                    )}
                    style={{ width: `${Math.max(pct, item.totalTokens > 0 ? 2 : 0)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-4 space-y-3.5">
          {data.byModel.map((item, idx) => {
            const pct = Math.max(0, Math.min(100, Math.round(item.share * 100)));
            const barColor = MODEL_BAR_CLASSES[idx % MODEL_BAR_CLASSES.length]!;
            return (
              <div key={`${item.provider}/${item.modelId}`} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <div className="min-w-0 truncate">
                    <span className="font-medium text-foreground">{item.modelId}</span>
                    {item.cacheHitRate !== null && (
                      <span className="ml-1.5 text-muted-foreground tabular-nums">
                        命中 {formatPercent(item.cacheHitRate, 0)}
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    <span className="font-medium text-foreground">
                      {formatCompactTokens(item.totalTokens)}
                    </span>{" "}
                    ({pct}%)
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className={cn("h-full rounded-full transition-all duration-300", barColor)}
                    style={{ width: `${Math.max(pct, item.totalTokens > 0 ? 2 : 0)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function UsagePage() {
  const { openMobileNav } = useMobileNav();
  const queryClient = useQueryClient();
  const [range, setRange] = useState<UsageRange>("7d");
  const [budgetPanelOpen, setBudgetPanelOpen] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState("");

  const usageQuery = useQuery({
    queryKey: ["usage", range],
    queryFn: () => getUsageSummary(range),
    staleTime: 15_000,
  });

  const budgetValue = usageQuery.data?.budget.dailyTokenBudget ?? null;

  useEffect(() => {
    if (!budgetPanelOpen) return;
    setBudgetDraft(budgetValue === null ? "" : formatCompactTokens(budgetValue));
  }, [budgetPanelOpen, budgetValue]);

  const budgetMutation = useMutation({
    mutationFn: (dailyTokenBudget: number | null) =>
      updateDailyTokenBudget(dailyTokenBudget),
    onSuccess: (result) => {
      queryClient.setQueryData<UsageSummaryResponse>(
        ["usage", range],
        (prev) => (prev ? { ...prev, budget: result.budget } : prev),
      );
      void queryClient.invalidateQueries({ queryKey: ["usage"] });
      setBudgetPanelOpen(false);
      toast.success(
        result.budget.dailyTokenBudget === null
          ? "已关闭每日 Token 预警"
          : `每日 Token 预警已设为 ${formatCompactTokens(result.budget.dailyTokenBudget)}`,
      );
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "保存预警阈值失败");
    },
  });

  const handleBudgetSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = parseBudgetInput(budgetDraft);
    if (parsed === "invalid") {
      toast.error("请输入有效的正整数，如 500k、1.5M 或 300000");
      return;
    }
    budgetMutation.mutate(parsed);
  };

  const data = usageQuery.data;
  const ctx = data?.contextOccupancy;
  const ctxPct =
    ctx?.ratio !== null && ctx?.ratio !== undefined
      ? Math.max(0, Math.min(100, Math.round(ctx.ratio * 100)))
      : 0;
  const budget = data?.budget;
  const budgetReached =
    budget !== undefined &&
    budget.dailyTokenBudget !== null &&
    budget.todayTokens >= budget.dailyTokenBudget;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="shrink-0 border-b border-border bg-background/90 backdrop-blur safe-top">
        <div className="mx-auto flex min-h-14 w-full max-w-4xl flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap sm:px-6">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={openMobileNav}
              className="flex size-10 items-center justify-center rounded-full bg-secondary text-foreground md:hidden"
              aria-label="打开导航"
            >
              <Menu className="size-5" />
            </button>
            <h1 className="text-base font-semibold tracking-tight">用量</h1>
          </div>

          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
            <div
              className="inline-flex items-center rounded-full bg-secondary p-0.5 text-xs"
              role="tablist"
              aria-label="统计周期"
            >
              {RANGE_OPTIONS.map((opt) => {
                const active = range === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setRange(opt.value)}
                    className={cn(
                      "rounded-full px-2.5 py-1 font-medium transition-colors sm:px-3",
                      active
                        ? "bg-primary text-primary-foreground shadow-2xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => setBudgetPanelOpen((open) => !open)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors sm:px-3",
                budgetPanelOpen || budgetValue !== null
                  ? "border-border/80 bg-secondary text-foreground"
                  : "border-border/80 bg-card text-muted-foreground hover:text-foreground",
              )}
              title="配置每日 Token 软预警阈值"
            >
              <SlidersHorizontal className="size-3.5 shrink-0" />
              <span className="hidden tabular-nums sm:inline">
                {budgetValue !== null ? `预警 ${formatCompactTokens(budgetValue)}` : "日预警"}
              </span>
            </button>

            <button
              type="button"
              onClick={() => void usageQuery.refetch()}
              disabled={usageQuery.isFetching}
              className="flex size-8 items-center justify-center rounded-full border border-border/80 bg-card text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              aria-label="刷新用量"
              title="刷新用量"
            >
              <RefreshCw
                className={cn("size-3.5", usageQuery.isFetching && "animate-spin")}
              />
            </button>
          </div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl space-y-4 px-3 py-4 sm:px-6 sm:py-6">
          {/* Optional inline soft daily budget bar */}
          {budgetPanelOpen && (
            <section className="rounded-3xl border border-border/80 bg-card p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-1.5 text-sm font-semibold">
                    <Bell className="size-3.5 text-muted-foreground" />
                    <span>每日 Token 软预警</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    达到阈值时仅发送一次系统提醒，不会中止对话或任务。留空则关闭预警。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setBudgetPanelOpen(false)}
                  className="flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
                  aria-label="关闭预警设置"
                >
                  <X className="size-4" />
                </button>
              </div>

              <form
                onSubmit={handleBudgetSubmit}
                className="mt-3.5 flex flex-wrap items-center gap-2"
              >
                <input
                  type="text"
                  value={budgetDraft}
                  onChange={(event) => setBudgetDraft(event.target.value)}
                  placeholder="例如 500k、1.5M（留空关闭）"
                  className="h-9 min-w-[180px] flex-1 rounded-full border border-border/80 bg-background px-3.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none tabular-nums"
                />
                <div className="flex items-center gap-1.5">
                  {BUDGET_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setBudgetDraft(formatCompactTokens(preset))}
                      className="h-8 rounded-full bg-secondary px-2.5 text-xs font-medium text-muted-foreground tabular-nums transition-colors hover:text-foreground"
                    >
                      {formatCompactTokens(preset)}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={budgetMutation.isPending}
                    className="h-9 rounded-full px-4 text-xs"
                  >
                    {budgetMutation.isPending ? <Spinner /> : "保存"}
                  </Button>
                  {budgetValue !== null && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={budgetMutation.isPending}
                      onClick={() => budgetMutation.mutate(null)}
                      className="h-9 rounded-full px-3.5 text-xs"
                    >
                      关闭预警
                    </Button>
                  )}
                </div>
              </form>
            </section>
          )}

          {usageQuery.isLoading ? (
            <div className="flex flex-col items-center justify-center gap-2.5 py-20 text-xs text-muted-foreground">
              <Spinner />
              <span>正在加载用量统计…</span>
            </div>
          ) : usageQuery.isError || !data ? (
            <div className="rounded-3xl border border-border/80 bg-card p-6 text-center space-y-3">
              <p className="text-sm font-medium text-foreground">无法加载用量统计</p>
              <p className="text-xs text-muted-foreground">
                {usageQuery.error instanceof Error
                  ? usageQuery.error.message
                  : "请稍后重试"}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void usageQuery.refetch()}
                className="rounded-full"
              >
                重试
              </Button>
            </div>
          ) : (
            <>
              {/* Context Occupancy Live Gauge */}
              <section className="rounded-3xl border border-border/80 bg-card px-5 py-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="size-2 shrink-0 rounded-full bg-primary" />
                    <span className="font-semibold text-foreground">
                      主对话上下文水位
                    </span>
                    {ctx?.modelId && (
                      <span className="truncate rounded-full bg-secondary px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                        {ctx.modelId}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 tabular-nums">
                    {ctx && (ctx.usedTokens > 0 || ctx.updatedAt !== null) ? (
                      <>
                        <span className="font-semibold text-foreground">
                          {formatCompactTokens(ctx.usedTokens)}
                        </span>
                        {ctx.contextWindow !== null && (
                          <span className="text-muted-foreground">
                            / {formatCompactTokens(ctx.contextWindow)} ({ctxPct}%)
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">尚未产生主对话上下文</span>
                    )}
                  </div>
                </div>

                <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all duration-300",
                      occupancyFillClass(ctx?.ratio ?? null),
                    )}
                    style={{
                      width: `${
                        ctx && ctx.usedTokens > 0 ? Math.max(2, ctxPct) : 0
                      }%`,
                    }}
                  />
                </div>

                {budget && budget.dailyTokenBudget !== null && (
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-xs text-muted-foreground tabular-nums">
                    <span>
                      今日累计 {formatCompactTokens(budget.todayTokens)} / 预警阈值{" "}
                      {formatCompactTokens(budget.dailyTokenBudget)}
                    </span>
                    {budgetReached && (
                      <span className="rounded-full bg-destructive/10 px-2.5 py-0.5 text-[11px] font-medium text-destructive">
                        今日已超阈值
                      </span>
                    )}
                  </div>
                )}
              </section>

              {/* 4 Compact Meta Muse KPI Cards */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-3xl bg-secondary p-4">
                  <div className="text-xs text-muted-foreground">总 Token</div>
                  <div className="mt-1.5 text-xl font-semibold tracking-tight text-foreground tabular-nums">
                    {formatCompactTokens(data.totals.totalTokens)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                    {data.totals.calls} 次调用
                  </div>
                </div>

                <div className="rounded-3xl bg-secondary p-4">
                  <div className="text-xs text-muted-foreground">输入 / 输出</div>
                  <div className="mt-1.5 text-base font-semibold tracking-tight text-foreground tabular-nums sm:text-lg">
                    {formatCompactTokens(data.totals.inputTokens)}{" "}
                    <span className="font-normal text-muted-foreground">/</span>{" "}
                    {formatCompactTokens(data.totals.outputTokens)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    含提示与回复
                  </div>
                </div>

                <div className="rounded-3xl bg-secondary p-4">
                  <div className="text-xs text-muted-foreground">缓存命中率</div>
                  <div
                    className={cn(
                      "mt-1.5 text-xl font-semibold tracking-tight tabular-nums",
                      data.totals.cacheHitRate !== null
                        ? "text-success"
                        : "text-muted-foreground",
                    )}
                  >
                    {formatPercent(data.totals.cacheHitRate)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                    {data.totals.cacheReadTokens > 0
                      ? `命中 ${formatCompactTokens(data.totals.cacheReadTokens)}`
                      : "暂无缓存命中"}
                  </div>
                </div>

                <div className="rounded-3xl bg-secondary p-4">
                  <div className="text-xs text-muted-foreground">估算费用</div>
                  <div
                    className={cn(
                      "mt-1.5 text-xl font-semibold tracking-tight tabular-nums",
                      data.totals.costUsd !== null
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {formatUsd(data.totals.costUsd)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {data.totals.costUsd !== null ? "按上游元数据" : "未返回计费信息"}
                  </div>
                </div>
              </div>

              {/* Lower Two-Column Grid: Trend + Breakdown */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <TrendCard range={range} trend={data.trend} />
                <BreakdownCard data={data} />
              </div>

              {/* Subtle Ledger Scope Note */}
              <div className="flex items-center justify-between gap-2 px-1 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Activity className="size-3.5 shrink-0" />
                  统计口径涵盖主对话、子任务、记忆整理、定时任务与上下文压缩
                </span>
                <span className="shrink-0 tabular-nums">{data.timezone}</span>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Menu,
  RefreshCw,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  getUsageSummary,
  updateDailyTokenBudget,
  type UsageCallItem,
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
  computeChartAxis,
  formatCompactTokens,
  formatPercent,
  formatRangeLabel,
  formatSourceLabel,
  formatTrendTitle,
  formatUsd,
  parseBudgetInput,
} from "./format";

const RANGE_OPTIONS: readonly { value: UsageRange; label: string }[] = [
  { value: "1d", label: "今日" },
  { value: "7d", label: "最近 7 天" },
  { value: "30d", label: "最近 30 天" },
];

const SOURCE_FILTER_OPTIONS: readonly { value: "" | UsageSource; label: string }[] = [
  { value: "", label: "全部来源" },
  { value: "main", label: "对话" },
  { value: "subagent", label: "后台子任务" },
  { value: "dreaming", label: "记忆整理" },
  { value: "routine", label: "定时任务" },
  { value: "compaction", label: "上下文压缩" },
];

const SOURCE_BAR_CLASS: Record<UsageSource, string> = {
  main: "bg-primary",
  subagent: "bg-sky-400/85 dark:bg-sky-400/75",
  dreaming: "bg-slate-400 dark:bg-zinc-400",
  routine: "bg-slate-400/75 dark:bg-zinc-500",
  compaction: "bg-slate-300 dark:bg-zinc-600",
};

const BUDGET_PRESETS = [200_000, 500_000, 1_000_000] as const;

type InspectedContext = {
  readonly subtitle: string;
  readonly isCustomSelection: boolean;
  readonly usedTokens: number;
  readonly contextWindow: number | null;
  readonly cacheReadTokens: number;
  readonly uncachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly updatedAt: number | null;
};

function StackedTrendChart({
  range,
  trend,
}: {
  range: UsageRange;
  trend: UsageTrendPoint[];
}) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const maxVal = Math.max(...trend.map((p) => p.totalTokens), 0);
  const { ceiling, ticks } = useMemo(() => computeChartAxis(maxVal), [maxVal]);
  const hovered = trend.find((p) => p.key === hoveredKey) ?? null;

  return (
    <section className="flex flex-col">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            {formatTrendTitle(range)}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            单位 token · 输入已包含缓存，避免重复计数
          </p>
        </div>
        <div className="flex items-center gap-3.5 pt-0.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-primary" />
            输入 (含缓存)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-slate-300 dark:bg-zinc-300" />
            输出
          </span>
        </div>
      </div>

      {maxVal <= 0 ? (
        <div className="mt-6 flex h-52 items-center justify-center rounded-xl border border-dashed border-border/70 text-xs text-muted-foreground">
          该时段暂无模型调用记录
        </div>
      ) : (
        <div className="mt-6">
          <div className="relative flex h-52">
            {/* Left Y-axis tick labels */}
            <div className="flex w-10 shrink-0 flex-col justify-between pb-6 pr-2 text-right text-[11px] text-muted-foreground/80 tabular-nums">
              {ticks.map((tick) => (
                <span key={tick} className="leading-none">
                  {tick === 0 ? "0" : formatCompactTokens(tick)}
                </span>
              ))}
            </div>

            {/* Gridlines + Stacked Bars */}
            <div className="relative flex flex-1 flex-col">
              {/* Background horizontal hairlines */}
              <div
                className="pointer-events-none absolute inset-x-0 top-0 bottom-6 flex flex-col justify-between"
                aria-hidden="true"
              >
                {ticks.map((tick) => (
                  <div
                    key={tick}
                    className={cn(
                      "w-full border-t",
                      tick === 0 ? "border-border/90" : "border-border/45",
                    )}
                  />
                ))}
              </div>

              {/* Bars */}
              <div
                className="relative z-10 flex flex-1 items-end justify-between gap-1.5 px-1 sm:gap-3 sm:px-3"
                role="list"
                aria-label="Token 消耗柱状图"
              >
                {trend.map((point) => {
                  const inputWithCache =
                    point.inputTokens + point.cacheReadTokens + point.cacheWriteTokens;
                  const total = point.totalTokens;
                  const totalPct = total > 0 ? Math.min(100, (total / ceiling) * 100) : 0;
                  const inputRatio = total > 0 ? Math.min(1, inputWithCache / total) : 0;
                  const outputRatio = Math.max(0, 1 - inputRatio);
                  const isHovered = hoveredKey === point.key;

                  return (
                    <button
                      key={point.key}
                      type="button"
                      onMouseEnter={() => setHoveredKey(point.key)}
                      onMouseLeave={() => setHoveredKey(null)}
                      onFocus={() => setHoveredKey(point.key)}
                      onBlur={() => setHoveredKey(null)}
                      onClick={() =>
                        setHoveredKey((prev) => (prev === point.key ? null : point.key))
                      }
                      className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end focus:outline-none"
                      aria-label={`${point.label}：${formatCompactTokens(total)} Token`}
                    >
                      <div className="flex w-full flex-1 flex-col items-center justify-end">
                        {total > 0 && (
                          <span
                            className={cn(
                              "mb-1 truncate text-[10px] font-medium tabular-nums transition-colors sm:text-[11px]",
                              isHovered
                                ? "text-foreground"
                                : "text-muted-foreground group-hover:text-foreground",
                            )}
                          >
                            {formatCompactTokens(total)}
                          </span>
                        )}
                        <div
                          className={cn(
                            "flex w-5 flex-col overflow-hidden rounded-t-[4px] transition-opacity sm:w-7",
                            hoveredKey !== null && !isHovered && "opacity-55",
                          )}
                          style={{
                            height: total > 0 ? `${Math.max(4, totalPct)}%` : "0%",
                          }}
                        >
                          {point.outputTokens > 0 && (
                            <div
                              className="w-full bg-slate-300 dark:bg-zinc-300"
                              style={{ height: `${Math.max(6, outputRatio * 100)}%` }}
                            />
                          )}
                          <div
                            className="w-full flex-1 bg-primary"
                            style={{ height: `${inputRatio * 100}%` }}
                          />
                        </div>
                      </div>
                      <span
                        className={cn(
                          "mt-2 h-4 truncate text-[11px] leading-4 tabular-nums transition-colors",
                          isHovered ? "font-medium text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {point.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Subtle hover readout */}
          <div className="mt-2 flex min-h-5 items-center justify-between text-[11px] text-muted-foreground tabular-nums">
            {hovered ? (
              <>
                <span className="font-medium text-foreground">
                  {hovered.label} · 总计 {formatCompactTokens(hovered.totalTokens)}
                </span>
                <span>
                  输入 {formatCompactTokens(hovered.inputTokens + hovered.cacheReadTokens + hovered.cacheWriteTokens)} · 输出{" "}
                  {formatCompactTokens(hovered.outputTokens)} · {hovered.calls} 次
                </span>
              </>
            ) : (
              <span className="text-muted-foreground/70">悬停或点击柱条查看该时段明细</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function SourceBreakdownSection({
  range,
  data,
}: {
  range: UsageRange;
  data: UsageSummaryResponse;
}) {
  const totalInputWithCache =
    data.totals.inputTokens + data.totals.cacheReadTokens + data.totals.cacheWriteTokens;

  return (
    <section className="flex flex-col">
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-foreground">
          来源用量
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          与{formatRangeLabel(range)}总量一致（输入 + 输出）
        </p>
      </div>

      {data.bySource.length === 0 ? (
        <div className="mt-6 flex flex-1 items-center justify-center rounded-xl border border-dashed border-border/70 py-12 text-xs text-muted-foreground">
          暂无来源分布数据
        </div>
      ) : (
        <div className="mt-6 flex flex-1 flex-col justify-between">
          <div className="space-y-4">
            {data.bySource.map((item) => {
              const pct = Math.max(0, Math.min(100, Math.round(item.share * 100)));
              return (
                <div key={item.source} className="space-y-2">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-foreground">
                      {formatSourceLabel(item.source)}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {formatCompactTokens(item.totalTokens)}
                      </span>{" "}
                      <span className="ml-1 text-muted-foreground">{pct}%</span>
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all duration-300",
                        SOURCE_BAR_CLASS[item.source] ?? "bg-primary",
                      )}
                      style={{
                        width: `${Math.max(pct, item.totalTokens > 0 ? 2 : 0)}%`,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3 text-xs text-muted-foreground tabular-nums">
            <span>
              合计{" "}
              <span className="font-medium text-foreground">
                {formatCompactTokens(data.totals.totalTokens)}
              </span>
            </span>
            <span>
              输入 {formatCompactTokens(totalInputWithCache)} + 输出{" "}
              {formatCompactTokens(data.totals.outputTokens)}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}

function CallsTableSection({
  calls,
  selectedCallId,
  onSelectCall,
}: {
  calls: UsageCallItem[];
  selectedCallId: number | null;
  onSelectCall: (call: UsageCallItem) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // Rank by totalTokens descending so the highest-cost calls surface first, matching the reference.
  const ranked = useMemo(
    () => [...calls].sort((a, b) => b.totalTokens - a.totalTokens),
    [calls],
  );
  const visible = expanded ? ranked : ranked.slice(0, 3);
  const topCallId = ranked[0]?.id ?? null;

  return (
    <section className="flex flex-col">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            调用明细
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {ranked.length > 3 && !expanded
              ? "仅列出消耗较高的 3 项，不是全部调用"
              : `共 ${ranked.length} 条近期调用记录`}
          </p>
        </div>
        {ranked.length > 3 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs font-medium text-primary hover:underline"
          >
            {expanded ? "仅看前 3 项" : `展开全部 (${ranked.length})`}
          </button>
        )}
      </div>

      {ranked.length === 0 ? (
        <div className="mt-4 flex items-center justify-center rounded-xl border border-dashed border-border/70 py-10 text-xs text-muted-foreground">
          暂无调用明细
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[460px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-border/70 text-[11px] font-medium text-muted-foreground">
                <th className="py-2.5 pr-3 font-medium">来源</th>
                <th className="py-2.5 pr-3 font-medium">模型</th>
                <th className="py-2.5 pr-3 text-right font-medium">输入</th>
                <th className="py-2.5 pr-3 text-right font-medium">输出</th>
                <th className="py-2.5 pr-3 text-right font-medium">估算费用</th>
                <th className="py-2.5 text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {visible.map((call) => {
                const inputWithCache =
                  call.inputTokens + call.cacheReadTokens + call.cacheWriteTokens;
                const isSelected = selectedCallId === call.id;
                const isHighest = call.id === topCallId && ranked.length > 1;
                const label =
                  call.source === "subagent" && call.subagentId
                    ? `子任务 · ${call.subagentId.slice(0, 12)}`
                    : formatSourceLabel(call.source);

                return (
                  <tr
                    key={call.id}
                    onClick={() => onSelectCall(call)}
                    className={cn(
                      "cursor-pointer border-b border-border/50 transition-colors",
                      isSelected ? "bg-secondary/70" : "hover:bg-secondary/40",
                    )}
                  >
                    <td className="py-3 pr-3 font-medium text-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="truncate max-w-[140px]">{label}</span>
                        {isHighest && (
                          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            较高
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="py-3 pr-3 text-muted-foreground">
                      <span className="block max-w-[150px] truncate" title={call.modelId}>
                        {call.modelId}
                      </span>
                    </td>
                    <td className="py-3 pr-3 text-right tabular-nums text-foreground">
                      {formatCompactTokens(inputWithCache)}
                    </td>
                    <td className="py-3 pr-3 text-right tabular-nums text-foreground">
                      {formatCompactTokens(call.outputTokens)}
                    </td>
                    <td className="py-3 pr-3 text-right tabular-nums text-foreground">
                      {formatUsd(call.costUsd)}
                    </td>
                    <td className="py-3 text-right">
                      <span
                        className={cn(
                          "whitespace-nowrap text-xs font-medium",
                          isSelected ? "text-foreground" : "text-primary",
                        )}
                      >
                        {isSelected ? "当前查看" : "查看 Context"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-3 text-[11px] text-muted-foreground">
            点击任意调用行，即可在右侧检查该次请求的 Context 构成。
          </p>
        </div>
      )}
    </section>
  );
}

function ContextInspectorCard({
  inspected,
  onResetSelection,
}: {
  inspected: InspectedContext;
  onResetSelection: () => void;
}) {
  const [openRow, setOpenRow] = useState<string | null>("cache");

  const windowSize = inspected.contextWindow;
  const remaining =
    windowSize !== null ? Math.max(0, windowSize - inspected.usedTokens) : null;
  const denom =
    windowSize !== null && windowSize > 0
      ? Math.max(windowSize, inspected.usedTokens)
      : Math.max(1, inspected.usedTokens);

  const cachePct = (inspected.cacheReadTokens / denom) * 100;
  const uncachedPct = (inspected.uncachedInputTokens / denom) * 100;
  const outputPct = (inspected.outputTokens / denom) * 100;

  const breakdownRows = [
    {
      id: "cache",
      label: "缓存命中输入",
      tokens: inspected.cacheReadTokens,
      dot: "bg-primary",
      hint: "复用服务端前缀缓存的输入 Token（系统提示与历史前缀），可显著降低成本与延迟。",
    },
    {
      id: "uncached",
      label: "新增提示输入",
      tokens: inspected.uncachedInputTokens,
      dot: "bg-sky-400/85",
      hint: "本轮未命中缓存的新增输入与缓存写入（包含最新用户消息、文件与工具返回结果）。",
    },
    {
      id: "output",
      label:
        inspected.reasoningTokens > 0
          ? `本轮模型输出（含思考 ${formatCompactTokens(inspected.reasoningTokens)}）`
          : "本轮模型输出",
      tokens: inspected.outputTokens,
      dot: "bg-slate-300 dark:bg-zinc-400",
      hint: "该次请求生成的最终回复文本与工具调用参数。",
    },
  ];

  return (
    <section className="rounded-2xl border border-border/80 bg-card p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            单次请求 Context
          </h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {inspected.subtitle}
          </p>
        </div>
        {inspected.isCustomSelection && (
          <button
            type="button"
            onClick={onResetSelection}
            className="shrink-0 text-xs font-medium text-primary hover:underline"
          >
            回到主对话
          </button>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-baseline gap-2">
        <span className="text-base font-semibold tracking-tight text-foreground tabular-nums">
          {inspected.usedTokens > 0 || inspected.updatedAt !== null
            ? windowSize !== null
              ? `已用 ${formatCompactTokens(inspected.usedTokens)} / ${formatCompactTokens(windowSize)}`
              : `已用 ${formatCompactTokens(inspected.usedTokens)}`
            : "暂无单次请求记录"}
        </span>
        <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
          实测用量
        </span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        这是该次请求实际携带的内容，不是累计用量
      </p>

      {/* Segmented horizontal Context Bar */}
      <div className="mt-3.5 h-2 w-full overflow-hidden rounded-full bg-secondary">
        {inspected.usedTokens > 0 && (
          <div className="flex h-full w-full">
            {cachePct > 0 && (
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${cachePct}%` }}
              />
            )}
            {uncachedPct > 0 && (
              <div
                className="h-full bg-sky-400/85 transition-all duration-300"
                style={{ width: `${uncachedPct}%` }}
              />
            )}
            {outputPct > 0 && (
              <div
                className="h-full bg-slate-300 dark:bg-zinc-400 transition-all duration-300"
                style={{ width: `${outputPct}%` }}
              />
            )}
          </div>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>已用 {formatCompactTokens(inspected.usedTokens)}</span>
        {remaining !== null && <span>剩余 {formatCompactTokens(remaining)}</span>}
      </div>

      {/* Expandable Breakdown Rows */}
      <div className="mt-4 space-y-1.5 border-t border-border/60 pt-3">
        {breakdownRows.map((row) => {
          const isOpen = openRow === row.id;
          return (
            <div key={row.id}>
              <button
                type="button"
                onClick={() => setOpenRow(isOpen ? null : row.id)}
                className="flex w-full items-center justify-between gap-2 rounded-lg py-1 text-left text-xs transition-colors hover:bg-secondary/60"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {isOpen ? (
                    <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className={cn("size-1.5 shrink-0 rounded-full", row.dot)} />
                  <span className="truncate text-foreground">{row.label}</span>
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatCompactTokens(row.tokens)}
                </span>
              </button>
              {isOpen && (
                <p className="pb-1 pl-7 pr-2 text-[11px] leading-relaxed text-muted-foreground">
                  {row.hint}
                </p>
              )}
            </div>
          );
        })}

        {remaining !== null && (
          <div className="flex items-center justify-between gap-2 py-1 pl-5 text-xs text-muted-foreground/80">
            <span className="flex items-center gap-2">
              <span className="size-1.5 shrink-0 rounded-full bg-secondary" />
              <span>剩余窗口</span>
            </span>
            <span className="tabular-nums">{formatCompactTokens(remaining)}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function FilterDropdown<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
  maxWidthClass,
}: {
  ariaLabel: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
  maxWidthClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const currentLabel = options.find((opt) => opt.value === value)?.label ?? value;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-8 items-center justify-between gap-1.5 rounded-lg border border-border/80 bg-card px-2.5 text-xs font-medium leading-none text-foreground transition-colors hover:bg-secondary/70 focus:border-primary focus:outline-none",
          maxWidthClass,
        )}
      >
        <span className="truncate">{currentLabel}</span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className="absolute right-0 z-30 mt-1.5 min-w-[144px] max-w-[240px] rounded-xl border border-border/80 bg-popover p-1 shadow-lg"
        >
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value || "__all__"}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors",
                  active
                    ? "bg-secondary font-medium text-foreground"
                    : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                )}
              >
                <span className="truncate">{opt.label}</span>
                {active && <Check className="size-3.5 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function UsagePage() {
  const { openMobileNav } = useMobileNav();
  const queryClient = useQueryClient();
  const [range, setRange] = useState<UsageRange>("7d");
  const [modelFilter, setModelFilter] = useState<string>("");
  const [sourceFilter, setSourceFilter] = useState<"" | UsageSource>("");
  const [selectedCallId, setSelectedCallId] = useState<number | null>(null);
  const [budgetPanelOpen, setBudgetPanelOpen] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState("");

  const usageQuery = useQuery({
    queryKey: ["usage", range, modelFilter, sourceFilter],
    queryFn: () =>
      getUsageSummary(range, {
        ...(modelFilter ? { model: modelFilter } : {}),
        ...(sourceFilter ? { source: sourceFilter } : {}),
      }),
    staleTime: 15_000,
  });

  const data = usageQuery.data;
  const budgetValue = data?.budget.dailyTokenBudget ?? null;

  useEffect(() => {
    if (!budgetPanelOpen) return;
    setBudgetDraft(budgetValue === null ? "" : formatCompactTokens(budgetValue));
  }, [budgetPanelOpen, budgetValue]);

  const budgetMutation = useMutation({
    mutationFn: (dailyTokenBudget: number | null) =>
      updateDailyTokenBudget(dailyTokenBudget),
    onSuccess: (result) => {
      queryClient.setQueryData<UsageSummaryResponse>(
        ["usage", range, modelFilter, sourceFilter],
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
      toast.error("请输入有效的正整数，如 500K、1.5M 或 300000");
      return;
    }
    budgetMutation.mutate(parsed);
  };

  const inspectedContext: InspectedContext | null = useMemo(() => {
    if (!data) return null;
    const picked =
      selectedCallId !== null
        ? data.recentCalls.find((c) => c.id === selectedCallId) ?? null
        : null;
    if (picked) {
      return {
        subtitle: `所选调用 · ${formatSourceLabel(picked.source)} · ${picked.modelId}`,
        isCustomSelection: true,
        usedTokens: picked.totalTokens,
        contextWindow: picked.contextWindow,
        cacheReadTokens: picked.cacheReadTokens,
        uncachedInputTokens: picked.inputTokens + picked.cacheWriteTokens,
        outputTokens: picked.outputTokens,
        reasoningTokens: picked.reasoningTokens,
        updatedAt: picked.timestamp,
      };
    }
    const ctx = data.contextOccupancy;
    return {
      subtitle: ctx.modelId
        ? `主对话 · 最近一次调用 · ${ctx.modelId}`
        : "主对话 · 最近一次调用",
      isCustomSelection: false,
      usedTokens: ctx.usedTokens,
      contextWindow: ctx.contextWindow,
      cacheReadTokens: ctx.cacheReadTokens,
      uncachedInputTokens: ctx.inputTokens + ctx.cacheWriteTokens,
      outputTokens: ctx.outputTokens,
      reasoningTokens: ctx.reasoningTokens,
      updatedAt: ctx.updatedAt,
    };
  }, [data, selectedCallId]);

  const totalInputWithCache = data
    ? data.totals.inputTokens + data.totals.cacheReadTokens + data.totals.cacheWriteTokens
    : 0;
  const budget = data?.budget;
  const budgetReached =
    budget !== undefined &&
    budget.dailyTokenBudget !== null &&
    budget.todayTokens >= budget.dailyTokenBudget;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Minimal Open Editorial Header */}
      <header className="shrink-0 bg-background/95 backdrop-blur safe-top">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-4 pt-5 pb-3 sm:px-8 sm:pt-7">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={openMobileNav}
              className="flex size-9 items-center justify-center rounded-full bg-secondary text-foreground md:hidden"
              aria-label="打开导航"
            >
              <Menu className="size-4" />
            </button>
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
                用量
              </h1>
              <p className="mt-0.5 text-xs text-muted-foreground">
                本地独立账本 · 费用仅按上游元数据估算
              </p>
            </div>
          </div>

          {/* Right Filter Controls (Range / Model / Source / Refresh) */}
          <div className="flex flex-wrap items-center gap-2">
            <FilterDropdown
              ariaLabel="统计周期"
              value={range}
              options={RANGE_OPTIONS}
              onChange={(next) => {
                setRange(next);
                setSelectedCallId(null);
              }}
            />

            <FilterDropdown
              ariaLabel="按模型筛选"
              value={modelFilter}
              maxWidthClass="max-w-[168px]"
              options={[
                { value: "", label: "全部模型" },
                ...(data?.availableModels ?? []).map((m) => ({
                  value: m.modelId,
                  label: m.modelId,
                })),
              ]}
              onChange={(next) => {
                setModelFilter(next);
                setSelectedCallId(null);
              }}
            />

            <FilterDropdown
              ariaLabel="按来源筛选"
              value={sourceFilter}
              options={SOURCE_FILTER_OPTIONS}
              onChange={(next) => {
                setSourceFilter(next);
                setSelectedCallId(null);
              }}
            />

            <button
              type="button"
              onClick={() => void usageQuery.refetch()}
              disabled={usageQuery.isFetching}
              className="flex size-8 items-center justify-center rounded-lg border border-border/80 bg-card text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground disabled:opacity-50"
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
        <div className="mx-auto w-full max-w-5xl space-y-8 px-4 py-5 sm:px-8 sm:py-6">
          {usageQuery.isLoading ? (
            <div className="flex flex-col items-center justify-center gap-2.5 py-24 text-xs text-muted-foreground">
              <Spinner />
              <span>正在加载用量统计…</span>
            </div>
          ) : usageQuery.isError || !data ? (
            <div className="rounded-2xl border border-border/80 bg-card p-6 text-center space-y-3">
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
              {/* Row 1: 4 Open Borderless Typographic KPIs */}
              <section className="grid grid-cols-2 gap-6 lg:grid-cols-4">
                <div>
                  <div className="text-xs text-muted-foreground">估算费用</div>
                  <div
                    className={cn(
                      "mt-1.5 text-2xl font-semibold tracking-tight tabular-nums sm:text-[28px]",
                      data.totals.costUsd !== null
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {formatUsd(data.totals.costUsd)}
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {data.totals.costUsd !== null
                      ? "仅 API 计价估算，不代表订阅额度"
                      : "上游未返回计费元数据"}
                  </p>
                </div>

                <div>
                  <div className="text-xs text-muted-foreground">输入 / 输出</div>
                  <div className="mt-1.5 text-2xl font-semibold tracking-tight text-foreground tabular-nums sm:text-[28px]">
                    {formatCompactTokens(totalInputWithCache)}{" "}
                    <span className="font-normal text-muted-foreground">/</span>{" "}
                    {formatCompactTokens(data.totals.outputTokens)}
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    输入已含缓存读取，图中不再重复堆叠
                  </p>
                </div>

                <div>
                  <div className="text-xs text-muted-foreground">缓存命中</div>
                  <div
                    className={cn(
                      "mt-1.5 text-2xl font-semibold tracking-tight tabular-nums sm:text-[28px]",
                      data.totals.cacheHitRate !== null
                        ? "text-success"
                        : "text-muted-foreground",
                    )}
                  >
                    {formatPercent(data.totals.cacheHitRate)}
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
                    {data.totals.cacheReadTokens > 0
                      ? `命中 ${formatCompactTokens(data.totals.cacheReadTokens)}，降低重复输入开销`
                      : "该时段暂无缓存命中"}
                  </p>
                </div>

                <div>
                  <div className="text-xs text-muted-foreground">模型调用</div>
                  <div className="mt-1.5 text-2xl font-semibold tracking-tight text-foreground tabular-nums sm:text-[28px]">
                    {data.totals.calls}
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {formatRangeLabel(range)}内的请求次数，含子任务
                  </p>
                </div>
              </section>

              {/* Row 2: Stacked Trend Chart + Source Breakdown */}
              <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
                <div className="lg:col-span-7">
                  <StackedTrendChart range={range} trend={data.trend} />
                </div>
                <div className="lg:col-span-5">
                  <SourceBreakdownSection range={range} data={data} />
                </div>
              </div>

              {/* Row 3: Calls Table + Single-Request Context Card */}
              <div className="grid grid-cols-1 gap-8 lg:grid-cols-12 lg:items-start">
                <div className="lg:col-span-7">
                  <CallsTableSection
                    calls={data.recentCalls}
                    selectedCallId={selectedCallId}
                    onSelectCall={(call) =>
                      setSelectedCallId((prev) => (prev === call.id ? null : call.id))
                    }
                  />
                </div>
                <div className="lg:col-span-5">
                  {inspectedContext && (
                    <ContextInspectorCard
                      inspected={inspectedContext}
                      onResetSelection={() => setSelectedCallId(null)}
                    />
                  )}
                </div>
              </div>

              {/* Row 4: Bottom Budget Reminder Strip (Blue Left Accent Bar) */}
              <section className="rounded-xl border border-border/80 bg-card/80 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="h-4 w-1 shrink-0 rounded-full bg-primary" />
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums">
                      <span className="font-medium text-foreground">
                        {budgetValue !== null
                          ? `每日 Token 预警 ${formatCompactTokens(budgetValue)} · 仅提醒，不自动中止`
                          : "每日 Token 预警未开启 · 仅提醒，不自动中止"}
                      </span>
                      {budget && budgetValue !== null && (
                        <span className="text-muted-foreground">
                          （今日累计 {formatCompactTokens(budget.todayTokens)}）
                        </span>
                      )}
                      {budgetReached && (
                        <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
                          今日已超阈值
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setBudgetPanelOpen((open) => !open)}
                    className="shrink-0 text-xs font-medium text-primary hover:underline"
                  >
                    {budgetPanelOpen ? "收起" : "配置预警"}
                  </button>
                </div>

                {budgetPanelOpen && (
                  <form
                    onSubmit={handleBudgetSubmit}
                    className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3"
                  >
                    <input
                      type="text"
                      value={budgetDraft}
                      onChange={(event) => setBudgetDraft(event.target.value)}
                      placeholder="例如 500K、1.5M（留空关闭）"
                      className="h-8 min-w-[180px] flex-1 rounded-lg border border-border/80 bg-background px-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none tabular-nums"
                    />
                    <div className="flex items-center gap-1.5">
                      {BUDGET_PRESETS.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setBudgetDraft(formatCompactTokens(preset))}
                          className="h-8 rounded-lg bg-secondary px-2.5 text-xs font-medium text-muted-foreground tabular-nums transition-colors hover:text-foreground"
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
                        className="h-8 rounded-lg px-3.5 text-xs"
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
                          className="h-8 rounded-lg px-3 text-xs"
                        >
                          关闭预警
                        </Button>
                      )}
                      <button
                        type="button"
                        onClick={() => setBudgetPanelOpen(false)}
                        className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground"
                        aria-label="取消"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  </form>
                )}
              </section>

              {/* Subtle Footer Note */}
              <footer className="flex flex-wrap items-center justify-between gap-2 pb-2 text-[11px] text-muted-foreground/80">
                <span>
                  统计口径涵盖对话、后台子任务、记忆整理、定时任务与上下文压缩 · 费用按上游元数据估算，不能作为账单或额度依据
                </span>
                <span className="tabular-nums">{data.timezone}</span>
              </footer>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

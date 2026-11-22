import { useEffect, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { errorText, toApiError } from "@/api/errors";
import { cancelSubagent, type SubagentSnapshot } from "@/api/subagents";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { isSubagentActive, useSubagentStore } from "@/store/subagents";

function formatElapsed(startedAt: number, finishedAt: number | null, now: number): string {
  const end = finishedAt ?? now;
  const totalSeconds = Math.max(0, Math.floor((end - startedAt) / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function statusMeta(item: SubagentSnapshot): { label: string; dotClass: string } {
  switch (item.status) {
    case "waiting_approval":
      return { label: "待审批", dotClass: "bg-warning" };
    case "completed":
      return { label: "已完成", dotClass: "bg-success" };
    case "cancelled":
      return { label: "已中止", dotClass: "bg-muted-foreground/60" };
    case "failed":
      return { label: "失败", dotClass: "bg-destructive" };
    default:
      return { label: "运行中", dotClass: "bg-primary animate-pulse" };
  }
}

/**
 * Meta Muse 风格 Sub-agent 折叠胶囊条：
 * - 位于输入框上方（QueuePanel 之上），平时默认收起为单行轻汇总胶囊；
 * - 点击展开每条 Sub-agent 的任务、状态、当前工具、实时耗时与一键中止；
 * - 全部子任务结束后保留 3 秒完成态回执后由 store 自动收起隐藏。
 */
export function SubagentPanel() {
  const items = useSubagentStore((state) => state.items);
  const [expanded, setExpanded] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const activeItems = items.filter(isSubagentActive);
  const hasActive = activeItems.length > 0;
  const waitingApprovalCount = activeItems.filter((item) => item.status === "waiting_approval").length;

  useEffect(() => {
    if (items.length === 0) {
      setExpanded(false);
      setCancellingId(null);
    }
  }, [items.length]);

  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasActive]);

  if (items.length === 0) return null;

  const earliestStart = Math.min(...items.map((item) => item.startedAt));
  const latestFinish = hasActive
    ? null
    : Math.max(...items.map((item) => item.finishedAt ?? now));

  const summaryText = hasActive
    ? `${activeItems.length} 个子任务运行中`
    : items.every((item) => item.status === "completed")
      ? `${items.length} 个子任务已完成`
      : `${items.length} 个子任务已结束`;

  const handleCancel = async (item: SubagentSnapshot) => {
    if (cancellingId !== null) return;
    setCancellingId(item.id);
    try {
      await cancelSubagent(item.id);
      toast.info("已中止子任务");
    } catch (error) {
      const apiErr = toApiError(error);
      if (apiErr.status !== 404 && apiErr.status !== 409) {
        toast.error(errorText(apiErr.code, apiErr.message));
      }
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <section className="shrink-0 bg-background" aria-label="运行中的子任务">
      <div className="mx-auto w-full max-w-3xl px-3 pb-1.5 pt-1 sm:px-6">
        <div className="overflow-hidden rounded-2xl border border-border/80 bg-secondary/85 transition-all">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            className="flex w-full items-center justify-between gap-3 px-3.5 py-2 text-left text-xs transition-colors hover:bg-secondary"
          >
            <div className="flex min-w-0 items-center gap-2">
              {hasActive ? (
                <span className="size-2 shrink-0 rounded-full bg-primary animate-pulse" aria-hidden />
              ) : (
                <Check className="size-3.5 shrink-0 text-success" aria-hidden />
              )}
              <span className="truncate font-medium text-foreground">{summaryText}</span>
              {waitingApprovalCount > 0 && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span className="inline-flex shrink-0 items-center gap-1 font-medium text-warning whitespace-nowrap">
                    <span className="size-1.5 rounded-full bg-warning" aria-hidden />
                    {waitingApprovalCount} 待审批
                  </span>
                </>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
              <span className="font-mono text-[11px] tabular-nums">
                {formatElapsed(earliestStart, latestFinish, now)}
              </span>
              <ChevronDown
                className={cn(
                  "size-3.5 transition-transform duration-200",
                  expanded && "rotate-180",
                )}
              />
            </div>
          </button>

          {expanded && (
            <ul className="max-h-48 space-y-1.5 overflow-y-auto px-2 pb-2">
              {items.map((item) => {
                const meta = statusMeta(item);
                const active = isSubagentActive(item);
                const cancelling = cancellingId === item.id;
                return (
                  <li
                    key={item.id}
                    className="flex items-center justify-between gap-2.5 rounded-xl bg-card px-3 py-2 text-xs shadow-2xs"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      {item.status === "completed" ? (
                        <Check className="size-3.5 shrink-0 text-success" aria-hidden />
                      ) : (
                        <span
                          className={cn("size-1.5 shrink-0 rounded-full", meta.dotClass)}
                          aria-hidden
                        />
                      )}
                      <span className="min-w-0 truncate text-card-foreground" title={item.task}>
                        {item.task}
                      </span>
                      {item.status === "waiting_approval" ? (
                        <span className="shrink-0 rounded-md bg-warning/15 px-1.5 py-0.5 text-[11px] font-medium text-warning whitespace-nowrap">
                          待审批
                        </span>
                      ) : item.currentTool ? (
                        <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                          {item.currentTool}
                        </span>
                      ) : !active ? (
                        <span className="shrink-0 text-[11px] text-muted-foreground whitespace-nowrap">
                          {meta.label}
                        </span>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                        {formatElapsed(item.startedAt, item.finishedAt, now)}
                      </span>
                      {active && (
                        <button
                          type="button"
                          disabled={cancellingId !== null}
                          onClick={() => void handleCancel(item)}
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                        >
                          {cancelling && <Spinner className="size-3" />}
                          中止
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import type { ApprovalRequestView } from "@/api/approvals";
import { errorText, toApiError } from "@/api/errors";
import { cancelSubagent, type SubagentSnapshot } from "@/api/subagents";
import { Spinner } from "@/components/ui/spinner";
import { ApprovalActionBody, useCountdownClock } from "@/features/approvals/ApprovalActionCard";
import { cn } from "@/lib/utils";
import { useApprovalStore } from "@/store/approvals";
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

function SubagentInlineApprovalDrawer({
  approvals,
  onResolved,
}: {
  approvals: ApprovalRequestView[];
  onResolved: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const safeIdx = approvals.length === 0 ? 0 : Math.min(idx, approvals.length - 1);
  const current = approvals[safeIdx] ?? null;
  const { clock, urgent } = useCountdownClock(current?.expiresAt ?? null);

  if (!current) return null;

  return (
    <div className="mt-2 border-t border-border/70 pt-2.5">
      <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="font-medium text-warning">待你确认敏感操作</span>
        <div className="flex items-center gap-1.5">
          {approvals.length > 1 && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-secondary px-1.5 py-0.5 tabular-nums">
              <button
                type="button"
                aria-label="上一条审批"
                onClick={() => setIdx((prev) => (prev - 1 + approvals.length) % approvals.length)}
                className="rounded-full p-0.5 hover:bg-card hover:text-foreground"
              >
                <ChevronLeft className="size-3" />
              </button>
              <span>
                {safeIdx + 1} / {approvals.length}
              </span>
              <button
                type="button"
                aria-label="下一条审批"
                onClick={() => setIdx((prev) => (prev + 1) % approvals.length)}
                className="rounded-full p-0.5 hover:bg-card hover:text-foreground"
              >
                <ChevronRight className="size-3" />
              </button>
            </span>
          )}
          <span
            className={cn(
              "tabular-nums",
              urgent ? "font-medium text-destructive" : "text-muted-foreground",
            )}
          >
            剩余 {clock}
          </span>
        </div>
      </div>
      <ApprovalActionBody approval={current} onResolved={onResolved} />
    </div>
  );
}

/**
 * Meta Muse 风格 Sub-agent 折叠胶囊条（集成 Sub-agent 行内非阻塞审批）：
 * - 位于输入框上方（QueuePanel 之上），平时默认收起为单行轻汇总胶囊；
 * - 点击展开每条 Sub-agent 的任务、状态、当前工具、实时耗时与一键中止；
 * - 若某条 Sub-agent 存在待审批敏感操作，点击其「待审批」标签即可在该行下方就地展开审批卡片，不额外占第三条胶囊、也不阻塞对话；
 * - 全部子任务结束后保留 3 秒完成态回执后由 store 自动收起隐藏。
 */
export function SubagentPanel() {
  const storeItems = useSubagentStore((state) => state.items);
  const pendingApprovals = useApprovalStore((state) => state.pending);

  const [expanded, setExpanded] = useState(false);
  const [openApprovalSubId, setOpenApprovalSubId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // 按 subagentId 分组待审批请求；如果某条 Sub-agent 审批早于 subagent.updated 到达，则合成兜底展示行避免丢失。
  const approvalsBySubId = new Map<string, ApprovalRequestView[]>();
  for (const apr of pendingApprovals) {
    if (apr.caller.kind !== "subagent") continue;
    const list = approvalsBySubId.get(apr.caller.subagentId) ?? [];
    list.push(apr);
    approvalsBySubId.set(apr.caller.subagentId, list);
  }

  const mergedItems: SubagentSnapshot[] = storeItems.map((item) => {
    const hasPendingApr = (approvalsBySubId.get(item.id)?.length ?? 0) > 0;
    if (hasPendingApr && item.status === "running") {
      return { ...item, status: "waiting_approval" };
    }
    return item;
  });

  const knownIds = new Set(mergedItems.map((item) => item.id));
  for (const [subagentId, aprs] of approvalsBySubId.entries()) {
    if (knownIds.has(subagentId)) continue;
    const first = aprs[0]!;
    if (first.caller.kind !== "subagent") continue;
    mergedItems.push({
      id: subagentId,
      task: first.caller.task,
      status: "waiting_approval",
      currentTool: first.toolName,
      startedAt: Date.parse(first.createdAt) || Date.now(),
      finishedAt: null,
    });
  }

  const activeItems = mergedItems.filter(isSubagentActive);
  const hasActive = activeItems.length > 0;
  const totalSubagentApprovals = [...approvalsBySubId.values()].reduce(
    (sum, list) => sum + list.length,
    0,
  );

  useEffect(() => {
    if (mergedItems.length === 0) {
      setExpanded(false);
      setOpenApprovalSubId(null);
      setCancellingId(null);
    }
  }, [mergedItems.length]);

  useEffect(() => {
    if (openApprovalSubId && (approvalsBySubId.get(openApprovalSubId)?.length ?? 0) === 0) {
      setOpenApprovalSubId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingApprovals, openApprovalSubId]);

  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasActive]);

  if (mergedItems.length === 0) return null;

  const earliestStart = Math.min(...mergedItems.map((item) => item.startedAt));
  const latestFinish = hasActive
    ? null
    : Math.max(...mergedItems.map((item) => item.finishedAt ?? now));

  const summaryText = hasActive
    ? `${activeItems.length} 个子任务运行中`
    : mergedItems.every((item) => item.status === "completed")
      ? `${mergedItems.length} 个子任务已完成`
      : `${mergedItems.length} 个子任务已结束`;

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
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full animate-pulse",
                    totalSubagentApprovals > 0 ? "bg-warning" : "bg-primary",
                  )}
                  aria-hidden
                />
              ) : (
                <Check className="size-3.5 shrink-0 text-success" aria-hidden />
              )}
              <span className="truncate font-medium text-foreground">{summaryText}</span>
              {totalSubagentApprovals > 0 && (
                <>
                  <span className="text-muted-foreground/50">·</span>
                  <span className="inline-flex shrink-0 items-center gap-1 font-medium text-warning whitespace-nowrap">
                    <span className="size-1.5 rounded-full bg-warning" aria-hidden />
                    {totalSubagentApprovals} 待审批
                  </span>
                </>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
              <span className="text-[11px] tabular-nums">
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
            <ul className="max-h-[340px] space-y-1.5 overflow-y-auto px-2 pb-2">
              {mergedItems.map((item) => {
                const meta = statusMeta(item);
                const active = isSubagentActive(item);
                const cancelling = cancellingId === item.id;
                const rowApprovals = approvalsBySubId.get(item.id) ?? [];
                const hasRowApproval = rowApprovals.length > 0;
                const approvalOpen = openApprovalSubId === item.id && hasRowApproval;

                return (
                  <li
                    key={item.id}
                    className="rounded-xl bg-card px-3 py-2 text-xs shadow-2xs transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2.5">
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        {item.status === "completed" ? (
                          <Check className="size-3.5 shrink-0 text-success" aria-hidden />
                        ) : (
                          <span
                            className={cn("size-1.5 shrink-0 rounded-full", meta.dotClass)}
                            aria-hidden
                          />
                        )}
                        <span
                          className="min-w-0 truncate text-card-foreground"
                          title={item.task}
                        >
                          {item.task}
                        </span>
                        {hasRowApproval ? (
                          <button
                            type="button"
                            onClick={() =>
                              setOpenApprovalSubId((prev) =>
                                prev === item.id ? null : item.id,
                              )
                            }
                            aria-expanded={approvalOpen}
                            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning transition-colors hover:bg-warning/25 whitespace-nowrap"
                          >
                            <span>
                              {approvalOpen
                                ? "收起审批"
                                : rowApprovals.length > 1
                                  ? `待审批 (${rowApprovals.length})`
                                  : "待审批"}
                            </span>
                            <ChevronDown
                              className={cn(
                                "size-3 transition-transform duration-200",
                                approvalOpen && "rotate-180",
                              )}
                            />
                          </button>
                        ) : item.status === "waiting_approval" ? (
                          <span className="shrink-0 rounded-md bg-warning/15 px-1.5 py-0.5 text-[11px] font-medium text-warning whitespace-nowrap">
                            待审批
                          </span>
                        ) : item.currentTool ? (
                          <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground whitespace-nowrap">
                            {item.currentTool}
                          </span>
                        ) : !active ? (
                          <span className="shrink-0 text-[11px] text-muted-foreground whitespace-nowrap">
                            {meta.label}
                          </span>
                        ) : null}
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-[11px] tabular-nums text-muted-foreground">
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
                    </div>

                    {approvalOpen && (
                      <SubagentInlineApprovalDrawer
                        approvals={rowApprovals}
                        onResolved={() => setOpenApprovalSubId(null)}
                      />
                    )}
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
